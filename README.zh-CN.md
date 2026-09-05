# llm-wiki-sidebar

[English](README.md) | 简体中文

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![DSH](https://img.shields.io/badge/DeepSeek%20Harness-0.1.2--rc.1%2B-blue)
![dsh-better-sidebar](https://img.shields.io/badge/dsh--better--sidebar-%E2%89%A50.16.0-green)

面向 [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) 的
[LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) 工作台：直接在
DSH 侧边栏浏览并体检 Karpathy 式互联 markdown wiki，提供高保真页面预览/编辑、可点击的
`[[wikilinks]]` 与溯源链接、背链，以及驱动导入/查询/维护的 `llm-wiki` agent skill——
打包为同一个 DSH 插件。

## 功能

- **📚 LLM Wiki 侧边栏页签** — 分区页面目录（entities / concepts / comparisons /
  queries），按 slug/标题/标签搜索，质量标记（`conf: low`、`contested` 争议），一键经
  `betterSidebar.openFile` 打开，另有从磁盘重新读取 wiki 的刷新按钮。
- **原生 markdown 查看器** — wiki 页面经由 dsh-better-sidebar 内置 markdown 查看器渲染
  （Mermaid、shiki、KaTeX、TOC、内嵌 HTML），保留原生预览/编辑工具栏与 Ctrl/Cmd+S 保存。
  不替换原生查看器的任何行为；插件只对其输出做装饰。
- **可点击的 `[[wikilinks]]`** — 预览模式的 DOM 装饰将 `[[目标]]` / `[[目标|别名]]` 对
  wiki map 解析并经 `openFile` 跳转（从不修改页面文本，编辑/保存始终安全）。无法解析的
  链接以删除线渲染并带提示。
- **可点击的溯源与站内相对 `.md` 链接** — 溯源标记（`^([来源](raw/...))`）与任何站内相对
  markdown 链接在预览中可点击，经与目录页相同的 `openFile` 通路打开。共享 markdown 渲染器
  会丢弃相对链接目标，因此插件改用「源码解析链接 ↔ 渲染标签文本」配对——从不改写
  `fp.content`，编辑模式保存逐字节不变。
- **背链** — 每页底部 "🔗 Linked here (N)" 栏。
- **Lint 报告** — 完整 12 项检查（断链、孤儿页、index 完整性、frontmatter 校验、过期页面、
  争议标记、质量信号、sha256 源漂移、页面体积、标签分类、log 轮转），按严重级别分组；
  error+warn 数量显示为页签徽标。同样检查可通过打包的 `scripts/wiki_lint.py` 在 CLI 使用。
- **内置 `llm-wiki` skill** — `skills/llm-wiki/SKILL.md` + `scripts/wiki_lint.py` 由专属的
  `dsh-skill-filesystem` 实例挂载并限定在本包目录，插件与其 skill 作为整体安装/卸载。

## 环境要求

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 0.1.2-rc.1+
- [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) ≥ 0.16.0（`openFile`
  能力；实测 0.18.0）
- Node.js ≥ 20

## 安装

wiki 位于 `<会话工作区>/wiki`（侧边栏文件路由强制工作区围栏，工作区内为受支持位置）。

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

```sh
git clone https://github.com/ApeInCodeMountain/llm-wiki-sidebar
cp -r llm-wiki-sidebar ~/.dsh/profiles/web/
ln -sfn ../llm-wiki-sidebar ~/.dsh/profiles/web/node_modules/llm-wiki-sidebar
# 注册为 link: 依赖，让 pnpm 保持软链
node -e "const fs=require('fs');const f=process.env.HOME+'/.dsh/profiles/web/package.json';const j=JSON.parse(fs.readFileSync(f));j.dependencies['llm-wiki-sidebar']='link:llm-wiki-sidebar';fs.writeFileSync(f,JSON.stringify(j,null,2)+'\n')"
```

然后重启 `dsh --profile web` 并硬刷新浏览器（Cmd/Ctrl+Shift+R）。

### 卸载

用 `dsh plugin --profile web remove llm-wiki-sidebar` 移除（或从
`~/.dsh/profiles/web/cordis.patch.yml` 删除两行、从 profile 的 `package.json` 删除依赖、
删除 `node_modules/llm-wiki-sidebar` 软链与 `~/.dsh/profiles/web/llm-wiki-sidebar` 目录），
重启 DSH。卸载同时撤下内置的 `llm-wiki` skill（它就在插件目录内）。

## 使用

1. 对 agent 说：“帮我在这个工作区初始化一个 wiki”——内置 `llm-wiki` skill 会创建 `wiki/`
   （`SCHEMA.md`、`index.md`、`log.md` 与分层目录），随后导入来源。
2. 打开侧边栏的 **📚 LLM Wiki** 页签：目录、搜索与 **Lint** 按钮。
3. 打开任意页面进入原生预览——`[[wikilinks]]`、溯源链接与背链均可点击；在侧边栏编辑即直接
   写盘（记得 bump `updated`）。

## 路由（宿主半边）

| 路由 | 请求体 | 用途 |
|---|---|---|
| `POST /llm-wiki/api/scan` | `{ cwd }` | wiki 页面目录 |
| `POST /llm-wiki/api/lint` | `{ cwd }` | lint 报告 |
| `POST /llm-wiki/api/map` | `{ cwd }` | slug→页面映射 + 背链图 + raw 索引 |

所有路由强制与 `/api` 网关相同的浏览器信任围栏（loopback/可信 Host + 同源标记），且只经
沙箱感知的 `fs` 服务读取。插件从不写盘。

## 开发

```sh
node --check lib/client.js && node --check lib/index.js   # 语法
node test/impl.test.mjs                                   # 单元 + 回归（无需 DOM）
```

可点击链接管线的设计说明（为什么采用「源码链接 ↔ 渲染标签」配对而非拦截锚点）见
[`docs/design-source-link-navigation-v2.md`](docs/design-source-link-navigation-v2.md)。

## 许可证

[MIT](LICENSE)

## 致谢

- [Karpathy 的 LLM Wiki 模式](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
  与 hermes-agent 项目的 MIT `llm-wiki` skill——本包 `skills/llm-wiki` 是该模式的 DSH 版。
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（MIT）——宿主运行时；
  `lib/index.js` 中的浏览器信任围栏是 `@deepseek-ai/dsh-client-connection`（MIT）里 `/api`
  网关围栏的行为级移植。
- [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar)（MIT）——本插件扩展
  的侧边栏工作台，`betterSidebar` 服务的提供方。
