import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "./env";
import * as schema from "../db/schema";

/**
 * Serverless-tuned pool. Vercel may run many instances at once, so each one
 * keeps a single connection (Neon's pooler multiplexes from there), drops it
 * when idle, and avoids prepared statements (the pooled endpoint is
 * PgBouncer-based and cannot keep per-connection statement state).
 */
const create = () => {
  const sql = postgres(env.databaseUrl, {
    max: 1,
    idle_timeout: 20,
    connect_timeout: 10,
    max_lifetime: 60 * 30,
    prepare: false,
  });
  return drizzle(sql, { schema });
};

const globalForDb = globalThis as unknown as {
  __wpDb?: ReturnType<typeof create>;
};

// Cache on globalThis everywhere: warm serverless instances reuse the pool
// instead of opening a new connection per invocation.
export const db = globalForDb.__wpDb ?? create();
globalForDb.__wpDb = db;

export type Db = typeof db;
