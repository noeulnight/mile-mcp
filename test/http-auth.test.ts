import assert from "node:assert/strict";
import { test } from "node:test";
import { CookieJar } from "tough-cookie";
import type { SavedSession, SessionStore } from "../src/auth/session.js";
import { HttpTransport } from "../src/auth/transport.js";
import { MileApi } from "../src/mile/api.js";
import { API_ORIGIN } from "../src/mile/constants.js";

class MemoryStore implements SessionStore {
  constructor(public saved: SavedSession | null) {}
  async load() {
    return structuredClone(this.saved);
  }
  async save(session: SavedSession) {
    this.saved = structuredClone(session);
  }
}

async function storedSession() {
  const jar = new CookieJar();
  await jar.setCookie(
    "refresh=initial-cookie; Secure; HttpOnly; Path=/auth",
    `${API_ORIGIN}/auth/silent-refresh`,
  );
  await jar.setCookie("unrelated=google-cookie; Secure; Path=/", "https://accounts.google.com/");
  return { version: 1 as const, accessToken: "initial-token", cookieJar: await jar.serialize() };
}

test("HTTP auth refreshes and persists rotated cookies and token across transport restarts", async () => {
  const store = new MemoryStore(await storedSession());
  let refreshCount = 0,
    reads = 0;
  const fetcher: typeof fetch = async (url, options) => {
    assert.equal(options?.redirect, "manual");
    const path = new URL(String(url)).pathname;
    const headers = new Headers(options?.headers);
    assert.ok(!headers.get("Cookie")?.includes("google-cookie"));
    if (path === "/auth/silent-refresh") {
      refreshCount++;
      assert.equal(options?.method, "POST");
      assert.equal(headers.get("Authorization"), null);
      assert.equal(headers.get("Cookie"), "refresh=initial-cookie");
      return new Response(JSON.stringify({ accessToken: "rotated-token" }), {
        status: 200,
        headers: { "Set-Cookie": "refresh=rotated-cookie; Secure; HttpOnly; Path=/auth" },
      });
    }
    reads++;
    // Path-scoped refresh cookies must not accompany ordinary read requests.
    assert.equal(headers.get("Cookie"), null);
    if (headers.get("Authorization") === "Bearer initial-token") {
      return new Response("{}", { status: 401 });
    }
    assert.equal(headers.get("Authorization"), "Bearer rotated-token");
    return new Response(JSON.stringify({ success: true }));
  };
  const first = new HttpTransport(store, fetcher);
  assert.deepEqual(await new MileApi(first).read("/users/info"), { success: true });
  await first.close();
  const second = new HttpTransport(store, fetcher);
  assert.deepEqual(await new MileApi(second).read("/users/info"), { success: true });
  assert.equal(refreshCount, 1);
  assert.equal(reads, 3);
  assert.equal(store.saved?.accessToken, "rotated-token");
  assert.ok(store.saved);
  const persisted = await CookieJar.deserialize(store.saved.cookieJar);
  assert.equal(
    await persisted.getCookieString(`${API_ORIGIN}/auth/silent-refresh`),
    "refresh=rotated-cookie",
  );
});

test("expired refresh sessions require login; transient errors preserve the saved session", async () => {
  for (const [status, code] of [
    [409, "LOGIN_REQUIRED"],
    [503, "API_ERROR"],
  ] as const) {
    const store = new MemoryStore(await storedSession());
    const fetcher: typeof fetch = async () => new Response("{}", { status });
    await assert.rejects(new HttpTransport(store, fetcher).refresh(), { code });
    assert.equal(store.saved?.accessToken, "initial-token");
  }
});

test("parallel refresh calls share one request and persist its replacement token", async () => {
  const store = new MemoryStore(await storedSession());
  let requests = 0;
  const fetcher: typeof fetch = async () => {
    requests++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    return new Response(JSON.stringify({ accessToken: "new-token" }));
  };
  const transport = new HttpTransport(store, fetcher);
  await Promise.all([transport.refresh(), transport.refresh(), transport.refresh()]);
  assert.equal(requests, 1);
  assert.equal(store.saved?.accessToken, "new-token");
});

test("missing sessions and foreign origins fail before sending credentials", async () => {
  let requests = 0;
  const fetcher: typeof fetch = async () => {
    requests++;
    return new Response("{}");
  };
  const transport = new HttpTransport(new MemoryStore(null), fetcher);
  await assert.rejects(transport.send("/users/info"), { code: "LOGIN_REQUIRED" });
  await assert.rejects(transport.send("https://example.com/"), { code: "ENDPOINT_NOT_ALLOWED" });
  await assert.rejects(transport.send("//example.com/"), { code: "ENDPOINT_NOT_ALLOWED" });
  assert.equal(requests, 0);
});

test("a running transport immediately adopts a newly logged-in session", async () => {
  const store = new MemoryStore(await storedSession());
  const seen: Array<string | null> = [];
  const fetcher: typeof fetch = async (_url, options) => {
    seen.push(new Headers(options?.headers).get("Authorization"));
    return new Response("{}");
  };
  const transport = new HttpTransport(store, fetcher);
  await transport.send("/users/info");
  assert.ok(store.saved);
  await store.save({ ...store.saved, accessToken: "relogged-in-token" });
  await transport.send("/users/info");
  assert.deepEqual(seen, ["Bearer initial-token", "Bearer relogged-in-token"]);
});

test("overlapping reads and refresh cannot overwrite rotated token or cookies", async () => {
  const store = new MemoryStore(await storedSession());
  const seen: string[] = [];
  const fetcher: typeof fetch = async (url) => {
    const path = new URL(String(url)).pathname;
    seen.push(path);
    if (path === "/auth/silent-refresh") {
      assert.deepEqual(seen, ["/users/info", "/auth/silent-refresh"]);
      return new Response(JSON.stringify({ accessToken: "rotated-token" }), {
        headers: { "Set-Cookie": "refresh=rotated; Secure; HttpOnly; Path=/auth" },
      });
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    return new Response("{}", { headers: { "Set-Cookie": "ordinary=value; Secure; Path=/" } });
  };
  const transport = new HttpTransport(store, fetcher);
  await Promise.all([
    transport.send("/users/info"),
    transport.refresh(),
    transport.send("/members/my/info"),
  ]);
  assert.equal(store.saved?.accessToken, "rotated-token");
  assert.ok(store.saved);
  const jar = await CookieJar.deserialize(store.saved.cookieJar);
  assert.match(await jar.getCookieString(`${API_ORIGIN}/auth/silent-refresh`), /refresh=rotated/);
  assert.match(await jar.getCookieString(`${API_ORIGIN}/users/info`), /ordinary=value/);
});
