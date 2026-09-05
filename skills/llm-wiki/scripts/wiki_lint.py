#!/usr/bin/env python3
"""wiki_lint.py — deterministic health check for a Karpathy-style LLM Wiki.

Ported from the hermes-agent `llm-wiki` skill (MIT) for the DSH `llm-wiki`
skill bundle. Stdlib only; no external dependencies.

Checks (grouped by severity in the report):
  - broken wikilinks            [[links]] that point to pages that do not exist
  - orphan pages                pages with zero inbound [[wikilinks]]
  - source drift                raw/ files whose recomputed sha256 differs from frontmatter
  - contested pages             frontmatter `contested: true` or non-empty `contradictions:`
  - stale content               page `updated` >90 days older than the newest cited raw source's
                                `ingested` date
  - frontmatter validation      missing required fields (title/created/updated/type/tags/sources)
  - index completeness          wiki pages absent from index.md (and index entries without a page)
  - quality signals             `confidence: low` pages; single-source pages with no confidence set
  - page size                   pages over 200 lines (split candidates)
  - tag audit                   tags in use; unknown tags when a taxonomy can be resolved
  - log rotation                log.md with more than 500 entries

Usage:
  python3 wiki_lint.py <WIKI_PATH> [--json] [--taxonomy "tag1,tag2,..."]

Exit codes: 0 = no ERROR/WARN findings, 1 = findings exist, 2 = usage/IO error.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
from datetime import date, datetime
from pathlib import Path

PAGE_DIRS = ("entities", "concepts", "comparisons", "queries")
RAW_DIRS = ("raw",)
ARCHIVE_DIR = "_archive"
REQUIRED_FIELDS = ("title", "created", "updated", "type", "tags", "sources")
WIKILINK_RE = re.compile(r"\[\[([^\[\]|#]+)(?:[|#][^\[\]]*)?\]\]")
LIST_RE = re.compile(r"^\[(.*)\]$")


# --------------------------------------------------------------------------- parsing

def parse_frontmatter(text: str):
    """Return (metadata_dict, body_str). Works without PyYAML: flat keys, [a, b] lists.

    The body is everything after the closing ``---`` line, byte-faithful to the
    raw file (split("\\n"), NOT splitlines()): a trailing newline stays in the
    body so the sha256 matches `tail -n +N | sha256sum` and the DSH plugin's
    Node implementation.
    """
    lines = text.split("\n")
    if not lines or lines[0].strip() != "---":
        return None, text
    meta, body_start = {}, None
    for i in range(1, len(lines)):
        line = lines[i]
        if line.strip() == "---":
            body_start = i + 1
            break
        m = re.match(r"^([A-Za-z_][\w-]*)\s*:\s*(.*)$", line)
        if m:
            key, raw = m.group(1), m.group(2).strip()
            lm = LIST_RE.match(raw)
            if lm:
                items = [v.strip().strip("'\"") for v in lm.group(1).split(",") if v.strip()]
                meta[key] = items
            elif raw.lower() in ("true", "false"):
                meta[key] = raw.lower() == "true"
            else:
                meta[key] = raw.strip("'\"")
    if body_start is None:
        return None, text
    return meta, "\n".join(lines[body_start:])


def parse_date(value):
    if not value:
        return None
    try:
        return datetime.strptime(str(value)[:10], "%Y-%m-%d").date()
    except ValueError:
        return None


def normalize_link(target: str) -> str:
    target = target.strip().lower()
    if target.endswith(".md"):
        target = target[:-3]
    return target.split("/")[-1] if "/" in target else target


# --------------------------------------------------------------------------- scanning

def scan_wiki(root: Path):
    pages, raws = [], []
    for sub in PAGE_DIRS:
        d = root / sub
        if d.is_dir():
            pages.extend(p for p in sorted(d.rglob("*.md")))
    archive = root / ARCHIVE_DIR
    if archive.is_dir():
        pages.extend(p for p in sorted(archive.rglob("*.md")))
    for sub in RAW_DIRS:
        d = root / sub
        if d.is_dir():
            raws.extend(p for p in sorted(d.rglob("*.md")))
    return pages, raws


def collect_links(page_texts):
    """Map normalized slug -> set of slugs it links to; and inbound-link counts."""
    outbound, inbound = {}, {}
    slugs = set()
    for path in page_texts:
        slugs.add(path.stem.lower())
    for path, (meta, text) in page_texts.items():
        targets = {normalize_link(t) for t in WIKILINK_RE.findall(text)}
        targets.discard(path.stem.lower())  # self-links don't count either way
        outbound[path] = targets
        for t in targets:
            inbound.setdefault(t, set()).add(path)
    return slugs, outbound, inbound


def lint(root: Path, taxonomy_override=None):
    findings = []  # (severity, category, message)

    def add(sev, cat, msg):
        findings.append({"severity": sev, "category": cat, "message": msg})

    pages, raws = scan_wiki(root)
    if not pages and not raws:
        add("ERROR", "structure", f"No wiki pages found under {root} (expected entities/, concepts/, comparisons/, queries/).")

    page_texts = {}
    for p in pages:
        try:
            meta, text = parse_frontmatter(p.read_text(encoding="utf-8", errors="replace"))
        except OSError as e:
            add("ERROR", "io", f"Cannot read {p.relative_to(root)}: {e}")
            continue
        page_texts[p] = (meta, text)

    raw_texts = {}
    for p in raws:
        try:
            meta, text = parse_frontmatter(p.read_text(encoding="utf-8", errors="replace"))
        except OSError as e:
            add("ERROR", "io", f"Cannot read {p.relative_to(root)}: {e}")
            continue
        raw_texts[p] = (meta, text)

    slugs, outbound, inbound = collect_links(page_texts)

    # -- 1/2. broken wikilinks + orphans -------------------------------------
    # Orphans count only inbound links that resolve to real pages: a broken
    # [[ghost-page]] must not make its own author look linked.
    real_inbound = {t: holders for t, holders in inbound.items() if t in slugs}
    for path, targets in sorted(outbound.items()):
        for t in sorted(targets - slugs):
            add("ERROR", "broken-link",
                f"{path.relative_to(root)}: [[{t}]] points to a page that does not exist")
    for path in sorted(page_texts):
        # inbound maps target slug -> pages linking to it; an orphan is a page
        # that never appears as a link target from a real page.
        if not real_inbound.get(path.stem.lower()):
            add("WARN", "orphan", f"{path.relative_to(root)}: no inbound [[wikilinks]] (orphan)")

    # -- 3. index completeness ----------------------------------------------
    index_path = root / "index.md"
    if index_path.is_file():
        index_text = index_path.read_text(encoding="utf-8", errors="replace")
        index_slugs = {normalize_link(t) for t in WIKILINK_RE.findall(index_text)}
        for path in sorted(page_texts):
            if path.stem.lower() not in index_slugs:
                add("WARN", "index", f"{path.relative_to(root)}: not listed in index.md")
        known = {p.stem.lower() for p in page_texts}
        for s in sorted(index_slugs - known):
            add("WARN", "index", f"index.md lists [[{s}]] but no such page exists")
    else:
        add("WARN", "index", "index.md is missing")

    # -- 4. frontmatter validation -------------------------------------------
    today = date.today()
    page_dates = {}
    for path, (meta, _text) in sorted(page_texts.items()):
        rel = path.relative_to(root)
        if meta is None:
            add("WARN", "frontmatter", f"{rel}: no YAML frontmatter block")
            continue
        missing = [f for f in REQUIRED_FIELDS if f not in meta or meta[f] in ("", [])]
        if missing:
            add("WARN", "frontmatter", f"{rel}: missing required field(s): {', '.join(missing)}")
        if parse_date(meta.get("updated")) and parse_date(meta.get("updated")) > today:
            add("WARN", "frontmatter", f"{rel}: `updated` date is in the future")
        page_dates[path] = meta

    # -- 5. stale content ------------------------------------------------------
    raw_ingested = {}
    for rp, (rmeta, _t) in raw_texts.items():
        d = parse_date(rmeta.get("ingested")) if rmeta else None
        if d:
            raw_ingested[normalize_link(rp.stem)] = d
            raw_ingested[rp.stem.lower()] = d
    for path, meta in sorted(page_dates.items()):
        updated = parse_date(meta.get("updated"))
        if not updated:
            continue
        source_dates = [raw_ingested[normalize_link(s)] for s in (meta.get("sources") or [])
                        if isinstance(s, str) and normalize_link(s) in raw_ingested]
        if source_dates and (max(source_dates) - updated).days > 90:
            add("WARN", "stale",
                f"{path.relative_to(root)}: updated {updated} is >90 days older than its newest cited source "
                f"({max(source_dates)})")

    # -- 6/7. contradictions + quality signals ---------------------------------
    for path, meta in sorted(page_dates.items()):
        rel = path.relative_to(root)
        if meta.get("contested") is True or meta.get("contradictions"):
            add("WARN", "contested", f"{rel}: flagged contested — review contradictions with the user")
        conf = meta.get("confidence")
        sources = meta.get("sources") or []
        n_sources = len(sources) if isinstance(sources, list) else 1
        if conf == "low":
            add("INFO", "quality", f"{rel}: confidence: low — find corroboration or demote/merge the claim")
        if n_sources <= 1 and conf not in ("high", "medium", "low"):
            add("INFO", "quality", f"{rel}: single-source page without a `confidence` field — set one")

    # -- 8. raw source drift ----------------------------------------------------
    for rp, (rmeta, body) in sorted(raw_texts.items()):
        rel = rp.relative_to(root)
        if not rmeta or not rmeta.get("sha256"):
            add("INFO", "drift", f"{rel}: raw source has no `sha256` frontmatter (re-ingest drift detection disabled)")
            continue
        digest = hashlib.sha256(body.encode("utf-8")).hexdigest()
        stored = str(rmeta["sha256"]).strip().lower()
        if digest != stored:
            add("WARN", "drift", f"{rel}: sha256 mismatch (raw content changed after ingest; {stored[:12]}… → {digest[:12]}…)")

    # -- 9. page size ------------------------------------------------------------
    for path, (_m, text) in sorted(page_texts.items()):
        n = text.count("\n") + 1
        if n > 200:
            add("INFO", "size", f"{path.relative_to(root)}: {n} lines (>200) — split candidate")

    # -- 10. tag audit ------------------------------------------------------------
    taxonomy = None
    if taxonomy_override:
        taxonomy = {t.strip().lower() for t in taxonomy_override.split(",") if t.strip()}
    else:
        schema = root / "SCHEMA.md"
        if schema.is_file():
            taxonomy = parse_taxonomy(schema.read_text(encoding="utf-8", errors="replace"))
    tags_in_use = {}
    for path, meta in page_dates.items():
        tags = meta.get("tags") if isinstance(meta.get("tags"), list) else []
        for t in tags:
            tags_in_use.setdefault(str(t), set()).add(path.relative_to(root).__str__())
    if taxonomy is not None:
        for t in sorted(tags_in_use):
            if t.lower() not in taxonomy:
                add("INFO", "tags", f"tag `{t}` is not in the SCHEMA.md taxonomy (used by {', '.join(sorted(tags_in_use[t])[:3])})")
    summary_tags = ", ".join(f"{t}×{len(v)}" for t, v in sorted(tags_in_use.items())) or "(none)"

    # -- 11. log rotation ----------------------------------------------------------
    log_path = root / "log.md"
    if log_path.is_file():
        entries = sum(1 for ln in log_path.read_text(encoding="utf-8", errors="replace").splitlines()
                      if ln.startswith("## ["))
        if entries > 500:
            add("INFO", "log", f"log.md has {entries} entries (>500) — rotate to log-{today.year}.md and start fresh")
    else:
        add("WARN", "log", "log.md is missing")

    order = {"ERROR": 0, "WARN": 1, "INFO": 2}
    findings.sort(key=lambda f: (order[f["severity"]], f["category"], f["message"]))
    stats = {
        "pages": len(page_texts), "raw_sources": len(raw_texts),
        "tags_in_use": sorted(tags_in_use), "wikilinks": sum(len(v) for v in outbound.values()),
        "orphans": sum(1 for f in findings if f["category"] == "orphan"),
        "broken_links": sum(1 for f in findings if f["category"] == "broken-link"),
    }
    return findings, stats


def parse_taxonomy(schema_text: str):
    """Best-effort extraction of the tag taxonomy from SCHEMA.md's Tag Taxonomy section."""
    tags, in_section = set(), False
    for line in schema_text.splitlines():
        if line.startswith("#"):
            in_section = "tag taxonomy" in line.lower()
            continue
        if in_section and line.strip().startswith(("-", "*")):
            item = line.strip().lstrip("-*").strip()
            item = re.sub(r"^[^:]{0,30}:\s*", "", item)  # strip a leading "Models: " label
            for part in item.split(","):
                part = part.strip().strip("*`")
                if part and " " not in part and len(part) < 32:
                    tags.add(part.lower())
    return tags or None


# --------------------------------------------------------------------------- reporting

def render(findings, stats):
    lines = ["Wiki lint report", "=" * 40,
             f"pages: {stats['pages']} | raw sources: {stats['raw_sources']} | wikilinks: {stats['wikilinks']}",
             f"tags in use: {', '.join(stats['tags_in_use']) or '(none)'}", ""]
    current = None
    for f in findings:
        if f["severity"] != current:
            current = f["severity"]
            label = {"ERROR": "ERRORS (fix first)", "WARN": "WARNINGS", "INFO": "STYLE / INFO"}[current]
            lines.append(f"── {label} " + "─" * max(4, 40 - len(label)))
        lines.append(f"[{f['category']}] {f['message']}")
    if not findings:
        lines.append("No issues found. Wiki is healthy.")
    counts = {s: sum(1 for f in findings if f["severity"] == s) for s in ("ERROR", "WARN", "INFO")}
    lines += ["", f"Summary: {counts['ERROR']} errors, {counts['WARN']} warnings, {counts['INFO']} info"]
    return "\n".join(lines)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Lint a Karpathy-style LLM Wiki directory.")
    ap.add_argument("wiki", help="path to the wiki root (contains SCHEMA.md, index.md, entities/, …)")
    ap.add_argument("--json", action="store_true", help="emit JSON instead of text")
    ap.add_argument("--taxonomy", help="comma-separated tag taxonomy override (default: parsed from SCHEMA.md)")
    args = ap.parse_args(argv)

    root = Path(args.wiki).expanduser()
    if not root.is_dir():
        print(f"wiki_lint: wiki root not found: {root}", file=sys.stderr)
        return 2
    findings, stats = lint(root, args.taxonomy)
    print(json.dumps({"stats": stats, "findings": findings}, indent=2, ensure_ascii=False) if args.json
          else render(findings, stats))
    return 1 if any(f["severity"] in ("ERROR", "WARN") for f in findings) else 0


if __name__ == "__main__":
    sys.exit(main())
