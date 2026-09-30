import assert from "node:assert/strict";
import { test } from "bun:test";
import { buildNewsItem, newsIdFromNotificationUrl, newsListResponseSchema } from "../src/news.js";

const notification = {
  id: 9001001,
  title: "Nyhet publicerad",
  subTitle: "Nyhet",
  subjectsCourses: "",
  dateSent: "2025-01-27T07:03:04",
  appType: "News",
  state: "New",
  type: "NewsItem",
  url: "/#/communication/news/9002001",
  pupilIM2Id: 1,
  pupilSourceId: "child",
  currentlySelectedPupil: true,
};

test("resolves the exact news ID from a NewsItem notification URL", () => {
  assert.equal(newsIdFromNotificationUrl("/#/communication/news/9002001"), 9002001);
  assert.equal(newsIdFromNotificationUrl("/#/communication/calendar/9002001"), undefined);
  assert.equal(newsIdFromNotificationUrl("/#/communication/news/not-a-number"), undefined);
});

test("parses a news feed, skips malformed rows, and extracts inert content", () => {
  const feed = newsListResponseSchema.parse({
    items: [
      {
        id: 9002001,
        title: "School news",
        content:
          '<h2>Heading</h2><p>Hello <strong>family</strong>.</p><p><a href="/calendar">Calendar</a> <a href="javascript:alert(1)">unsafe</a><br>Tomorrow<img src="/image.png" alt="School image"></p>',
        publishedDate: "2025-01-27T07:03:04",
        publishedDateString: "27 januari 2025",
        publishedBy: "School",
        newsImageUrl: "/hero.png",
        newsThumbnailImageUrl: null,
        attachments: [{ title: "Letter PDF", url: "/Resources/Resource/Download/1" }],
      },
      { id: "not-a-news-id" },
    ],
  });

  assert.equal(feed.items.length, 1);
  assert.equal(feed.skipped, 1);
  const item = buildNewsItem(notification, feed.items[0]!, feed.skipped);
  assert.equal(item.newsId, 9002001);
  assert.match(item.bodyText, /Hello family\./);
  assert.match(item.bodyText, /Tomorrow/);
  assert.equal(item.links.length, 1);
  assert.equal(item.links[0]?.href, "https://hub.infomentor.se/calendar");
  assert.equal(item.images.length, 2);
  assert.equal(
    item.attachments[0]?.href,
    "https://hub.infomentor.se/Resources/Resource/Download/1",
  );
  assert.doesNotMatch(
    JSON.stringify({ links: item.links, images: item.images, attachments: item.attachments }),
    /javascript:/,
  );
});

test("accepts the upstream array response shape", () => {
  const feed = newsListResponseSchema.parse([{ id: 1, title: "one", content: "body" }]);
  assert.equal(feed.items[0]?.id, 1);
  assert.equal(feed.items[0]?.title, "one");
});
