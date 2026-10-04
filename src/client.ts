import { rm } from "node:fs/promises";
import { isAbsolute } from "node:path";
import { z } from "zod";
import {
  login,
  importSession,
  createAuthenticatedHttp,
  hasConfiguredCredentials,
  httpFromSession,
  sessionFromHttp,
} from "./login.js";
import { withSessionLock } from "./lock.js";
import {
  collectUpdates,
  collectRequestSchema,
  type CollectRequest,
  type Collection,
} from "./collection.js";
import {
  buildSaveCommentFields,
  buildSaveTimeRegistrationsPayload,
  commentsResponseSchema,
  datePart,
  fritidsschemaCommentRequestSchema,
  fritidsschemaRequestSchema,
  fritidsschemaTimesRequestSchema,
  saveCommentResponseSchema,
  saveTimeRegistrationsResponseSchema,
  timePart,
  timeRegistrationsResponseSchema,
  addLocalDate,
  type FritidsschemaCommentRequest,
  type FritidsschemaCommentReadResult,
  type FritidsschemaCommentResult,
  type FritidsschemaRequest,
  type FritidsschemaTimesRequest,
  type FritidsschemaTimesResult,
  type FritidsschemaResult,
} from "./fritidsschema.js";
import {
  buildCalendarEvent,
  calendarEntriesResponseSchema,
  calendarEventIdFromNotificationUrl,
  calendarEventRequestSchema,
  calendarRangeFromNotification,
  type CalendarEntriesResponse,
  type CalendarEvent,
  type CalendarEventRequest,
} from "./calendar.js";
import {
  buildNewsContent,
  buildNewsItem,
  childIdFromPupilSourceId,
  newsIdFromNotificationUrl,
  newsItemRequestSchema,
  newsListResponseSchema,
  newsSearchRequestSchema,
  newsSearchSchema,
  type NewsItem,
  type NewsItemRequest,
  type NewsListResponse,
  type NewsSearch,
  type NewsSearchRequest,
} from "./news.js";
import type { InfoMentorHttp } from "./http.js";
import {
  InfoMentorError,
  overviewRequestSchema,
  selectChildRequestSchema,
  messagesRequestSchema,
  messageRequestSchema,
  notificationsRequestSchema,
  messagesPageResponseSchema,
  messageDetailSchema,
  notificationsResponseSchema,
  timetableResponseSchema,
  readSession,
  sessionPath,
  throwIfAborted,
  writeSession,
  type Overview,
  type OverviewRequest,
  type SelectChildRequest,
  type SessionOptions,
  type SessionStatus,
  type MessagesRequest,
  type MessageRequest,
  type NotificationsRequest,
  type Messages,
  type Message,
  type Notifications,
  type SavedSession,
} from "./session.js";

export const loginRequestSchema = z
  .object({
    importFile: z.string().refine(isAbsolute, "Use an absolute path on the MCP host.").optional(),
    credentialsFile: z
      .string()
      .refine(isAbsolute, "Use an absolute path on the MCP host.")
      .optional(),
    allowAccountChange: z.boolean().optional(),
    timeoutSeconds: z.number().int().min(1).max(3600).default(300),
  })
  .strict();

export type LoginRequest = z.input<typeof loginRequestSchema>;

export const setupStatusSchema = z.object({
  state: z.enum(["idle", "running", "succeeded", "failed", "cancelled"]),
  operation: z.enum(["login", "import"]).optional(),
  message: z.string(),
});

export type SetupStatus = z.infer<typeof setupStatusSchema>;

type Notification = Notifications["notifications"][number];

type NotificationFeed = { notifications: Notification[]; skipped: number };

type ResolverCaches = {
  newsFeeds: Map<string, Promise<NewsListResponse>>;
  calendarFeeds: Map<string, Promise<CalendarEntriesResponse>>;
};

function comparableSession(session: SavedSession): string {
  return JSON.stringify({
    accountId: session.accountId,
    selectedChildId: session.selectedChildId,
    rateLimitedUntil: session.rateLimitedUntil,
    cookies: session.cookies.map(({ lastAccessed: _lastAccessed, ...cookie }) => cookie),
  });
}

const swedishMonths = new Map([
  ["januari", 1],
  ["februari", 2],
  ["mars", 3],
  ["april", 4],
  ["maj", 5],
  ["juni", 6],
  ["juli", 7],
  ["augusti", 8],
  ["september", 9],
  ["oktober", 10],
  ["november", 11],
  ["december", 12],
]);

function newsDatePart(value: string | null): string | undefined {
  if (!value) return undefined;
  const iso = /^(\d{4}-\d{2}-\d{2})/.exec(value)?.[1];
  if (iso) return iso;

  const swedish = /^(\d{1,2})\s+([A-Za-zåäöÅÄÖ]+)\s+(\d{4})$/u.exec(value.trim());
  if (!swedish) return undefined;
  const monthName = swedish[2];
  const year = swedish[3];
  const day = swedish[1];
  if (!monthName || !year || !day) return undefined;
  const month = swedishMonths.get(monthName.toLocaleLowerCase("sv-SE"));
  if (!month) return undefined;
  return `${year}-${String(month).padStart(2, "0")}-${day.padStart(2, "0")}`;
}

function newsRowDate(row: NewsListResponse["items"][number]): string | undefined {
  return newsDatePart(row.publishedDate) ?? newsDatePart(row.publishedDateString);
}

/** Reuses cookies and serializes account requests for one MCP connection. */
export class InfoMentorClient {
  private active: { http: InfoMentorHttp; serializedSession: string } | undefined;
  private pending: Promise<void> = Promise.resolve();
  private readonly lifetime = new AbortController();
  private closed = false;
  private loggingOut = false;
  private setup: { controller: AbortController; promise: Promise<void> } | undefined;
  private setupStatus: SetupStatus = { state: "idle", message: "No setup operation has started." };
  private readonly options: SessionOptions;
  constructor(options: SessionOptions = {}) {
    this.options = { ...options };
  }

  private read<T>(
    read: (http: InfoMentorHttp, signal: AbortSignal) => Promise<T>,
    signal?: AbortSignal,
  ): Promise<T> {
    const combined = signal
      ? AbortSignal.any([signal, this.lifetime.signal])
      : this.lifetime.signal;

    // A local queue preserves call order; the file lock also excludes other MCP processes.
    const result = this.pending.then(async () => {
      throwIfAborted(combined);

      if (this.closed)
        throw new InfoMentorError("CANCELLED", "This InfoMentor client has been closed.");

      if (this.setup || this.loggingOut)
        throw new InfoMentorError(
          "OPERATION_IN_PROGRESS",
          "Account setup is in progress. Check infomentor_setup_status before reading school data.",
        );
      const file = sessionPath(this.options.sessionFile);

      return withSessionLock(file, combined, async () => {
        let saved = await readSession(file);

        if (this.active?.serializedSession !== JSON.stringify(saved))
          this.active = {
            http: httpFromSession(saved, this.options.fetch),
            serializedSession: JSON.stringify(saved),
          };
        let http = this.active.http;
        let preserveSession = false;

        try {
          // A validated parent page already proves authentication and is reused by the read below.
          const parent = await http.readParent(combined);

          if (saved.accountId && parent.account.currentUser.id !== saved.accountId)
            throw new InfoMentorError(
              "INVALID_SESSION",
              "The saved session no longer matches its verified account. Sign in explicitly before continuing.",
            );
          saved = await this.saveActive(http, saved, combined);
          const output = await read(http, combined);
          throwIfAborted(combined);

          return output;
        } catch (cause) {
          if (!(cause instanceof InfoMentorError) || cause.code !== "LOGIN_REQUIRED") throw cause;
          preserveSession = true;

          if (!hasConfiguredCredentials(this.options)) throw cause;
          const accountId = saved.accountId ?? http.parent?.account.currentUser.id;

          if (!accountId)
            throw new InfoMentorError(
              "LOGIN_REQUIRED",
              "This older session expired before its account could be verified. Call infomentor_login once to enable automatic authentication refresh.",
            );
          const selectedChildId = saved.selectedChildId;

          const candidate = await createAuthenticatedHttp({
            ...this.options,
            signal: combined,
            timeoutMs: 60_000,
          });

          if (candidate.parent?.account.currentUser.id !== accountId)
            throw new InfoMentorError(
              "LOGIN_REQUIRED",
              "The configured credentials belong to a different InfoMentor account. The previous session was kept. Correct the private credentials or explicitly sign in to change accounts.",
            );

          if (selectedChildId) await candidate.readParent(combined, selectedChildId);
          saved = await this.saveActive(candidate, saved, combined);
          http = candidate;
          preserveSession = false;
          // Only confirmed authentication expiry replays a read, once. Other failures propagate.
          const output = await read(http, combined);
          throwIfAborted(combined);

          return output;
        } finally {
          if (!preserveSession && !combined.aborted) await this.saveActive(http, saved, combined);
        }
      });
    });

    this.pending = result.then(
      () => undefined,
      () => undefined,
    );

    return result;
  }

  private async saveActive(
    http: InfoMentorHttp,
    previous: SavedSession,
    signal: AbortSignal,
  ): Promise<SavedSession> {
    const current = sessionFromHttp(http);

    if (previous.accountId && current.accountId && current.accountId !== previous.accountId)
      throw new InfoMentorError(
        "INVALID_SESSION",
        "Refusing to replace the verified account during a school-data request. Sign in explicitly to change accounts.",
      );

    if (!current.accountId && previous.accountId) current.accountId = previous.accountId;

    if (!current.selectedChildId && previous.selectedChildId)
      current.selectedChildId = previous.selectedChildId;

    if (comparableSession(current) === comparableSession(previous)) {
      this.active = { http, serializedSession: JSON.stringify(previous) };

      return previous;
    }

    await (this.options.writeSession ?? writeSession)(
      current,
      sessionPath(this.options.sessionFile),
      signal,
    );
    this.active = { http, serializedSession: JSON.stringify(current) };

    return current;
  }

  getOverview(request: OverviewRequest = {}, signal?: AbortSignal): Promise<Overview> {
    const input = overviewRequestSchema.parse(request);
    return this.read(
      (http, activeSignal) => this.overview(http, activeSignal, input.childId),
      signal,
    );
  }

  selectChild(request: SelectChildRequest, signal?: AbortSignal): Promise<Overview> {
    const { childId } = selectChildRequestSchema.parse(request);

    return this.read((http, activeSignal) => this.overview(http, activeSignal, childId), signal);
  }

  getFritidsschema(
    request: FritidsschemaRequest,
    signal?: AbortSignal,
  ): Promise<FritidsschemaResult> {
    const input = fritidsschemaRequestSchema.parse(request);

    return this.read(async (http, activeSignal) => {
      const parent = await http.readParent(activeSignal, input.childId);

      if (!parent.apps.some((app) => app.codeName === "timeregistration"))
        throw new InfoMentorError(
          "INVALID_CONFIGURATION",
          "This InfoMentor account does not provide a fritidsschema.",
        );

      const registrations = await http.readAppData(
        "TimeRegistration/TimeRegistration/GetTimeRegistrations/",
        {
          date: input.date,
          showNextWeekIfNoMoreSchoolDays: "true",
        },
        timeRegistrationsResponseSchema,
        activeSignal,
      );

      const day = registrations.days.find((item) => datePart(item.date) === input.date);

      if (!day)
        throw new InfoMentorError(
          "INVALID_CONFIGURATION",
          "No fritidsschema entry was found for the requested date.",
        );

      return {
        childId: input.childId,
        date: input.date,
        timeRegistrationId: day.timeRegistrationId,
        startDateTime: day.startDateTime,
        endDateTime: day.endDateTime,
        startTime: timePart(day.startDateTime),
        endTime: timePart(day.endDateTime),
        onLeave: day.onLeave,
        isLocked: day.isLocked,
        isSchoolClosed: day.isSchoolClosed,
        canEdit: day.canEdit,
        hasUnreadComments: day.hasUnreadComments,
        hasComments: day.hasComments,
        canEditComment: day.canEditComment,
        skipped: registrations.skipped,
        retrievedAt: new Date().toISOString(),
      };
    }, signal);
  }

  private async readFritidsschemaComments(http: InfoMentorHttp, date: string, signal: AbortSignal) {
    return http.readAppData(
      "TimeRegistration/TimeRegistration/GetComments/",
      { date },
      commentsResponseSchema,
      signal,
    );
  }

  private async readFritidsschemaCommentContext(
    http: InfoMentorHttp,
    input: Pick<FritidsschemaRequest, "childId" | "date">,
    signal: AbortSignal,
  ) {
    const parent = await http.readParent(signal, input.childId);

    if (!parent.apps.some((app) => app.codeName === "timeregistration"))
      throw new InfoMentorError(
        "INVALID_CONFIGURATION",
        "This InfoMentor account does not provide a fritidsschema.",
      );

    const registrations = await http.readAppData(
      "TimeRegistration/TimeRegistration/GetTimeRegistrations/",
      {
        date: input.date,
        showNextWeekIfNoMoreSchoolDays: "true",
      },
      timeRegistrationsResponseSchema,
      signal,
    );

    const day = registrations.days.find((item) => datePart(item.date) === input.date);

    if (!day)
      throw new InfoMentorError(
        "INVALID_CONFIGURATION",
        "No fritidsschema entry was found for the requested date.",
      );

    const comments = await this.readFritidsschemaComments(http, day.date, signal);

    return { day, comments };
  }

  getFritidsschemaComment(
    request: FritidsschemaRequest,
    signal?: AbortSignal,
  ): Promise<FritidsschemaCommentReadResult> {
    const input = fritidsschemaRequestSchema.parse(request);

    return this.read(async (http, activeSignal) => {
      const { day, comments } = await this.readFritidsschemaCommentContext(
        http,
        input,
        activeSignal,
      );

      return {
        childId: input.childId,
        date: input.date,
        timeRegistrationId: day.timeRegistrationId,
        comment: comments.userComment,
        canEditComment: comments.canEditComment,
        canEdit: comments.canEdit,
        timesLockedBySchool: comments.timesLockedBySchool,
        parentCommentId: comments.parentCommentId,
        retrievedAt: new Date().toISOString(),
      };
    }, signal);
  }

  setFritidsschemaTimes(
    request: FritidsschemaTimesRequest,
    signal?: AbortSignal,
  ): Promise<FritidsschemaTimesResult> {
    const input = fritidsschemaTimesRequestSchema.parse(request);

    return this.read(async (http, activeSignal) => {
      const parent = await http.readParent(activeSignal, input.childId);

      if (!parent.apps.some((app) => app.codeName === "timeregistration"))
        throw new InfoMentorError(
          "INVALID_CONFIGURATION",
          "This InfoMentor account does not provide a fritidsschema.",
        );

      const registrations = await http.readAppData(
        "TimeRegistration/TimeRegistration/GetTimeRegistrations/",
        {
          date: input.date,
          showNextWeekIfNoMoreSchoolDays: "true",
        },
        timeRegistrationsResponseSchema,
        activeSignal,
      );

      const day = registrations.days.find((item) => datePart(item.date) === input.date);

      if (!day)
        throw new InfoMentorError(
          "INVALID_CONFIGURATION",
          "No fritidsschema entry was found for the requested date.",
        );

      if (!day.canEdit || day.isLocked || day.isSchoolClosed)
        throw new InfoMentorError(
          "INVALID_CONFIGURATION",
          "The fritidsschema times cannot be edited for the requested date.",
        );

      const expectedEndDate = addLocalDate(input.date, input.endTimeNextDay ? 1 : 0);
      const currentStartDate = day.startDateTime ? datePart(day.startDateTime) : undefined;
      const currentEndDate = day.endDateTime ? datePart(day.endDateTime) : undefined;

      const alreadyMatches =
        !day.onLeave &&
        currentStartDate === input.date &&
        currentEndDate === expectedEndDate &&
        timePart(day.startDateTime) === input.startTime &&
        timePart(day.endDateTime) === input.endTime;

      if (!alreadyMatches) {
        const saved = await http.writeJsonAppData(
          "TimeRegistration/TimeRegistration/SaveTimeRegistrations/",
          buildSaveTimeRegistrationsPayload(day, input),
          saveTimeRegistrationsResponseSchema,
          activeSignal,
        );

        if (!saved.success)
          throw new InfoMentorError(
            "UNEXPECTED_PAGE",
            "InfoMentor did not save the fritidsschema times.",
          );
      }

      const verifiedRegistrations = await http.readAppData(
        "TimeRegistration/TimeRegistration/GetTimeRegistrations/",
        {
          date: input.date,
          showNextWeekIfNoMoreSchoolDays: "true",
        },
        timeRegistrationsResponseSchema,
        activeSignal,
      );

      const verifiedDay = verifiedRegistrations.days.find(
        (item) => datePart(item.date) === input.date,
      );

      if (!verifiedDay)
        throw new InfoMentorError(
          "UNEXPECTED_PAGE",
          "InfoMentor reported success but the fritidsschema times could not be verified.",
        );

      const verifiedStartDateTime = verifiedDay.startDateTime;
      const verifiedEndDateTime = verifiedDay.endDateTime;

      if (
        verifiedDay.onLeave ||
        verifiedStartDateTime === null ||
        verifiedEndDateTime === null ||
        datePart(verifiedStartDateTime) !== input.date ||
        datePart(verifiedEndDateTime) !== expectedEndDate ||
        timePart(verifiedStartDateTime) !== input.startTime ||
        timePart(verifiedEndDateTime) !== input.endTime
      )
        throw new InfoMentorError(
          "UNEXPECTED_PAGE",
          "InfoMentor reported success but the fritidsschema times could not be verified.",
        );

      return {
        childId: input.childId,
        date: input.date,
        timeRegistrationId: verifiedDay.timeRegistrationId,
        startDateTime: verifiedStartDateTime,
        endDateTime: verifiedEndDateTime,
        startTime: input.startTime,
        endTime: input.endTime,
        endTimeNextDay: input.endTimeNextDay,
        changed: !alreadyMatches,
        verified: true,
      };
    }, signal);
  }

  setFritidsschemaComment(
    request: FritidsschemaCommentRequest,
    signal?: AbortSignal,
  ): Promise<FritidsschemaCommentResult> {
    const input = fritidsschemaCommentRequestSchema.parse(request);

    return this.read(async (http, activeSignal) => {
      const { day, comments } = await this.readFritidsschemaCommentContext(
        http,
        input,
        activeSignal,
      );

      if (!comments.canEdit || comments.timesLockedBySchool)
        throw new InfoMentorError(
          "INVALID_CONFIGURATION",
          "The fritidsschema comment cannot be edited for the requested date.",
        );

      const saved = await http.writeAppData(
        "TimeRegistration/TimeRegistration/SaveComment/",
        buildSaveCommentFields({
          timeRegistrationId: day.timeRegistrationId,
          parentCommentId: comments.parentCommentId,
          commentText: input.comment,
        }),
        saveCommentResponseSchema,
        activeSignal,
      );

      if (!saved.success)
        throw new InfoMentorError(
          "UNEXPECTED_PAGE",
          "InfoMentor did not save the fritidsschema comment.",
        );

      // SaveComment returns a success flag, but reading the record back is the
      // authoritative confirmation that the school system stored the text.
      const verified = await this.readFritidsschemaComments(http, day.date, activeSignal);

      if (verified.userComment !== input.comment)
        throw new InfoMentorError(
          "UNEXPECTED_PAGE",
          "InfoMentor reported success but the fritidsschema comment could not be verified.",
        );

      return {
        childId: input.childId,
        date: input.date,
        timeRegistrationId: day.timeRegistrationId,
        comment: input.comment,
        verified: true,
      };
    }, signal);
  }

  collectUpdates(request: CollectRequest = {}, signal?: AbortSignal): Promise<Collection> {
    const input = collectRequestSchema.parse(request);
    const deadline = AbortSignal.timeout(5 * 60_000);
    const collectionSignal = signal ? AbortSignal.any([signal, deadline]) : deadline;

    return this.read((http, activeSignal) => {
      let cachedParent = http.parent;
      const notificationFeeds = new Map<string, NotificationFeed>();
      const resolverCaches: ResolverCaches = {
        newsFeeds: new Map(),
        calendarFeeds: new Map(),
      };

      const getParent = (nextSignal: AbortSignal) => {
        if (cachedParent) {
          const parent = cachedParent;
          cachedParent = undefined;

          return Promise.resolve(parent);
        }

        return http.readParent(nextSignal);
      };

      return collectUpdates(input, {
        sessionFile: sessionPath(this.options.sessionFile),
        signal: activeSignal,
        getParent,
        selectChild: (childId, nextSignal) => http.readParent(nextSignal, childId),
        readTimetable: async (parent, nextSignal) =>
          parent.apps.some((app) => app.codeName === "timetable")
            ? await http.readAppData(
                "timetable/timetable/appData",
                {},
                timetableResponseSchema,
                nextSignal,
              )
            : null,
        getMessages: (folder, page, nextSignal) =>
          http.readAppData(
            "Message/message/GetMessages",
            {
              page: String(page),
              pageSize: "100",
              messageText: "",
              inbox: String(folder === "inbox"),
              sentItems: String(folder === "sent"),
            },
            messagesPageResponseSchema,
            nextSignal,
          ),
        getMessage: (id, nextSignal) =>
          http.readAppData(
            "Message/message/GetMessage",
            { id: String(id) },
            messageDetailSchema,
            nextSignal,
          ),
        getNotifications: async (nextSignal) => {
          const selectedChildId =
            http.parent?.account.pupils.find((pupil) => pupil.selected)?.id ?? "";
          const cached = notificationFeeds.get(selectedChildId);
          if (cached) return cached;

          const feed = await http.readAppData(
            "NotificationApp/NotificationApp/appData",
            {},
            notificationsResponseSchema,
            nextSignal,
          );
          notificationFeeds.set(selectedChildId, feed);
          return feed;
        },
        resolveNewsItem: (notificationId, nextSignal, notification) =>
          this.resolveNewsItem(http, notificationId, nextSignal, notification, resolverCaches),
        resolveCalendarEvent: (notificationId, nextSignal, notification) =>
          this.resolveCalendarEvent(http, notificationId, nextSignal, notification, resolverCaches),
      });
    }, collectionSignal);
  }

  private currentSelectedChildId(http: InfoMentorHttp): string {
    const selected = http.parent?.account.pupils.filter((pupil) => pupil.selected) ?? [];

    if (selected.length !== 1 || !selected[0])
      throw new InfoMentorError(
        "UNEXPECTED_PAGE",
        "InfoMentor did not identify exactly one selected child. Refresh infomentor_get_overview before continuing.",
      );

    return selected[0].id;
  }

  /** Selects and verifies an optional target, then returns the effective context. */
  private async ensureSelectedChild(
    http: InfoMentorHttp,
    signal: AbortSignal,
    childId?: string,
  ): Promise<string> {
    const current = this.currentSelectedChildId(http);
    if (childId === undefined || childId === current) return current;

    await http.readParent(signal, childId);
    const verified = this.currentSelectedChildId(http);

    if (verified !== childId)
      throw new InfoMentorError(
        "UNEXPECTED_PAGE",
        "InfoMentor did not confirm the requested child. Selection may have changed; refresh infomentor_get_overview before continuing.",
      );

    return verified;
  }

  private async overview(
    http: InfoMentorHttp,
    signal: AbortSignal,
    childId?: string,
  ): Promise<Overview> {
    let selectionAttempted = false;

    try {
      selectionAttempted = childId !== undefined;

      const parent =
        childId === undefined && http.parent ? http.parent : await http.readParent(signal, childId);

      const hasTimetable = parent.apps.some((app) => app.codeName === "timetable");
      let timetable: Overview["timetable"] = null;
      let skipped = 0;

      if (hasTimetable) {
        const feed = await http.readAppData(
          "timetable/timetable/appData",
          {},
          timetableResponseSchema,
          signal,
        );

        timetable = feed.items;
        skipped = feed.skipped;
      }

      const lines = parent.account.pupils.map(
        (pupil) => `${pupil.name}${pupil.selected ? " (selected)" : ""}`,
      );

      if (timetable)
        for (const item of timetable)
          lines.push(`${item.start}: ${item.title} (${item.startTime}–${item.endTime})`);
      const text = lines.join("\n");

      return {
        title: "InfoMentor parent overview",
        text: text.slice(0, 40_000),
        truncated: text.length > 40_000,
        children: parent.account.pupils.map(({ id, name, selected }) => ({ id, name, selected })),
        timetable,
        skipped,
        retrievedAt: new Date().toISOString(),
      };
    } catch (cause) {
      if (!selectionAttempted) throw cause;
      const error = cause instanceof InfoMentorError ? cause : undefined;

      throw new InfoMentorError(
        error?.code ?? "UNEXPECTED_PAGE",
        "InfoMentor could not load the selected child. Selection may have changed; refresh infomentor_get_overview before continuing.",
        error?.retryAfterMs,
      );
    }
  }

  getMessages(request: MessagesRequest = {}, signal?: AbortSignal): Promise<Messages> {
    const input = messagesRequestSchema.parse(request);

    return this.read(async (http, activeSignal) => {
      const selectedChildId = await this.ensureSelectedChild(http, activeSignal, input.childId);
      const data = await http.readAppData(
        "Message/message/GetMessages",
        {
          page: String(input.page),
          pageSize: String(input.pageSize),
          messageText: input.search,
          inbox: String(input.folder === "inbox"),
          sentItems: String(input.folder === "sent"),
        },
        messagesPageResponseSchema,
        activeSignal,
      );

      // The live endpoint reports page: 0 even when it correctly applies a requested page.
      return {
        ...data,
        page: input.page,
        pageSize: input.pageSize,
        folder: input.folder,
        selectedChildId,
        retrievedAt: new Date().toISOString(),
      };
    }, signal);
  }

  getMessage(request: MessageRequest, signal?: AbortSignal): Promise<Message> {
    const input = messageRequestSchema.parse(request);

    return this.read(async (http, activeSignal) => {
      const selectedChildId = await this.ensureSelectedChild(http, activeSignal, input.childId);

      return {
        selectedChildId,
        message: await http.readAppData(
          "Message/message/GetMessage",
          { id: String(input.id) },
          messageDetailSchema,
          activeSignal,
        ),
        retrievedAt: new Date().toISOString(),
      };
    }, signal);
  }

  searchNews(request: NewsSearchRequest, signal?: AbortSignal): Promise<NewsSearch> {
    const input = newsSearchRequestSchema.parse(request);

    return this.read(async (http, activeSignal) => {
      const originalParent = http.parent ?? (await http.readParent(activeSignal));
      const originalChildId = originalParent.account.pupils.find((pupil) => pupil.selected)?.id;

      if (!originalChildId)
        throw new InfoMentorError(
          "UNEXPECTED_PAGE",
          "InfoMentor did not identify the currently selected child.",
        );

      const switchedChild = input.childId !== originalChildId;
      if (switchedChild) await http.readParent(activeSignal, input.childId);

      try {
        const feed = await http.readJsonAppData(
          "Communication/News/GetNewsList",
          { pageSize: -1, sortBy: "lastPublishDate___SORT_DESC" },
          newsListResponseSchema,
          activeSignal,
        );
        const rows = feed.items.filter((row) => {
          const date = newsRowDate(row);
          return date !== undefined && date >= input.fromDate && date <= input.toDate;
        });

        return newsSearchSchema.parse({
          childId: input.childId,
          fromDate: input.fromDate,
          toDate: input.toDate,
          items: rows.map((row) => buildNewsContent(row, feed.skipped)),
          skipped: feed.skipped,
          retrievedAt: new Date().toISOString(),
        });
      } finally {
        if (switchedChild) await http.readParent(activeSignal, originalChildId);
      }
    }, signal);
  }

  /** Resolve a CalendarV2 notification ID to its full authenticated calendar event. */
  getCalendarEvent(request: CalendarEventRequest, signal?: AbortSignal): Promise<CalendarEvent> {
    const { notificationId } = calendarEventRequestSchema.parse(request);
    return this.read(
      (http, activeSignal) => this.resolveCalendarEvent(http, notificationId, activeSignal),
      signal,
    );
  }

  private async resolveCalendarEvent(
    http: InfoMentorHttp,
    notificationId: number,
    signal: AbortSignal,
    suppliedNotification?: Notification,
    resolverCaches?: ResolverCaches,
  ): Promise<CalendarEvent> {
    let notification = suppliedNotification;

    if (!notification) {
      const notifications = await http.readAppData(
        "NotificationApp/NotificationApp/appData",
        {},
        notificationsResponseSchema,
        signal,
      );
      notification = notifications.notifications.find((item) => item.id === notificationId);
    }

    if (!notification)
      throw new InfoMentorError(
        "INVALID_CONFIGURATION",
        "The requested InfoMentor notification is not available in the current feed.",
      );

    if (
      notification.appType !== "CalendarV2" &&
      !notification.type.toLowerCase().startsWith("calendarv2")
    )
      throw new InfoMentorError(
        "INVALID_CONFIGURATION",
        "The requested InfoMentor notification is not a CalendarV2 event.",
      );

    const eventId = calendarEventIdFromNotificationUrl(notification.url);
    if (!eventId)
      throw new InfoMentorError(
        "UNEXPECTED_PAGE",
        "InfoMentor returned a CalendarV2 notification without a supported event ID.",
      );

    const currentParent = http.parent;
    const originalChildId = currentParent?.account.pupils.find((pupil) => pupil.selected)?.id;
    const targetChildId = childIdFromPupilSourceId(notification.pupilSourceId);

    if (!originalChildId)
      throw new InfoMentorError(
        "UNEXPECTED_PAGE",
        "InfoMentor did not identify the currently selected child.",
      );

    if (!targetChildId)
      throw new InfoMentorError(
        "UNEXPECTED_PAGE",
        "InfoMentor returned a CalendarV2 notification without a supported child ID.",
      );

    const switchedChild = targetChildId !== originalChildId;
    if (switchedChild) await http.readParent(signal, targetChildId);

    try {
      const range = calendarRangeFromNotification(notification.url, notification.dateSent);
      const feedKey = JSON.stringify([targetChildId, range]);
      let feedPromise = resolverCaches?.calendarFeeds.get(feedKey);
      if (!feedPromise) {
        feedPromise = http.readJsonAppData(
          "calendarv2/calendarv2/getentries",
          range,
          calendarEntriesResponseSchema,
          signal,
        );
        resolverCaches?.calendarFeeds.set(feedKey, feedPromise);
      }
      const feed = await feedPromise;
      const row = feed.items.find((item) => item.id === eventId);

      if (!row)
        throw new InfoMentorError(
          "UNEXPECTED_PAGE",
          "InfoMentor did not return the requested CalendarV2 event in its authenticated calendar feed.",
        );

      return buildCalendarEvent(notification, row, targetChildId, feed.skipped);
    } finally {
      if (switchedChild) await http.readParent(signal, originalChildId);
    }
  }

  /** Resolve a NewsItem notification ID to its full authenticated news record. */
  getNewsItem(request: NewsItemRequest, signal?: AbortSignal): Promise<NewsItem> {
    const { notificationId } = newsItemRequestSchema.parse(request);
    return this.read(
      (http, activeSignal) => this.resolveNewsItem(http, notificationId, activeSignal),
      signal,
    );
  }

  private async resolveNewsItem(
    http: InfoMentorHttp,
    notificationId: number,
    signal: AbortSignal,
    suppliedNotification?: Notification,
    resolverCaches?: ResolverCaches,
  ): Promise<NewsItem> {
    let notification = suppliedNotification;

    if (!notification) {
      const notifications = await http.readAppData(
        "NotificationApp/NotificationApp/appData",
        {},
        notificationsResponseSchema,
        signal,
      );
      notification = notifications.notifications.find((item) => item.id === notificationId);
    }

    if (!notification)
      throw new InfoMentorError(
        "INVALID_CONFIGURATION",
        "The requested InfoMentor notification is not available in the current feed.",
      );

    if (notification.type !== "NewsItem")
      throw new InfoMentorError(
        "INVALID_CONFIGURATION",
        "The requested InfoMentor notification is not a NewsItem.",
      );

    const newsId = newsIdFromNotificationUrl(notification.url);

    if (!newsId)
      throw new InfoMentorError(
        "UNEXPECTED_PAGE",
        "InfoMentor returned a NewsItem notification without a supported news ID.",
      );

    const currentParent = http.parent;
    const originalChildId = currentParent?.account.pupils.find((pupil) => pupil.selected)?.id;
    const targetChildId = childIdFromPupilSourceId(notification.pupilSourceId);

    if (!originalChildId)
      throw new InfoMentorError(
        "UNEXPECTED_PAGE",
        "InfoMentor did not identify the currently selected child.",
      );

    if (!targetChildId)
      throw new InfoMentorError(
        "UNEXPECTED_PAGE",
        "InfoMentor returned a NewsItem notification without a supported child ID.",
      );

    const switchedChild = targetChildId !== originalChildId;

    if (switchedChild) await http.readParent(signal, targetChildId);

    try {
      const feedKey = targetChildId;
      let feedPromise = resolverCaches?.newsFeeds.get(feedKey);
      if (!feedPromise) {
        feedPromise = http.readJsonAppData(
          "Communication/News/GetNewsList",
          { pageSize: -1, sortBy: "lastPublishDate___SORT_DESC" },
          newsListResponseSchema,
          signal,
        );
        resolverCaches?.newsFeeds.set(feedKey, feedPromise);
      }
      const feed = await feedPromise;
      const row = feed.items.find((item) => item.id === newsId);

      if (!row)
        throw new InfoMentorError(
          "UNEXPECTED_PAGE",
          "InfoMentor did not return the requested NewsItem in its authenticated news feed.",
        );

      return buildNewsItem(notification, row, feed.skipped);
    } finally {
      if (switchedChild) await http.readParent(signal, originalChildId);
    }
  }

  getNotifications(
    request: NotificationsRequest = {},
    signal?: AbortSignal,
  ): Promise<Notifications> {
    const input = notificationsRequestSchema.parse(request);

    return this.read(async (http, activeSignal) => {
      const selectedChildId = await this.ensureSelectedChild(http, activeSignal, input.childId);
      const data = await http.readAppData(
        "NotificationApp/NotificationApp/appData",
        {},
        notificationsResponseSchema,
        activeSignal,
      );

      return {
        childId: selectedChildId,
        notifications: data.notifications.filter(
          (item) =>
            (input.includeCleared || item.state !== "Cleared") &&
            (!input.selectedChildOnly || item.currentlySelectedPupil),
        ),
        skipped: data.skipped,
        selectedChildOnly: input.selectedChildOnly,
        includeCleared: input.includeCleared,
        retrievedAt: new Date().toISOString(),
      };
    }, signal);
  }

  async getSessionStatus(signal?: AbortSignal): Promise<SessionStatus> {
    try {
      return await this.read(async () => ({ authenticated: true }), signal);
    } catch (error) {
      if (error instanceof InfoMentorError && error.code === "LOGIN_REQUIRED")
        return { authenticated: false, nextStep: error.message };
      throw error;
    }
  }

  startLogin(request: LoginRequest = {}): SetupStatus {
    const parsed = loginRequestSchema.parse(request);

    if (parsed.importFile && parsed.credentialsFile)
      throw new InfoMentorError(
        "INVALID_CONFIGURATION",
        "Choose session import or login, not both.",
      );

    if (this.closed)
      throw new InfoMentorError("CANCELLED", "This InfoMentor client has been closed.");

    if (this.setup || this.loggingOut)
      throw new InfoMentorError(
        "OPERATION_IN_PROGRESS",
        "Another setup operation is active. Check its status or cancel it first.",
      );
    const operation = parsed.importFile ? "import" : "login";
    const controller = new AbortController();
    this.setupStatus = {
      operation,
      state: "running",
      message: "Setup started. Check infomentor_setup_status for progress.",
    };

    const promise = (async () => {
      await this.pending;
      throwIfAborted(controller.signal);
      this.active = undefined;

      if (parsed.importFile)
        await importSession(
          parsed.importFile,
          { ...this.options, allowAccountChange: parsed.allowAccountChange ?? false },
          controller.signal,
        );
      else {
        const options = {
          ...this.options,
          signal: controller.signal,
          allowAccountChange: parsed.allowAccountChange ?? false,
          timeoutMs: parsed.timeoutSeconds * 1000,
        };

        await login(
          parsed.credentialsFile
            ? { ...options, credentialsFile: parsed.credentialsFile }
            : options,
        );
      }

      this.setupStatus = {
        operation,
        state: "succeeded",
        message: "Session saved. Call infomentor_session_status to verify access.",
      };
    })()
      .catch((cause: unknown) => {
        this.setupStatus = {
          operation,
          state: controller.signal.aborted ? "cancelled" : "failed",
          message: controller.signal.aborted
            ? "Setup cancelled. The previously saved session was kept."
            : cause instanceof InfoMentorError
              ? cause.message
              : "Setup failed. Check the network and session-file permissions.",
        };
      })
      .finally(() => {
        this.setup = undefined;
      });

    this.setup = { controller, promise };

    return this.getSetupStatus();
  }

  getSetupStatus(): SetupStatus {
    return { ...this.setupStatus };
  }
  async cancelSetup(): Promise<SetupStatus> {
    this.setup?.controller.abort();
    await this.setup?.promise;

    return this.getSetupStatus();
  }
  async logout(): Promise<void> {
    if (this.loggingOut)
      throw new InfoMentorError("OPERATION_IN_PROGRESS", "Logout is already in progress.");
    this.loggingOut = true;

    try {
      await this.cancelSetup();
      await this.pending;
      this.active = undefined;
      const file = sessionPath(this.options.sessionFile);
      await withSessionLock(file, undefined, async () => {
        await rm(file, { force: true });
        // Snapshots hold fingerprints and identifiers of the account; they leave with the session.
        await rm(file + ".collections", { recursive: true, force: true });
      });
      this.setupStatus = {
        state: "idle",
        message: "Local session removed. Call infomentor_login to sign in again.",
      };
    } finally {
      this.loggingOut = false;
    }
  }
  async close(): Promise<void> {
    this.closed = true;
    this.lifetime.abort();
    await this.cancelSetup();
    await this.pending;
    this.active = undefined;
  }
}
