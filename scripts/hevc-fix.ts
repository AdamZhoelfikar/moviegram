import { spawn } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import bigInt from "big-integer";
import { Api } from "teleproto";
import { eq } from "drizzle-orm";
import { db } from "../lib/db";
import { videos } from "../db/schema";
import { getTelegramClient, resolveTelegramVideo } from "../lib/telegram";

/**
 * Converts a browser-hostile video (HEVC/H.265 etc.) in the Telegram library
 * into an H.264 + faststart copy and swaps the library row onto the new
 * message, so Chrome/Firefox can render a picture (audio-only otherwise).
 *
 * Usage: npm run media:fix-hevc -- <videoId>
 * Resumable: re-run to continue a failed step; finished artifacts are reused.
 */

function ffprobeJson(file: string): Promise<{
  streams: { codec_type: string; codec_name: string }[];
  format: { duration?: string };
}> {
  return new Promise((resolve, reject) => {
    const p = spawn("ffprobe", [
      "-v", "error", "-print_format", "json",
      "-show_streams", "-show_format", file,
    ]);
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.stderr.on("data", (d) => console.error(d.toString()));
    p.on("close", (code) =>
      code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`ffprobe exit ${code}`)),
    );
  });
}

function ffmpegEncode(src: string, dst: string, nvenc: boolean): Promise<void> {
  const vcodec = nvenc
    ? ["-c:v", "h264_nvenc", "-preset", "p4", "-rc", "constqp", "-cq", "24", "-b:v", "0"]
    : ["-c:v", "libx264", "-preset", "fast", "-crf", "22"];
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", [
      "-y", "-hide_banner", "-loglevel", "error", "-stats", "-stats_period", "30",
      "-i", src,
      "-map", "0:v:0", "-map", "0:a?", "-map", "0:s?",
      ...vcodec,
      "-c:a", "copy", "-c:s", "mov_text",
      "-movflags", "+faststart",
      dst,
    ]);
    p.stderr.on("data", (d) => process.stdout.write(`[ffmpeg] ${d}`));
    p.on("close", (code) =>
      code === 0 ? resolve() : reject(new Error(`ffmpeg exit ${code}`)),
    );
  });
}

function pct(current: number, total: number): string {
  return total > 0 ? `${((current / total) * 100).toFixed(1)}%` : "?";
}

// teleproto types OnProgress as (number, number) but passes big-integer
// instances at runtime — normalize whichever arrives.
function toN(v: number | { toJSNumber(): number }): number {
  return typeof v === "number" ? v : v.toJSNumber();
}

/**
 * Resumable parallel download: 8 MB segments aligned to the 512 KB MTProto
 * chunk size, written at their file offset, each retried up to 5 times.
 * teleproto's own downloadMedia dies on a dropped media session
 * (SlotRemovedError) and restarts from byte zero; this picks up where it
 * stopped, which matters for a 1.6 GB file over a flaky DC connection.
 */
const SEGMENT = 8 * 1024 * 1024;
const MT_CHUNK = 512 * 1024;

async function downloadSegment(
  client: Awaited<ReturnType<typeof getTelegramClient>>,
  location: Api.InputDocumentFileLocation,
  fd: number,
  seg: number,
  total: number,
  dcRef: { dc?: number },
): Promise<void> {
  const base = seg * SEGMENT;
  const end = Math.min(base + SEGMENT, total);
  let offset = base;
  while (offset < end) {
    let data: Uint8Array | null = null;
    for (let attempt = 1; ; ) {
      try {
        const result = await client.invoke(
          new Api.upload.GetFile({
            location,
            offset: bigInt(offset),
            limit: MT_CHUNK,
            precise: true,
          }),
          dcRef.dc,
        );
        if (result instanceof Api.upload.FileCdnRedirect) {
          throw new Error("CDN redirect unsupported here");
        }
        data = result.bytes as Uint8Array;
        break;
      } catch (err) {
        const rpc = err as { errorMessage?: string; newDc?: number };
        if (
          typeof rpc.errorMessage === "string" &&
          rpc.errorMessage.startsWith("FILE_MIGRATE_") &&
          typeof rpc.newDc === "number"
        ) {
          dcRef.dc = rpc.newDc; // migrate is not a failure — same offset, new DC
          continue;
        }
        if (attempt >= 5) throw err;
        attempt += 1;
        console.log(`[retry seg ${seg} @${offset} attempt ${attempt}: ${(err as Error).message}]`);
        await new Promise((r) => setTimeout(r, 2000 * attempt));
      }
    }
    if (!data || data.byteLength === 0) return; // EOF
    fs.writeSync(fd, data, 0, Math.min(data.byteLength, end - offset), offset);
    offset += data.byteLength;
    if (data.byteLength < MT_CHUNK) return; // end of file
  }
}

async function resumableDownload(
  client: Awaited<ReturnType<typeof getTelegramClient>>,
  message: Api.Message,
  file: string,
  total: number,
): Promise<void> {
  const media = message.media as Api.MessageMediaDocument;
  if (!(media.document instanceof Api.Document)) throw new Error("no document on source message");
  const doc = media.document;
  const location = new Api.InputDocumentFileLocation({
    id: doc.id,
    accessHash: doc.accessHash,
    fileReference: doc.fileReference,
    thumbSize: "",
  });
  const existing = fs.existsSync(file) ? fs.statSync(file).size : 0;
  const complete = Math.floor(existing / SEGMENT) * SEGMENT; // redo partial tail
  if (existing > complete) fs.truncateSync(file, complete);
  const fd = fs.openSync(file, complete > 0 ? "r+" : "w+");
  const dcRef: { dc?: number } = { dc: doc.dcId || undefined };
  const segCount = Math.ceil(total / SEGMENT);
  let done = complete / SEGMENT;
  console.log(`[download] resuming at ${pct(complete, total)}`);
  let lastPct = -1;
  const progress = () => {
    const p = Math.floor((done / segCount) * 100);
    if (p >= lastPct + 5) {
      lastPct = p;
      console.log(`[download] ${p}%`);
    }
  };
  let next = done;
  const worker = async (): Promise<void> => {
    for (;;) {
      const seg = next;
      next += 1;
      if (seg >= segCount) return;
      await downloadSegment(client, location, fd, seg, total, dcRef);
      done += 1;
      progress();
    }
  };
  const workers = Array.from({ length: 4 }, worker);
  try {
    await Promise.all(workers);
  } finally {
    fs.closeSync(fd);
  }
}

async function main(): Promise<void> {
  const videoId = process.argv[2];
  if (!videoId) {
    console.error("Usage: npm run media:fix-hevc -- <videoId>");
    process.exit(1);
  }
  const [video] = await db.select().from(videos).where(eq(videos.id, videoId)).limit(1);
  if (!video || video.sourceType !== "telegram" || !video.telegramChatId || video.telegramMessageId == null) {
    console.error("Not a Telegram-sourced video row.");
    process.exit(1);
  }

  const src = { chatId: video.telegramChatId, messageId: video.telegramMessageId };
  const scratch = path.join(os.homedir(), ".cache", "moviegram", "hevc", videoId);
  fs.mkdirSync(scratch, { recursive: true });
  const sourceFile = path.join(scratch, "source.mp4");
  const outFile = path.join(scratch, "h264.mp4");
  const doneMarker = path.join(scratch, "h264.done");
  if (!fs.existsSync(doneMarker)) fs.rmSync(outFile, { force: true }); // partial encode — redo

  const client = await getTelegramClient();

  // 1. Download the original (teleproto uses parallel media sessions).
  const { message, size } = await resolveTelegramVideo(src);
  const total = size;
  if (fs.existsSync(sourceFile) && fs.statSync(sourceFile).size === total) {
    console.log("[download] source.mp4 already complete, reusing");
  } else {
    console.log(`Downloading original (${(total / 1048576).toFixed(0)} MB)...`);
    await resumableDownload(client, message, sourceFile, total);
    if (fs.statSync(sourceFile).size !== total) throw new Error("download truncated");
  }

  // 2. Encode to H.264 + faststart (NVENC when available, CPU otherwise).
  if (!fs.existsSync(doneMarker)) {
    try {
      console.log("[encode] trying h264_nvenc...");
      await ffmpegEncode(sourceFile, outFile, true);
    } catch (err) {
      console.log(`[encode] NVENC failed (${(err as Error).message}), falling back to libx264`);
      fs.rmSync(outFile, { force: true });
      await ffmpegEncode(sourceFile, outFile, false);
    }
    fs.writeFileSync(doneMarker, "ok");
  } else {
    console.log("[encode] h264.mp4 already exists, reusing");
  }
  const probe = await ffprobeJson(outFile);
  const videoStream = probe.streams.find((s) => s.codec_type === "video");
  const audioCodec = probe.streams.find((s) => s.codec_type === "audio")?.codec_name ?? "unknown";
  if (videoStream?.codec_name !== "h264") throw new Error(`encode produced ${videoStream?.codec_name}`);
  const duration = Math.round(Number(probe.format.duration ?? video.durationSeconds ?? 0)) || null;
  console.log(`[encode] ok: h264 video, audio=${audioCodec}, duration=${duration}s`);

  // 3. Upload the replacement to the same channel.
  const sentMarker = path.join(scratch, "sent.json");
  const entity = await client.getEntity(src.chatId);
  const outSize = fs.statSync(outFile).size;
  let sentId: number;
  let sentDoc: Api.Document;
  if (fs.existsSync(sentMarker)) {
    const m = JSON.parse(fs.readFileSync(sentMarker, "utf8")) as { id: number; docId: string };
    sentId = m.id;
    console.log(`[upload] reusing previous upload (message ${sentId})`);
    const msgs = await client.getMessages(entity, { ids: [sentId] });
    const mm = msgs[0]?.media;
    if (!(mm instanceof Api.MessageMediaDocument) || !(mm.document instanceof Api.Document)) {
      throw new Error("sent message lost its document media");
    }
    sentDoc = mm.document;
  } else {
    console.log("Uploading h264.mp4 back to the channel (this can take a while)...");
    let lastUp = -1;
    const sent = await client.sendFile(entity, {
      file: outFile,
      caption: video.title,
      supportsStreaming: true,
      workers: 8,
      progressCallback: (uploaded) => {
        const p = Math.floor((toN(uploaded) / outSize) * 20) * 5;
        if (p !== lastUp) {
          lastUp = p;
          console.log(`[upload] ${p}%`);
        }
      },
    });
    const sentMedia = sent.media;
    if (!(sentMedia instanceof Api.MessageMediaDocument) || !(sentMedia.document instanceof Api.Document)) {
      throw new Error("sent message has no document media");
    }
    sentId = sent.id;
    sentDoc = sentMedia.document;
    fs.writeFileSync(sentMarker, JSON.stringify({ id: sentId, docId: String(sentDoc.id) }));
  }
  const doc = sentDoc;
  console.log(`Uploaded as message ${sentId} (doc ${String(doc.id)})`);

  // 4. Point the library row at the new message, then delete the HEVC original
  //    from the channel (source.mp4 stays in ~/.cache/moviegram/hevc as a backup).
  await db
    .update(videos)
    .set({
      telegramMessageId: sentId,
      telegramFileId: String(doc.id),
      fileSizeBytes: Number(doc.size),
      mimeType: doc.mimeType ?? "video/mp4",
      durationSeconds: duration,
      title: video.title,
    })
    .where(eq(videos.id, videoId));
  console.log("Library row updated to the H.264 copy.");

  await client.deleteMessages(entity, [src.messageId], { revoke: true });
  console.log(`Deleted old HEVC message ${src.messageId} from the channel.`);
  console.log("DONE");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
