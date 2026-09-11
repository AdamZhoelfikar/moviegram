import {
  bigint,
  boolean,
  doublePrecision,
  index,
  integer,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  username: text("username").notNull().unique(),
  displayName: text("display_name").notNull(),
  avatar: text("avatar"),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const series = pgTable("series", {
  id: text("id").primaryKey(),
  title: text("title").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export type VideoSourceKind = "telegram" | "url";

export const videos = pgTable(
  "videos",
  {
    id: text("id").primaryKey(),
    title: text("title").notNull(),
    description: text("description"),
    thumbnail: text("thumbnail"),
    durationSeconds: doublePrecision("duration"),
    year: integer("year"),
    genre: text("genre"),
    subtitleUrl: text("subtitle_url"),
    seriesId: text("series_id").references(() => series.id),
    season: integer("season"),
    episode: integer("episode"),
    // Telegram source reference (PRD 6.3 / 9) — server-side only, never exposed to the browser
    sourceType: text("source_type").$type<VideoSourceKind>().notNull().default("telegram"),
    telegramChatId: text("telegram_chat_id"),
    telegramMessageId: integer("telegram_message_id"),
    telegramFileId: text("telegram_file_id"),
    // Fallback direct URL (used by the local POC A demo content)
    url: text("url"),
    mimeType: text("mime_type"),
    fileSizeBytes: bigint("file_size", { mode: "number" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("videos_series_idx").on(t.seriesId, t.season, t.episode)],
);

export const rooms = pgTable(
  "rooms",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    inviteCode: text("invite_code").notNull(),
    title: text("title").notNull().default("Watch Party"),
    hostId: uuid("host_id")
      .notNull()
      .references(() => users.id),
    videoId: text("video_id")
      .notNull()
      .references(() => videos.id),
    status: text("status").$type<"active" | "ended">().notNull().default("active"),
    // Authoritative playback state (PRD 6.11 / 10). Position is the value measured at serverTime.
    playing: boolean("playing").notNull().default(false),
    positionSeconds: doublePrecision("position").notNull().default(0),
    playbackRate: doublePrecision("playback_rate").notNull().default(1),
    serverTime: timestamp("server_time", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  },
  (t) => [
    uniqueIndex("rooms_invite_code_idx").on(t.inviteCode),
    index("rooms_status_idx").on(t.status),
  ],
);

export const roomMembers = pgTable(
  "room_members",
  {
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    role: text("role").$type<"host" | "guest">().notNull().default("guest"),
    joinedAt: timestamp("joined_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.roomId, t.userId] })],
);

export const messages = pgTable(
  "messages",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    roomId: uuid("room_id")
      .notNull()
      .references(() => rooms.id),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    body: text("body").notNull(),
    videoTimestamp: doublePrecision("video_timestamp"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("messages_room_idx").on(t.roomId, t.createdAt)],
);

export const watchHistory = pgTable(
  "watch_history",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id),
    videoId: text("video_id")
      .notNull()
      .references(() => videos.id),
    positionSeconds: doublePrecision("position").notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("watch_history_user_video_idx").on(t.userId, t.videoId)],
);
