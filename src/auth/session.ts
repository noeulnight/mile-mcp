import { CookieJar, type SerializedCookieJar } from "tough-cookie";
import { z } from "zod";
import { MileError } from "../errors.js";

export interface SavedSession {
  version: 1;
  accessToken: string;
  cookieJar: SerializedCookieJar;
}

export interface SessionStore {
  load(): Promise<SavedSession | null>;
  save(session: SavedSession): Promise<void>;
}

const savedSessionSchema = z.object({
  version: z.literal(1),
  accessToken: z.string().min(1),
  cookieJar: z.record(z.string(), z.unknown()),
});

export async function parseSession(value: string): Promise<SavedSession> {
  try {
    const session = savedSessionSchema.parse(JSON.parse(value)) as SavedSession;
    await CookieJar.deserialize(session.cookieJar);
    return session;
  } catch {
    throw new MileError(
      "AUTH_FORMAT_CHANGED",
      "세션 형식이 올바르지 않습니다. 유효한 세션을 가져와 주세요.",
    );
  }
}
