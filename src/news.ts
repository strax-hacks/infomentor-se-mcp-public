import { parseDocument } from "htmlparser2";
import { z } from "zod";
import { notificationSchema, PARENT_URL } from "./session.js";

export const newsItemRequestSchema = z
  .object({
    /** The numeric ID from infomentor_get_notifications, not the news-row ID. */
    notificationId: z.number().int().positive(),
  })
  .strict();

export type NewsItemRequest = z.input<typeof newsItemRequestSchema>;

const newsRowIdSchema = z.union([
  z.number().int().positive(),
  z
    .string()
    .regex(/^\d+$/)
    .transform((value) => Number(value)),
]);

const nullableString = z
  .string()
  .nullish()
  .transform((value) => value ?? null);

export const newsItemRowSchema = z
  .object({
    id: newsRowIdSchema,
    title: z
      .string()
      .nullish()
      .transform((value) => value ?? ""),
    content: z
      .string()
      .nullish()
      .transform((value) => value ?? ""),
    publishedDate: nullableString,
    publishedDateString: nullableString,
    publishedBy: nullableString,
    newsImageUrl: nullableString,
    newsThumbnailImageUrl: nullableString,
    attachments: z
      .array(z.unknown())
      .nullish()
      .transform((value) => value ?? []),
  })
  .passthrough();

export type NewsItemRow = z.infer<typeof newsItemRowSchema>;

const rawNewsListResponseSchema = z.union([
  z.array(z.unknown()),
  z.object({ items: z.array(z.unknown()) }),
]);

/** Parse the whole list but retain malformed-row counts for diagnostics. */
export const newsListResponseSchema = rawNewsListResponseSchema.transform((payload) => {
  const rawItems = Array.isArray(payload) ? payload : payload.items;
  const items: NewsItemRow[] = [];
  let skipped = 0;

  for (const rawItem of rawItems) {
    const parsed = newsItemRowSchema.safeParse(rawItem);
    if (parsed.success) items.push(parsed.data);
    else skipped++;
  }

  return { items, skipped };
});

export type NewsListResponse = z.infer<typeof newsListResponseSchema>;

const linkSchema = z.object({ text: z.string(), href: z.string().min(1) });

export const newsItemSchema = z.object({
  notification: notificationSchema,
  newsId: z.number().int().positive(),
  title: z.string(),
  contentHtml: z.string(),
  bodyText: z.string().min(1),
  publishedDate: z.string().nullable(),
  publishedDateString: z.string().nullable(),
  publishedBy: z.string().nullable(),
  newsImageUrl: z.string().nullable(),
  newsThumbnailImageUrl: z.string().nullable(),
  links: z.array(linkSchema),
  images: z.array(linkSchema),
  attachments: z.array(linkSchema),
  skipped: z.number().int().nonnegative(),
  retrievedAt: z.iso.datetime(),
});

export type NewsItem = z.infer<typeof newsItemSchema>;

export function newsIdFromNotificationUrl(url: string): number | undefined {
  const match = /(?:^|\/)news\/(\d+)(?:[/?#]|$)/i.exec(url);
  if (!match?.[1]) return undefined;
  const id = Number(match[1]);
  return Number.isSafeInteger(id) && id > 0 ? id : undefined;
}

/** Extract the registered child ID from InfoMentor's composite pupil source ID. */
export function childIdFromPupilSourceId(sourceId: string): string | undefined {
  const childId = sourceId.split("|")[1]?.trim();
  return childId || undefined;
}

type HtmlNode = {
  type?: string;
  name?: string;
  data?: string;
  attribs?: Record<string, string>;
  children?: HtmlNode[];
};

const blockTags = new Set([
  "address",
  "article",
  "aside",
  "blockquote",
  "div",
  "dl",
  "fieldset",
  "figcaption",
  "figure",
  "footer",
  "form",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "header",
  "li",
  "main",
  "nav",
  "ol",
  "p",
  "pre",
  "section",
  "table",
  "tbody",
  "td",
  "tfoot",
  "th",
  "thead",
  "tr",
  "ul",
]);

function textFromNodes(nodes: readonly HtmlNode[]): string {
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

    const childText = textFromNodes(node.children ?? []);
    if (blockTags.has(node.name ?? "")) output += `\n${childText}\n`;
    else output += childText;
  }

  return output
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function safeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;

  try {
    const url = new URL(value, PARENT_URL);
    return url.protocol === "http:" || url.protocol === "https:" ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function walkContent(
  nodes: readonly HtmlNode[],
  links: Array<{ text: string; href: string }>,
  images: Array<{ text: string; href: string }>,
): void {
  for (const node of nodes) {
    if (node.type === "tag" && node.name === "a") {
      const href = safeHttpUrl(node.attribs?.href);
      if (href) links.push({ text: textFromNodes(node.children ?? []) || href, href });
    }

    if (node.type === "tag" && node.name === "img") {
      const src = safeHttpUrl(node.attribs?.src);
      if (src) images.push({ text: node.attribs?.alt?.trim() ?? "", href: src });
    }

    walkContent(node.children ?? [], links, images);
  }
}

function attachmentLink(value: unknown): { text: string; href: string } | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const href = safeHttpUrl(record.url ?? record.fileUrl ?? record.downloadUrl);
  if (!href) return undefined;
  const text = [record.title, record.name, record.fileName]
    .find((item): item is string => typeof item === "string" && item.trim().length > 0)
    ?.trim();
  return { text: text ?? "Attachment", href };
}

export function buildNewsItem(
  notification: z.infer<typeof notificationSchema>,
  row: NewsItemRow,
  skipped: number,
): NewsItem {
  const document = parseDocument(row.content);
  const root = document.children as unknown as HtmlNode[];
  const links: Array<{ text: string; href: string }> = [];
  const images: Array<{ text: string; href: string }> = [];
  walkContent(root, links, images);

  const primaryImage = safeHttpUrl(row.newsImageUrl);
  if (primaryImage) images.unshift({ text: row.title, href: primaryImage });

  const attachments = row.attachments
    .map(attachmentLink)
    .filter((item): item is { text: string; href: string } => item !== undefined);
  const bodyText = textFromNodes(root);

  return newsItemSchema.parse({
    notification,
    newsId: row.id,
    title: row.title.trim(),
    contentHtml: row.content,
    bodyText,
    publishedDate: row.publishedDate,
    publishedDateString: row.publishedDateString,
    publishedBy: row.publishedBy,
    newsImageUrl: primaryImage ?? null,
    newsThumbnailImageUrl: safeHttpUrl(row.newsThumbnailImageUrl) ?? null,
    links,
    images,
    attachments,
    skipped,
    retrievedAt: new Date().toISOString(),
  });
}
