import { closeSync, mkdirSync, openSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { drizzle } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import { MileError } from "../errors.js";
import * as schema from "./schema.js";

const migrationsFolder = fileURLToPath(new URL("../../drizzle/", import.meta.url));

export function openDatabase(path: string) {
  let client: Database.Database | undefined;
  try {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    closeSync(openSync(path, "a", 0o600));
    client = new Database(path);
    client.pragma("busy_timeout = 5000");
    const db = drizzle(client, { schema });
    migrate(db, { migrationsFolder });
    const connection = client;
    return { db, close: () => connection.close() };
  } catch {
    client?.close();
    throw new MileError("SESSION_UNAVAILABLE", "마일 세션 DB에 접근하지 못했습니다.");
  }
}

export type SessionDatabase = ReturnType<typeof openDatabase>["db"];
