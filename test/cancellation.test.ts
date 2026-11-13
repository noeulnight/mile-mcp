import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { CookieJar } from "tough-cookie";
import { HttpTransport } from "../src/auth/transport.js";
import { publicError } from "../src/errors.js";
import { createServer } from "../src/mcp/server.js";
import { MileApi } from "../src/mile/api.js";
import { API_ORIGIN } from "../src/mile/constants.js";
import { MileService } from "../src/mile/service.js";

async function transport(fetcher: typeof fetch) {
  const saved = {
    version: 1 as const,
    accessToken: "test-token",
    cookieJar: await new CookieJar().serialize(),
  };
  return new HttpTransport({ load: async () => saved, save: async () => {} }, fetcher);
}

test("MCP cancellation validates targets and explicit scope, then sends the observed DELETE payload", async () => {
  const calls: Array<unknown> = [];
  const http = await transport(async (url, options) => {
    assert.equal(String(url), `${API_ORIGIN}/meetings/meeting-reservation`);
    assert.equal(options?.method, "DELETE");
    assert.equal(new Headers(options.headers).get("Authorization"), "Bearer test-token");
    assert.equal(options.redirect, "manual");
    calls.push(JSON.parse(String(options.body)));
    return Response.json({ result: true });
  });
  const server = createServer(new MileService(new MileApi(http)));
  const client = new Client({ name: "cancellation-test", version: "1" });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await server.connect(remote);
  await client.connect(local);
  try {
    const tool = (await client.listTools()).tools.find(
      (entry) => entry.name === "cancel_reservation",
    );
    assert.deepEqual(tool?.annotations, {
      readOnlyHint: false,
      destructiveHint: true,
      idempotentHint: false,
      openWorldHint: true,
    });
    for (const arguments_ of [
      { roomId: "room", reservationId: "reservation" },
      { roomId: "room", reservationId: "reservation", scope: "invalid" },
      { roomId: "room", scope: "THIS" },
      { roomId: "", reservationId: "reservation", scope: "THIS" },
    ]) {
      assert.equal(
        (await client.callTool({ name: "cancel_reservation", arguments: arguments_ })).isError,
        true,
      );
    }
    assert.equal(calls.length, 0);
    for (const scope of ["SINGLE", "THIS", "THIS_AND_FUTURE", "ALL"]) {
      const result = await client.callTool({
        name: "cancel_reservation",
        arguments: {
          roomId: "room",
          reservationId: "reservation",
          googleEventId: "occurrence",
          scope,
        },
      });
      assert.ok(!result.isError);
      assert.deepEqual(calls.at(-1), {
        googleEventId: "occurrence",
        meetingReservationId: "reservation",
        meetingRoomId: "room",
        ...(scope === "SINGLE" ? {} : { editOption: scope }),
      });
    }
    for (const ids of [{ reservationId: "reservation" }, { googleEventId: "occurrence" }]) {
      assert.ok(
        !(
          await client.callTool({
            name: "cancel_reservation",
            arguments: {
              roomId: "room",
              scope: "THIS",
              ...ids,
            },
          })
        ).isError,
      );
      assert.deepEqual(calls.at(-1), {
        googleEventId: "googleEventId" in ids ? ids.googleEventId : "",
        meetingReservationId: "reservationId" in ids ? ids.reservationId : "",
        meetingRoomId: "room",
        editOption: "THIS",
      });
    }
  } finally {
    await client.close();
    await server.close();
    await http.close();
  }
});

test("cancellation never replays failed or ambiguous writes and never exposes upstream secrets", async () => {
  for (const [status, data, code] of [
    [401, {}, "LOGIN_REQUIRED"],
    [403, {}, "PERMISSION_DENIED"],
    [404, {}, "RESERVATION_NOT_FOUND"],
    [409, {}, "API_ERROR"],
    [429, {}, "RATE_LIMITED"],
    [503, {}, "CANCELLATION_OUTCOME_UNKNOWN"],
    [200, null, "CANCELLATION_OUTCOME_UNKNOWN"],
    [200, {}, "CANCELLATION_OUTCOME_UNKNOWN"],
    [200, { result: false }, "CANCELLATION_OUTCOME_UNKNOWN"],
  ] as const) {
    let requests = 0;
    const http = await transport(async (_url, options) => {
      requests++;
      assert.equal(options?.method, "DELETE");
      return Response.json(data, { status });
    });
    await assert.rejects(new MileApi(http).cancelReservation({}), { code });
    assert.equal(requests, 1);
    await http.close();
  }
  let requests = 0;
  const http = await transport(async () => {
    requests++;
    throw new Error("Authorization: DO_NOT_EXPOSE");
  });
  await assert.rejects(new MileApi(http).cancelReservation({}), (error) => {
    const exposed = publicError(error);
    assert.equal(exposed.code, "CANCELLATION_OUTCOME_UNKNOWN");
    assert.ok(!JSON.stringify(exposed).includes("DO_NOT_EXPOSE"));
    return true;
  });
  assert.equal(requests, 1);
  await http.close();
});
