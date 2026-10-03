import { z } from "zod";

export const fritidsschemaDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Use a date in YYYY-MM-DD format.")
  .refine(isValidLocalDate, "Use a real calendar date.");

const localTimeSchema = z
  .string()
  .regex(/^(?:[01]\d|2[0-3]):[0-5]\d$/, "Use a local time in HH:mm format.");

function isValidLocalDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  if (!match) return false;

  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const parsed = new Date(Date.UTC(year, month - 1, day));

  return (
    parsed.getUTCFullYear() === year &&
    parsed.getUTCMonth() === month - 1 &&
    parsed.getUTCDate() === day
  );
}

/** The schedule row returned by InfoMentor's GetTimeRegistrations endpoint. */
export const timeRegistrationDaySchema = z
  .object({
    timeRegistrationId: z.number().int().positive(),
    date: z.string().min(1),
    startDateTime: z.string().nullable(),
    endDateTime: z.string().nullable(),
    onLeave: z.boolean(),
    isLocked: z.boolean(),
    isSchoolClosed: z.boolean(),
    canEdit: z.boolean(),
    hasUnreadComments: z.boolean(),
    hasComments: z.boolean(),
    canEditComment: z.boolean(),
    schoolOpeningTime: z.string().nullish(),
    schoolClosingTime: z.string().nullish(),
    comment: z.string().optional(),
    commentChanged: z.boolean().optional(),
    commentId: z.number().int().nonnegative().optional(),
  })
  .passthrough();

function parseItems<T>(items: unknown[], schema: z.ZodType<T>) {
  const parsed: T[] = [];
  let skipped = 0;

  for (const item of items) {
    const result = schema.safeParse(item);

    if (result.success) parsed.push(result.data);
    else skipped++;
  }

  return { items: parsed, skipped };
}

export const timeRegistrationsResponseSchema = z
  .object({
    startDate: z.string(),
    endDate: z.string(),
    days: z.array(z.unknown()),
  })
  .transform(({ startDate, endDate, days }) => {
    const parsed = parseItems(days, timeRegistrationDaySchema);

    return {
      startDate,
      endDate,
      days: parsed.items,
      skipped: parsed.skipped,
    };
  });

export const commentsResponseSchema = z
  .object({
    date: z.string(),
    teacherComment: z.string().nullable(),
    teacherName: z.string().nullable(),
    teacherCommentDate: z.string(),
    userComment: z.string().nullable(),
    userName: z.string().nullable(),
    userCommentDate: z.string(),
    checkedIn: z.string(),
    checkedOut: z.string(),
    canEdit: z.boolean(),
    timesLockedBySchool: z.boolean(),
    parentCommentId: z.number().int().positive().nullable(),
    checkInUserDisplayName: z.string(),
    checkOutUserDisplayName: z.string(),
    canEditComment: z.boolean(),
  })
  .passthrough();

export const saveCommentResponseSchema = z
  .object({
    success: z.boolean(),
    notifications: z.array(z.unknown()),
  })
  .passthrough();

export const saveTimeRegistrationsResponseSchema = z
  .object({
    success: z.boolean(),
    notifications: z.array(z.unknown()),
  })
  .passthrough();

export const fritidsschemaRequestSchema = z
  .object({
    childId: z.string().min(1).max(1024),
    date: fritidsschemaDateSchema,
  })
  .strict();

export type FritidsschemaRequest = z.input<typeof fritidsschemaRequestSchema>;

export const fritidsschemaTimesRequestSchema = z
  .object({
    childId: z.string().min(1).max(1024),
    date: fritidsschemaDateSchema,
    startTime: localTimeSchema,
    endTime: localTimeSchema,
    endTimeNextDay: z.boolean().default(false),
  })
  .strict()
  .superRefine((value, context) => {
    if (!value.endTimeNextDay && value.endTime <= value.startTime)
      context.addIssue({
        code: "custom",
        path: ["endTime"],
        message: "End time must be after start time unless endTimeNextDay is true.",
      });
  });

export type FritidsschemaTimesRequest = z.input<typeof fritidsschemaTimesRequestSchema>;

/** Public read result: the entered parent/child fritidsschema times, not school timetable data. */
export const fritidsschemaResultSchema = z.object({
  childId: z.string(),
  date: fritidsschemaDateSchema,
  timeRegistrationId: z.number().int().positive(),
  startDateTime: z.string().nullable(),
  endDateTime: z.string().nullable(),
  startTime: z.string().nullable(),
  endTime: z.string().nullable(),
  onLeave: z.boolean(),
  isLocked: z.boolean(),
  isSchoolClosed: z.boolean(),
  canEdit: z.boolean(),
  hasUnreadComments: z.boolean(),
  hasComments: z.boolean(),
  canEditComment: z.boolean(),
  skipped: z.number().int().nonnegative(),
  retrievedAt: z.iso.datetime(),
});

export type FritidsschemaResult = z.infer<typeof fritidsschemaResultSchema>;

export const fritidsschemaTimesResultSchema = z.object({
  childId: z.string(),
  date: fritidsschemaDateSchema,
  timeRegistrationId: z.number().int().positive(),
  startDateTime: z.string(),
  endDateTime: z.string(),
  startTime: localTimeSchema,
  endTime: localTimeSchema,
  endTimeNextDay: z.boolean(),
  changed: z.boolean(),
  verified: z.literal(true),
});

export type FritidsschemaTimesResult = z.infer<typeof fritidsschemaTimesResultSchema>;

export const fritidsschemaCommentRequestSchema = z
  .object({
    childId: z.string().min(1).max(1024),
    date: fritidsschemaDateSchema,
    comment: z.string().min(1).max(2_000),
  })
  .strict();

export type FritidsschemaCommentRequest = z.input<typeof fritidsschemaCommentRequestSchema>;

/** Public read result for the signed-in parent's fritidsschema comment. */
export const fritidsschemaCommentReadResultSchema = z.object({
  childId: z.string(),
  date: fritidsschemaDateSchema,
  timeRegistrationId: z.number().int().positive(),
  comment: z.string().nullable(),
  canEditComment: z.boolean(),
  canEdit: z.boolean(),
  timesLockedBySchool: z.boolean(),
  parentCommentId: z.number().int().positive().nullable(),
  retrievedAt: z.iso.datetime(),
});

export type FritidsschemaCommentReadResult = z.infer<typeof fritidsschemaCommentReadResultSchema>;

export const fritidsschemaCommentResultSchema = z.object({
  childId: z.string(),
  date: fritidsschemaDateSchema,
  timeRegistrationId: z.number().int().positive(),
  comment: z.string(),
  verified: z.literal(true),
});

export type FritidsschemaCommentResult = z.infer<typeof fritidsschemaCommentResultSchema>;

type SaveCommentFields = {
  commentId: string;
  commentText: string;
  timeRegistrationId: string;
};

export type SaveTimeRegistrationDay = Omit<
  z.infer<typeof timeRegistrationDaySchema>,
  "startDateTime" | "endDateTime" | "onLeave"
> & {
  startDateTime: string;
  endDateTime: string;
  onLeave: false;
  registrationType: "TimeReg";
  commentText: string;
  isCommentUpdated: boolean;
  commentId: number;
};

export type SaveTimeRegistrationsPayload = {
  days: SaveTimeRegistrationDay[];
  series: null;
};

export function buildSaveCommentFields(input: {
  timeRegistrationId: number;
  parentCommentId: number | null;
  commentText: string;
}): SaveCommentFields {
  return {
    commentId: String(input.parentCommentId ?? 0),
    commentText: input.commentText,
    timeRegistrationId: String(input.timeRegistrationId),
  };
}

export function buildSaveTimeRegistrationsPayload(
  day: z.infer<typeof timeRegistrationDaySchema>,
  input: {
    startTime: z.infer<typeof localTimeSchema>;
    endTime: z.infer<typeof localTimeSchema>;
    endTimeNextDay: boolean;
  },
): SaveTimeRegistrationsPayload {
  const payloadDay: SaveTimeRegistrationDay = {
    ...day,
    onLeave: false,
    date: day.date,
    startDateTime: `${datePart(day.date)}T${input.startTime}:00`,
    endDateTime: `${addLocalDate(datePart(day.date), input.endTimeNextDay ? 1 : 0)}T${input.endTime}:00`,
    registrationType: "TimeReg",
    commentText: day.comment ?? "",
    isCommentUpdated: day.commentChanged ?? false,
    commentId: day.commentId ?? 0,
  };

  if (day.schoolOpeningTime) payloadDay.schoolOpeningTime = day.schoolOpeningTime;

  if (day.schoolClosingTime) payloadDay.schoolClosingTime = day.schoolClosingTime;

  return { days: [payloadDay], series: null };
}

export function addLocalDate(value: string, days: number): string {
  const [year, month, day] = value.split("-").map(Number);
  const shifted = new Date(Date.UTC(year ?? 0, (month ?? 1) - 1, day ?? 1));

  shifted.setUTCDate(shifted.getUTCDate() + days);

  return [shifted.getUTCFullYear(), shifted.getUTCMonth() + 1, shifted.getUTCDate()]
    .map((part) => String(part).padStart(2, "0"))
    .join("-");
}

export function datePart(value: string): string {
  return value.slice(0, 10);
}

export function timePart(value: string | null): string | null {
  if (value === null) return null;

  const match = /^(?:\d{4}-\d{2}-\d{2})T(\d{2}:\d{2})/.exec(value);

  return match?.[1] ?? value;
}
