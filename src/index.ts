import type {
  CapabilitiesBundleContract,
  ChapterContentContract,
  ChapterPayload,
  ChapterSummary,
  ComicDetailContract,
  ComicDetailPayload,
  ComicPagedListContract,
  DownloadConcurrencyResult,
  FetchImageBytesPayload,
  FilterBundleContract,
  InfoContract,
  ReadSnapshotContract,
  ReadSnapshotPayload,
  SearchComicPayload,
  SearchResultContract,
  SettingsBundleContract,
} from "breeze-plugin-kit";
import {
  PAGE_SIZE,
  PLUGIN_ID,
  SORTS,
  STATUS_OPTIONS,
  TYPE_OPTIONS,
  USER_AGENT,
  absoluteUrl,
  buildSearchPath,
  cleanText,
  createImage,
  createMetadata,
  extractUlid,
  siteFetch,
} from "./common";
import {
  parseChapterImages,
  parseChapterList,
  parseSeriesDetail,
  parseSeriesList,
  toComicListItem,
} from "./parse";
import { buildPluginInfo } from "./get-info";
import { authConfig } from "breeze-plugin-kit";
import {
  applyTranslateSettings,
  isDisplayTranslateEnabled,
  translateChapterNames,
  translateListTitles,
  translateTags,
  translateToChinese,
} from "./translate-display";

/** 设置里开了「显示翻译」才生效：把列表标题批量译成中文 */
async function maybeTranslateTitles<T extends { title: string }>(items: T[]): Promise<T[]> {
  if (!(await isDisplayTranslateEnabled())) {
    return items;
  }
  try {
    return await translateListTitles(items);
  } catch {
    return items;
  }
}

/** 英文枚举 → 中文（type/status 固定词，查表比翻译更准） */
function typeZh(value: string): string {
  return TYPE_OPTIONS.find((item) => item.value === value)?.label ?? value;
}
function statusZh(value: string): string {
  return STATUS_OPTIONS.find((item) => item.value === value)?.label ?? value;
}

function toNumber(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? Math.floor(parsed) : fallback;
}

function pickString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return "";
}

// ---------------------------------------------------------------------------
// 列表
// ---------------------------------------------------------------------------

async function fetchList(params: {
  text?: string;
  sort?: string;
  order?: string;
  page: number;
  status?: string;
  type?: string;
}): Promise<{ items: ReturnType<typeof toComicListItem>[]; hasMore: boolean }> {
  const limit = PAGE_SIZE;
  const offset = (params.page - 1) * limit;
  const htmlText = await siteFetch(
    buildSearchPath({
      text: params.text,
      sort: params.sort,
      order: params.order,
      limit,
      offset,
      status: params.status,
      type: params.type,
    }),
    { htmx: true },
  );
  const cards = parseSeriesList(htmlText);
  return {
    items: cards.map(toComicListItem),
    hasMore: cards.length >= limit,
  };
}

async function searchComic(payload: SearchComicPayload): Promise<SearchResultContract> {
  const keyword = cleanText(payload.keyword);
  const page = Math.max(1, toNumber(payload.page, 1));

  if (!keyword) {
    const empty = { page: 1, pages: 1, total: 0, hasReachedMax: true };
    return {
      source: PLUGIN_ID,
      extern: null,
      scheme: { version: "1.0.0", type: "searchResult", source: PLUGIN_ID, list: "grid" },
      data: { paging: empty, items: [] },
      paging: empty,
      items: [],
    };
  }

  const { items, hasMore } = await fetchList({ text: keyword, page, sort: "Popularity", order: "Descending" });
  const translatedItems = await maybeTranslateTitles(items);
  const paging = {
    page,
    pages: hasMore ? page + 1 : page,
    total: hasMore ? (page + 1) * PAGE_SIZE : (page - 1) * PAGE_SIZE + translatedItems.length,
    hasReachedMax: !hasMore,
  };

  return {
    source: PLUGIN_ID,
    extern: null,
    scheme: { version: "1.0.0", type: "searchResult", source: PLUGIN_ID, list: "grid" },
    data: { paging, items: translatedItems },
    paging,
    items: translatedItems,
  };
}

async function getRankingData(payload: SearchComicPayload): Promise<ComicPagedListContract> {
  const extern = (payload.extern ?? {}) as Record<string, unknown>;
  const record = payload as unknown as Record<string, unknown>;
  const page = Math.max(1, toNumber(payload.page, 1));

  const sort = pickString(extern.sort, record.sort) || "Popularity";
  const order = pickString(extern.order, record.order) || "Descending";
  const status = pickString(extern.status, record.status);
  const type = pickString(extern.type, record.type);

  const { items, hasMore } = await fetchList({ page, sort, order, status, type });
  const translatedItems = await maybeTranslateTitles(items);

  return {
    source: PLUGIN_ID,
    extern: null,
    data: { items: translatedItems, hasReachedMax: !hasMore },
  };
}

async function getRankingFilterBundle(): Promise<FilterBundleContract> {
  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "rankingFilter",
      title: "筛选",
      fields: [
        {
          key: "sort",
          kind: "choice",
          label: "排序",
          options: [
            ...SORTS.map((item) => ({
              label: item.label,
              value: `${item.value}_Descending`,
              result: { extern: { sort: item.value, order: "Descending" } },
            })),
            { label: "字母 Z-A", value: "Alphabetical_Descending", result: { extern: { sort: "Alphabetical", order: "Descending" } } },
          ],
        },
        {
          key: "status",
          kind: "choice",
          label: "连载状态",
          options: STATUS_OPTIONS.map((item) => ({
            label: item.label,
            value: item.value,
            result: { extern: { status: item.value } },
          })),
        },
        {
          key: "type",
          kind: "choice",
          label: "作品类型",
          options: TYPE_OPTIONS.map((item) => ({
            label: item.label,
            value: item.value,
            result: { extern: { type: item.value } },
          })),
        },
      ],
    },
    data: {
      values: { sort: "Popularity_Descending", status: "Any", type: "Any" },
    },
  };
}

// ---------------------------------------------------------------------------
// 详情
// ---------------------------------------------------------------------------

async function getComicDetail(payload: ComicDetailPayload): Promise<ComicDetailContract> {
  const comicId = extractUlid(cleanText(payload.comicId));
  if (!comicId) {
    throw new Error("缺少有效的作品 ID");
  }

  const [seriesHtml, chaptersHtml] = await Promise.all([
    siteFetch(`/series/${comicId}`),
    siteFetch(`/series/${comicId}/full-chapter-list`).catch(() => ""),
  ]);

  const detail = parseSeriesDetail(seriesHtml, comicId);
  const entries = chaptersHtml ? parseChapterList(chaptersHtml) : [];

  // 站点的章节列表是新→旧，翻转为旧→新，符合阅读顺序
  const ordered = [...entries].reverse();
  let chapters: ChapterSummary[] = ordered.map((entry, index) => ({
    id: entry.ulid,
    requestId: entry.ulid,
    logicalKey: `${comicId}-${entry.ulid}`,
    storageChapterId: entry.ulid,
    name: entry.name,
    order: index + 1,
    extern: {},
  }));

  // 详情页翻译始终开启：标题/简介/章节名/标签自动译成中文（列表标题翻译由设置开关控制）
  let displayTitle = detail.title;
  let displayDescription = detail.description;
  // type/status 是固定英文枚举，用查表转中文；tags 用翻译
  let displayType = typeZh(detail.type);
  let displayStatus = statusZh(detail.status);
  let displayTags = detail.tags;
  try {
    const [titleZh, descZh, nameMap, tagMap] = await Promise.all([
      translateToChinese(detail.title),
      translateToChinese(detail.description),
      translateChapterNames(chapters.map((chapter) => chapter.name)),
      translateTags(detail.tags),
    ]);
    if (titleZh && titleZh !== detail.title) {
      displayTitle = `${titleZh}（${detail.title}）`;
    }
    if (descZh) {
      displayDescription = descZh;
    }
    if (nameMap.size > 0) {
      chapters = chapters.map((chapter) => ({
        ...chapter,
        name: nameMap.get(chapter.name) ?? chapter.name,
      }));
    }
    if (tagMap.size > 0) {
      displayTags = detail.tags.map((tag) => tagMap.get(tag) ?? tag);
    }
  } catch {
    // 翻译失败保留原文
  }

  return {
    source: PLUGIN_ID,
    comicId,
    extern: null,
    scheme: { version: "1.0.0", type: "comicDetail", source: PLUGIN_ID },
    data: {
      normal: {
        comicInfo: {
          id: comicId,
          title: displayTitle,
          titleMeta: [],
          creator: {
            id: "",
            name: detail.author,
            avatar: { id: "", url: "", name: "", path: "", extern: {} },
            onTap: null,
            extern: {},
          },
          description: displayDescription,
          cover: createImage({
            id: comicId,
            url: detail.coverUrl,
            name: detail.title,
            path: `comic/${comicId}/cover.jpg`,
            extern: {},
          }),
          metadata: [
            createMetadata("author", "作者", detail.authors),
            createMetadata("categories", "标签", displayTags),
            createMetadata("tags", "信息", [displayType, displayStatus, detail.released].filter(Boolean)),
          ],
          extern: {},
        },
        preview: { enabled: false },
        eps: chapters,
        recommend: [],
        totalViews: 0,
        totalLikes: 0,
        totalComments: 0,
        isFavourite: false,
        isLiked: false,
        allowComments: false,
        allowLike: false,
        allowCollected: true,
        allowDownload: true,
        allowCommentsReason: "站点评论需登录，插件未接入",
        allowLikeReason: "站点未提供点赞接口",
        extern: {},
      },
      raw: {
        ulid: comicId,
        type: detail.type,
        status: detail.status,
        released: detail.released,
      },
    },
  };
}

// ---------------------------------------------------------------------------
// 阅读
// ---------------------------------------------------------------------------

async function buildChapterData(comicId: string, chapterId: string) {
  const ulid = extractUlid(comicId);
  const chapterUlid = extractUlid(chapterId);
  if (!chapterUlid) {
    throw new Error("缺少有效章节 ID");
  }

  let chapters: ChapterSummary[] = [];
  let comicTitle = `作品 ${ulid}`;

  try {
    const [seriesHtml, chaptersHtml] = await Promise.all([
      ulid ? siteFetch(`/series/${ulid}`).catch(() => "") : Promise.resolve(""),
      ulid ? siteFetch(`/series/${ulid}/full-chapter-list`).catch(() => "") : Promise.resolve(""),
    ]);
    if (seriesHtml) {
      comicTitle = parseSeriesDetail(seriesHtml, ulid).title;
    }
    if (chaptersHtml) {
      const ordered = parseChapterList(chaptersHtml).reverse();
      chapters = ordered.map((entry, index) => ({
        id: entry.ulid,
        requestId: entry.ulid,
        logicalKey: `${ulid}-${entry.ulid}`,
        storageChapterId: entry.ulid,
        name: entry.name,
        order: index + 1,
        extern: {},
      }));
    }
  } catch (error) {
    console.log("[weebcentral] 章节上下文加载失败:", error instanceof Error ? error.message : error);
  }

  const imagesHtml = await siteFetch(`/chapters/${chapterUlid}/images?is_prev=False`, { htmx: true });
  const imageUrls = parseChapterImages(imagesHtml);
  if (imageUrls.length === 0) {
    throw new Error("未解析到章节图片，站点结构可能已调整");
  }

  const pages = imageUrls.map((url, index) => {
    const pageNo = String(index + 1).padStart(3, "0");
    return {
      id: `${chapterUlid}-${pageNo}`,
      name: `${pageNo}.jpg`,
      path: `comic/${ulid}/${chapterUlid}/${pageNo}.jpg`,
      url,
      extern: { index: index + 1 },
    };
  });

  const current = chapters.find((item) => item.requestId === chapterUlid);
  const chapter = current ?? {
    id: chapterUlid,
    requestId: chapterUlid,
    logicalKey: `${ulid}-${chapterUlid}`,
    storageChapterId: chapterUlid,
    name: `章节 ${chapterUlid.slice(-6)}`,
    order: 1,
    extern: {},
  };

  return { comicTitle, chapters, chapter: { ...chapter, pages } };
}

async function getReadSnapshot(payload: ReadSnapshotPayload): Promise<ReadSnapshotContract> {
  const comicId = cleanText(payload.comicId);
  const chapterId = String(payload.chapterId ?? "").trim();
  const { comicTitle, chapters, chapter } = await buildChapterData(comicId, chapterId);

  return {
    source: PLUGIN_ID,
    extern: null,
    data: {
      comic: { id: comicId, source: PLUGIN_ID, title: comicTitle, extern: {} },
      chapter,
      chapters,
    },
  };
}

async function getChapter(payload: ChapterPayload): Promise<ChapterContentContract> {
  const comicId = cleanText(payload.comicId);
  const chapterId = String(payload.chapterId ?? "").trim();
  const { comicTitle, chapters, chapter } = await buildChapterData(comicId, chapterId);

  return {
    source: PLUGIN_ID,
    comicId,
    chapterId,
    extern: null,
    scheme: { version: "1.0.0", type: "chapterContent", source: PLUGIN_ID },
    data: {
      comic: { id: comicId, source: PLUGIN_ID, title: comicTitle, extern: {} },
      chapter,
      chapters,
    },
  };
}

async function fetchImageBytes(payload: FetchImageBytesPayload): Promise<Uint8Array> {
  const url = absoluteUrl(cleanText(payload.url));
  if (!url) {
    throw new Error("图片地址为空");
  }
  const res = await fetch(url, {
    headers: {
      "User-Agent": USER_AGENT,
      Referer: "https://weebcentral.com/",
      "x-rquickjs-host-offload-binary-v1": "1",
      Accept: "image/avif,image/webp,image/*,*/*;q=0.8",
    },
    redirect: "follow",
    signal: AbortSignal.timeout(payload.timeoutMs ?? 30000),
  });
  if (!res.ok) {
    throw new Error(`图片下载失败（HTTP ${res.status}）`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

async function getDownloadConcurrency(): Promise<DownloadConcurrencyResult> {
  return { concurrency: 3 };
}

async function getSettingsBundle(): Promise<SettingsBundleContract> {
  return {
    source: PLUGIN_ID,
    scheme: {
      version: "1.0.0",
      type: "settings",
      sections: [
        { id: "about", title: "无需登录，直接可读", fields: [] },
        {
          id: "translate",
          title: "在线翻译（实验性）",
          fields: [
            {
              key: "translate.display",
              kind: "switch",
              label: "列表标题也翻译成中文（详情页的标题/简介/章节名/标签始终自动翻译）",
            },
            {
              key: "translate.email",
              kind: "text",
              label: "MyMemory 邮箱（可选，注册用户配额更高）",
            },
          ],
        },
      ],
    },
    data: {
      canShowUserInfo: false,
      canLogin: false,
      values: {
        "translate.display": (await isDisplayTranslateEnabled()) ? "true" : "false",
        "translate.email": "",
      },
    },
  };
}

async function onSettingChanged(payload?: Record<string, unknown>) {
  const key = typeof payload?.key === "string" ? payload.key : "";
  const raw = payload?.value;
  const value = typeof raw === "boolean" ? (raw ? "true" : "false") : String(raw ?? "");
  if (key) {
    try {
      await authConfig.save(key, value);
    } catch {
      // 持久化失败不影响本次会话
    }
    applyTranslateSettings({ [key]: value });
  }
  return { source: PLUGIN_ID, data: { ok: true } };
}

async function getCapabilitiesBundle(): Promise<CapabilitiesBundleContract> {
  return {
    source: PLUGIN_ID,
    scheme: { version: "1.0.0", type: "capabilities", actions: [] },
    data: {},
  };
}

async function init(): Promise<{ source: string; data: { ok: boolean } }> {
  console.log("[weebcentral] init");
  return { source: PLUGIN_ID, data: { ok: true } };
}

async function getInfo(): Promise<InfoContract> {
  return buildPluginInfo();
}

export default {
  init,
  getInfo,
  searchComic,
  getRankingData,
  getRankingFilterBundle,
  getComicDetail,
  getReadSnapshot,
  getChapter,
  fetchImageBytes,
  getDownloadConcurrency,
  getSettingsBundle,
  onSettingChanged,
  getCapabilitiesBundle,
};
