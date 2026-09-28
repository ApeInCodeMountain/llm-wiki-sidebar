# llm-wiki-sidebar

English | [简体中文](README.zh-CN.md)

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![DSH](https://img.shields.io/badge/DeepSeek%20Harness-0.1.7--rc.2%2B-blue)
![sidebar](https://img.shields.io/badge/sidebar-built--in-green)

[LLM Wiki](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f) workbench for the
**sidebar shipped with DeepSeek Harness itself**: browse and lint a Karpathy-style interlinked
markdown wiki directly in the right Sidebar, render pages with clickable `[[wikilinks]]`,
relative `.md` / provenance links and backlinks, and ship the `llm-wiki` agent skill — packaged as
one DSH plugin.

> **v2.0.0 is the built-in-sidebar rewrite.** v1.x targeted the third-party
> [`dsh-better-sidebar`](https://github.com/omdsh-dev/DSH-better-sidebar) plugin and registered a
> `betterSidebar` tab + file viewer. DeepSeek Harness now ships its own right Sidebar
> (`@deepseek-ai/dsh-client-ui-sidebar-right`), which conflicts with that plugin. v2 talks to the
> built-in sidebar instead: no third-party sidebar plugin is required or supported.

## Features

- **📚 LLM Wiki sidebar tab** — sectioned page catalog (entities / concepts / comparisons /
  queries), search by slug/title/tag, quality markers (`conf: low`, `contested`), one-click open as
  a file resource, a refresh button, and the page-refresh shortcut bound to the product command.
- **Wiki page rendering** — `.md` files that live inside a wiki root are claimed by this plugin's
  own resource tab type and rendered with [markdown-it](https://github.com/markdown-it/markdown-it)
  (GFM tables, fenced code, blockquotes, lists, images). Files outside a wiki root keep the
  product's native document preview untouched.
- **Clickable `[[wikilinks]]`** — `[[target]]` / `[[target|label]]` resolve against the wiki map;
  unresolved links render struck-through with a tooltip. Rendered from the source text, so nothing
  is written back and the file on disk is never modified.
- **Heading anchors** — `[[page#section]]` opens the page and scrolls to the matching heading, and
  `[[#section]]` jumps within the current page. Matching accepts the heading text or its slug
  (GitHub-style, Unicode-aware, so CJK headings work too).
- **Clickable provenance & relative `.md` links** — provenance markers (`^([来源](raw/...))`) and
  any relative markdown link open through the same resource path as the catalog.
- **Backlinks** — a "🔗 Linked here (N)" bar under each wiki page.
- **Source / preview toggle** — read the raw markdown (frontmatter included) without leaving the
  sidebar; frontmatter fields render as a compact chip row above the preview.
- **Lint report** — the full 12 checks (broken links, orphans, index completeness, frontmatter
  validation, stale pages, contested, quality signals, sha256 source drift, page size, tag
  taxonomy, log rotation) grouped by severity. The same checks are available on the CLI via the
  packaged `scripts/wiki_lint.py`.
- **Multiple wikis per workspace** — alongside the default `wiki/`, the tab auto-discovers sibling
  directories that look like a wiki (`SCHEMA.md`/`index.md` + a section or `raw/` dir) and shows a
  switcher in the tab header; page rendering follows the file's owning wiki root via longest-prefix
  match. Extra roots can be registered explicitly via the `wikiRoots` plugin config (see
  [Multiple wikis](#multiple-wikis)).
- **Ships the `llm-wiki` skill** — `skills/llm-wiki/SKILL.md` + `scripts/wiki_lint.py` are mounted
  by a dedicated `dsh-skill-filesystem` instance scoped to this package, so the plugin and its
  skill install and uninstall as one unit.

## Requirements

- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) with the built-in right
  Sidebar (`@deepseek-ai/dsh-client-ui-sidebar-right`, 0.1.7-rc.2 or newer)
- Node.js ≥ 20

No third-party sidebar plugin is needed. `dsh-better-sidebar` must **not** be installed: it
provides its own sidebar and conflicts with the built-in one.

## Install

The default wiki lives at `<session workspace>/wiki` (the sidebar file routes enforce the workspace
fence, so workspace-relative is the supported location). Additional wikis may live in any directory
inside the workspace — see [Multiple wikis](#multiple-wikis).

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

The served browser bundle `lib/client.js` is generated (it inlines the vendored markdown-it), so
build it once after cloning:

```sh
git clone https://github.com/ApeInCodeMountain/llm-wiki-sidebar
cd llm-wiki-sidebar && node scripts/build-client.mjs
cp -r . ~/.dsh/profiles/web/llm-wiki-sidebar
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
2. Open the right Sidebar: the **📚 LLM Wiki** entry on the guide page (or its tab) shows the
   catalog, search, and the **Lint** button.
3. Click a page: it opens as a wiki page tab with clickable `[[wikilinks]]`, provenance links and
   backlinks. Use **Source** to read the raw markdown.
4. A second knowledge base? Create it as a sibling directory (convention: `wiki-<topic>/`) with the
   same layered layout — the sidebar discovers it automatically and the tab header gains a wiki
   switcher. Each wiki keeps its own slug namespace; cross-wiki references use relative `.md` links.

## Multiple wikis

A workspace can hold several independent knowledge bases. The host unions three sources (dedupli-
cated by root, in this order):

1. **Default** — `<workspace>/wiki`, always listed; a workspace with only it renders without a
   switcher.
2. **Plugin config** — `wikiRoots` in the plugin row's `config:` (workspace-relative or absolute
   inside the workspace). Registered roots are listed even before they exist (`exists: false`) and
   are never subject to `exclude`.
3. **Auto-discovery** — depth-1 directories under the workspace that look like a wiki: contain
   `SCHEMA.md` or `index.md` **and** at least one of `entities/ concepts/ comparisons/ queries/
   raw/`, so ordinary project folders are never misreported. `exclude` (basenames) skips noisy
   directories.

A file belongs to the longest matching registered root, so wikilinks, provenance links and
backlinks work in every wiki. Wiki roots are always validated to stay inside the session workspace
(`lib/wiki-root.js`) — paths escaping the workspace are refused. `wiki_lint.py` takes the wiki root
as its argument, so each wiki lints separately.

Example config in `~/.dsh/profiles/web/cordis.patch.yml`:

```yaml
- insert:
    - id: llm-wiki-sidebar
      name: 'llm-wiki-sidebar'
      config:
        wikiRoots: ['wiki-game', 'kb/research']
        exclude: ['node_modules', 'archive']
```

## How it plugs into the built-in sidebar

| Piece | Extension point |
|---|---|
| Browse + lint tab | page type `llm-wiki` via `ctx.sidebarRightTabs.register`, body in the keyed `sidebar.right.pane.tab` seat |
| Wiki page rendering | resource type `llm-wiki-page` via `ctx.sidebarRightTabs.register` (`dsh-resource://file/**` + `canOpen` for wiki `.md`), same body seat |
| Opening a page | `tab.actions.openResource(dsh-resource://file/session/<sessionId>/<path>)` |
| Page text | `ctx.remote.workspaceFiles.read` (paged line reads, sandbox-aware) |
| Catalog / lint / map / registries | this plugin's own host routes (below) |

Only wiki `.md` files are claimed; every other address keeps the product's native document
preview. The plugin never reads or patches another plugin's DOM.

## Routes (host half)

| Route | Body | Purpose |
|---|---|---|
| `POST /llm-wiki/api/wikis` | `{ cwd }` | wiki roots exposed by the workspace (default + config + discovery) |
| `POST /llm-wiki/api/scan` | `{ cwd, wiki? }` | wiki page catalog |
| `POST /llm-wiki/api/lint` | `{ cwd, wiki? }` | lint report |
| `POST /llm-wiki/api/map` | `{ cwd, wiki? }` | slug→page map + backlink graph + raw index |

`wiki` is optional on scan/lint/map: omitted selects the default `<cwd>/wiki`; otherwise it is a
workspace-relative or workspace-absolute root resolved by `resolveWikiRoot()`.

All routes enforce the same browser-trust fence as the `/api` gateway
(loopback/trusted Host + same-origin markers) and read only through the
sandbox-aware `fs` service. The plugin never writes to disk.

## Development

```sh
node scripts/build-client.mjs                              # regenerate lib/client.js from lib/client.src.js
node --check lib/client.js && node --check lib/index.js && node --check lib/wiki-root.js
node test/impl.test.mjs                                    # unit + regression (no browser required)
```

`lib/client.js` is **generated**: edit `lib/client.src.js`, then run the build. The vendored
markdown-it build and its MIT license text live in `lib/vendor/`.

The v1 design notes for the old DOM-text-pairing pipeline are kept in the repository for history
and no longer describe the implementation: v2 renders instead of patching another plugin's DOM, so
that pipeline was removed together with the better-sidebar dependency.

## License

[MIT](LICENSE)

## Acknowledgments

- [Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f)
  and the MIT-licensed `llm-wiki` skill from the hermes-agent project — the packaged
  `skills/llm-wiki` skill is a DSH edition of that pattern.
- [markdown-it](https://github.com/markdown-it/markdown-it) (MIT) — vendored into the browser
  bundle for wiki page rendering; its license ships at `lib/vendor/markdown-it.LICENSE`.
- [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (MIT) — the host
  runtime; the browser-trust fence in `lib/index.js` is a behavioral port of the
  `/api` gateway's fence from `@deepseek-ai/dsh-client-connection` (MIT).
- [dsh-better-sidebar](https://github.com/omdsh-dev/DSH-better-sidebar) (MIT) — the sidebar plugin
  v1.x extended; v2 no longer depends on it because DSH ships its own sidebar.
