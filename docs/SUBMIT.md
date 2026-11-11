# 上架 DSH 插件市场 · 操作手册

## 先说清楚这个市场是什么

| 问题 | 事实 |
|---|---|
| 谁在维护 | **第三方**，不是官方。市场应用是 `dshmarket`（dshmarket.com，MIT，GitHub: dsh-market/dsh-market） |
| 插件列表从哪来 | 另一个开源精选仓库 `awesome-dsh-plugin`，站点每天拉 `https://awesome-dsh-plugin.com/plugins.json`（当前 10,424 条） |
| 怎么上架 | **去 awesome-dsh-plugin 提 PR**，在列表里加一条；站点和市场自动收录，通常一天内生效 |
| 有人审核吗 | 文档只写了「提 PR，维护者合并」；明确声明 **收录 ≠ 背书**，插件是第三方代码，用户自负 |
| 收费吗 | 免费，公开列表 |
| 收录什么 | **以 GitHub 仓库为单位**（`owner` + `url`），npm 包只是其中一个字段 `npm` |

**关键前提：你需要一个公开的 GitHub 仓库。** 只发 npm 包不够——条目是按仓库收录的。

---

## 三步上架

### 第 1 步：建 GitHub 仓库

材料已经准备好：`D:\Reading\dist\github-repo\`（4.3MB，含 README / LICENSE / 截图 / 源码）

1. GitHub 上新建仓库，名字建议 `stellar-shelf`，公开
2. 把 `dist/github-repo/` 里的**全部内容**推上去（注意是里面的内容，不是这个文件夹本身）

```powershell
cd D:\Reading\dist\github-repo
git init
git add .
git commit -m "feat: 星槎 · 私人书架，长成一片星空"
git branch -M main
git remote add origin https://github.com/zhang-1239/stellar-shelf.git
git push -u origin main
```

### 第 2 步：给 awesome-dsh-plugin 提 PR

1. 打开 https://github.com/awesome-dsh-plugin/awesome-dsh-plugin
2. 点 **Fork**
3. 在你的 fork 里找到插件列表文件（可能是 `plugins.yml` / `data/plugins.json` / README 里的表格——**照一条已有条目的格式抄**）
4. 加一条（见下方草稿）
5. 提交 PR，标题写 `Add stellar-shelf`

### 第 3 步：等一天

CI 会自动补 `stars` / `downloads` / `capabilities` / `capabilityCheckedAt` 这些字段，然后站点和市场刷新。

---

## PR 条目草稿

字段依据是市场实际读取的 `plugins.json`。**不要自己填 `stars` / `downloads` / `capabilities`**——那些由 CI 扫描生成。

```json
{
  "name": "stellar-shelf",
  "owner": "zhang-1239",
  "url": "https://github.com/zhang-1239/stellar-shelf",
  "category": "ui",
  "description": {
    "en": "A private bookshelf that grew into a starfield: galaxies are genres, star colour is reading status (unread / reading / finished / recommended), and each star becomes a book when you drift close enough. Reads EPUB, PDF, TXT, MOBI, AZW3, DOCX and Markdown with a full-screen reader (six display modes, eight Chinese fonts), highlights and notes, plus optional Douban recommendations. All data stays local in SQLite.",
    "zh": "把私人书架做成一片星空：星系是题材，星的颜色是阅读状态（未读 / 在读 / 已读完 / 推荐），飞近一颗星它才显形成一本书。支持 EPUB、PDF、TXT、MOBI、AZW3、DOCX、Markdown，全屏阅读器带六种显示模式与八种中文字体，可划词摘录与写想法，豆瓣推荐源可选开启。数据全部本地 SQLite，不联网不上传。"
  },
  "npm": "@zhangxij/stellar-shelf",
  "version": "1.0.0",
  "install": "dsh plugin --profile web add @zhangxij/stellar-shelf",
  "icon": "https://raw.githubusercontent.com/zhang-1239/stellar-shelf/main/icon.svg",
  "screenshots": [
    "https://raw.githubusercontent.com/zhang-1239/stellar-shelf/main/docs/screenshots/01-star-sea.jpg",
    "https://raw.githubusercontent.com/zhang-1239/stellar-shelf/main/docs/screenshots/02-filter.jpg",
    "https://raw.githubusercontent.com/zhang-1239/stellar-shelf/main/docs/screenshots/03-first-run.jpg",
    "https://raw.githubusercontent.com/zhang-1239/stellar-shelf/main/docs/screenshots/04-reader.jpg"
  ]
}
```

### 关于 category

现有分类里没有「阅读」，最接近的是 `ui`（UI 增强）——它确实往侧栏塞了一整个面板。备选是 `docs`（文档与渲染），但不太贴。**选 `ui`。**

### 关于 capabilities

CI 会扫描代码自动判定。这个插件实际会：启动本地子进程（HTTP 服务）、读写自己的数据目录（SQLite + 文件）。豆瓣源关闭时不联网。所以大概率会标成 `fs-read` / `fs-write` / `env`，可能还有 `shell`（因为 spawn）。**这是正常的，不用狡辩，如实即可。**

---

## 提 PR 时要写的话

> 新增一个插件：星槎（stellar-shelf）。
>
> 一个本地优先的私人书架，以第一人称星空呈现：星系是题材、星的颜色是阅读状态，靠近才显出封面，翻开进入全屏阅读器。
>
> - npm: `@zhangxij/stellar-shelf`
> - 仓库: https://github.com/zhang-1239/stellar-shelf
> - 许可证: MIT
> - 全部数据本地存储，不联网（豆瓣推荐源默认关闭）
> - 装完自带三本公版书演示，无需配置

---

## 备选：不发市场也能分享

`dist/stellar-shelf/` 是个自包含目录，压成 zip 发给对方 → 插件管理「从目录安装」→ 选那个目录。

这条路不需要 GitHub、不需要 PR、当天就能用。
