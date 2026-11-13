import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CookieJar } from "tough-cookie";
import { HttpTransport } from "../src/auth/transport.js";
import { createServer } from "../src/mcp/server.js";
import { MileApi } from "../src/mile/api.js";
import { MileService } from "../src/mile/service.js";

test("queries log parameters and outcome without results or credentials", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "error", (line: string) => lines.push(line));
  const service = new MileService(
    new MileApi({
      send: async (path) =>
        path === "/users/member/list"
          ? {
              status: 200,
              data: [
                {
                  id: "member",
                  role: 1,
                  workspace: { id: "workspace", name: "PRIVATE_WORKSPACE" },
                },
              ],
            }
          : { status: 403, data: { token: "PRIVATE_TOKEN" } },
      refresh: async () => {},
      close: async () => {},
    }),
  );
  t.mock.method(service, "selectWorkspace", async () => ({
    selected: true,
    workspaceId: "workspace",
    name: "PRIVATE_WORKSPACE",
  }));
  const server = createServer(service);
  const client = new Client({ name: "query-log-test", version: "1" });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await server.connect(remote);
  await client.connect(local);
  try {
    assert.ok(!(await client.callTool({ name: "list_workspaces", arguments: {} })).isError);
    assert.equal(
      (
        await client.callTool({
          name: "search_members",
          arguments: { query: "PRIVATE_EMAIL@example.com" },
        })
      ).isError,
      true,
    );
    assert.ok(
      !(
        await client.callTool({ name: "select_workspace", arguments: { workspaceId: "workspace" } })
      ).isError,
    );
    assert.equal(lines.length, 2);
    const logs = lines.map((line) => JSON.parse(line));
    assert.deepEqual(
      logs.map(({ tool, success, errorCode }) => ({ tool, success, errorCode })),
      [
        { tool: "list_workspaces", success: true, errorCode: undefined },
        { tool: "search_members", success: false, errorCode: "PERMISSION_DENIED" },
      ],
    );
    for (const log of logs) {
      assert.equal(log.event, "mcp_query");
      assert.ok(Number.isFinite(Date.parse(log.timestamp)));
      assert.ok(Number.isInteger(log.durationMs) && log.durationMs >= 0);
    }
    assert.deepEqual(logs[0].params, {});
    assert.deepEqual(logs[1].params, { query: "PRIVATE_EMAIL@example.com", page: 1 });
    assert.ok(!lines.join("\n").includes("PRIVATE_WORKSPACE"));
    assert.ok(!lines.join("\n").includes("PRIVATE_TOKEN"));
  } finally {
    await client.close();
    await server.close();
  }
});

test("Mile query logs record each actual attempt including retries, without auth or writes", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "error", (line: string) => lines.push(line));
  let saved = {
    version: 1 as const,
    accessToken: "PRIVATE_TOKEN",
    cookieJar: await new CookieJar().serialize(),
  };
  let roomRequests = 0;
  const http = new HttpTransport(
    {
      load: async () => saved,
      save: async (session) => {
        saved = session;
      },
    },
    async (url) => {
      const path = new URL(String(url)).pathname;
      if (path === "/auth/silent-refresh") {
        return Response.json({ accessToken: "PRIVATE_REFRESHED_TOKEN" });
      }
      if (path === "/users/info") {
        throw new Error("PRIVATE_ERROR");
      }
      if (path === "/meetings/meeting-room/list") {
        roomRequests++;
        return Response.json(
          { meetingRoomList: [{ name: "PRIVATE_RESULT" }] },
          { status: roomRequests === 1 ? 401 : 200 },
        );
      }
      return Response.json({ result: true });
    },
  );
  try {
    const params = { meetingRoomIdList: ["room"], nowPageNumber: 2 };
    await new MileApi(http).read("/meetings/meeting-room/list", params);
    await http.send("/meetings/meeting-reservation", { title: "PRIVATE_TITLE" });
    await http.send(
      "/meetings/meeting-reservation",
      { meetingReservationId: "reservation" },
      "DELETE",
    );
    await assert.rejects(http.send("/users/info"));
    const missingSession = new HttpTransport(
      { load: async () => null, save: async () => {} },
      async () => {
        assert.fail("No session must not send a request");
      },
    );
    await assert.rejects(missingSession.send("/users/info"), { code: "LOGIN_REQUIRED" });
    await missingSession.close();
    const logs = lines.map((line) => JSON.parse(line));
    assert.equal(logs.length, 3);
    assert.deepEqual(
      logs.slice(0, 2).map(({ path, method, params, httpStatus, success }) => ({
        path,
        method,
        params,
        httpStatus,
        success,
      })),
      [
        {
          path: "/meetings/meeting-room/list",
          method: "POST",
          params,
          httpStatus: 401,
          success: false,
        },
        {
          path: "/meetings/meeting-room/list",
          method: "POST",
          params,
          httpStatus: 200,
          success: true,
        },
      ],
    );
    assert.equal(logs[2].path, "/users/info");
    assert.equal(logs[2].method, "GET");
    assert.equal(logs[2].success, false);
    assert.equal(logs[2].errorCode, "UNEXPECTED_ERROR");
    assert.equal(logs[2].httpStatus, undefined);
    for (const log of logs) {
      assert.equal(log.event, "mile_query");
      assert.ok(Number.isFinite(Date.parse(log.timestamp)));
      assert.ok(Number.isInteger(log.durationMs) && log.durationMs >= 0);
    }
    assert.deepEqual(logs[0].response, { meetingRoomList: [{ name: "PRIVATE_RESULT" }] });
    assert.deepEqual(logs[1].response, { meetingRoomList: [{ name: "PRIVATE_RESULT" }] });
    assert.equal(logs[2].response, undefined);
    for (const secret of [
      "PRIVATE_TOKEN",
      "PRIVATE_REFRESHED_TOKEN",
      "PRIVATE_TITLE",
      "PRIVATE_ERROR",
    ]) {
      assert.ok(!lines.join("\n").includes(secret));
    }
  } finally {
    await http.close();
  }
});

test("Mile response logging preserves data while masking nested credentials in success and error bodies", async (t) => {
  const lines: string[] = [];
  t.mock.method(console, "error", (line: string) => lines.push(line));
  const saved = {
    version: 1 as const,
    accessToken: "SENSITIVE_CURRENT_TOKEN",
    cookieJar: await new CookieJar().serialize(),
  };
  const body = {
    memberList: [{ id: "member-1", nickname: "테스트 사용자", email: "test@example.com" }],
    accessToken: "SENSITIVE_ACCESS",
    refresh_token: "SENSITIVE_REFRESH",
    nested: [
      {
        Authorization: "SENSITIVE_AUTH",
        "Set-Cookie": "SENSITIVE_COOKIE",
        cookieJar: { cookies: ["SENSITIVE_JAR"] },
        api_key: "SENSITIVE_KEY",
        clientSecret: "SENSITIVE_SECRET",
        password: "SENSITIVE_PASSWORD",
      },
    ],
    message: "Upstream echoed SENSITIVE_CURRENT_TOKEN",
  };
  const http = new HttpTransport({ load: async () => saved, save: async () => {} }, async () =>
    Response.json(body, { status }),
  );
  let status = 200;
  try {
    for (status of [200, 403]) {
      const result = await http.send("/members", { searchWord: "테스트" });
      assert.deepEqual(result.data, body);
    }
    const logs = lines.map((line) => JSON.parse(line));
    for (const log of logs) {
      assert.deepEqual(log.response.memberList, body.memberList);
      assert.equal(log.response.accessToken, "[REDACTED]");
      assert.equal(log.response.refresh_token, "[REDACTED]");
      assert.deepEqual(log.response.nested, [
        {
          Authorization: "[REDACTED]",
          "Set-Cookie": "[REDACTED]",
          cookieJar: "[REDACTED]",
          api_key: "[REDACTED]",
          clientSecret: "[REDACTED]",
          password: "[REDACTED]",
        },
      ]);
      assert.equal(log.response.message, "Upstream echoed [REDACTED]");
    }
    assert.equal(logs[0].httpStatus, 200);
    assert.equal(logs[1].httpStatus, 403);
    assert.ok(!lines.join("\n").includes("SENSITIVE_"));
  } finally {
    await http.close();
  }
});
