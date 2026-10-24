import {
  COVER_BASE,
  PLUGIN_ID,
  absoluteUrl,
  cleanText,
  createImage,
  createMetadata,
  extractUlid,
  titleFromSlug,
} from "./common";
import type { ComicListItem } from "breeze-plugin-kit";

type Selection = {
  attr: (name: string) => string | undefined;
  text: () => string;
  html: () => string;
  find: (selector: string) => Selection;
  first: () => Selection;
  each: (fn: (index: number, element: unknown) => void) => void;
  toArray: () => unknown[];
};

type HtmlApi = ((selector: string) => Selection) & { load: (html: string) => HtmlApi };

function html(): HtmlApi {
  return (globalThis as unknown as { BreezeHtml: HtmlApi }).BreezeHtml;
}

function load(htmlText: string): HtmlApi {
  return html().load(htmlText);
}

function size(selection: Selection): number {
  const raw = (selection as unknown as { length?: unknown }).length;
  if (typeof raw === "number") {
    return raw;
  }
  try {
    return selection.toArray().length;
  } catch {
    return 0;
  }
}

function attrOf(selection: Selection, name: string): string {
  return cleanText(selection.attr(name) ?? "");
}

export type SeriesCard = {
  ulid: string;
  slug: string;
  title: string;
  coverUrl: string;
  detailUrl: string;
};

/** 从列表 HTML（/search/data 结果）解析卡片 */
export function parseSeriesList(htmlText: string): SeriesCard[] {
  const $ = load(htmlText);
  const cards: SeriesCard[] = [];
  const seen = new Set<string>();

  $("a").each((_, element) => {
    const $a = $(element as never);
    const href = attrOf($a, "href");
    if (!href.includes("/series/")) {
      return;
    }
    const ulid = extractUlid(href);
    if (!ulid || seen.has(ulid)) {
      return;
    }
    const $img = $a.find("img").first();
    const alt = attrOf($img, "alt");
    const src = attrOf($img, "src");
    if (!alt && !src) {
      return;
    }
    seen.add(ulid);
    const slug = href.replace(/.*\/series\/[^/]+\/?/, "").split("?")[0];
    const title = alt.replace(/\s+cover$/i, "").trim() || titleFromSlug(slug);
    cards.push({
      ulid,
      slug,
      title,
      coverUrl: src || `${COVER_BASE}/${ulid}.jpg`,
      detailUrl: absoluteUrl(href),
    });
  });

  return cards;
}

export function toComicListItem(card: SeriesCard): ComicListItem {
  return {
    source: PLUGIN_ID,
    id: card.ulid,
    title: card.title,
    subtitle: "",
    finished: false,
    likesCount: 0,
    viewsCount: 0,
    updatedAt: "",
    cover: createImage({
      id: card.ulid,
      url: card.coverUrl,
      name: card.title,
      path: `comic/${card.ulid}/cover.jpg`,
      extern: {},
    }),
    metadata: [],
    raw: { ulid: card.ulid, slug: card.slug, detailUrl: card.detailUrl },
    extern: {},
  };
}

export type SeriesDetail = {
  ulid: string;
  title: string;
  author: string;
  authors: string[];
  tags: string[];
  type: string;
  status: string;
  released: string;
  description: string;
  coverUrl: string;
  finished: boolean;
};

/** 解析系列详情页 */
export function parseSeriesDetail(htmlText: string, ulid: string): SeriesDetail {
  const $ = load(htmlText);

  const pageTitle = cleanText($("title").first().text()).replace(/\s*\|\s*Weeb Central$/i, "");
  const heading = size($("h1")) > 0 ? cleanText($("h1").first().text()) : "";
  const title = heading || pageTitle || `未命名-${ulid.slice(0, 8)}`;

  // 元信息以固定标签形式出现在正文里，用正则从纯文本中提取最稳
  const bodyText = cleanText($("main").text() || $("body").text());

  const authorMatch = bodyText.match(/Author\(s\):\s*(.+?)\s*(?:Tags?\(s\)|Type:|Status:|Released:|Official)/i);
  const authors = authorMatch
    ? authorMatch[1]
        .split(/[,，]/)
        .map((item) => cleanText(item))
        .filter((item) => item.length > 0 && item.length < 80)
    : [];

  const tagsMatch = bodyText.match(/Tags?\(s\):\s*(.+?)\s*(?:Type:|Status:|Released:|Official|Anime)/i);
  const tags = tagsMatch
    ? tagsMatch[1]
        .split(/[,，]/)
        .map((item) => cleanText(item))
        .filter((item) => item.length > 0 && item.length < 40)
    : [];

  const typeMatch = bodyText.match(/Type:\s*([A-Za-z]+)/i);
  const statusMatch = bodyText.match(/Status:\s*([A-Za-z]+)/i);
  const releasedMatch = bodyText.match(/Released:\s*(\d{4})/i);
  const descMatch = bodyText.match(/Description:\s*(.+?)(?:Author\(s\)|Tags?\(s\)|Type:|Read)/i);

  const status = statusMatch ? statusMatch[1] : "";

  return {
    ulid,
    title,
    author: authors[0] ?? "",
    authors,
    tags,
    type: typeMatch ? typeMatch[1] : "",
    status,
    released: releasedMatch ? releasedMatch[1] : "",
    description: descMatch ? cleanText(descMatch[1]).slice(0, 4000) : "",
    coverUrl: `${COVER_BASE}/${ulid}.jpg`,
    finished: /complete/i.test(status),
  };
}

export type ChapterEntry = {
  ulid: string;
  name: string;
};

/** 解析完整章节列表（/series/{ulid}/full-chapter-list） */
export function parseChapterList(htmlText: string): ChapterEntry[] {
  const $ = load(htmlText);
  const entries: ChapterEntry[] = [];
  const seen = new Set<string>();

  $("a").each((_, element) => {
    const $a = $(element as never);
    const href = attrOf($a, "href");
    if (!href.includes("/chapters/")) {
      return;
    }
    const ulid = extractUlid(href);
    if (!ulid || seen.has(ulid)) {
      return;
    }
    seen.add(ulid);

    // 章节名在链接内第一个文本 span 里，图标与徽标需排除
    const inner = $a.html() ?? "";
    const spanMatch = inner.match(/<span class="[^"]*">([^<]{1,120})<\/span>/);
    let name = spanMatch ? cleanText(spanMatch[1]) : "";
    if (!name) {
      name = cleanText($a.text()).slice(0, 80);
    }
    entries.push({ ulid, name: name || `章节 ${ulid.slice(-6)}` });
  });

  return entries;
}

/** 解析章节页图片列表 */
export function parseChapterImages(htmlText: string): string[] {
  const $ = load(htmlText);
  const urls: string[] = [];

  $("img").each((_, element) => {
    const $img = $(element as never);
    const src = attrOf($img, "src") || attrOf($img, "data-src");
    if (!src) {
      return;
    }
    if (/\/static\//.test(src) || /brand|logo|icon|avatar|badge/i.test(src)) {
      return;
    }
    if (!/\.(?:jpe?g|png|webp|avif|gif)(?:\?|$)/i.test(src) && !src.includes("planeptune")) {
      return;
    }
    const url = absoluteUrl(src);
    if (url && !urls.includes(url)) {
      urls.push(url);
    }
  });

  return urls;
}

export { createMetadata };
