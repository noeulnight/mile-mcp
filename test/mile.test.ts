import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { ApiTransport } from "../src/auth/transport.js";
import { publicError } from "../src/errors.js";
import { createServer } from "../src/mcp/server.js";
import { MileApi } from "../src/mile/api.js";
import { MileService } from "../src/mile/service.js";

class FakeTransport implements ApiTransport {
  requests: Array<{ path: string; body: unknown }> = [];
  refreshes = 0;
  constructor(
    private readonly handler: (
      path: string,
      body: Record<string, unknown> | undefined,
      number: number,
    ) => { status: number; data: unknown },
  ) {}
  async send(path: string, body?: unknown) {
    this.requests.push({ path, body });
    return this.handler(path, body as Record<string, unknown> | undefined, this.requests.length);
  }
  async refresh() {
    this.refreshes++;
  }
  async close() {}
}

const room = (id: string, overrides = {}) => ({
  id,
  name: id,
  capacity: 6,
  attendeeLimits: [],
  ...overrides,
});
const emptyCalendar = (id: string) => ({ id, meetingReservations: [] });
const interval = (start: string, end: string) => ({
  startTime: `2026-11-11T${start}:00+09:00`,
  endTime: `2026-11-11T${end}:00+09:00`,
});
const search = { date: "2026-11-11", startTime: "15:00", endTime: "16:00" };

test("a 401 refreshes once and retries; repeated 401 requires login", async () => {
  const transport = new FakeTransport(() => ({ status: 401, data: {} }));
  await assert.rejects(new MileApi(transport).read("/users/info"), { code: "LOGIN_REQUIRED" });
  assert.equal(transport.refreshes, 1);
  assert.equal(transport.requests.length, 2);
});

test("successful refresh returns the retried response", async () => {
  const transport = new FakeTransport((_path, _body, number) => ({
    status: number === 1 ? 401 : 200,
    data: { ok: true },
  }));
  assert.deepEqual(await new MileApi(transport).read("/users/info"), { ok: true });
  assert.equal(transport.refreshes, 1);
});

test("writes and absolute URLs are rejected before the HTTP transport", async () => {
  const transport = new FakeTransport(() => ({ status: 200, data: {} }));
  const api = new MileApi(transport);
  for (const path of [
    "/meetings/meeting-reservation",
    "/auth/logout",
    "https://example.com/users/info",
  ]) {
    await assert.rejects(api.read(path, {}), { code: "ENDPOINT_NOT_ALLOWED" });
  }
  assert.equal(transport.requests.length, 0);
});

test("HTTP errors are mapped and upstream error bodies are never exposed", async () => {
  for (const [status, code] of [
    [403, "PERMISSION_DENIED"],
    [429, "RATE_LIMITED"],
    [500, "API_ERROR"],
  ] as const) {
    const api = new MileApi(
      new FakeTransport(() => ({ status, data: { secret: "DO_NOT_EXPOSE" } })),
    );
    await assert.rejects(api.read("/users/info"), (error) => {
      const exposed = publicError(error);
      assert.equal(exposed.code, code);
      assert.ok(!JSON.stringify(exposed).includes("DO_NOT_EXPOSE"));
      return true;
    });
  }
  assert.ok(!JSON.stringify(publicError(new Error("Authorization: secret"))).includes("secret"));
});

test("availability excludes overlaps but accepts adjacent meetings and normalizes UTC", async () => {
  const rooms = [
    room("before"),
    room("after"),
    room("overlap"),
    room("utc"),
    room("free"),
    room("missing"),
  ];
  const transport = new FakeTransport((path) => ({
    status: 200,
    data: path.endsWith("meeting-room/list")
      ? { meetingRoomList: rooms, totalPageNumber: 1 }
      : [
          { id: "before", meetingReservations: [interval("14:00", "15:00")] },
          { id: "after", meetingReservations: [interval("16:00", "17:00")] },
          { id: "overlap", meetingReservations: [interval("15:30", "16:30")] },
          {
            id: "utc",
            meetingReservations: [
              { startTime: "2026-11-11T06:00:00Z", endTime: "2026-11-11T07:00:00Z" },
            ],
          },
          emptyCalendar("free"),
        ],
  }));
  const result = await new MileService(new MileApi(transport)).findAvailableRooms(search);
  assert.deepEqual(
    result.availableRooms.map((room) => room.id),
    ["before", "after", "free"],
  );
  assert.deepEqual(result.unverifiedRoomIds, ["missing"]);
});

test("availability covers every room page and respects capacity, location and peak-time minimum", async () => {
  const transport = new FakeTransport((path, body) => ({
    status: 200,
    data: path.endsWith("meeting-room/list")
      ? {
          meetingRoomList:
            body?.nowPageNumber === 1
              ? [
                  room("small", { capacity: 2 }),
                  room("wrong-building", { floor: { name: "1층", building: { name: "별관" } } }),
                ]
              : [
                  room("peak", {
                    name: "본관 회의실",
                    attendeeLimits: [
                      { startTime: "15:00:00", endTime: "17:00:00", minAttendeeNum: 5 },
                    ],
                  }),
                  room("fit", { floor: { name: "2층", building: { name: "본관" } } }),
                ],
          totalPageNumber: 2,
        }
      : [emptyCalendar("peak"), emptyCalendar("fit")],
  }));
  const result = await new MileService(new MileApi(transport)).findAvailableRooms({
    ...search,
    attendees: 4,
    location: "본관",
  });
  assert.deepEqual(
    result.availableRooms.map((room) => room.id),
    ["fit"],
  );
  assert.equal(result.availableRooms[0]?.location, "본관 2층");
  assert.equal(
    transport.requests.filter((request) => request.path.endsWith("meeting-room/list")).length,
    2,
  );
});

test("an invalid calendar response fails instead of declaring all rooms available", async () => {
  for (const data of [
    { result: [] },
    [{ id: "one", meetingReservations: [{ startTime: "bad", endTime: "bad" }] }],
  ]) {
    const transport = new FakeTransport((path) => ({
      status: 200,
      data: path.endsWith("meeting-room/list")
        ? { meetingRoomList: [room("one")], totalPageNumber: 1 }
        : data,
    }));
    await assert.rejects(new MileService(new MileApi(transport)).findAvailableRooms(search), {
      code: "API_FORMAT_CHANGED",
    });
  }
});

test("my reservations use Korean day boundaries and enforce the six-month limit", async () => {
  const transport = new FakeTransport(() => ({ status: 200, data: {} }));
  const service = new MileService(new MileApi(transport));
  const input = {
    period: "upcoming" as const,
    startDate: "2026-11-11",
    endDate: "2026-11-11",
    page: 1,
    creatorOnly: true,
  };
  await service.listMyReservations(input);
  assert.deepEqual(transport.requests[0]?.body, {
    nowPageNumber: 1,
    viewStartDate: "2026-11-10T15:00:00.000Z",
    viewEndDate: "2026-11-11T14:59:59.999Z",
    creatorOnly: true,
  });
  await assert.rejects(service.listMyReservations({ ...input, endDate: "2027-05-12" }), {
    code: "INVALID_RANGE",
  });
  await assert.rejects(service.findAvailableRooms({ ...search, endTime: "14:00" }), {
    code: "INVALID_RANGE",
  });
});

test("MCP handshake exposes seven read tools, workspace selection and booking, applies defaults and rejects invalid dates", async () => {
  const transport = new FakeTransport(() => ({
    status: 200,
    data: { meetingRoomList: [], totalPageNumber: 0 },
  }));
  const server = createServer(new MileService(new MileApi(transport)));
  const client = new Client({ name: "test-client", version: "1.0.0" });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await server.connect(serverSide);
  await client.connect(clientSide);
  try {
    const list = await client.listTools();
    assert.equal(list.tools.length, 9);
    assert.ok(!list.tools.some((tool) => tool.name === "check_reservation_conflicts"));
    assert.equal(list.tools.filter((tool) => tool.annotations?.readOnlyHint).length, 7);
    const booking = list.tools.find((tool) => tool.name === "create_reservation");
    assert.ok(booking);
    assert.equal(booking.annotations?.readOnlyHint, false);
    assert.equal(booking.annotations?.idempotentHint, false);
    const result = await client.callTool({ name: "list_meeting_rooms", arguments: {} });
    assert.ok(!result.isError);
    assert.deepEqual(transport.requests[0]?.body, {
      nowPageNumber: 1,
      numberOfContents: 100,
      locationFilter: [],
      meetingRoomIdList: [],
      withBlocked: false,
      attendeeLimitFilter: "ALL",
    });
    const invalid = await client.callTool({
      name: "list_reservations",
      arguments: { date: "2026-02-30", roomIds: ["one"] },
    });
    assert.equal(invalid.isError, true);
    assert.equal(transport.requests.length, 1);
    const missingId = await client.callTool({
      name: "get_reservation",
      arguments: { roomId: "one" },
    });
    assert.equal(missingId.isError, true);
    assert.equal(transport.requests.length, 1);
  } finally {
    await client.close();
    await server.close();
  }
});

test("the real CLI supports stdio initialization and clean shutdown without a browser", async () => {
  const temporary = await mkdtemp(join(tmpdir(), "mile-stdio-"));
  const client = new Client({ name: "stdio-test", version: "1.0.0" });
  const stdio = new StdioClientTransport({
    command: process.execPath,
    args: ["--import", "tsx", "src/cli.ts", "stdio"],
    cwd: process.cwd(),
    stderr: "pipe",
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter(
          (entry): entry is [string, string] => entry[1] !== undefined,
        ),
      ),
      MILE_MCP_DATABASE_PATH: join(temporary, "mile.db"),
    },
  });
  try {
    await client.connect(stdio);
    const list = await client.listTools();
    assert.equal(list.tools.length, 9);
    assert.ok(!list.tools.some((tool) => tool.name === "check_reservation_conflicts"));
    const result = await client.callTool({
      name: "get_reservation",
      arguments: { roomId: "test" },
    });
    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /INVALID_INPUT/);
  } finally {
    await client.close();
    await rm(temporary, { recursive: true, force: true });
  }
});
