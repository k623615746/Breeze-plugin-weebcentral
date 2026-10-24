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
  const paging = {
    page,
    pages: hasMore ? page + 1 : page,
    total: hasMore ? (page + 1) * PAGE_SIZE : (page - 1) * PAGE_SIZE + items.length,
    hasReachedMax: !hasMore,
  };

  return {
    source: PLUGIN_ID,
    extern: null,
    scheme: { version: "1.0.0", type: "searchResult", source: PLUGIN_ID, list: "grid" },
    data: { paging, items },
    paging,
    items,
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

  return {
    source: PLUGIN_ID,
    extern: null,
    data: { items, hasReachedMax: !hasMore },
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
  const chapters: ChapterSummary[] = ordered.map((entry, index) => ({
    id: entry.ulid,
    requestId: entry.ulid,
    logicalKey: `${comicId}-${entry.ulid}`,
    storageChapterId: entry.ulid,
    name: entry.name,
    order: index + 1,
    extern: {},
  }));

  return {
    source: PLUGIN_ID,
    comicId,
    extern: null,
    scheme: { version: "1.0.0", type: "comicDetail", source: PLUGIN_ID },
    data: {
      normal: {
        comicInfo: {
          id: comicId,
          title: detail.title,
          titleMeta: [],
          creator: {
            id: "",
            name: detail.author,
            avatar: { id: "", url: "", name: "", path: "", extern: {} },
            onTap: null,
            extern: {},
          },
          description: detail.description,
          cover: createImage({
            id: comicId,
            url: detail.coverUrl,
            name: detail.title,
            path: `comic/${comicId}/cover.jpg`,
            extern: {},
          }),
          metadata: [
            createMetadata("author", "作者", detail.authors),
            createMetadata("categories", "标签", detail.tags),
            createMetadata("tags", "信息", [detail.type, detail.status, detail.released].filter(Boolean)),
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
      ],
    },
    data: { canShowUserInfo: false, canLogin: false, values: {} },
  };
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
  getCapabilitiesBundle,
};
