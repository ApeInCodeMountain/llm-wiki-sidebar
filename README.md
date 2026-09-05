# llm-wiki-sidebar

English | [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![DSH](https://img.shields.io/badge/DeepSeek%20Harness-0.1.2--rc.1%2B-blue)
![dsh-better-sidebar](https://img.shields.io/badge/dsh--better--sidebar-%E2%89%A50.16.0-green)

[LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) workbench for
[dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar): browse and lint a
Karpathy-style interlinked markdown wiki directly in the DSH sidebar, with full-fidelity page
preview/editing, clickable `[[wikilinks]]` and provenance links, backlinks, and the `llm-wiki`
agent skill that drives ingest/query/maintenance — packaged as one DSH plugin.

## Features

- **📚 LLM Wiki sidebar tab** — sectioned page catalog (entities / concepts / comparisons /
  queries), search by slug/title/tag, quality markers (`conf: low`, `contested`), one-click open
  via `betterSidebar.openFile`, and a refresh button that re-reads the wiki from disk.
- **Native markdown viewer** — wiki pages render through dsh-better-sidebar's built-in markdown
  viewer (Mermaid, shiki, KaTeX, TOC, embedded HTML) with the stock preview/edit toolbar and
  Ctrl/Cmd+S save. Nothing about the native viewer is replaced; the plugin only decorates its
  output.
- **Clickable `[[wikilinks]]`** — preview-mode DOM decoration resolves `[[target]]` /
  `[[target|label]]` against the wiki map and jumps via `openFile` (page text is never modified,
  so editing/saving stays safe). Unresolvable links render struck-through with a tooltip.
- **Clickable provenance & relative `.md` links** — provenance markers (`^([来源](raw/...))`) and
  any in-site relative markdown link are clickable in the preview and open through the same
  `openFile` path as the catalog. The shared markdown renderer drops relative link destinations,
  so the plugin pairs source-parsed links with their rendered label text instead — `fp.content`
  is never rewritten, keeping edit-mode saves byte-identical.
- **Backlinks** — "🔗 Linked here (N)" bar under each wiki page.
- **Lint report** — the full 12 checks (broken links, orphans, index completeness, frontmatter
  validation, stale pages, contested, quality signals, sha256 source drift, page size, tag
  taxonomy, log rotation) grouped by severity; error+warn count shows as a tab badge. The same
  checks are available on the CLI via the packaged `scripts/wiki_lint.py`.
- **Ships the `llm-wiki` skill** — `skills/llm-wiki/SKILL.md` + `scripts/wiki_lint.py` are
  mounted by a dedicated `dsh-skill-filesystem` instance scoped to this package, so the plugin
  and its skill install and uninstall as one unit.

## Requirements

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 0.1.2-rc.1+
- [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) ≥ 0.16.0 (`openFile`
  capability; tested against 0.18.0)
- Node.js ≥ 20

## Install

The wiki lives at `<session workspace>/wiki` (the sidebar file routes enforce the workspace
fence, so workspace-relative is the supported location).

### From GitHub (official bundle CLI)

```sh
dsh plugin --profile web add "github:ApeInCodeMountain/llm-wiki-sidebar"
```

Then restart `dsh --profile web` and hard-refresh the browser.

### From npm

```sh
dsh plugin --profile web add llm-wiki-sidebar
```

### Local development install

```sh
git clone https://github.com/ApeInCodeMountain/llm-wiki-sidebar
cp -r llm-wiki-sidebar ~/.dsh/profiles/web/
ln -sfn ../llm-wiki-sidebar ~/.dsh/profiles/web/node_modules/llm-wiki-sidebar
# register as a link: dependency so pnpm keeps the symlink
node -e "const fs=require('fs');const f=process.env.HOME+'/.dsh/profiles/web/package.json';const j=JSON.parse(fs.readFileSync(f));j.dependencies['llm-wiki-sidebar']='link:llm-wiki-sidebar';fs.writeFileSync(f,JSON.stringify(j,null,2)+'\n')"
```

Then restart `dsh --profile web` and hard-refresh the browser (Cmd/Ctrl+Shift+R).

### Uninstall

Remove the package via `dsh plugin --profile web remove llm-wiki-sidebar` (or delete both rows
from `~/.dsh/profiles/web/cordis.patch.yml`, the profile `package.json` entry, the
`node_modules/llm-wiki-sidebar` symlink and the `~/.dsh/profiles/web/llm-wiki-sidebar`
directory); restart DSH. Uninstalling also withdraws the packaged `llm-wiki` skill (it lives
inside the plugin directory).

## Usage

1. Tell the agent: “帮我在这个工作区初始化一个 wiki” (or "create a wiki here") — the packaged
   `llm-wiki` skill creates `wiki/` with `SCHEMA.md`, `index.md`, `log.md` and the layered
   directories, then ingests sources.
2. Open the **📚 LLM Wiki** tab in the sidebar: the catalog, search, and the **Lint** button.
3. Open any page for the native preview — `[[wikilinks]]`, provenance links and backlinks are
   clickable; editing in the sidebar writes the file directly (bump `updated`).

## Routes (host half)

| Route | Body | Purpose |
|---|---|---|
| `POST /llm-wiki/api/scan` | `{ cwd }` | wiki page catalog |
| `POST /llm-wiki/api/lint` | `{ cwd }` | lint report |
| `POST /llm-wiki/api/map` | `{ cwd }` | slug→page map + backlink graph + raw index |

All routes enforce the same browser-trust fence as the `/api` gateway
(loopback/trusted Host + same-origin markers) and read only through the
sandbox-aware `fs` service. The plugin never writes to disk.

## Development

```sh
node --check lib/client.js && node --check lib/index.js   # syntax
node test/impl.test.mjs                                   # unit + regression (no DOM required)
```

The design notes for the clickable-link pipeline (why it pairs source links with rendered
label text instead of intercepting anchors) live in
[`docs/design-source-link-navigation-v2.md`](docs/design-source-link-navigation-v2.md).

## License

[MIT](LICENSE)

## Acknowledgments

- [Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
  and the MIT-licensed `llm-wiki` skill from the hermes-agent project — the packaged
  `skills/llm-wiki` skill is a DSH edition of that pattern.
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (MIT) — the host
  runtime; the browser-trust fence in `lib/index.js` is a behavioral port of the
  `/api` gateway's fence from `@deepseek-ai/dsh-client-connection` (MIT).
- [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) (MIT) — the sidebar
  workbench this plugin extends, and the provider of the `betterSidebar` service.
