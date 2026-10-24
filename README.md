# WeebCentral 漫画源 · Breeze 插件

给 [Breeze](https://github.com/deretame/Breeze) 漫画阅读器写的 WeebCentral 源。
站点是原 MangaSee 的继任站，英文日漫 / 韩漫 / 国漫资源量很大。

- 仓库：<https://github.com/k623615746/Breeze-plugin-weebcentral>
- 版本：1.0.1
- 站点：<https://weebcentral.com>

---

## 安装

**方式一：插件商店（推荐）**

仓库名符合 Breeze 收录规范（`Breeze-plugin-` 前缀 + 公开 + 根目录有 `manifest.json`），
客户端扫描 GitHub 后自动收录，通常 2~4 小时入库。之后在 **发现页 → 插件 → 商店** 搜「WeebCentral」。

**方式二：本地安装**

下载 [Releases](https://github.com/k623615746/Breeze-plugin-weebcentral/releases/latest) 里的
`breeze-plugin-weebcentral.bundle.cjs`，在 **发现页 → 插件 → 设置 → 插件管理 → 更新 → 从本地安装**。

**方式三：网络安装**

同一对话框选「从网络安装」，填入：

```
https://github.com/k623615746/Breeze-plugin-weebcentral/releases/download/1.0.1/breeze-plugin-weebcentral.bundle.cjs
```

---

## 功能

| 功能 | 说明 |
| --- | --- |
| 发现页入口 | 人气排行 / 最近更新 / 最新收录 |
| 搜索 | 关键词搜索，服务端分页（每页 32 条） |
| 筛选 | 排序、连载状态、作品类型（日漫/韩漫/国漫/欧美） |
| 详情 | 标题、作者、标签、类型、状态、年份、简介 |
| 章节 | **完整章节列表**（见下方说明） |
| 阅读 | 图片 CDN 直连，无需登录 |

### 接口映射

| 能力 | 端点 |
| --- | --- |
| 搜索 / 列表 | `GET /search/data?text=&sort=&order=&limit=&offset=` |
| 详情 | `GET /series/{ULID}` |
| 完整章节 | `GET /series/{ULID}/full-chapter-list` |
| 章节图片 | `GET /chapters/{ULID}/images?is_prev=False` |
| 封面 | `https://temp.compsci88.com/cover/fallback/{ULID}.jpg` |

---

## 实现要点

**必须带浏览器 User-Agent。** 这一点是能否访问的前提，不是可选优化：
裸请求会被 Cloudflare 直接挡回 403。插件所有请求都带完整浏览器 UA。

**章节列表要单独拉。** 系列页上的章节缩略列表只渲染 9 条（懒加载），
真正的完整列表在 `/full-chapter-list`，返回的是整页 HTML。实测 One-Punch Man 有 **268 话**，
只解析系列页会严重漏章。

**章节顺序要反转。** 站点的完整列表是「新→旧」，插件反转成阅读顺序（第 1 话在前）。

**列表卡片取标题的技巧。** 卡片的 `<img>` 有 `alt="One Piece cover"`，
去掉 ` cover` 后缀就是标题，比从 DOM 层级里找标题更稳。

---

## 开发

```bash
npm install

npx tsc --noEmit                  # 类型检查
npx tsx build/generate-manifest.ts
npx rspack build
npx tsx build/generate-brotli.ts

npx tsx test/e2e.test.ts          # 7 项，真实抓站
```

测试是真联网的，包含图片下载与文件头（JPEG/PNG 魔数）校验，不是 mock。
最新结果：**7/7 通过**（含 268 话章节列表与 23 页章节图片）。

源码结构：

```
src/
  common.ts   # 常量、UA、URL 工具、搜索端点构造
  parse.ts    # BreezeHtml 解析：列表卡片 / 系列详情 / 章节列表 / 章节图片
  get-info.ts # 插件注册信息 + manifest 生成
  index.ts    # 11 个 fnPath 实现
```

### 更新机制

`getInfo` 与 `manifest.json` 均配置了 `updateUrl` 指向本仓库的 Release API，
客户端启动后会静默比对版本。

发新版：改 `src/get-info.ts` 的 `version` → 重新构建 → 建一个 **tag 与 version 完全一致**
（如 `1.0.0`，不加 `v` 前缀）的 Release，上传 `dist/` 两个产物和 `manifest.json`。

---

## 已知限制

- 站点位于 Cloudflare 之后，若出现 403 通常是临时风控，稍后重试即可。
- 只有英文翻译，没有中文。
- 站点改版会导致 HTML 选择器失效，届时需要更新 `parse.ts`。

---

## 声明

本插件仅解析站点公开页面，不存储、不缓存、不分发任何漫画内容，所有图片均从原站实时获取。

内容为社区上传的英文翻译（scanlation），版权归原作者及出版方所有。
请自行判断使用行为的合规性，并支持正版。
