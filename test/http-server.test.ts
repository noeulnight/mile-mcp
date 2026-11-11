import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { CookieJar } from "tough-cookie";
import { createApplication } from "../src/app.js";

test("the HTTP MCP supports real initialization, tool discovery and room queries", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "mile-app-"));
  const config = { host: "127.0.0.1", port: 0, databasePath: join(temporary, "mile.db") };
  const token = `header.${Buffer.from(JSON.stringify({ exp: Date.now() / 1000 + 3600 })).toString("base64url")}.signature`;
  const app = createApplication(config, async (_url, options) => {
    assert.equal(new Headers(options?.headers).get("Authorization"), `Bearer ${token}`);
    return Response.json({ meetingRoomList: [], totalPageNumber: 0 });
  });
  await app.store.save({
    version: 1,
    accessToken: token,
    cookieJar: await new CookieJar().serialize(),
  });
  const address = await app.start("http");
  assert.ok(address && typeof address !== "string");
  const url = `http://127.0.0.1:${address.port}`;
  const client = new Client({ name: "http-test", version: "1.0.0" });
  try {
    assert.equal((await fetch(`${url}/health`)).status, 200);
    await client.connect(new StreamableHTTPClientTransport(new URL(`${url}/mcp`)));
    assert.equal((await client.listTools()).tools.length, 9);
    const result = await client.callTool({ name: "list_meeting_rooms", arguments: {} });
    assert.ok(!result.isError);
    assert.equal((await fetch(`${url}/mcp`)).status, 405);
  } finally {
    await client.close();
    await Promise.all([app.close(), app.close()]);
    await assert.rejects(app.store.load(), { code: "SESSION_UNAVAILABLE" });
    await assert.rejects(fetch(`${url}/health`));
    const reopened = createApplication(config);
    try {
      assert.equal((await reopened.store.load())?.accessToken, token);
    } finally {
      await reopened.close();
      await rm(temporary, { recursive: true, force: true });
    }
  }
});

test("a failed HTTP startup closes its database without starting authentication refresh", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "mile-start-failure-"));
  const app = createApplication(
    { host: "invalid host", port: 8000, databasePath: join(temporary, "mile.db") },
    async () => {
      assert.fail("startup failure must not send authentication requests");
    },
  );
  try {
    await assert.rejects(app.start("http"));
    await app.close();
    await assert.rejects(app.store.load(), { code: "SESSION_UNAVAILABLE" });
  } finally {
    await app.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
