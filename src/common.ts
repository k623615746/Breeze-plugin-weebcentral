import type { ActionItem, ImageItem, MetadataListItem, StringMap } from "breeze-plugin-kit";

/** 插件唯一标识 */
export const PLUGIN_ID = "9c4b7a20-1e83-4d5f-8a6b-3d2c9f1e7b45";

export const SITE_ORIGIN = "https://weebcentral.com";
export const COVER_BASE = "https://temp.compsci88.com/cover/fallback";

/**
 * 站点挂在 Cloudflare 后面：不带浏览器 UA 会直接 403。
 * 这是能否访问的前提，不是可选项。
 */
export const USER_AGENT =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

export const PLACEHOLDER_IMAGE_URL = "https://cdn.jsdelivr.net/gh/k623615746/Breeze-plugin-weebcentral@main/assets/icon.png";

export const PAGE_SIZE = 32;

/** 浏览排序选项 */
export const SORTS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "Popularity", label: "人气" },
  { value: "Latest Update", label: "最近更新" },
  { value: "Alphabetical", label: "字母顺序" },
  { value: "Recently Added", label: "最新收录" },
];

export const STATUS_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "Any", label: "全部" },
  { value: "Ongoing", label: "连载中" },
  { value: "Complete", label: "已完结" },
  { value: "Hiatus", label: "休载" },
  { value: "Canceled", label: "已取消" },
];

export const TYPE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "Any", label: "全部" },
  { value: "Manga", label: "日漫" },
  { value: "Manhwa", label: "韩漫" },
  { value: "Manhua", label: "国漫" },
  { value: "OEL", label: "欧美" },
];

export function decodeEntities(input: string): string {
  if (!input || input.indexOf("&") < 0) {
    return input;
  }
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex: string) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec: string) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&nbsp;/g, " ")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function safeFromCodePoint(code: number): string {
  if (!Number.isFinite(code) || code <= 0 || code > 0x10ffff) {
    return "";
  }
  try {
    return String.fromCodePoint(code);
  } catch {
    return "";
  }
}

export function cleanText(input: unknown): string {
  if (typeof input !== "string") {
    return "";
  }
  return decodeEntities(input).replace(/[\s\u3000]+/g, " ").trim();
}

export function absoluteUrl(raw: string | null | undefined): string {
  const value = cleanText(raw);
  if (!value) {
    return "";
  }
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  if (value.startsWith("//")) {
    return `https:${value}`;
  }
  if (value.startsWith("/")) {
    return `${SITE_ORIGIN}${value}`;
  }
  return `${SITE_ORIGIN}/${value}`;
}

export function createImage(input: {
  id?: string;
  url?: string;
  name?: string;
  path?: string;
  extern?: StringMap;
} = {}): ImageItem {
  const url = cleanText(input.url);
  return {
    id: String(input.id ?? ""),
    url: url || PLACEHOLDER_IMAGE_URL,
    name: String(input.name ?? ""),
    path: String(input.path ?? "").trim() || "cover/placeholder.png",
    extern: input.extern ?? {},
  };
}

export function createActionItem(name: string, extern: StringMap = {}): ActionItem {
  return { name: cleanText(name), onTap: null, extern };
}

export function createMetadata(
  type: string,
  name: string,
  values: ReadonlyArray<string>,
): MetadataListItem {
  return {
    type,
    name,
    value: values
      .map((item) => cleanText(item))
      .filter((item) => item.length > 0)
      .map((item) => createActionItem(item)),
  };
}

/** 站点 ULID（26 位 Crockford Base32） */
export function isUlid(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/i.test(value);
}

/** 从 /series/{ULID}/{slug} 里取 ULID */
export function extractUlid(input: string): string {
  const matched = String(input ?? "").match(/([0-9A-HJKMNP-TV-Z]{26})/i);
  return matched ? matched[1] : "";
}

/** 从 slug 还原一个可读标题（兜底用） */
export function titleFromSlug(slug: string): string {
  return cleanText(String(slug ?? "").replace(/[-_]+/g, " "));
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

export type FetchOptions = {
  method?: "GET" | "POST";
  body?: string;
  timeoutMs?: number;
  htmx?: boolean;
  extraHeaders?: Record<string, string>;
};

/** 统一的站点请求：强制浏览器 UA（绕 Cloudflare 403） */
export async function siteFetch(pathOrUrl: string, options: FetchOptions = {}): Promise<string> {
  const url = absoluteUrl(pathOrUrl);
  const headers: Record<string, string> = {
    "User-Agent": USER_AGENT,
    Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
    Referer: `${SITE_ORIGIN}/`,
    ...(options.extraHeaders ?? {}),
  };
  if (options.htmx) {
    headers["HX-Request"] = "true";
  }
  if (options.method === "POST") {
    headers["Content-Type"] = "application/x-www-form-urlencoded; charset=UTF-8";
  }

  // Cloudflare 偶发 403/503（风控抖动）：等待 2 秒重试一次，再失败才报错
  let res = await fetch(url, {
    method: options.method ?? "GET",
    headers,
    body: options.body,
    redirect: "follow",
    signal: AbortSignal.timeout(options.timeoutMs ?? 25000),
  });
  if (res.status === 403 || res.status === 503) {
    await new Promise<void>((resolve) => setTimeout(resolve, 2000));
    res = await fetch(url, {
      method: options.method ?? "GET",
      headers,
      body: options.body,
      redirect: "follow",
      signal: AbortSignal.timeout(options.timeoutMs ?? 25000),
    });
  }

  if (res.status === 403) {
    throw new Error("WeebCentral 拒绝访问（403）：可能触发了 Cloudflare 校验，稍后重试");
  }
  if (!res.ok) {
    throw new Error(`WeebCentral 返回 ${res.status}`);
  }
  return res.text();
}

/** 列表 / 搜索数据端点 */
export function buildSearchPath(params: {
  text?: string;
  author?: string;
  sort?: string;
  order?: string;
  limit?: number;
  offset?: number;
  status?: string;
  type?: string;
}): string {
  const query = new URLSearchParams();
  query.set("text", params.text ?? "");
  if (params.author) {
    query.set("author", params.author);
  }
  query.set("sort", params.sort || "Popularity");
  query.set("order", params.order || "Descending");
  query.set("limit", String(params.limit ?? PAGE_SIZE));
  query.set("offset", String(params.offset ?? 0));
  query.set("display_mode", "Full Display");
  if (params.status && params.status !== "Any") {
    query.set("included_status", params.status);
  }
  if (params.type && params.type !== "Any") {
    query.set("included_type", params.type);
  }
  return `/search/data?${query.toString()}`;
}
