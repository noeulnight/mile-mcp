import assert from "node:assert/strict";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { DateTime } from "luxon";
import { z } from "zod";
import type { ApiTransport } from "../src/auth/transport.js";
import type { MileError } from "../src/errors.js";
import { createServer } from "../src/mcp/server.js";
import { MileApi } from "../src/mile/api.js";
import { makeRRule, repeatSchema } from "../src/mile/recurrence.js";
import { createInput, MileService } from "../src/mile/service.js";

class Transport implements ApiTransport {
  calls: Array<{ path: string; body: Record<string, unknown> | undefined }> = [];
  refreshes = 0;
  constructor(
    private readonly handler: (
      path: string,
      body: Record<string, unknown> | undefined,
    ) => { status: number; data: unknown } = (path) => ({
      status: 200,
      data: path.endsWith("/list")
        ? [{ id: "room", meetingReservations: [] }]
        : path.endsWith("check-duplication")
          ? { available: ["2030-11-11T12:00:00Z", "2030-11-12T12:00:00Z"], unavailable: [] }
          : { result: { id: "created" } },
    }),
  ) {}
  async send(path: string, body?: unknown) {
    this.calls.push({ path, body: body as Record<string, unknown> | undefined });
    return this.handler(path, body as Record<string, unknown> | undefined);
  }
  async refresh() {
    this.refreshes++;
  }
  async close() {}
}
const input = {
  roomId: "room",
  date: "2030-11-11",
  startTime: "21:00",
  endTime: "21:30",
  title: "예약 테스트",
  attendees: [{ isVisitor: false as const, memberId: "self", visitorEmail: "self@example.com" }],
};
const repeat = { frequency: "daily", end: { type: "count", count: 2 } };
const parsed = (overrides = {}) => z.object(createInput).parse({ ...input, ...overrides });

test("recurrence covers weekly intervals, weekdays and both monthly modes with Korean UNTIL boundaries", () => {
  const start = DateTime.fromISO("2026-11-11T21:00", { zone: "Asia/Seoul" });
  for (const [options, expected] of [
    [{ frequency: "daily" }, "RRULE:FREQ=DAILY;COUNT=2"],
    [
      { frequency: "weekly", weekdays: ["MO", "WE"], interval: 2 },
      "RRULE:FREQ=WEEKLY;BYDAY=MO,WE;INTERVAL=2;COUNT=2",
    ],
    [{ frequency: "weekdays" }, "RRULE:FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR;COUNT=2"],
    [{ frequency: "monthly" }, "RRULE:FREQ=MONTHLY;COUNT=2;BYDAY=2WE"],
    [
      { frequency: "monthly", monthlyMode: "day_of_month" },
      "RRULE:FREQ=MONTHLY;COUNT=2;BYMONTHDAY=11",
    ],
  ] as const) {
    assert.equal(
      makeRRule(repeatSchema.parse({ end: { type: "count", count: 2 }, ...options }), start),
      expected,
    );
  }
  assert.equal(
    makeRRule(
      repeatSchema.parse({ frequency: "daily", end: { type: "until", date: "2026-11-12" } }),
      start,
    ),
    "RRULE:FREQ=DAILY;UNTIL=20261112T145959Z",
  );
  assert.throws(
    () =>
      makeRRule(
        repeatSchema.parse({ frequency: "daily", end: { type: "until", date: "2026-11-10" } }),
        start,
      ),
    { code: "INVALID_RANGE" },
  );
  for (const options of [
    { frequency: "weekly" },
    { ...repeat, interval: 0 },
    { ...repeat, end: { type: "count", count: 201 } },
  ]) {
    assert.equal(repeatSchema.safeParse(options).success, false);
  }
});

test("creation maps attendees, options and Korean times to a single upstream request", async () => {
  const transport = new Transport();
  const service = new MileService(new MileApi(transport));
  await service.createReservation(
    parsed({
      memo: "메모",
      isPrivate: true,
      guestsCanModify: true,
      attendees: [...input.attendees, { isVisitor: true, visitorEmail: "guest@example.com" }],
    }),
  );
  assert.deepEqual(
    transport.calls.map((call) => call.path),
    ["/meetings/meeting-reservation/list", "/meetings/meeting-reservation"],
  );
  assert.deepEqual(transport.calls[1]?.body, {
    title: input.title,
    memo: "메모",
    isPrivate: true,
    guestsCanModify: true,
    meetingRoomId: "room",
    rsvStartTime: "2030-11-11T12:00:00.000Z",
    rsvEndTime: "2030-11-11T12:30:00.000Z",
    reservationAttendees: [
      ...input.attendees,
      { isVisitor: true, visitorEmail: "guest@example.com" },
    ],
    exceptedAttendeeLimit: false,
  });
});

test("repeating reservations are checked before creation; partial conflicts never create a subset", async () => {
  const success = new Transport();
  await new MileService(new MileApi(success)).createReservation(parsed({ repeat }));
  assert.equal(success.calls[0]?.path, "/meetings/recurring-reservation/check-duplication");
  assert.equal(success.calls[0]?.body?.rrule, "RRULE:FREQ=DAILY;COUNT=2");
  assert.equal(success.calls[1]?.body?.rrule, success.calls[0]?.body?.rrule);
  const blocked = new Transport(() => ({
    status: 200,
    data: { available: ["2030-11-11"], unavailable: ["2030-11-12"] },
  }));
  await assert.rejects(
    new MileService(new MileApi(blocked)).createReservation(parsed({ repeat })),
    { code: "RESERVATION_CONFLICT" },
  );
  assert.equal(blocked.calls.length, 1);
});

test("missing calendars, invalid recurrence responses and overlapping reservations fail before writing", async () => {
  for (const [data, code] of [
    [[], "API_FORMAT_CHANGED"],
    [
      [
        {
          id: "room",
          meetingReservations: [
            { startTime: "2030-11-11T12:00:00Z", endTime: "2030-11-11T12:30:00Z" },
          ],
        },
      ],
      "RESERVATION_CONFLICT",
    ],
  ] as const) {
    const transport = new Transport(() => ({ status: 200, data }));
    await assert.rejects(new MileService(new MileApi(transport)).createReservation(parsed()), {
      code,
    });
    assert.equal(transport.calls.length, 1);
  }
  for (const data of [
    {},
    { available: [], unavailable: [] },
    { available: ["bad-date", "2030-11-12"], unavailable: [] },
    { available: ["2030-11-11"], unavailable: [] },
  ]) {
    const transport = new Transport(() => ({ status: 200, data }));
    await assert.rejects(
      new MileService(new MileApi(transport)).createReservation(parsed({ repeat })),
      { code: "API_FORMAT_CHANGED" },
    );
    assert.equal(transport.calls.length, 1);
  }
  const adjacent = new Transport((path) => ({
    status: 200,
    data: path.endsWith("/list")
      ? [
          {
            id: "room",
            meetingReservations: [
              { startTime: "2030-11-11T11:30:00Z", endTime: "2030-11-11T12:00:00Z" },
            ],
          },
        ]
      : { result: true },
  }));
  assert.equal(
    (await new MileService(new MileApi(adjacent)).createReservation(parsed())).created,
    true,
  );
});

test("invalid time ranges and duplicate recipients are rejected without upstream calls", async () => {
  const transport = new Transport();
  const service = new MileService(new MileApi(transport));
  await assert.rejects(service.createReservation(parsed({ endTime: "20:30" })), {
    code: "INVALID_RANGE",
  });
  await assert.rejects(
    service.createReservation(parsed({ attendees: [input.attendees[0], input.attendees[0]] })),
    { code: "INVALID_INPUT" },
  );
  assert.equal(transport.calls.length, 0);
});

test("booking writes are never replayed, including 401, conflicts, 5xx and uncertain responses", async () => {
  for (const [status, data, code] of [
    [401, {}, "LOGIN_REQUIRED"],
    [403, {}, "PERMISSION_DENIED"],
    [409, {}, "RESERVATION_CONFLICT"],
    [429, {}, "RATE_LIMITED"],
    [400, { secret: "DO_NOT_EXPOSE" }, "API_ERROR"],
    [500, {}, "RESERVATION_OUTCOME_UNKNOWN"],
    [200, null, "RESERVATION_OUTCOME_UNKNOWN"],
    [200, {}, "RESERVATION_OUTCOME_UNKNOWN"],
  ] as const) {
    const transport = new Transport(() => ({ status, data }));
    await assert.rejects(new MileApi(transport).createReservation({}), (error) => {
      assert.equal((error as MileError).code, code);
      assert.ok(!(error as Error).message.includes("DO_NOT_EXPOSE"));
      return true;
    });
    assert.equal(transport.calls.length, 1);
    assert.equal(transport.refreshes, 0);
  }
  const transport = new Transport(() => {
    throw new Error("Authorization: DO_NOT_EXPOSE");
  });
  await assert.rejects(new MileApi(transport).createReservation({}), {
    code: "RESERVATION_OUTCOME_UNKNOWN",
  });
  assert.equal(transport.calls.length, 1);
});

test("member search uses the current workspace's paginated member API", async () => {
  const transport = new Transport(() => ({
    status: 200,
    data: { memberList: [{ id: "self", nickname: "본인", email: "self@example.com" }] },
  }));
  await new MileService(new MileApi(transport)).searchMembers({ query: "본인", page: 2 });
  assert.deepEqual(transport.calls, [
    { path: "/members", body: { nowPageNumber: 2, role: null, searchWord: "본인" } },
  ]);
});

test("real MCP calls expose and validate all booking tools without contacting Mile", async () => {
  const transport = new Transport((path) => ({
    status: 200,
    data:
      path === "/members"
        ? { memberList: [{ id: "self", email: "self@example.com" }] }
        : path.endsWith("/list")
          ? [{ id: "room", meetingReservations: [] }]
          : { result: true },
  }));
  const server = createServer(new MileService(new MileApi(transport)));
  const client = new Client({ name: "booking-test", version: "1" });
  const [local, remote] = InMemoryTransport.createLinkedPair();
  await server.connect(remote);
  await client.connect(local);
  try {
    assert.ok(
      !(await client.callTool({ name: "search_members", arguments: { query: "본인" } })).isError,
    );
    assert.ok(
      !(await client.callTool({ name: "create_reservation", arguments: { ...input } })).isError,
    );
    const count = transport.calls.length;
    for (const overrides of [
      { title: "" },
      { attendees: [] },
      { repeat: { frequency: "weekly", end: { type: "count", count: 2 } } },
    ]) {
      assert.equal(
        (
          await client.callTool({
            name: "create_reservation",
            arguments: { ...input, ...overrides },
          })
        ).isError,
        true,
      );
    }
    assert.equal(transport.calls.length, count);
  } finally {
    await client.close();
    await server.close();
  }
});
