import type { ComicListScene, InfoContract, PluginFunctionItem } from "breeze-plugin-kit";
import { COVER_BASE, PLUGIN_ID } from "./common";

/** 发布仓库：Breeze 只会扫描 GitHub 上以 Breeze-plugin- 开头的公开仓库 */
const GITHUB_OWNER = "k623615746";
const GITHUB_REPO = "Breeze-plugin-weebcentral";

/** 自动更新通道：GitHub Release API */
const UPDATE_URL = `https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/releases/latest`;


function buildScene(title: string, core: Record<string, unknown> = {}): ComicListScene {
  return {
    title,
    source: PLUGIN_ID,
    body: {
      type: "pluginPagedComicList",
      request: { fnPath: "getRankingData", core, extern: {} },
    },
    filter: { fnPath: "getRankingFilterBundle", core, extern: {} },
  };
}

function buildFunctions(): PluginFunctionItem[] {
  return [
    {
      id: "popular",
      title: "人气排行",
      action: {
        type: "openComicList",
        payload: { scene: buildScene("人气排行", { sort: "Popularity", order: "Descending" }) },
      },
    },
    {
      id: "latest",
      title: "最近更新",
      action: {
        type: "openComicList",
        payload: { scene: buildScene("最近更新", { sort: "Latest Update", order: "Descending" }) },
      },
    },
    {
      id: "new",
      title: "最新收录",
      action: {
        type: "openComicList",
        payload: { scene: buildScene("最新收录", { sort: "Recently Added", order: "Descending" }) },
      },
    },
  ];
}

export function buildPluginInfo(): InfoContract {
  return {
    name: "WeebCentral",
    uuid: PLUGIN_ID,
    iconUrl: "https://cdn.jsdelivr.net/gh/k623615746/Breeze-plugin-weebcentral@main/assets/icon.png",
    describe: [
      "WeebCentral 漫画源（原 MangaSee 的继任站）。",
      "",
      "- 英文日漫 / 韩漫 / 国漫为主，资源量大",
      "- 支持关键词搜索、人气/更新/收录排序",
      "- 可按连载状态、作品类型筛选",
      "- 章节图片直连，无需登录",
      "",
      "**注意**：站点位于 Cloudflare 之后，插件会带浏览器 UA 请求。",
      "若出现 403，通常是临时的风控校验，稍后重试即可。",
      "",
      "v1.1.0 新增「在线翻译」：设置里开启后，英文标题/简介/章节名会自动翻译成中文显示。",
      "",
      "> 内容为社区上传的英文翻译，版权归原作者及出版方所有。",
    ].join("\n"),
    version: "1.3.0",
    home: `https://github.com/${GITHUB_OWNER}/${GITHUB_REPO}`,
    updateUrl: UPDATE_URL,
    function: buildFunctions(),
  };
}

export function buildManifestInfo() {
  const info = buildPluginInfo();
  return {
    name: info.name,
    uuid: info.uuid,
    iconUrl: info.iconUrl,
    describe: info.describe,
    version: info.version,
    home: info.home,
    updateUrl: info.updateUrl,
    function: info.function,
  };
}
