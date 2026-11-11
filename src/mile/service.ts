import { DateTime } from "luxon";
import { z } from "zod";
import { MileError } from "../errors.js";
import type { MileApi } from "./api.js";
import { makeRRule, repeatSchema } from "./recurrence.js";

export const ZONE = "Asia/Seoul";
export const dateSchema = z.iso.date();
const id = z.string().min(1);
const page = z.number().int().min(1).default(1);
export const roomInput = {
  page,
  pageSize: z.number().int().min(1).max(100).default(100),
  roomIds: z.array(id).max(100).default([]),
};
export const reservationInput = { date: dateSchema, roomIds: z.array(id).min(1).max(100) };
export const detailInput = {
  roomId: id,
  reservationId: id.optional(),
  googleEventId: id.optional(),
};
export const myInput = {
  period: z.enum(["upcoming", "completed"]).default("upcoming"),
  startDate: dateSchema,
  endDate: dateSchema,
  creatorOnly: z.boolean().default(false),
  page,
};
const timeSchema = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "HH:mm 형식으로 입력해 주세요.");
export const availableInput = {
  date: dateSchema,
  startTime: timeSchema,
  endTime: timeSchema,
  attendees: z.number().int().min(1).optional(),
  location: z.string().min(1).optional(),
};

export const workspaceInput = { workspaceId: id };

export const memberInput = { query: z.string().trim().min(1), page };
const conflictInput = {
  roomId: id,
  date: dateSchema,
  startTime: timeSchema,
  endTime: timeSchema,
  repeat: repeatSchema.optional(),
};
export const createInput = {
  ...conflictInput,
  title: z.string().trim().min(1).max(100),
  attendees: z
    .array(
      z.discriminatedUnion("isVisitor", [
        z.object({ isVisitor: z.literal(false), memberId: id, visitorEmail: z.email() }),
        z.object({ isVisitor: z.literal(true), visitorEmail: z.email() }),
      ]),
    )
    .min(1)
    .describe(
      "내부 멤버는 search_members에서 얻은 ID와 이메일을 지정합니다. 예약자 본인도 참석자로 포함하려면 명시해 주세요. 외부 참석자는 isVisitor=true와 이메일을 지정합니다.",
    ),
  memo: z.string().max(1000).default(""),
  isPrivate: z.boolean().default(false),
  guestsCanModify: z.boolean().default(false),
  exceptedAttendeeLimit: z
    .boolean()
    .default(false)
    .describe("최소 참석 인원 제한에 대한 예외를 명시적으로 적용할 때만 true."),
};

const roomSchema = z
  .object({
    id,
    name: z.string(),
    capacity: z.number().nullable().optional(),
    floor: z
      .object({
        name: z.string().optional(),
        building: z.object({ name: z.string().optional() }).passthrough().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    building: z.object({ name: z.string().optional() }).passthrough().nullable().optional(),
    attendeeLimits: z
      .array(z.object({ startTime: z.string(), endTime: z.string(), minAttendeeNum: z.number() }))
      .optional(),
  })
  .passthrough();
const roomsSchema = z
  .object({ meetingRoomList: z.array(roomSchema), totalPageNumber: z.number().int().min(0) })
  .passthrough();
const reservationsSchema = z.array(
  z.object({
    id,
    meetingReservations: z.array(
      z.object({ startTime: z.string(), endTime: z.string() }).passthrough(),
    ),
  }),
);

const membershipsSchema = z.array(
  z
    .object({
      id,
      role: z.number(),
      workspace: z.object({ id, name: z.string() }).passthrough(),
    })
    .passthrough(),
);

type Room = z.infer<typeof roomSchema>;

function parseResponse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new MileError(
      "API_FORMAT_CHANGED",
      "마일 응답 형식이 예상과 다릅니다. 빈 회의실로 판단하지 않고 조회를 중단했습니다.",
    );
  }
  return result.data;
}

function day(date: string): DateTime {
  const value = DateTime.fromISO(date, { zone: ZONE });
  if (!value.isValid) {
    throw new MileError("INVALID_DATE", "유효한 날짜를 입력해 주세요.");
  }
  return value;
}

function instant(value: string): number {
  const time = DateTime.fromISO(value, { zone: ZONE, setZone: true });
  if (!time.isValid) {
    throw new MileError(
      "API_FORMAT_CHANGED",
      "예약 시간 형식을 확인할 수 없습니다. 빈 회의실 판단을 중단했습니다.",
    );
  }
  return time.toMillis();
}

function roomLocation(room: Room): string {
  return [room.building?.name, room.floor?.building?.name, room.floor?.name]
    .filter(Boolean)
    .join(" ");
}

export class MileService {
  constructor(private readonly api: MileApi) {}

  private pendingTool: Promise<unknown> = Promise.resolve();

  // Hold the workspace for the entire MCP tool, including booking preflight and creation.
  runTool<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pendingTool.then(operation);
    this.pendingTool = result.catch(() => {});
    return result;
  }

  private async memberships() {
    const result = membershipsSchema.safeParse(await this.api.read("/users/member/list"));
    if (!result.success) {
      throw new MileError("API_FORMAT_CHANGED", "워크스페이스 목록의 응답 형식이 변경됐습니다.");
    }
    return result.data;
  }

  async listWorkspaces() {
    return {
      workspaces: (await this.memberships()).map((member) => ({
        memberId: member.id,
        role: member.role,
        workspaceId: member.workspace.id,
        name: member.workspace.name,
      })),
    };
  }

  async selectWorkspace(input: z.infer<z.ZodObject<typeof workspaceInput>>) {
    const member = (await this.memberships()).find(
      (entry) => entry.workspace.id === input.workspaceId,
    );
    if (!member) {
      throw new MileError(
        "WORKSPACE_NOT_AVAILABLE",
        "참여 중인 목록에서 워크스페이스를 선택해 주세요.",
      );
    }
    await this.api.selectWorkspace(member);
    return {
      selected: true,
      workspaceId: member.workspace.id,
      name: member.workspace.name,
      memberId: member.id,
    };
  }

  async searchMembers(input: z.infer<z.ZodObject<typeof memberInput>>) {
    return this.api.read("/members", {
      nowPageNumber: input.page,
      role: null,
      searchWord: input.query,
    });
  }

  private async checkReservationConflicts(input: z.infer<z.ZodObject<typeof conflictInput>>) {
    const start = DateTime.fromISO(`${input.date}T${input.startTime}`, { zone: ZONE });
    const end = DateTime.fromISO(`${input.date}T${input.endTime}`, { zone: ZONE });
    if (!start.isValid || !end.isValid || end <= start) {
      throw new MileError(
        "INVALID_RANGE",
        "같은 날짜 안에서 종료 시각이 시작 시각보다 늦어야 합니다.",
      );
    }
    const rrule = makeRRule(input.repeat, start);
    const body = {
      meetingRoomId: input.roomId,
      rsvStartTime: start.toUTC().toJSDate().toISOString(),
      rsvEndTime: end.toUTC().toJSDate().toISOString(),
      ...(rrule ? { rrule } : {}),
    };
    if (rrule) {
      const result = parseResponse(
        z.object({ available: z.array(z.string()), unavailable: z.array(z.string()) }),
        await this.api.read("/meetings/recurring-reservation/check-duplication", body),
      );
      const occurrences = [...result.available, ...result.unavailable];
      if (
        occurrences.length === 0 ||
        occurrences.some((date) => !DateTime.fromISO(date, { zone: ZONE }).isValid) ||
        (input.repeat?.end.type === "count" && occurrences.length !== input.repeat.end.count)
      ) {
        throw new MileError(
          "API_FORMAT_CHANGED",
          "반복 예약의 검사 결과가 불완전합니다. 예약을 생성하지 않았습니다.",
        );
      }
      return {
        ...body,
        canCreate: result.available.length > 0 && result.unavailable.length === 0,
        ...result,
        timezone: ZONE,
      };
    }
    const calendars = parseResponse(
      reservationsSchema,
      await this.listReservations({ date: input.date, roomIds: [input.roomId] }),
    );
    const calendar = calendars.find((room) => room.id === input.roomId);
    if (!calendar) {
      throw new MileError(
        "API_FORMAT_CHANGED",
        "회의실 예약 데이터를 확인할 수 없어 생성을 중단했습니다.",
      );
    }
    const conflicts = calendar.meetingReservations.filter((reservation) => {
      const from = instant(reservation.startTime),
        to = instant(reservation.endTime);
      if (to <= from) {
        throw new MileError("API_FORMAT_CHANGED", "예약 시간 범위가 올바르지 않습니다.");
      }
      return from < end.toMillis() && to > start.toMillis();
    });
    return {
      ...body,
      canCreate: conflicts.length === 0,
      available: conflicts.length ? [] : [body.rsvStartTime],
      unavailable: conflicts.map((item) => item.startTime),
      timezone: ZONE,
    };
  }

  async createReservation(input: z.infer<z.ZodObject<typeof createInput>>) {
    const emails = input.attendees.map((attendee) => attendee.visitorEmail.toLowerCase());
    const members = input.attendees
      .filter((attendee) => !attendee.isVisitor)
      .map((attendee) => attendee.memberId);
    if (new Set(emails).size !== emails.length || new Set(members).size !== members.length) {
      throw new MileError("INVALID_INPUT", "같은 참석자를 중복 지정할 수 없습니다.");
    }
    const checked = await this.checkReservationConflicts(input);
    if (!checked.canCreate) {
      throw new MileError(
        "RESERVATION_CONFLICT",
        "겹치는 예약이 있어 생성하지 않았습니다. 다른 시간을 선택해 주세요. 반복 예약 중 일부 일정만 생성하지 않습니다.",
      );
    }
    const result = await this.api.createReservation({
      title: input.title,
      memo: input.memo,
      isPrivate: input.isPrivate,
      guestsCanModify: input.guestsCanModify,
      meetingRoomId: checked.meetingRoomId,
      rsvStartTime: checked.rsvStartTime,
      rsvEndTime: checked.rsvEndTime,
      reservationAttendees: input.attendees,
      ...(checked.rrule ? { rrule: checked.rrule } : {}),
      exceptedAttendeeLimit: input.exceptedAttendeeLimit,
    });
    return { created: true, roomId: input.roomId, timezone: ZONE, result };
  }

  async listRooms(input: z.infer<z.ZodObject<typeof roomInput>>) {
    return parseResponse(
      roomsSchema,
      await this.api.read("/meetings/meeting-room/list", {
        nowPageNumber: input.page,
        numberOfContents: input.pageSize,
        locationFilter: [],
        meetingRoomIdList: input.roomIds,
        withBlocked: false,
        attendeeLimitFilter: "ALL",
      }),
    );
  }

  async listReservations(input: z.infer<z.ZodObject<typeof reservationInput>>) {
    const date = day(input.date);
    return this.api.read("/meetings/meeting-reservation/list", {
      meetingRoomIdList: input.roomIds,
      year: date.year,
      month: date.month,
      date: date.day,
    });
  }

  async getReservation(input: z.infer<z.ZodObject<typeof detailInput>>) {
    if (!input.reservationId && !input.googleEventId) {
      throw new MileError("INVALID_INPUT", "reservationId 또는 googleEventId를 입력해 주세요.");
    }
    return this.api.read("/meetings/meeting-reservation/detail", {
      meetingRoomId: input.roomId,
      meetingReservationId: input.reservationId ?? "",
      googleEventId: input.googleEventId ?? "",
    });
  }

  async listMyReservations(input: z.infer<z.ZodObject<typeof myInput>>) {
    const start = day(input.startDate),
      end = day(input.endDate);
    if (end < start || end > start.plus({ months: 6 })) {
      throw new MileError(
        "INVALID_RANGE",
        "조회 기간은 시작일 이후부터 최대 6개월까지 가능합니다.",
      );
    }
    return this.api.read(`/meetings/meeting-reservation/my/${input.period}`, {
      nowPageNumber: input.page,
      viewStartDate: start.startOf("day").toJSDate().toISOString(),
      viewEndDate: end.endOf("day").toJSDate().toISOString(),
      creatorOnly: input.creatorOnly,
    });
  }

  async findAvailableRooms(input: z.infer<z.ZodObject<typeof availableInput>>) {
    day(input.date);
    if (input.endTime <= input.startTime) {
      throw new MileError("INVALID_RANGE", "종료 시각은 같은 날짜의 시작 시각보다 늦어야 합니다.");
    }
    const start = instant(`${input.date}T${input.startTime}:00+09:00`);
    const end = instant(`${input.date}T${input.endTime}:00+09:00`);
    const rooms: Room[] = [];
    let current = 1;
    let total = 1;
    do {
      const result = await this.listRooms({ page: current, pageSize: 100, roomIds: [] });
      rooms.push(...result.meetingRoomList);
      total = result.totalPageNumber;
      if (total > 100) {
        throw new MileError(
          "TOO_MANY_ROOMS",
          "회의실 목록이 너무 큽니다. 조회 범위를 나누는 기능이 필요합니다.",
        );
      }
      current++;
    } while (current <= total);
    const candidates = rooms.filter((room) => {
      if (
        input.attendees !== undefined &&
        (room.capacity === null || room.capacity === undefined || room.capacity < input.attendees)
      ) {
        return false;
      }
      if (
        input.location &&
        !`${room.name} ${roomLocation(room)}`
          .toLocaleLowerCase()
          .includes(input.location.toLocaleLowerCase())
      ) {
        return false;
      }
      return true;
    });
    const availableRooms: Array<{
      id: string;
      name: string;
      capacity: number | null;
      location: string;
      minAttendees: number;
    }> = [];
    const unverifiedRoomIds: string[] = [];
    for (let offset = 0; offset < candidates.length; offset += 100) {
      const batch = candidates.slice(offset, offset + 100);
      const result = parseResponse(
        reservationsSchema,
        await this.listReservations({ date: input.date, roomIds: batch.map((room) => room.id) }),
      );
      for (const room of batch) {
        const calendar = result.find((item) => item.id === room.id);
        if (!calendar) {
          unverifiedRoomIds.push(room.id);
          continue;
        }
        const busy = calendar.meetingReservations.some((reservation) => {
          const rsvStart = instant(reservation.startTime),
            rsvEnd = instant(reservation.endTime);
          if (rsvEnd <= rsvStart) {
            throw new MileError(
              "API_FORMAT_CHANGED",
              "예약 시간 범위가 올바르지 않아 빈 회의실 판단을 중단했습니다.",
            );
          }
          return rsvStart < end && rsvEnd > start;
        });
        const minimum = Math.max(
          0,
          ...(room.attendeeLimits ?? [])
            .filter(
              (limit) =>
                limit.startTime.slice(0, 5) < input.endTime &&
                limit.endTime.slice(0, 5) > input.startTime,
            )
            .map((limit) => limit.minAttendeeNum),
        );
        if (!busy && (input.attendees === undefined || input.attendees >= minimum)) {
          availableRooms.push({
            id: room.id,
            name: room.name,
            capacity: room.capacity ?? null,
            location: roomLocation(room),
            minAttendees: minimum,
          });
        }
      }
    }
    return {
      date: input.date,
      startTime: input.startTime,
      endTime: input.endTime,
      timezone: ZONE,
      availableRooms,
      unverifiedRoomIds,
      notice:
        "조회 시점의 예약 기준입니다. 실제 예약 가능 여부는 생성 시 서버에서 다시 확인해야 합니다.",
    };
  }
}
