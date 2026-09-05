---
name: llm-wiki
description: Build and maintain a persistent, compounding knowledge base as interlinked markdown files (Karpathy's LLM Wiki pattern) — ingest sources into raw/, curate entity/concept/comparison/query pages with wikilinks and frontmatter, answer queries from compiled knowledge, and lint wiki health. Use when the user asks to create or grow a wiki/knowledge base, ingest or add a source to it, query an existing wiki or their notes, or lint/audit/health-check it.
whenToUse: Activate on requests mentioning a wiki, knowledge base, or research notes; on ingest/add/process-a-source requests when a wiki exists at the configured path; and on lint/audit/health-check requests. Do not activate for ordinary one-off questions with no wiki present.
---

# Karpathy's LLM Wiki (DSH edition, ships with llm-wiki-sidebar)

Build and maintain a persistent, compounding knowledge base as interlinked markdown files. Ported from the hermes-agent `llm-wiki` skill (MIT), based on [Andrej Karpathy's LLM Wiki pattern](https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f).

Unlike traditional RAG (which rediscovers knowledge from scratch per query), the wiki compiles knowledge once and keeps it current. Cross-references are already there. Contradictions have already been flagged. Synthesis reflects everything ingested.

**Division of labor:** The human curates sources and directs analysis. You summarize, cross-reference, file, and maintain consistency.

## The companion plugin (llm-wiki-sidebar)

This skill ships inside the `llm-wiki-sidebar` DSH plugin, which renders the wiki in the dsh-better-sidebar workbench:

- **📚 LLM Wiki tab** — the page catalog (entities / concepts / comparisons / queries), search, and a **Lint button** running the full 12-check report (including sha256 source drift). Its ↻ refresh re-reads the wiki from disk.
- **Native page view** — opening a page uses the built-in markdown preview/editor; `[[wikilinks]]` in the preview are clickable and jump between pages; each page shows a "🔗 Linked here" backlink bar.
- Editing in the sidebar writes the file directly — treat those edits as page updates (bump `updated`, keep frontmatter valid).

Division of work: **you drive ingest/query/maintenance; the plugin displays and audits.** After ingesting, tell the user to hit ↻ in the 📚 tab — do not enumerate every changed file as if nothing shows it.

## Tool mapping (DSH)

| Task | DSH tool |
| --- | --- |
| Read a wiki page / source | `read` |
| Create or rewrite a page | `write` |
| Targeted page edit (bump `updated`, add a paragraph) | `edit` |
| Find pages by filename | `glob` |
| Find pages by content / frontmatter field | `grep` (ripgrep regex) |
| Fetch a URL as text (ingest) | `web_fetch` |
| Find sources on the web | `web_search` |
| Programmatic scans (lint), hashing, PDF fallback | `bash` |

`web_fetch` decodes **textual content only** — it does not extract PDF text (binary types fail with `WEB_UNSUPPORTED_CONTENT_TYPE`). For PDFs: download with `bash` (`curl -L -o raw/papers/<name>.pdf <url>`), try `pdftotext` (poppler) if installed, and if extraction is impossible, archive the PDF, note it in the wiki page as "source archived, not yet text-extracted", and never invent its contents.

## Wiki location

Resolve the wiki root in this order and confirm with the user when ambiguous:

1. `$WIKI_PATH` from the environment, if set (checked via `bash`: `echo "${WIKI_PATH:-}"`).
2. **A project wiki: `wiki/` under the current workspace root — the supported location for the sidebar plugin** (its file routes enforce the workspace fence; a wiki outside the session workspace is browsable by neither preview nor edit).
3. The global default `~/wiki` (Karpathy/hermes convention) — CLI lint still works there, but the sidebar cannot open those pages; say so explicitly if the user picks it.

The wiki is just a directory of markdown files — open it in Obsidian, VS Code, or any editor. No database, no special tooling required.

## Architecture: Three Layers

```
wiki/
├── SCHEMA.md           # Conventions, structure rules, domain config
├── index.md            # Sectioned content catalog with one-line summaries
├── log.md              # Chronological action log (append-only, rotated yearly)
├── raw/                # Layer 1: Immutable source material
│   ├── articles/       # Web articles, clippings
│   ├── papers/         # PDFs, arxiv papers
│   ├── transcripts/    # Meeting notes, interviews
│   └── assets/         # Images, diagrams referenced by sources
├── entities/           # Layer 2: Entity pages (people, orgs, products, models)
├── concepts/           # Layer 2: Concept/topic pages
├── comparisons/        # Layer 2: Side-by-side analyses
└── queries/            # Layer 2: Filed query results worth keeping
```

**Layer 1 — Raw Sources:** Immutable. You read but never modify these. **Layer 2 — The Wiki:** agent-owned markdown files you create, update, and cross-reference. **Layer 3 — The Schema:** `SCHEMA.md` defines structure, conventions, and tag taxonomy.

## Resuming an Existing Wiki (CRITICAL — do this every time)

When the user has an existing wiki, **always orient yourself before doing anything**:

1. Read `SCHEMA.md` — understand the domain, conventions, and tag taxonomy.
2. Read `index.md` — learn what pages exist and their summaries.
3. Scan recent `log.md` — read the last 20–30 entries to understand recent activity.

Only after orientation should you ingest, query, or lint. This prevents duplicate pages, missed cross-references, contradictions with the schema, and repeated work. For large wikis (100+ pages), also `grep`/`glob` for the topic at hand before creating anything new.

## Initializing a New Wiki

1. Determine the wiki path (see Wiki location; ask the user if ambiguous).
2. Create the directory structure above.
3. Ask the user what domain the wiki covers — be specific.
4. Write `SCHEMA.md` customized to the domain (template below).
5. Write initial `index.md` and `log.md` (templates below).
6. Confirm the wiki is ready and suggest first sources to ingest. Point the user at the 📚 LLM Wiki tab in the sidebar.

### SCHEMA.md template

```
# Wiki Schema

## Domain
[What this wiki covers — e.g., "AI/ML research", "personal health", "startup intelligence"]

## Conventions
- File names: lowercase, hyphens, no spaces (e.g., `transformer-architecture.md`)
- Every wiki page starts with YAML frontmatter (see below)
- Use `[[wikilinks]]` to link between pages (minimum 2 outbound links per page)
- When updating a page, always bump the `updated` date
- Every new page must be added to `index.md` under the correct section
- Every action must be appended to `log.md`
- **Provenance markers:** On pages that synthesize 3+ sources, append
  `^[raw/articles/source-file.md]` at the end of paragraphs whose claims come
  from a specific source, so each claim is traceable without re-reading the raw file.

## Frontmatter
---
title: Page Title
created: YYYY-MM-DD
updated: YYYY-MM-DD
type: entity | concept | comparison | query | summary
tags: [from taxonomy below]
sources: [raw/articles/source-name.md]
# Optional quality signals:
confidence: high | medium | low        # how well-supported the claims are
contested: true                        # set when the page has unresolved contradictions
contradictions: [other-page-slug]      # pages this one conflicts with
---

`confidence` and `contested` are optional but recommended for opinion-heavy or
fast-moving topics. Lint surfaces `contested: true` and `confidence: low` pages
for review so weak claims don't silently harden into accepted wiki fact.

## Tag Taxonomy
[Define 10-20 top-level tags for the domain. Add new tags here BEFORE using them.]
```

Rule: every tag on a page must appear in this taxonomy. If a new tag is needed, add it to `SCHEMA.md` first, then use it. This prevents tag sprawl.

### raw/ frontmatter and the sha256 convention

Raw sources ALSO get a small frontmatter block so re-ingests can detect drift:

```
---
source_url: https://example.com/article   # original URL, if applicable
ingested: YYYY-MM-DD
sha256: <hex digest of the raw content below the frontmatter>
---
```

**Exact convention (must match the plugin's lint and `wiki_lint.py`):** the hash covers **all bytes after the closing `---` line, including the trailing newline**. Compute it with:

```bash
N=$(grep -n -m2 '^---$' raw/articles/<name>.md | tail -1 | cut -d: -f1)
HASH=$(tail -n +$((N+1)) raw/articles/<name>.md | sha256sum | cut -d' ' -f1)
```

On re-ingest of the same URL: recompute with the same recipe, skip if identical, flag drift and update if different. A mismatch surfaces as a `drift` warning in the plugin's Lint report.

### index.md template

```
# Wiki Index

> Content catalog. Every wiki page listed under its type with a one-line summary.
> Read this first to find relevant pages for any query.
> Last updated: YYYY-MM-DD | Total pages: N

## Entities
<!-- Alphabetical within section -->

## Concepts

## Comparisons

## Queries
```

**Scaling rule:** When any section exceeds 50 entries, split it into sub-sections by first letter or sub-domain. When the index exceeds 200 entries total, create a `_meta/topic-map.md` grouping pages by theme.

### log.md template

```
# Wiki Log

> Chronological record of all wiki actions. Append-only.
> Format: `## [YYYY-MM-DD] action | subject`
> Actions: ingest, update, query, lint, create, archive, delete
> When this file exceeds 500 entries, rotate: rename to log-YYYY.md, start fresh.
```

## Page Thresholds

- **Create a page** when an entity/concept appears in 2+ sources OR is central to one source.
- **Add to existing page** when a source mentions something already covered.
- **DON'T create a page** for passing mentions, minor details, or things outside the domain.
- **Split a page** when it exceeds ~200 lines — break into sub-topics with cross-links.
- **Archive a page** when its content is fully superseded — move to `_archive/`, remove from index.

## Entity / Concept / Comparison pages

- **Entity page** (one per notable entity): overview / what it is; key facts and dates; relationships to other entities (`[[wikilinks]]`); source references.
- **Concept page** (one per concept or topic): definition / explanation; current state of knowledge; open questions or debates; related concepts (`[[wikilinks]]`).
- **Comparison page** (side-by-side analyses): what is being compared and why; dimensions of comparison (table format preferred); verdict or synthesis; sources.

## Update Policy

When new information conflicts with existing content:

1. Check the dates — newer sources generally supersede older ones.
2. If genuinely contradictory, note both positions with dates and sources.
3. Mark the contradiction in frontmatter: `contradictions: [page-name]`.
4. Flag for user review in the lint report.

## Core Operations

### 1. Ingest

When the user provides a source (URL, file, paste):

1. **Capture the raw source.** URL → `web_fetch`, save the text to `raw/articles/<descriptive-name>.md`. PDF → see the PDF fallback in Tool mapping, save to `raw/papers/`. Pasted text → appropriate `raw/` subdirectory. Add the raw frontmatter (`source_url`, `ingested`, `sha256` per the exact recipe above).
2. **Discuss takeaways** with the user — what's interesting, what matters for the domain. (Skip this in automated/scheduled contexts — proceed directly.)
3. **Check what already exists** — read `index.md` and `grep`/`glob` for entities/concepts mentioned. This is the difference between a growing wiki and a pile of duplicates.
4. **Write or update wiki pages.** New pages only if they meet the Page Thresholds. Existing pages: add new information, bump `updated`, follow the Update Policy on conflict. Every new or updated page links to at least 2 other pages via `[[wikilinks]]`; check that existing pages link back. Tags only from the taxonomy. Provenance markers on 3+ source syntheses. Set `confidence: medium`/`low` for single-source or opinion-heavy claims.
5. **Update navigation.** Add pages to `index.md` (correct section, alphabetical), update header count/date, append to `log.md` listing every file created or updated.
6. **Report what changed and point at the 📚 tab** — the user can refresh the tab (↻) to see the new pages; `[[wikilinks]]` and backlinks appear there automatically.

A single source can trigger updates across 5–15 wiki pages. This is normal and desired — it's the compounding effect.

### 2. Query

1. Read `index.md` to identify relevant pages.
2. For wikis with 100+ pages, also `grep` across `*.md` for key terms — the index alone may miss relevant content.
3. `read` the relevant pages.
4. Synthesize an answer from the compiled knowledge. Cite the wiki pages you drew from: "Based on [[page-a]] and [[page-b]]…".
5. File valuable answers back — substantial comparisons, deep dives, or novel syntheses become pages in `queries/` or `comparisons/`. Don't file trivial lookups — only answers that would be painful to re-derive.
6. Update `log.md` with the query and whether it was filed. Mention that the answer's page (if filed) is viewable in the 📚 tab.

### 3. Lint

**Primary surface:** the 📚 tab's **Lint button** in the sidebar runs the full 12-check report (broken links, orphans, index completeness, frontmatter validation, stale pages, contested, quality signals, sha256 drift, page size, tag audit, log rotation) grouped by severity, with an error+warn badge on the tab. Prefer it when the user is in the GUI — findings there are the same checks this skill describes.

**CLI equivalent** (deterministic, works without the sidebar):

```bash
python3 scripts/wiki_lint.py "$WIKI"          # path relative to this skill's bundle directory
# fallback if the resource base is unavailable:
python3 ~/.dsh/profiles/web/llm-wiki-sidebar/skills/llm-wiki/scripts/wiki_lint.py "$WIKI"
# machine-readable: add --json
```

If `python3` is unavailable, degrade to an equivalent `bash`-based scan of the checks rather than skipping lint. Then:

1. Fix or propose fixes for findings, grouped by severity: broken links > orphans > source drift > contested pages > stale content > style issues.
2. Append to `log.md`: `## [YYYY-MM-DD] lint | N issues found`.

## Bulk Ingest

When ingesting multiple sources at once:

1. Read all sources first (for a large batch, consider `subagent`/`workflow` to parallelize fetch-and-extract per source; do the dedup, page writing, and index/log updates in this session so consistency is preserved).
2. Identify all entities and concepts across all sources.
3. Check existing pages for all of them (one search pass, not N).
4. Create/update pages in one pass (avoids redundant updates).
5. Update `index.md` once at the end.
6. Write a single log entry covering the batch.

**Ask before mass-updating** — if an ingest would touch 10+ existing pages, confirm the scope with the user first.

## Archiving

1. Create `_archive/` if it doesn't exist.
2. Move the page to `_archive/` preserving its subpath (e.g., `_archive/entities/old-page.md`).
3. Remove it from `index.md`.
4. Update pages that linked to it — replace the wikilink with plain text + "(archived)".
5. Log the archive action.

## Obsidian Integration

The wiki directory works as an Obsidian vault out of the box: `[[wikilinks]]` render as clickable links; Graph View visualizes the knowledge network; YAML frontmatter powers Dataview queries; `raw/assets/` holds images referenced via `![[image.png]]`.

- Set Obsidian's attachment folder to `raw/assets/`; keep "Wikilinks" enabled.
- Dataview queries like `TABLE tags FROM "entities" WHERE contains(tags, "company")`.

On headless servers, `obsidian-headless` (`npm i -g obsidian-headless`; `ob login` → `ob sync-create-remote` → `ob sync-setup` → `ob sync --continuous` under a systemd user unit with `loginctl enable-linger`) lets you write here while reading the vault elsewhere. Set that up via `bash` only when the user asks for syncing.

## Pitfalls

- **Never modify files in `raw/`** — sources are immutable. Corrections go in wiki pages.
- **Always orient first** — SCHEMA + index + recent log before any operation, every time.
- **Always update `index.md` and `log.md`** — they are the navigational backbone; skipping this degrades the wiki.
- **Don't create pages for passing mentions** — follow the Page Thresholds.
- **Don't create pages without cross-references** — every page must link to at least 2 other pages.
- **Frontmatter is required** — it enables search, filtering, and staleness detection.
- **Tags must come from the taxonomy** — add new tags to `SCHEMA.md` first.
- **Keep pages scannable** — readable in 30 seconds; split pages over 200 lines.
- **Ask before mass-updating** — 10+ page touches need user confirmation first.
- **Rotate the log** — over 500 entries, rename to `log-YYYY.md` and start fresh.
- **Handle contradictions explicitly** — don't silently overwrite; note both claims with dates, mark in frontmatter, flag for review.
- **Hash the raw body with the exact recipe** — a different trailing-newline convention makes every re-ingest look like drift.
