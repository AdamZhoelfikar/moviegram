import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import { env } from "./env";
import * as schema from "../db/schema";

const create = () => {
  const sql = postgres(env.databaseUrl, { max: 10 });
  return drizzle(sql, { schema });
};

const globalForDb = globalThis as unknown as {
  __wpDb?: ReturnType<typeof create>;
};

export const db = globalForDb.__wpDb ?? create();
if (process.env.NODE_ENV !== "production") globalForDb.__wpDb = db;

export type Db = typeof db;
