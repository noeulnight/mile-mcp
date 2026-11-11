import { eq } from "drizzle-orm";
import { parseSession, type SavedSession, type SessionStore } from "../auth/session.js";
import { MileError } from "../errors.js";
import type { SessionDatabase } from "./database.js";
import { sessions } from "./schema.js";

export class SqliteSessionStore implements SessionStore {
  constructor(private readonly db: SessionDatabase) {}

  async load(): Promise<SavedSession | null> {
    try {
      const row = this.db.select().from(sessions).where(eq(sessions.id, 1)).get();
      if (!row) {
        return null;
      }
      return await parseSession(
        JSON.stringify({
          version: 1,
          accessToken: row.accessToken,
          cookieJar: row.cookieJar,
        }),
      );
    } catch (error) {
      if (error instanceof MileError) {
        throw error;
      }
      throw new MileError("SESSION_UNAVAILABLE", "마일 세션 DB를 읽지 못했습니다.");
    }
  }

  async save(session: SavedSession): Promise<void> {
    try {
      const values = {
        accessToken: session.accessToken,
        cookieJar: session.cookieJar,
        updatedAt: new Date().toISOString(),
      };
      // A single upsert commits the rotated token and cookies atomically.
      this.db
        .insert(sessions)
        .values({ id: 1, ...values })
        .onConflictDoUpdate({ target: sessions.id, set: values })
        .run();
    } catch {
      throw new MileError("SESSION_UNAVAILABLE", "마일 세션 DB에 저장하지 못했습니다.");
    }
  }
}
