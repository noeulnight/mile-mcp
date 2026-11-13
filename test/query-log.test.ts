import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/mcp/server.js";
import { MileApi } from "../src/mile/api.js";
import { MileService } from "../src/mile/service.js";

test("queries log outcome and duration without arguments, results or credentials", async (t) => {
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
    assert.ok(!lines.join("\n").includes("PRIVATE_"));
  } finally {
    await client.close();
    await server.close();
  }
});
