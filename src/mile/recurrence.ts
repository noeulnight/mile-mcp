import { DateTime } from "luxon";
import { z } from "zod";
import { MileError } from "../errors.js";

const weekdays = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"] as const;
export const repeatSchema = z
  .object({
    frequency: z.enum(["daily", "weekly", "weekdays", "monthly"]),
    interval: z.number().int().min(1).default(1),
    weekdays: z
      .array(z.enum(weekdays))
      .min(1)
      .max(7)
      .optional()
      .describe("weekly일 때 반복할 요일. MO=월요일, SU=일요일."),
    monthlyMode: z
      .enum(["nth_weekday", "day_of_month"])
      .optional()
      .describe("monthly일 때 기본값 nth_weekday. 시작일의 몇째 요일 또는 일자를 반복합니다."),
    end: z.discriminatedUnion("type", [
      z.object({ type: z.literal("count"), count: z.number().int().min(1).max(200) }),
      z.object({ type: z.literal("until"), date: z.iso.date() }),
    ]),
  })
  .superRefine((value, context) => {
    if (value.frequency === "weekly" && !value.weekdays?.length) {
      context.addIssue({
        code: "custom",
        path: ["weekdays"],
        message: "주간 반복의 요일을 지정해 주세요.",
      });
    }
  });

// Adapted from Mile's deployed generateRRuleString: keep the same RRULE dialect.
// UNTIL is converted from the Korean end-of-day to actual UTC, rather than adding a literal Z to local time.
export function makeRRule(
  repeat: z.infer<typeof repeatSchema> | undefined,
  start: DateTime,
): string | undefined {
  if (!repeat) {
    return undefined;
  }
  const frequency = { daily: "DAILY", weekly: "WEEKLY", weekdays: "WEEKLY", monthly: "MONTHLY" }[
    repeat.frequency
  ];
  const parts = [`RRULE:FREQ=${frequency}`];
  if (repeat.frequency === "weekly") {
    parts.push(`BYDAY=${[...new Set(repeat.weekdays)].join(",")}`);
  }
  if (repeat.frequency === "weekdays") {
    parts.push("BYDAY=MO,TU,WE,TH,FR");
  }
  if (repeat.interval > 1) {
    parts.push(`INTERVAL=${repeat.interval}`);
  }
  if (repeat.end.type === "count") {
    parts.push(`COUNT=${repeat.end.count}`);
  } else {
    const end = DateTime.fromISO(repeat.end.date, { zone: "Asia/Seoul" }).endOf("day");
    if (!end.isValid || end < start) {
      throw new MileError("INVALID_RANGE", "반복 종료 날짜는 시작 날짜보다 빠를 수 없습니다.");
    }
    parts.push(`UNTIL=${end.toUTC().toFormat("yyyyMMdd'T'HHmmss'Z'")}`);
  }
  if (repeat.frequency === "monthly") {
    parts.push(
      repeat.monthlyMode === "day_of_month"
        ? `BYMONTHDAY=${start.day}`
        : `BYDAY=${Math.ceil(start.day / 7)}${weekdays[start.weekday - 1]}`,
    );
  }
  return parts.join(";");
}
