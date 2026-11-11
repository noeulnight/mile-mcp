import assert from "node:assert/strict";
import { test } from "node:test";
import { CookieJar } from "tough-cookie";
import { SessionRefresher } from "../src/auth/refresher.js";
import type { SavedSession, SessionStore } from "../src/auth/session.js";
import { MileError } from "../src/errors.js";

class MemoryStore implements SessionStore {
  constructor(public saved: SavedSession) {}
  async load() {
    return this.saved;
  }
  async save(session: SavedSession) {
    this.saved = session;
  }
}
const token = (expires: number) =>
  `header.${Buffer.from(JSON.stringify({ exp: expires })).toString("base64url")}.signature`;
const session = async (accessToken: string): Promise<SavedSession> => ({
  version: 1,
  accessToken,
  cookieJar: await new CookieJar().serialize(),
});

test("a token near expiration refreshes without any API call, then the renewed token is reused", async () => {
  const now = Math.floor(Date.now() / 1000);
  const store = new MemoryStore(await session(token(now + 60)));
  let refreshes = 0;
  const refresher = new SessionRefresher(
    {
      async refresh() {
        refreshes++;
        await store.save(await session(token(now + 3600)));
      },
    },
    store,
    () => {},
  );
  await refresher.check();
  await refresher.check();
  assert.equal(refreshes, 1);
});

test("a valid token is not refreshed prematurely", async () => {
  const store = new MemoryStore(await session(token(Math.floor(Date.now() / 1000) + 3600)));
  let refreshes = 0;
  await new SessionRefresher(
    {
      async refresh() {
        refreshes++;
      },
    },
    store,
    () => {},
  ).check();
  assert.equal(refreshes, 0);
});

test("expired login stops retrying until the session is replaced; temporary errors retry", async () => {
  const store = new MemoryStore(await session(token(1)));
  let calls = 0;
  const logs: object[] = [];
  const refresher = new SessionRefresher(
    {
      async refresh() {
        calls++;
        if (calls === 1) {
          throw new MileError("LOGIN_REQUIRED", "login required");
        }
      },
    },
    store,
    (message) => logs.push(message),
  );
  await refresher.check();
  await refresher.check();
  assert.equal(calls, 1);
  await store.save(await session(token(2)));
  await refresher.check();
  assert.equal(calls, 2);
  assert.equal(logs.length, 2);

  let transientCalls = 0;
  const retrying = new SessionRefresher(
    {
      async refresh() {
        transientCalls++;
        throw new MileError("API_ERROR", "temporary");
      },
    },
    store,
    () => {},
  );
  await retrying.check();
  await retrying.check();
  assert.equal(transientCalls, 2);
});

test("opaque tokens refresh at a bounded interval and stopping waits for startup work", async (context) => {
  let now = 1_000_000;
  context.mock.method(Date, "now", () => now);
  const store = new MemoryStore(await session("opaque-token"));
  let calls = 0;
  const refresher = new SessionRefresher(
    {
      async refresh() {
        calls++;
      },
    },
    store,
    () => {},
  );
  refresher.start();
  await refresher.stop();
  assert.equal(calls, 1);
  await refresher.check();
  assert.equal(calls, 1);
  now += 15 * 60_000;
  await refresher.check();
  assert.equal(calls, 2);
});
