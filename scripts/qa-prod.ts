import WebSocket from "ws";

/**
 * Headless production QA: two users, room join over the tunnel WS,
 * host play → guest state, stream range fetch through Vercel → Telegram,
 * third user rejected. Usage: tsx scripts/qa-prod.ts
 */
const BASE = process.env.QA_BASE ?? "https://moviegram-r3b11en7c-adam-8a40.vercel.app";
const WSS = process.env.QA_WSS ?? "wss://source-discounts-bbs-tcp.trycloudflare.com";
const VIDEO = process.env.QA_VIDEO ?? "cb722943-8e27-4cb7-a8cb-7d523bbf1f72";

async function login(name: string): Promise<string> {
  const res = await fetch(`${BASE}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ displayName: name }),
  });
  if (!res.ok) throw new Error(`login ${name}: ${res.status}`);
  const setCookie = res.headers.getSetCookie?.() ?? [];
  return setCookie.map((c) => c.split(";")[0]).join("; ");
}

type JsonRecord = Record<string, unknown>;

type WsEvent = {
  type: string;
  code?: string;
  state?: { playing?: boolean; positionSeconds?: number };
  stream?: { path?: string };
};

async function post(cookie: string, path: string, body?: unknown): Promise<{ status: number; data: JsonRecord }> {
  const res = await fetch(`${BASE}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", cookie },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: (await res.json().catch(() => ({}))) as JsonRecord };
}

function connectWs(code: string, ticket: string): Promise<{ ws: WebSocket; events: WsEvent[] }> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`${WSS}/?code=${code}&token=${ticket}`);
    const events: WsEvent[] = [];
    const timer = setTimeout(() => reject(new Error("ws connect timeout")), 15_000);
    ws.on("open", () => {
      clearTimeout(timer);
      resolve({ ws, events });
    });
    ws.on("message", (raw) => events.push(JSON.parse(raw.toString()) as WsEvent));
    ws.on("error", reject);
  });
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  const results: string[] = [];
  const ok = (name: string, pass: boolean, detail = "") => {
    results.push(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
    if (!pass) process.exitCode = 1;
  };

  const cookieA = await login("QA-Adam");
  const cookieB = await login("QA-Friend");
  const room = await post(cookieA, "/api/rooms", { videoId: VIDEO });
  ok("create room", room.status === 200 && !!room.data.inviteCode, `code=${room.data.inviteCode}`);
  const code = room.data.inviteCode as string;

  const joinA = await post(cookieA, `/api/rooms/${code}/join`);
  const joinB = await post(cookieB, `/api/rooms/${code}/join`);
  ok("host+guest join REST", joinA.status === 200 && joinB.status === 200);

  const joinC = await post(await login("QA-Third"), `/api/rooms/${code}/join`);
  ok("third user rejected", joinC.status === 409, `status=${joinC.status}`);

  const a = await connectWs(code, joinA.data.ticket as string);
  const b = await connectWs(code, joinB.data.ticket as string);
  await wait(8000);
  const joinedA = a.events.find((e) => e.type === "joined");
  const joinedB = b.events.find((e) => e.type === "joined");
  ok("ws joined (host+guest)", !!joinedA && !!joinedB);
  const stream = joinedB?.stream ?? joinedA?.stream;
  if (!stream) {
    console.log("DEBUG host events:", JSON.stringify(a.events).slice(0, 600));
    console.log("DEBUG guest events:", JSON.stringify(b.events).slice(0, 600));
    console.log(results.join("\n"));
    a.ws.close(); b.ws.close();
    process.exit(1);
  }
  ok("stream descriptor has grant", typeof stream?.path === "string" && stream.path.includes("grant="));

  a.ws.send(JSON.stringify({ type: "play", position: 30 }));
  await wait(1500);
  const playState = b.events.find((e) => e.type === "state" && e.state?.playing === true);
  ok(
    "guest receives host play",
    !!playState,
    playState?.state ? `pos=${playState.state.positionSeconds}` : "none",
  );

  const guestTriesPlay = b.events.length;
  b.ws.send(JSON.stringify({ type: "play", position: 99 }));
  await wait(1200);
  const forbidden = b.events.slice(guestTriesPlay).find((e) => e.type === "error" && e.code === "forbidden");
  ok("guest play rejected server-side", !!forbidden);

  const rangeRes = await fetch(`${BASE}${stream.path}`, { headers: { range: "bytes=0-1023" } });
  const buf = Buffer.from(await rangeRes.arrayBuffer());
  ok(
    "stream 206 via Vercel→Telegram",
    rangeRes.status === 206 && buf.length === 1024 && buf.subarray(4, 8).toString() === "ftyp",
    `status=${rangeRes.status} len=${buf.length} magic=${buf.subarray(4, 8).toString()}`,
  );

  a.ws.close();
  b.ws.close();
  console.log(results.join("\n"));
  process.exit(process.exitCode ?? 0);
}

main().catch((err) => {
  console.error("QA crashed:", err);
  process.exit(1);
});
