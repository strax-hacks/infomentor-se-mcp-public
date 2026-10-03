import { parseDocument } from "htmlparser2";
import { z } from "zod";
import { notificationSchema } from "./session.js";

const positiveInteger = z
  .union([
    z.number().int().positive(),
    z
      .string()
      .regex(/^\d+$/)
      .transform((value) => Number(value)),
  ])
  .refine(Number.isSafeInteger, "must be a safe integer");

const nullableInteger = positiveInteger.nullish().transform((value) => value ?? null);
const nullableString = z
  .string()
  .nullish()
  .transform((value) => value ?? null);

export const calendarEventRequestSchema = z
  .object({
    /** The numeric notification ID returned by infomentor_get_notifications. */
    notificationId: z.number().int().positive(),
  })
  .strict();

export type CalendarEventRequest = z.input<typeof calendarEventRequestSchema>;

const calendarSubjectSchema = z
  .object({
    id: nullableInteger,
    title: z
      .string()
      .nullish()
      .transform((value) => value ?? ""),
  })
  .passthrough();

export const calendarEventRowSchema = z
  .object({
    id: positiveInteger,
    title: z
      .string()
      .nullish()
      .transform((value) => value ?? ""),
    text: z
      .string()
      .nullish()
      .transform((value) => value ?? ""),
    description: z
      .string()
      .nullish()
      .transform((value) => value ?? ""),
    calendarEntryTypeId: nullableInteger,
    isAllDayEvent: z
      .boolean()
      .nullish()
      .transform((value) => value ?? false),
    startDateFull: z.string(),
    endDateFull: z.string(),
    startDate: z.string(),
    endDate: z.string(),
    formattedStartDate: nullableString,
    formattedEndDate: nullableString,
    startTime: nullableString,
    endTime: nullableString,
    hasAttachments: z
      .boolean()
      .nullish()
      .transform((value) => value ?? false),
    subjects: z
      .array(calendarSubjectSchema)
      .nullish()
      .transform((value) => value ?? []),
    courses: z
      .array(z.unknown())
      .nullish()
      .transform((value) => value ?? []),
    url: nullableString,
  })
  .passthrough();

export type CalendarEventRow = z.infer<typeof calendarEventRowSchema>;

const rawCalendarResponseSchema = z.union([
  z.array(z.unknown()),
  z.object({ items: z.array(z.unknown()) }),
]);

/** Parse the calendar feed while retaining malformed-row counts for diagnostics. */
export const calendarEntriesResponseSchema = rawCalendarResponseSchema.transform((payload) => {
  const rawItems = Array.isArray(payload) ? payload : payload.items;
  const items: CalendarEventRow[] = [];
  let skipped = 0;

  for (const rawItem of rawItems) {
    const parsed = calendarEventRowSchema.safeParse(rawItem);
    if (parsed.success) items.push(parsed.data);
    else skipped++;
  }

  return { items, skipped };
});

export type CalendarEntriesResponse = z.infer<typeof calendarEntriesResponseSchema>;

type HtmlNode = {
  type?: string;
  name?: string;
  data?: string;
  children?: HtmlNode[];
};

const blockTags = new Set(["div", "li", "p", "pre", "section", "br", "td", "th", "tr"]);

function htmlText(nodes: readonly HtmlNode[]): string {
  let output = "";
  for (const node of nodes) {
    if (node.type === "text") {
      output += node.data ?? "";
      continue;
    }
    if (node.type !== "tag") continue;
    if (node.name === "br") {
      output += "\n";
      continue;
    }
    const childText = htmlText(node.children ?? []);
    output += blockTags.has(node.name ?? "") ? `\n${childText}\n` : childText;
  }
  return output
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function plainCalendarText(value: string): string {
  if (!/<[a-z][\s\S]*>/i.test(value)) return value.trim();
  return htmlText(parseDocument(value).children as unknown as HtmlNode[]);
}

const calendarEventSubjectSchema = z.object({
  id: z.number().int().positive().nullable(),
  title: z.string(),
});

export const calendarEventSchema = z.object({
  notification: notificationSchema,
  eventId: z.number().int().positive(),
  childId: z.string().min(1),
  title: z.string(),
  text: z.string(),
  description: z.string(),
  subjects: z.array(calendarEventSubjectSchema),
  courses: z.array(z.unknown()),
  calendarEntryTypeId: z.number().int().positive().nullable(),
  isAllDayEvent: z.boolean(),
  startDateFull: z.string(),
  endDateFull: z.string(),
  startDate: z.string(),
  endDate: z.string(),
  formattedStartDate: z.string().nullable(),
  formattedEndDate: z.string().nullable(),
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
  hasAttachments: z.boolean(),
  url: z.string().nullable(),
  skipped: z.number().int().nonnegative(),
  retrievedAt: z.iso.datetime(),
});

export type CalendarEvent = z.infer<typeof calendarEventSchema>;

/** Extract the calendar event ID embedded in a CalendarV2 hash route. */
export function calendarEventIdFromNotificationUrl(url: string): number | undefined {
  const match = /(?:^|[?&#])eventId=(\d+)(?:[&#]|$)/i.exec(url);
  if (!match?.[1]) return undefined;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

function dateParts(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function isoWeekStart(year: number, week: number): Date {
  const januaryFourth = new Date(Date.UTC(year, 0, 4));
  const day = januaryFourth.getUTCDay() || 7;
  januaryFourth.setUTCDate(januaryFourth.getUTCDate() - day + 1 + (week - 1) * 7);
  return januaryFourth;
}

function weekFromDate(value: string): { year: number; week: number } | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return undefined;
  const date = new Date(`${match[1]}-${match[2]}-${match[3]}T00:00:00Z`);
  if (Number.isNaN(date.valueOf())) return undefined;
  const thursday = new Date(date);
  thursday.setUTCDate(date.getUTCDate() + (4 - (date.getUTCDay() || 7)));
  const year = thursday.getUTCFullYear();
  const firstThursday = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round((thursday.valueOf() - firstThursday.valueOf()) / 604_800_000);
  return { year, week };
}

/** Get the week request range represented by a CalendarV2 notification URL. */
export function calendarRangeFromNotification(
  url: string,
  fallbackDate: string,
): { startDate: string; endDate: string } {
  const year = /[?&#]selectedYear=(\d{4})(?:[&#]|$)/i.exec(url)?.[1];
  const week = /[?&#]selectedWeek=(\d{1,2})(?:[&#]|$)/i.exec(url)?.[1];
  const selected =
    year && week ? { year: Number(year), week: Number(week) } : weekFromDate(fallbackDate);
  if (!selected || selected.week < 1 || selected.week > 53) {
    throw new Error("InfoMentor returned a CalendarV2 notification without a usable week.");
  }

  const start = isoWeekStart(selected.year, selected.week);
  const end = new Date(start);
  end.setUTCDate(start.getUTCDate() + 6);
  return { startDate: dateParts(start), endDate: dateParts(end) };
}

export function buildCalendarEvent(
  notification: z.infer<typeof notificationSchema>,
  row: CalendarEventRow,
  childId: string,
  skipped: number,
): CalendarEvent {
  const text = plainCalendarText(row.text) || plainCalendarText(row.description);
  const description = plainCalendarText(row.description) || plainCalendarText(row.text);

  return calendarEventSchema.parse({
    notification,
    eventId: row.id,
    childId,
    title: row.title.trim(),
    text,
    description,
    subjects: row.subjects,
    courses: row.courses,
    calendarEntryTypeId: row.calendarEntryTypeId,
    isAllDayEvent: row.isAllDayEvent,
    startDateFull: row.startDateFull,
    endDateFull: row.endDateFull,
    startDate: row.startDate,
    endDate: row.endDate,
    formattedStartDate: row.formattedStartDate,
    formattedEndDate: row.formattedEndDate,
    startTime: row.startTime,
    endTime: row.endTime,
    hasAttachments: row.hasAttachments,
    url: row.url,
    skipped,
    retrievedAt: new Date().toISOString(),
  });
}
