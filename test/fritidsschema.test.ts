import * as assert from "node:assert/strict";
import { test } from "bun:test";
import { InfoMentorHttp } from "../src/http.js";
import {
  buildSaveCommentFields,
  buildSaveTimeRegistrationsPayload,
  commentsResponseSchema,
  fritidsschemaDateSchema,
  fritidsschemaTimesRequestSchema,
  saveCommentResponseSchema,
  saveTimeRegistrationsResponseSchema,
  timePart,
  timeRegistrationsResponseSchema,
} from "../src/fritidsschema.js";

const registration = {
  timeRegistrationId: 7001001,
  date: "2025-01-20T00:00:00",
  startDateTime: "2025-01-20T08:00:00",
  endDateTime: "2025-01-20T15:10:00",
  onLeave: false,
  isLocked: false,
  isSchoolClosed: false,
  canEdit: false,
  hasUnreadComments: false,
  hasComments: true,
  canEditComment: true,
};

test("fritidsschema dates require the explicit YYYY-MM-DD shape", () => {
  assert.equal(fritidsschemaDateSchema.parse("2025-01-24"), "2025-01-24");
  assert.throws(() => fritidsschemaDateSchema.parse("2026-9-25"));
  assert.throws(() => fritidsschemaDateSchema.parse("2025-01-24T00:00:00"));
  assert.throws(() => fritidsschemaDateSchema.parse("2026-02-30"));
});

test("fritidsschema time requests validate ordering and explicit next-day pickup", () => {
  assert.deepEqual(
    fritidsschemaTimesRequestSchema.parse({
      childId: "child-1",
      date: "2025-01-24",
      startTime: "22:00",
      endTime: "01:00",
      endTimeNextDay: true,
    }),
    {
      childId: "child-1",
      date: "2025-01-24",
      startTime: "22:00",
      endTime: "01:00",
      endTimeNextDay: true,
    },
  );
  assert.throws(() =>
    fritidsschemaTimesRequestSchema.parse({
      childId: "child-1",
      date: "2025-01-24",
      startTime: "15:00",
      endTime: "14:59",
    }),
  );
});

test("fritidsschema response keeps valid rows and counts malformed rows", () => {
  const parsed = timeRegistrationsResponseSchema.parse({
    startDate: "2025-01-20T00:00:00",
    endDate: "2025-01-26T00:00:00",
    days: [registration, { date: "malformed" }],
  });

  assert.equal(parsed.days.length, 1);
  assert.equal(parsed.days[0]?.timeRegistrationId, 7001001);
  assert.equal(parsed.skipped, 1);
  assert.equal(timePart(registration.startDateTime), "08:00");
  assert.equal(timePart(registration.endDateTime), "15:10");
});

test("comment payload preserves text and reuses the parent comment id", () => {
  assert.deepEqual(
    buildSaveCommentFields({
      timeRegistrationId: 7001001,
      parentCommentId: 8001001,
      commentText: "Barnet går hem efter skolan",
    }),
    {
      commentId: "8001001",
      commentText: "Barnet går hem efter skolan",
      timeRegistrationId: "7001001",
    },
  );

  assert.deepEqual(
    buildSaveCommentFields({
      timeRegistrationId: 7001002,
      parentCommentId: null,
      commentText: "Barnet går hem efter skolan",
    }),
    {
      commentId: "0",
      commentText: "Barnet går hem efter skolan",
      timeRegistrationId: "7001002",
    },
  );
});

test("comment and save response schemas accept the live endpoint shapes", () => {
  const comments = commentsResponseSchema.parse({
    date: "2025-01-20T00:00:00",
    teacherComment: "ok",
    teacherName: "Personal",
    teacherCommentDate: "2025-01-20T06:33:14",
    userComment: "Barnet går hem efter skolan",
    userName: "Parent",
    userCommentDate: "2025-01-18T13:56:56",
    checkedIn: "14:32",
    checkedOut: "15:23",
    canEdit: true,
    timesLockedBySchool: false,
    parentCommentId: 8001001,
    checkInUserDisplayName: "Personal",
    checkOutUserDisplayName: "Personal",
    canEditComment: false,
  });

  assert.equal(comments.userComment, "Barnet går hem efter skolan");
  assert.deepEqual(saveCommentResponseSchema.parse({ success: true, notifications: [] }), {
    success: true,
    notifications: [],
  });
  assert.deepEqual(
    saveTimeRegistrationsResponseSchema.parse({ success: true, notifications: [] }),
    {
      success: true,
      notifications: [],
    },
  );
});

test("time payload preserves the provider row and uses the JSON write contract", () => {
  assert.deepEqual(
    buildSaveTimeRegistrationsPayload(registration, {
      startTime: "22:00",
      endTime: "01:00",
      endTimeNextDay: true,
    }),
    {
      days: [
        {
          ...registration,
          onLeave: false,
          startDateTime: "2025-01-20T22:00:00",
          endDateTime: "2025-01-21T01:00:00",
          registrationType: "TimeReg",
          commentText: "",
          isCommentUpdated: false,
          commentId: 0,
        },
      ],
      series: null,
    },
  );
});

test("writeAppData posts form fields and parses the JSON response", async () => {
  let request: { url: string; method: string; body: string } | undefined;

  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    request = {
      url: input instanceof Request ? input.url : input instanceof URL ? input.href : input,
      method: init?.method ?? "GET",
      body: await new Response(init?.body ?? null).text(),
    };

    return new Response(JSON.stringify({ success: true, notifications: [] }), { status: 200 });
  };

  const http = new InfoMentorHttp(undefined, 0, fetcher);

  const result = await http.writeAppData(
    "TimeRegistration/TimeRegistration/SaveComment/",
    {
      commentId: "0",
      commentText: "Barnet går hem efter skolan",
      timeRegistrationId: "7001002",
    },
    saveCommentResponseSchema,
  );

  assert.deepEqual(result, { success: true, notifications: [] });
  assert.deepEqual(request, {
    url: "https://hub.infomentor.se/TimeRegistration/TimeRegistration/SaveComment/",
    method: "POST",
    body: "commentId=0&commentText=Barnet+g%C3%A5r+hem+efter+skolan&timeRegistrationId=7001002",
  });
});

test("writeJsonAppData posts the exact JSON payload and parses the response", async () => {
  let request: { contentType: string | null; method: string; body: string } | undefined;

  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    void input;
    request = {
      contentType: new Headers(init?.headers).get("content-type"),
      method: init?.method ?? "GET",
      body: await new Response(init?.body ?? null).text(),
    };

    return new Response(JSON.stringify({ success: true, notifications: [] }), { status: 200 });
  };

  const http = new InfoMentorHttp(undefined, 0, fetcher);

  const payload = buildSaveTimeRegistrationsPayload(registration, {
    startTime: "08:00",
    endTime: "16:00",
    endTimeNextDay: false,
  });

  const result = await http.writeJsonAppData(
    "TimeRegistration/TimeRegistration/SaveTimeRegistrations/",
    payload,
    saveTimeRegistrationsResponseSchema,
  );

  assert.deepEqual(result, { success: true, notifications: [] });
  assert.deepEqual(request, {
    contentType: "application/json",
    method: "POST",
    body: JSON.stringify(payload),
  });
});
