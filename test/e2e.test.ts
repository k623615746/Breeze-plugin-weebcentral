/**
 * WeebCentral 插件端到端测试（真实请求站点）
 * 运行：npx tsx test/e2e.test.ts
 */
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import * as cheerio from "cheerio";

(globalThis as unknown as { BreezeHtml: unknown }).BreezeHtml = {
  load: (html: string) => cheerio.load(html),
};

const require = createRequire(import.meta.url);
const plugin = require("../dist/breeze-plugin-weebcentral.bundle.cjs").default;

let passed = 0;
let failed = 0;

async function check(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ✓ ${name}`);
  } catch (error) {
    failed += 1;
    console.log(`  ✗ ${name}`);
    console.log(`    ${error instanceof Error ? error.message : String(error)}`);
  }
}

console.log("\n[WeebCentral E2E]");

await check("getInfo 注册信息", async () => {
  const info = await plugin.getInfo();
  assert.equal(info.name, "WeebCentral");
  assert.equal(info.version, "1.0.0");
});

await check("人气排行列表", async () => {
  const res = await plugin.getRankingData({ page: 1, extern: { sort: "Popularity", order: "Descending" } });
  assert.ok(res.data.items.length > 0, "列表为空");
  const first = res.data.items[0];
  assert.ok(first.id.length === 26, `ULID 长度=${first.id.length}`);
  assert.ok(first.title.length > 0, "标题为空");
  assert.ok(first.cover.url.includes("compsci88.com"), first.cover.url);
  console.log(`    首条：${first.title}`);
});

await check("搜索命中关键词", async () => {
  const res = await plugin.searchComic({ keyword: "solo leveling", page: 1 });
  assert.ok(res.items.length > 0, "搜索无结果");
  const titles = res.items.map((i: { title: string }) => i.title.toLowerCase());
  assert.ok(titles.some((t: string) => t.includes("solo")), titles.slice(0, 4).join(" | "));
  console.log(`    结果 ${res.items.length} 条，首条：${res.items[0].title}`);
});

await check("空关键词返回空", async () => {
  const res = await plugin.searchComic({ keyword: "", page: 1 });
  assert.equal(res.items.length, 0);
});

await check("筛选器字段", async () => {
  const res = await plugin.getRankingFilterBundle();
  const keys = res.scheme.fields.map((f: { key: string }) => f.key);
  assert.deepEqual(keys, ["sort", "status", "type"]);
});

await check("详情 + 完整章节列表", async () => {
  const res = await plugin.getComicDetail({ comicId: "01J76XY7KT7J224EBK6J816Y1Q" });
  const normal = res.data.normal;
  assert.ok(normal.comicInfo.title.length > 0, "标题为空");
  assert.ok(normal.eps.length > 100, `章节数=${normal.eps.length}`);
  console.log(`    作品：${normal.comicInfo.title}，章节 ${normal.eps.length} 话，作者 ${normal.comicInfo.creator.name}`);
});

await check("阅读页图片 + 下载", async () => {
  const detail = await plugin.getComicDetail({ comicId: "01J76XY7KT7J224EBK6J816Y1Q" });
  const chapterId = detail.data.normal.eps[0].requestId;
  const res = await plugin.getReadSnapshot({ comicId: "01J76XY7KT7J224EBK6J816Y1Q", chapterId });
  const pages = res.data.chapter.pages;
  assert.ok(pages.length > 0, "无图片页");
  assert.ok(/^https?:\/\//.test(pages[0].url), pages[0].url);

  const bytes = await plugin.fetchImageBytes({ url: pages[0].url });
  assert.ok(bytes instanceof Uint8Array);
  assert.ok(bytes.length > 5000, `字节数=${bytes.length}`);
  const isPng = bytes[0] === 0x89 && bytes[1] === 0x50;
  const isJpeg = bytes[0] === 0xff && bytes[1] === 0xd8;
  assert.ok(isPng || isJpeg, `魔数=${bytes[0].toString(16)},${bytes[1].toString(16)}`);
  console.log(`    ${pages.length} 页，首图 ${bytes.length} B`);
});

console.log(`\n结果：${passed} 通过，${failed} 失败\n`);
process.exit(failed > 0 ? 1 : 0);
