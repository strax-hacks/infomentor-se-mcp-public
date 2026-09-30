import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "bun:test";
import { CookieJar } from "tough-cookie";
import { InfoMentorClient } from "../src/client.js";
import { captureSession, writeSession } from "../src/session.js";

const parentHtml = (selectedChild: string): string => {
  const pupils = [
    {
      id: "child-1",
      name: "Child A",
      selected: selectedChild === "child-1",
      switchPupilUrl: "/Account/PupilSwitcher/SwitchPupil/101",
    },
    {
      id: "child-2",
      name: "Child B",
      selected: selectedChild === "child-2",
      switchPupilUrl: "/Account/PupilSwitcher/SwitchPupil/102",
    },
  ];
  const parent = { account: { currentUser: { id: "parent" }, pupils }, apps: [] };
  return `<script>IMHome.home.homeData = ${JSON.stringify(parent)}; IMHome.home.init(IMHome.home.homeData);</script>`;
};

test("NewsItem resolution selects the notification child, reads the feed, and restores selection", async () => {
  const directory = await mkdtemp(join(tmpdir(), "infomentor-news-client-"));
  const sessionFile = join(directory, "session.json");
  const saved = captureSession(new CookieJar());
  saved.accountId = "parent";
  saved.selectedChildId = "child-2";
  await writeSession(saved, sessionFile);

  let selectedChild = "child-2";
  const requests: Array<{ path: string; method: string; body: string }> = [];

  const fetcher = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : input.toString());
    const method = init?.method ?? "GET";
    const body = typeof init?.body === "string" ? init.body : "";
    requests.push({ path: url.pathname, method, body });

    if (url.pathname === "/" && method === "GET") return new Response(parentHtml(selectedChild));

    if (/^\/Account\/PupilSwitcher\/SwitchPupil\/\d+$/.test(url.pathname) && method === "GET") {
      selectedChild = url.pathname.endsWith("/101") ? "child-1" : "child-2";
      return new Response(null, {
        status: 302,
        headers: { Location: "https://hub.infomentor.se/" },
      });
    }

    if (url.pathname === "/NotificationApp/NotificationApp/appData" && method === "POST") {
      return Response.json({
        notifications: [
          {
            id: 9001001,
            title: "Nyhet publicerad",
            subTitle: "Nyhet",
            subjectsCourses: "",
            dateSent: "2025-01-27T07:03:04",
            appType: "News",
            state: "New",
            type: "NewsItem",
            url: "/#/communication/news/9002001",
            pupilIM2Id: 9003001,
            pupilSourceId: "2372|child-1|TEST_SCHOOL",
            currentlySelectedPupil: selectedChild === "child-1",
          },
        ],
      });
    }

    if (url.pathname === "/Communication/News/GetNewsList" && method === "POST") {
      assert.equal(selectedChild, "child-1");
      return Response.json({
        items: [
          {
            id: 9002001,
            title: "Viktig information",
            content: '<p>Hej <a href="https://example.test/info">läs mer</a>.</p>',
            publishedDate: "2025-01-27T07:03:04",
            publishedDateString: "27 januari 2025",
            publishedBy: "Skolan",
            newsImageUrl: null,
            newsThumbnailImageUrl: null,
            attachments: [],
          },
        ],
      });
    }

    return new Response("unexpected", { status: 404 });
  };

  try {
    const client = new InfoMentorClient({ sessionFile, fetch: fetcher });
    try {
      const result = await client.getNewsItem({ notificationId: 9001001 });
      assert.equal(result.newsId, 9002001);
      assert.equal(result.title, "Viktig information");
      assert.equal(result.bodyText, "Hej läs mer.");
      assert.equal(result.notification.pupilSourceId, "2372|child-1|TEST_SCHOOL");
      assert.equal(selectedChild, "child-2");
      assert.equal(
        requests.filter((request) => request.path === "/Communication/News/GetNewsList").length,
        1,
      );
      assert.equal(
        JSON.parse(
          requests.find((request) => request.path === "/Communication/News/GetNewsList")?.body ??
            "{}",
        ).pageSize,
        -1,
      );
    } finally {
      await client.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
