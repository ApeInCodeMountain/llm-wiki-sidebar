# llm-wiki-sidebar

[English](README.md) | 简体中文

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![DSH](https://img.shields.io/badge/DeepSeek%20Harness-0.1.7--rc.2%2B-blue)
![sidebar](https://img.shields.io/badge/sidebar-built--in-green)

面向 **DeepSeek Harness 自带侧边栏**的
[LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 工作台：直接在
右侧边栏浏览并体检 Karpathy 式互联 markdown wiki，页面渲染时提供可点击的 `[[wikilinks]]`、
相对 `.md`/溯源链接与背链，并内置 `llm-wiki` agent skill——打包为同一个 DSH 插件。

> **v2.0.0 是「改用内置侧边栏」的重写版。** v1.x 面向第三方插件
> [`dsh-better-sidebar`](https://github.com/omdsh-dev/DSH-better-sidebar)，注册的是
> `betterSidebar` 页签与文件查看器。DSH 现在自带右侧边栏
> （`@deepseek-ai/dsh-client-ui-sidebar-right`），与该插件冲突。v2 直接对接内置侧边栏：
> 不再需要、也不支持第三方侧边栏插件。

## 功能

- **📚 LLM Wiki 侧边栏页签** — 分区页面目录（entities / concepts / comparisons / queries），
  按 slug/标题/标签搜索，质量标记（`conf: low`、`contested` 争议），一键以文件资源形式打开，
  刷新按钮，并把产品自带的「刷新页面」快捷键绑定到本页签。
- **wiki 页面渲染** — 位于 wiki 根内的 `.md` 由本插件自己的资源页签类型接管，使用
  [markdown-it](https://github.com/markdown-it/markdown-it) 渲染（GFM 表格、代码围栏、引用、
  列表、图片）。wiki 根之外的文件仍走产品原生文档预览，完全不受影响。
- **可点击的 `[[wikilinks]]`** — `[[目标]]` / `[[目标|别名]]` 对 wiki map 解析；无法解析的
  链接以删除线渲染并带提示。渲染源自源文本，不回写文件，磁盘内容永不被修改。
- **标题锚点** — `[[页面#小节]]` 打开该页并滚动到对应标题，`[[#小节]]` 在当前页内跳转。
  匹配同时接受标题原文与 slug（GitHub 风格、Unicode 感知，中文标题同样可用）。
- **可点击的溯源与站内相对 `.md` 链接** — 溯源标记（`^([来源](raw/...))`）与任何相对
  markdown 链接都经与目录页相同的资源通路打开。
- **背链** — 每页底部 "🔗 Linked here (N)" 栏。
- **源码 / 预览切换** — 不离开侧边栏即可查看原始 markdown（含 frontmatter）；frontmatter
  字段在预览上方以紧凑标签行显示。
- **Lint 报告** — 完整 12 项检查（断链、孤儿页、index 完整性、frontmatter 校验、过期页面、
  争议标记、质量信号、sha256 源漂移、页面体积、标签分类、log 轮转），按严重级别分组。同样
  检查可通过打包的 `scripts/wiki_lint.py` 在 CLI 使用。
- **一个工作区多个 wiki** — 除默认 `wiki/` 外，页签自动发现形似 wiki 的同级目录（含
  `SCHEMA.md`/`index.md` 且有分区或 `raw/` 目录），并在页签头部提供切换器；页面渲染按
  「最长前缀匹配」跟随文件所属的 wiki 根。额外位置可用插件的 `wikiRoots` 配置显式注册
  （见下方「多 wiki」）。
- **内置 `llm-wiki` skill** — `skills/llm-wiki/SKILL.md` + `scripts/wiki_lint.py` 由专属的
  `dsh-skill-filesystem` 实例挂载并限定在本包目录，插件与其 skill 作为整体安装/卸载。

## 环境要求

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)，需带内置右侧边栏
  （`@deepseek-ai/dsh-client-ui-sidebar-right`，0.1.7-rc.2 或更新）
- Node.js ≥ 20

无需任何第三方侧边栏插件。`dsh-better-sidebar` 必须**不要**安装：它自带侧边栏，会与内置
侧边栏冲突。

## 安装

默认 wiki 位于 `<会话工作区>/wiki`（侧边栏文件路由强制工作区围栏，工作区内为受支持位置）。
其他 wiki 可放在工作区内任意目录——见[多 wiki](#多-wiki)。

### 从 GitHub（官方 bundle CLI）

```sh
dsh plugin --profile web add "github:ApeInCodeMountain/llm-wiki-sidebar"
```

然后重启 `dsh --profile web` 并硬刷新浏览器。

### 从 npm

```sh
dsh plugin --profile web add llm-wiki-sidebar
```

### 本地开发安装

浏览器端实际加载的 `lib/client.js` 是生成产物（内联了 vendored 的 markdown-it），clone
之后先生成一次：

```sh
git clone https://github.com/ApeInCodeMountain/llm-wiki-sidebar
cd llm-wiki-sidebar && node scripts/build-client.mjs
cp -r . ~/.dsh/profiles/web/llm-wiki-sidebar
ln -sfn ../llm-wiki-sidebar ~/.dsh/profiles/web/node_modules/llm-wiki-sidebar
# 注册为 link: 依赖，让 pnpm 保留该软链
node -e "const fs=require('fs');const f=process.env.HOME+'/.dsh/profiles/web/package.json';const j=JSON.parse(fs.readFileSync(f));j.dependencies['llm-wiki-sidebar']='link:llm-wiki-sidebar';fs.writeFileSync(f,JSON.stringify(j,null,2)+'\n')"
```

然后重启 `dsh --profile web` 并硬刷新浏览器（Cmd/Ctrl+Shift+R）。

### 卸载

用 `dsh plugin --profile web remove llm-wiki-sidebar` 移除（或手动删除
`~/.dsh/profiles/web/cordis.patch.yml` 中的两行、profile `package.json` 中的依赖项、
`node_modules/llm-wiki-sidebar` 软链以及 `~/.dsh/profiles/web/llm-wiki-sidebar` 目录）；
重启 DSH。卸载会一并撤下打包的 `llm-wiki` skill（它就在插件目录内）。

## 使用

1. 对 agent 说：“帮我在这个工作区初始化一个 wiki”——内置的 `llm-wiki` skill 会创建
   `wiki/`（`SCHEMA.md`、`index.md`、`log.md` 与分层目录）并开始 ingest 源材料。
2. 打开右侧边栏：引导页上的 **📚 LLM Wiki** 入口（或其页签）显示目录、搜索与 **体检** 按钮。
3. 点击某个页面：它以 wiki 页面页签打开，`[[wikilinks]]`、溯源链接与背链均可点击。用
   **源码** 查看原始 markdown。
4. 想要第二个知识库？用相同的分层结构建一个同级目录（惯例：`wiki-<主题>/`）——侧边栏会自动
   发现它，页签头部出现 wiki 切换器。每个 wiki 有独立的 slug 命名空间；跨 wiki 引用请用
   相对 `.md` 链接。

## 多 wiki

一个工作区可以放多个互相独立的知识库。宿主按以下顺序合并三类来源（按根去重）：

1. **默认** — `<工作区>/wiki`，始终列出；只存在它时界面不显示切换器。
2. **插件配置** — 插件行 `config:` 中的 `wikiRoots`（工作区相对路径，或工作区内绝对路径）。
   显式注册的根即使尚未创建也会列出（`exists: false`），且不受 `exclude` 影响。
3. **自动发现** — 工作区下深度 1 的、形似 wiki 的目录：含 `SCHEMA.md` 或 `index.md`，**且**
   含 `entities/ concepts/ comparisons/ queries/ raw/` 中至少一个，因此普通项目目录不会被
   误报。`exclude`（basename 列表）可跳过嘈杂目录。

文件归属于「最长匹配」的已注册根，因此 wikilink、溯源链接与背链在每个 wiki 中都可用。所有
wiki 根都会被校验必须留在会话工作区内（`lib/wiki-root.js`）——越界路径一律拒绝。
`wiki_lint.py` 以 wiki 根为参数，因此每个 wiki 各自体检。

在 `~/.dsh/profiles/web/cordis.patch.yml` 中配置示例：

```yaml
- insert:
    - id: llm-wiki-sidebar
      name: 'llm-wiki-sidebar'
      config:
        wikiRoots: ['wiki-game', 'kb/research']
        exclude: ['node_modules', 'archive']
        # /llm-wiki/api 围栏在 loopback 之外接受的远程主机——仅当 GUI
        # 以非 loopback 名称提供时才需要。
        trustedHosts: ['app.example']
```

## 如何接入内置侧边栏

| 组成 | 扩展点 |
|---|---|
| 浏览 + 体检页签 | page 类型 `llm-wiki`，经 `ctx.sidebarRightTabs.register` 注册，body 注册进 keyed `sidebar.right.pane.tab` 座位 |
| wiki 页面渲染 | 资源类型 `llm-wiki-page`，经 `ctx.sidebarRightTabs.register`（`dsh-resource://file/**` + `canOpen` 限定 wiki `.md`），同一个 body 座位 |
| 打开页面 | `tab.actions.openResource(dsh-resource://file/session/<sessionId>/<path>)` |
| 页面文本 | `ctx.remote.workspaceFiles.read`（分页行读取，受沙箱约束） |
| 目录 / Lint / map / wiki 注册表 | 本插件自己的宿主路由（见下） |

只接管 wiki `.md`；其他地址一律保留产品原生文档预览。插件从不读取或改写其它插件的 DOM。

## 路由（宿主半边）

| 路由 | 请求体 | 用途 |
|---|---|---|
| `POST /llm-wiki/api/wikis` | `{ cwd }` | 工作区暴露的 wiki 根（默认 + 配置 + 发现） |
| `POST /llm-wiki/api/scan` | `{ cwd, wiki? }` | wiki 页面目录 |
| `POST /llm-wiki/api/lint` | `{ cwd, wiki? }` | 体检报告 |
| `POST /llm-wiki/api/map` | `{ cwd, wiki? }` | slug→页面映射 + 背链图 + raw 索引 |

scan/lint/map 的 `wiki` 可省略：省略时选默认 `<cwd>/wiki`；否则为经 `resolveWikiRoot()`
解析的工作区相对或工作区绝对根。

所有路由都强制与 `/api` 网关相同的浏览器信任围栏（loopback / 监听绑定 IP / 配置的
`trustedHosts` + 同源标记；见下文「远程访问」），并且只通过沙箱感知的 `fs` 服务读取。
插件从不写盘。

### 远程访问（GUI 通过域名或隧道提供）

`/llm-wiki/api` 路由强制与 `/api` 网关相同的浏览器信任围栏，但插件读不到网关的
`trustedHosts`（产品不向插件暴露它）：**默认围栏只接受 loopback Host**。通过
`https://app.example`（反向代理、rathole、socat…）访问 GUI 时，浏览器发送
`Host: app.example`，于是每个 wiki API 调用都返回 `403 forbidden`，而 `127.0.0.1`
照常工作。

在插件配置中声明部署的权威，语义与 `dsh --profile web --trusted-host` 相同
（不带端口的 `host` = 任意端口，`host:port` = 精确匹配），并保持两份列表同步：

```yaml
- id: llm-wiki-sidebar
  config:
    trustedHosts: ['app.example']
```

格式错误的条目（路径、`user@host`、多余空白、零填充端口）会在插件加载时直接报错，
而不是悄悄改变授权。监听器的绑定 IP 字面量始终被接受，与产品围栏一致。

## 开发

```sh
node scripts/build-client.mjs                              # 由 lib/client.src.js 重新生成 lib/client.js
node --check lib/client.js && node --check lib/index.js && node --check lib/wiki-root.js
node test/impl.test.mjs                                    # 单元 + 回归（无需浏览器）
```

`lib/client.js` 是**生成产物**：请改 `lib/client.src.js`，然后跑构建。vendored 的
markdown-it 构建产物与其 MIT 许可证文本在 `lib/vendor/`。

v1 那套 DOM 文本配对流水线的设计文档仅作为历史保留在仓库里，已不再描述当前实现：v2 改为
「渲染而非给别的插件打 DOM 补丁」，该流水线已随 better-sidebar 依赖一并移除。

## 许可证

[MIT](LICENSE)

## 致谢

- [Karpathy 的 LLM Wiki 模式](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
  与 hermes-agent 项目中 MIT 许可的 `llm-wiki` skill——本包内置的 `skills/llm-wiki`
  是该模式的 DSH 版本。
- [markdown-it](https://github.com/markdown-it/markdown-it)（MIT）——用于 wiki 页面渲染，
  已 vendored 进浏览器 bundle；许可证随包提供于 `lib/vendor/markdown-it.LICENSE`。
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）——宿主运行时；
  `lib/index.js` 中的浏览器信任围栏是对 `@deepseek-ai/dsh-client-connection`（MIT）中
  `/api` 网关围栏的行为级移植。
- [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)（MIT）——v1.x 扩展的
  侧边栏插件；因 DSH 已自带侧边栏，v2 不再依赖它。
