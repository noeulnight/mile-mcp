import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CookieJar } from "tough-cookie";
import { type ApiTransport, HttpTransport } from "../src/auth/transport.js";
import { openDatabase } from "../src/db/database.js";
import { SqliteSessionStore } from "../src/db/session-store.js";
import { createServer } from "../src/mcp/server.js";
import { MileApi } from "../src/mile/api.js";
import { MileService } from "../src/mile/service.js";

const membership = {
  id: "personal-member",
  nickname: "본인",
  role: 0,
  deleteFlag: false,
  workspace: { id: "personal", name: "개인 워크스페이스", image: null, deleteFlag: false },
};

async function connect(service: MileService) {
  const server = createServer(service);
  const client = new Client({ name: "workspace-test", version: "1" });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await server.connect(remote);
  await client.connect(local);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

function resultData(result: Awaited<ReturnType<Client["callTool"]>>) {
  assert.ok(!result.isError, JSON.stringify(result));
  const content = result.content as Array<{ type: string; text: string }>;
  return JSON.parse(content[0]?.text ?? "null");
}

test("MCP workspace selection persists credentials, refreshes in the selected workspace and survives restart", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "mile-workspace-"));
  const path = join(temporary, "mile.db");
  const database = openDatabase(path);
  const store = new SqliteSessionStore(database.db);
  await store.save({
    version: 1,
    accessToken: "old-token",
    cookieJar: await new CookieJar().serialize(),
  });
  const requests: string[] = [];
  const transport = new HttpTransport(store, async (url, options) => {
    const path = new URL(String(url)).pathname;
    requests.push(path);
    if (path === "/users/member/list") {
      return Response.json([membership]);
    }
    if (path === "/auth/member/my") {
      assert.equal(new Headers(options?.headers).get("Authorization"), "Bearer old-token");
      assert.deepEqual(JSON.parse(String(options?.body)), membership);
      return Response.json(
        { accessToken: "selected-token", user: { privateField: "hidden" } },
        {
          headers: { "Set-Cookie": "refresh=selected-cookie; Secure; HttpOnly; Path=/auth" },
        },
      );
    }
    if (path === "/auth/silent-refresh") {
      assert.equal(new Headers(options?.headers).get("Cookie"), "refresh=selected-cookie");
      return Response.json(
        { accessToken: "selected-refreshed-token" },
        {
          headers: {
            "Set-Cookie": "refresh=selected-refreshed-cookie; Secure; HttpOnly; Path=/auth",
          },
        },
      );
    }
    assert.equal(
      new Headers(options?.headers).get("Authorization"),
      "Bearer selected-refreshed-token",
    );
    return Response.json({ meetingRoomList: [], totalPageNumber: 0 });
  });
  const connection = await connect(new MileService(new MileApi(transport)));
  try {
    assert.deepEqual(
      resultData(await connection.client.callTool({ name: "list_workspaces", arguments: {} })),
      {
        workspaces: [
          {
            memberId: membership.id,
            role: 0,
            workspaceId: "personal",
            name: membership.workspace.name,
          },
        ],
      },
    );
    const unavailable = await connection.client.callTool({
      name: "select_workspace",
      arguments: { workspaceId: "unknown" },
    });
    assert.equal(unavailable.isError, true);
    assert.ok(!requests.includes("/auth/member/my"));
    const invalid = await connection.client.callTool({
      name: "select_workspace",
      arguments: { workspaceId: "" },
    });
    assert.equal(invalid.isError, true);
    const selected = await connection.client.callTool({
      name: "select_workspace",
      arguments: { workspaceId: "personal" },
    });
    assert.deepEqual(resultData(selected), {
      selected: true,
      workspaceId: "personal",
      name: membership.workspace.name,
      memberId: membership.id,
    });
    assert.ok(!JSON.stringify(selected).includes("selected-token"));
    assert.ok(!JSON.stringify(selected).includes("hidden"));
    assert.equal((await store.load())?.accessToken, "selected-token");
    await transport.refresh();
    resultData(await connection.client.callTool({ name: "list_meeting_rooms", arguments: {} }));
  } finally {
    await connection.close();
    await transport.close();
    database.close();
  }
  const reopened = openDatabase(path);
  try {
    const saved = await new SqliteSessionStore(reopened.db).load();
    assert.equal(saved?.accessToken, "selected-refreshed-token");
    assert.ok(saved);
    const jar = await CookieJar.deserialize(saved.cookieJar);
    assert.equal(
      await jar.getCookieString("https://alb-tablet.mile.im/auth/silent-refresh"),
      "refresh=selected-refreshed-cookie",
    );
  } finally {
    reopened.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("failed and ambiguous selections never retry or replace the persisted token and cookies", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "mile-workspace-failure-"));
  const database = openDatabase(join(temporary, "mile.db"));
  const store = new SqliteSessionStore(database.db);
  const initial = {
    version: 1 as const,
    accessToken: "original-token",
    cookieJar: await new CookieJar().serialize(),
  };
  await store.save(initial);
  try {
    for (const [status, code] of [
      [401, "LOGIN_REQUIRED"],
      [403, "WORKSPACE_NOT_AVAILABLE"],
      [404, "WORKSPACE_NOT_AVAILABLE"],
      [429, "RATE_LIMITED"],
      [503, "WORKSPACE_SELECTION_UNKNOWN"],
      [200, "WORKSPACE_SELECTION_UNKNOWN"],
      [0, "WORKSPACE_SELECTION_UNKNOWN"],
    ] as const) {
      let calls = 0;
      const transport = new HttpTransport(store, async () => {
        calls++;
        if (status === 0) {
          throw new Error("DO_NOT_EXPOSE");
        }
        return Response.json(
          { unexpected: "DO_NOT_EXPOSE" },
          { status, headers: { "Set-Cookie": "refresh=uncommitted-cookie; Secure; Path=/auth" } },
        );
      });
      await assert.rejects(new MileApi(transport).selectWorkspace(membership), (error: unknown) => {
        assert.equal((error as { code: string }).code, code);
        assert.ok(!String(error).includes("DO_NOT_EXPOSE"));
        return true;
      });
      await transport.close();
      assert.equal(calls, 1);
      assert.deepEqual(await store.load(), initial);
    }
  } finally {
    database.close();
    await rm(temporary, { recursive: true, force: true });
  }
});

test("workspace selection cannot interleave with booking preflight and creation across MCP connections", async () => {
  const checking = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const paths: string[] = [];
  const transport: ApiTransport = {
    async send(path) {
      paths.push(path);
      if (path === "/meetings/meeting-reservation/list") {
        checking.resolve();
        await release.promise;
        return { status: 200, data: [{ id: "room", meetingReservations: [] }] };
      }
      if (path === "/users/member/list") {
        return { status: 200, data: [membership] };
      }
      return { status: 200, data: { result: { id: "created" } } };
    },
    async refresh() {},
    async close() {},
  };
  const service = new MileService(new MileApi(transport));
  const first = await connect(service);
  const second = await connect(service);
  try {
    const booking = first.client.callTool({
      name: "create_reservation",
      arguments: {
        roomId: "room",
        date: "2030-11-11",
        startTime: "21:00",
        endTime: "21:30",
        title: "테스트",
        attendees: [{ isVisitor: false, memberId: "self", visitorEmail: "self@example.com" }],
      },
    });
    await checking.promise;
    const selection = second.client.callTool({
      name: "select_workspace",
      arguments: { workspaceId: "personal" },
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(paths, ["/meetings/meeting-reservation/list"]);
    release.resolve();
    resultData(await booking);
    resultData(await selection);
    assert.deepEqual(paths, [
      "/meetings/meeting-reservation/list",
      "/meetings/meeting-reservation",
      "/users/member/list",
      "/auth/member/my",
    ]);
  } finally {
    release.resolve();
    await first.close();
    await second.close();
  }
});

test("malformed or empty workspace lists never send a selection request", async () => {
  for (const data of [{}, [{ id: "member", role: 0 }], []]) {
    const transport: ApiTransport = {
      async send(path) {
        assert.equal(path, "/users/member/list");
        return { status: 200, data };
      },
      async refresh() {},
      async close() {},
    };
    await assert.rejects(
      new MileService(new MileApi(transport)).selectWorkspace({ workspaceId: "personal" }),
      {
        code:
          Array.isArray(data) && data.length === 0
            ? "WORKSPACE_NOT_AVAILABLE"
            : "API_FORMAT_CHANGED",
      },
    );
  }
});
