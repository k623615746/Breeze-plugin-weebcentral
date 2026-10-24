/**
 * 显示层在线翻译（韩文/英文/日文 → 中文）
 *
 * 用免费 MyMemory 翻译 API（免密钥），把界面上展示的标题、简介等
 * 非中文文本翻译成中文。设计要点：
 *
 *  - **默认关闭**：在插件设置里打开「显示翻译」才生效，避免无谓消耗配额
 *  - **会话内缓存**：同一文本只翻译一次
 *  - **跳过无需翻译的文本**：纯序号章节名（第12话 / Chapter 12 / 12화）、
 *    已含中文的文本、纯数字符号
 *  - **批量限流**：一次列表最多翻译 limit 条，并发 3，防止配额被打爆
 *  - **长文本分块**：简介超过单次请求上限时按句子切块翻译后拼接
 *  - **失败保留原文**：翻译出错不影响正常展示
 */

import { authConfig } from "breeze-plugin-kit";

const ENABLE_KEY = "translate.display";
const EMAIL_KEY = "translate.email";

/** 单次请求最大字符数（MyMemory 上限 500 字节，留余量给 UTF-8 多字节） */
const CHUNK_LIMIT = 380;
/** 一次批量翻译的最大条数（超出部分保留原文） */
const BATCH_LIMIT = 40;
/** 章节名翻译上限 */
const CHAPTER_LIMIT = 30;

let enabledLoaded = false;
let enabled = false;
let emailLoaded = false;
let email = "";

export async function isDisplayTranslateEnabled(): Promise<boolean> {
  if (!enabledLoaded) {
    enabledLoaded = true;
    try {
      enabled = String(await authConfig.load(ENABLE_KEY, "false")).trim() === "true";
    } catch {
      enabled = false;
    }
  }
  return enabled;
}

async function myMemoryEmail(): Promise<string> {
  if (!emailLoaded) {
    emailLoaded = true;
    try {
      email = String(await authConfig.load(EMAIL_KEY, "")).trim();
    } catch {
      email = "";
    }
  }
  return email;
}

/** 设置页保存后同步内存态（避免下次读取多一次 IO） */
export function applyTranslateSettings(values: Record<string, unknown>): void {
  const display = values[ENABLE_KEY];
  const mail = values[EMAIL_KEY];
  if (typeof display === "string" || typeof display === "boolean") {
    enabled = String(display) === "true";
    enabledLoaded = true;
  }
  if (typeof mail === "string") {
    email = mail.trim();
    emailLoaded = true;
  }
}

function clean(input: unknown): string {
  if (typeof input !== "string") {
    return "";
  }
  return input.replace(/[\s\u3000]+/g, " ").trim();
}

/** 纯序号章节名：第12话 / Chapter 12 / 12화 / 12.5 / 12-13 等，无需翻译 */
export function looksLikeNumbering(text: string): boolean {
  const value = text.trim();
  if (!value) {
    return true;
  }
  // 去掉尾部的括号备注（如「12화 (특별편)」→「12화」）再判断
  const base = value.replace(/\s*[(（][^)）]{0,20}[)）]\s*$/, "").trim();
  if (!base) {
    return false;
  }
  return (
    /^第\s*\d+(?:\.\d+)?\s*[话話回]$/.test(base) ||
    /^chap(?:ter)?\s*[\d.]+(?:\s*[-~]\s*[\d.]+)?$/i.test(base) ||
    /^\d+(?:\.\d+)?\s*(?:화|話|话)$/.test(base) ||
    /^[\d.\s\-~]+$/.test(base)
  );
}

/** 判断是否值得调用翻译（含外文单词、非纯序号、尚未是中文） */
export function isTranslatableText(text: string): boolean {
  const value = clean(text);
  if (!value || looksLikeNumbering(value)) {
    return false;
  }
  // 没有任何字母（纯数字/符号/空白）不翻
  if (!/[a-z\u00c0-\u024f\u0400-\u04ff\u0600-\u06ff\u3040-\u30ff\uac00-\ud7af]/i.test(value)) {
    return false;
  }
  // 已含中文且不含韩文/日文假名 → 视为中文，不翻
  if (/[\u4e00-\u9fff]/.test(value) && !/[\uac00-\ud7af\u3040-\u30ff]/.test(value)) {
    return false;
  }
  return true;
}

const cache = new Map<string, string>();

function chunkText(text: string): string[] {
  if (text.length <= CHUNK_LIMIT) {
    return [text];
  }
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > CHUNK_LIMIT) {
    // 在限制范围内找最后一个句子边界
    let cut = rest.lastIndexOf("。", CHUNK_LIMIT);
    const forCandidates = [
      rest.lastIndexOf("。", CHUNK_LIMIT),
      rest.lastIndexOf("！", CHUNK_LIMIT),
      rest.lastIndexOf("？", CHUNK_LIMIT),
      rest.lastIndexOf(". ", CHUNK_LIMIT),
      rest.lastIndexOf("! ", CHUNK_LIMIT),
      rest.lastIndexOf("? ", CHUNK_LIMIT),
      rest.lastIndexOf("\n", CHUNK_LIMIT),
    ].filter((idx) => idx > CHUNK_LIMIT / 3);
    cut = forCandidates.length > 0 ? Math.max(...forCandidates) + 1 : CHUNK_LIMIT;
    chunks.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest) {
    chunks.push(rest);
  }
  return chunks;
}

async function translateChunk(chunk: string, emailAddr: string): Promise<string> {
  const params = new URLSearchParams({ q: chunk, langpair: "Autodetect|zh-CN" });
  if (emailAddr) {
    params.set("de", emailAddr);
  }
  const res = await fetch(`https://api.mymemory.translated.net/get?${params.toString()}`, {
    headers: { Accept: "application/json" },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const data = (await res.json()) as {
    responseData?: { translatedText?: string };
    responseStatus?: number | string;
  };
  const out = clean(data?.responseData?.translatedText);
  if (!out) {
    throw new Error("翻译结果为空");
  }
  // MyMemory 对超限请求会回显提示语（含 "MYMEMORY WARNING"），视为失败
  if (/MYMEMORY WARNING|QUERY LENGTH LIMIT/i.test(out)) {
    throw new Error("配额受限");
  }
  return out;
}

/** 翻译单条文本（自动分块、走缓存），失败返回原文 */
export async function translateToChinese(text: string): Promise<string> {
  const value = clean(text);
  if (!value || !isTranslatableText(value)) {
    return value;
  }
  const hit = cache.get(value);
  if (hit !== undefined) {
    return hit;
  }
  try {
    const emailAddr = await myMemoryEmail();
    const chunks = chunkText(value);
    const parts: string[] = [];
    for (const chunk of chunks) {
      parts.push(await translateChunk(chunk, emailAddr));
    }
    const merged = parts.join(" ").replace(/\s+/g, " ").trim();
    if (merged) {
      cache.set(value, merged);
      return merged;
    }
  } catch {
    // 失败保留原文
  }
  return value;
}

/**
 * 批量翻译（并发 3，上限 BATCH_LIMIT 条），返回 原文→译文 映射。
 * 未翻译的条目不在结果里，调用方用 map.get(title) ?? title 兜底。
 */
export async function translateBatch(
  texts: ReadonlyArray<string>,
  options: { limit?: number } = {},
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const cap = options.limit ?? BATCH_LIMIT;
  const queue: string[] = [];
  const seen = new Set<string>();

  for (const raw of texts) {
    const key = clean(raw);
    if (!key || seen.has(key)) {
      continue;
    }
    seen.add(key);
    if (!isTranslatableText(key)) {
      continue;
    }
    const hit = cache.get(key);
    if (hit !== undefined) {
      result.set(key, hit);
      continue;
    }
    if (queue.length < cap) {
      queue.push(key);
    }
  }

  let index = 0;
  const emailAddr = await myMemoryEmail();
  const workerCount = Math.min(3, queue.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (index < queue.length) {
      const item = queue[index];
      index += 1;
      try {
        const translated = await translateChunk(item, emailAddr);
        cache.set(item, translated);
        result.set(item, translated);
      } catch {
        // 保留原文
      }
    }
  });
  await Promise.all(workers);
  return result;
}

/** 翻译列表条目标题（就地返回新数组） */
export async function translateListTitles<
  T extends { title: string },
>(items: ReadonlyArray<T>, options: { limit?: number } = {}): Promise<T[]> {
  if (items.length === 0) {
    return [...items];
  }
  const map = await translateBatch(
    items.map((item) => item.title),
    options,
  );
  if (map.size === 0) {
    return [...items];
  }
  return items.map((item) => {
    const translated = map.get(item.title);
    return translated ? { ...item, title: translated } : item;
  });
}

/** 章节名批量翻译（带独立上限，纯序号自动跳过） */
export async function translateChapterNames(names: ReadonlyArray<string>): Promise<Map<string, string>> {
  return translateBatch(names, { limit: CHAPTER_LIMIT });
}

/**
 * 标签批量翻译成中文。
 * 返回 原文→中文 映射；同时把已含中文的原文原样保留在映射里，方便调用方直接替换。
 */
export async function translateTags(tags: ReadonlyArray<string>): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const needTranslate: string[] = [];
  for (const raw of tags) {
    const tag = clean(raw);
    if (!tag) {
      continue;
    }
    // 优先命中固定术语表（漫画标签语境更准）
    const known = MANGA_TAG_ZH.get(tag.toLowerCase());
    if (known) {
      result.set(tag, known);
      continue;
    }
    if (!isTranslatableText(tag)) {
      // 已含中文或纯序号等，直接原样
      result.set(tag, tag);
      continue;
    }
    needTranslate.push(tag);
  }
  const translated = await translateBatch(needTranslate, { limit: 30 });
  for (const [key, value] of translated) {
    result.set(key, value);
  }
  // 未翻译成功的也原样保留
  for (const tag of needTranslate) {
    if (!result.has(tag)) {
      result.set(tag, tag);
    }
  }
  return result;
}

/** 常见漫画标签/类型的中文术语表（比机器翻译更准确） */
const MANGA_TAG_ZH = new Map<string, string>([
  ["action", "动作"],
  ["adventure", "冒险"],
  ["comedy", "喜剧"],
  ["drama", "剧情"],
  ["fantasy", "奇幻"],
  ["romance", "爱情"],
  ["slice of life", "日常"],
  ["slice-of-life", "日常"],
  ["sci-fi", "科幻"],
  ["science fiction", "科幻"],
  ["horror", "恐怖"],
  ["mystery", "悬疑"],
  ["thriller", "惊悚"],
  ["psychological", "心理"],
  ["supernatural", "超自然"],
  ["historical", "历史"],
  ["martial arts", "武术"],
  ["sports", "运动"],
  ["school", "校园"],
  ["school life", "校园"],
  ["harem", "后宫"],
  ["isekai", "异世界"],
  ["mecha", "机甲"],
  ["music", "音乐"],
  ["game", "游戏"],
  ["magic", "魔法"],
  ["military", "军事"],
  ["crime", "犯罪"],
  ["detective", "侦探"],
  ["tragedy", "悲剧"],
  ["seinen", "青年"],
  ["shounen", "少年"],
  ["shonen", "少年"],
  ["shoujo", "少女"],
  ["shojo", "少女"],
  ["josei", "女性"],
  ["ecchi", "擦边"],
  ["harem", "后宫"],
  ["adult", "成人"],
  ["mature", "成人"],
  ["gore", "血腥"],
  ["monster", "怪兽"],
  ["demons", "恶魔"],
  ["vampire", "吸血鬼"],
  ["zombie", "丧尸"],
  ["apocalypse", "末日"],
  ["survival", "生存"],
  ["manga", "日漫"],
  ["manhwa", "韩漫"],
  ["manhua", "国漫"],
  ["webtoon", "网络漫画"],
  ["ongoing", "连载中"],
  ["completed", "已完结"],
  ["complete", "已完结"],
  ["hiatus", "休载"],
  ["canceled", "已取消"],
  ["cancelled", "已取消"],
  ["oel", "欧美"],
]);
