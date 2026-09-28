// llm-wiki-sidebar — host half
//
// Serves four same-origin POST routes for the client half:
//   POST /llm-wiki/api/wikis { cwd }        → wiki roots available in the workspace
//   POST /llm-wiki/api/scan  { cwd, wiki }  → wiki page catalog (slim)
//   POST /llm-wiki/api/lint  { cwd, wiki }  → 12-check lint report
//   POST /llm-wiki/api/map   { cwd, wiki }  → slug→page map + backlink graph
//
// Routes are fenced like the /api gateway (loopback/trusted Host + same-origin
// browser markers) — a DNS-rebinding defense, not authentication. A workspace
// may hold SEVERAL independent wikis (v1 supported exactly one): the default
// `<session cwd>/wiki`, any sibling directory that looks like a wiki
// (SCHEMA.md/index.md + a section or raw/ dir), and plugin-config `wikiRoots`.
// Every route accepts an optional `wiki` root (workspace-relative or absolute
// inside the workspace), resolved by resolveWikiRoot() (lib/wiki-root.js);
// omitting it selects the v1 default. Wiki roots are read through the
// sandbox-aware `fs` service only; the plugin never writes.

import { createHash } from "node:crypto";

import { resolveWikiRoot } from "./wiki-root.js";

export const name = 'llm-wiki-sidebar'
export const inject = ['fs', 'webServer']

// Optional config (cordis row `config:`). Declared via a guarded dynamic import
// so the plugin still loads from a bare source checkout where
// @deepseek-ai/schemastery is not resolvable — there it simply runs config-less
// (v1 behavior); in an installed profile the schema documents and normalizes
// the keys. apply() reads both shapes defensively either way.
export let Config
try {
  const z = (await import('@deepseek-ai/schemastery')).default
  Config = z.object({
    // Extra wiki roots beyond the default and beyond auto-discovery.
    // Workspace-relative ("wiki-game", "kb/research") or absolute inside the
    // workspace. Explicitly registered roots appear even when they do not
    // exist yet (exists: false) and are never subject to `exclude`.
    wikiRoots: z.array(z.string()).default([]),
    // Directory basenames (e.g. "node_modules") to skip during discovery.
    exclude: z.array(z.string()).default([]),
  })
} catch (e) { Config = undefined }

export function apply(ctx, config) {
  const fs = ctx.fs
  const webServer = ctx.webServer
  const webRuntime = ctx.get('webRuntime')
  const trustedHosts = webRuntime && Array.isArray(webRuntime.trustedHosts) ? webRuntime.trustedHosts : []
  // Defensive read: config may arrive raw (no Config schema could load) or
  // schema-normalized — accept both shapes.
  const cfg = {
    wikiRoots: config && Array.isArray(config.wikiRoots) ? config.wikiRoots.filter((v) => typeof v === 'string') : [],
    exclude: config && Array.isArray(config.exclude) ? config.exclude.filter((v) => typeof v === 'string') : [],
  }

  // ---------------------------------------------------------------------------
  // Browser-trust fence: a behavioral port of the /api gateway's fence from
  // @deepseek-ai/dsh-client-connection (MIT, part of DeepSeek Harness,
  // github.com/deepseek-ai/deepseek-harness). Ported rather than imported
  // because the package does not export these helpers and a plugin must not
  // depend on its internals. Upstream is MIT; this package carries the same
  // license (see LICENSE).
  // ---------------------------------------------------------------------------

  function header(headers, key) {
    const value = headers[key]
    return typeof value === 'string' ? value : undefined
  }

  function parseAuthority(authority) {
    try {
      return new URL('http://' + authority)
    } catch (e) {
      return undefined
    }
  }

  function isLoopbackHostname(hostname) {
    if (hostname === 'localhost' || hostname === '[::1]') return true
    const parts = hostname.split('.')
    return parts.length === 4
      && parts[0] === '127'
      && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  }

  function canonicalAuthority(entry, entryUrl) {
    const port = entryUrl.port !== '' ? entryUrl.port : new URL('https://' + entry).port
    return port === '' ? entryUrl.hostname : entryUrl.hostname + ':' + port
  }

  function isTrustedAuthority(hostUrl, entries) {
    return entries.some((entry) => {
      const entryUrl = parseAuthority(entry)
      if (entryUrl === undefined) return false
      return canonicalAuthority(entry, entryUrl) === entryUrl.hostname
        ? entryUrl.hostname === hostUrl.hostname
        : entryUrl.host === hostUrl.host
    })
  }

  function isTrustedApiRequest(req) {
    const host = header(req.headers, 'host')
    if (host === undefined) return false
    const hostUrl = parseAuthority(host)
    if (hostUrl === undefined) return false
    if (!isLoopbackHostname(hostUrl.hostname) && !isTrustedAuthority(hostUrl, trustedHosts)) return false
    if (header(req.headers, 'sec-fetch-site') === 'cross-site') return false
    // Origin fence: when a browser attaches an Origin it must name this
    // hostname (the Host fence already bound the authority, so the port must
    // not re-decide trust). Absent Origin is fine; the literal "null" is an
    // opaque origin, refused.
    const origin = header(req.headers, 'origin')
    if (origin === undefined) return true
    try {
      return new URL(origin).hostname === hostUrl.hostname
    } catch (e) {
      return false
    }
  }

  async function readJsonBody(req) {
    let text = ''
    for await (const chunk of req) {
      text += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8')
      if (text.length > 1048576) throw new Error('payload too large')
    }
    if (text === '') return {}
    return JSON.parse(text)
  }

  function sendJson(res, status, payload) {
    res.statusCode = status
    res.writeHead(status, { 'content-type': 'application/json' })
    res.end(JSON.stringify(payload))
  }

  // ---------------------------------------------------------------------------
  // Wiki reading (Karpathy-style layout: SCHEMA.md / index.md / log.md +
  // entities|concepts|comparisons|queries + raw/)
  // ---------------------------------------------------------------------------

  const SECTIONS = ['entities', 'concepts', 'comparisons', 'queries']
  const REQUIRED_FIELDS = ['title', 'created', 'updated', 'type', 'tags', 'sources']
  const DAY = 86400000

  function parseFrontmatter(text) {
    const lines = String(text).split('\n')
    if (lines.length === 0 || lines[0].trim() !== '---') return { meta: null, body: String(text) }
    const meta = {}
    let closed = -1
    for (let i = 1; i < lines.length; i++) {
      if (lines[i].trim() === '---') { closed = i; break }
      const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(lines[i])
      if (!m) continue
      const key = m[1]
      const raw = m[2].trim()
      const lm = /^\[(.*)\]$/.exec(raw)
      if (lm) {
        meta[key] = lm[1].split(',').map((v) => v.trim().replace(/^['"]|['"]$/g, '')).filter((v) => v !== '')
      } else if (raw === 'true' || raw === 'false') {
        meta[key] = raw === 'true'
      } else {
        meta[key] = raw.replace(/^['"]|['"]$/g, '')
      }
    }
    if (closed === -1) return { meta: null, body: String(text) }
    return { meta, body: lines.slice(closed + 1).join('\n') }
  }

  function parseDate(value) {
    if (!value) return null
    const s = String(value).slice(0, 10)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null
    const t = Date.parse(s + 'T00:00:00Z')
    return Number.isNaN(t) ? null : t
  }

  function normalizeLink(target) {
    let s = String(target).trim().toLowerCase()
    if (s.slice(-3) === '.md') s = s.slice(0, -3)
    const i = s.lastIndexOf('/')
    return i >= 0 ? s.slice(i + 1) : s
  }

  function extractLinks(body) {
    const out = []
    const re = /\[\[([^\[\]|#]+)(?:[|#][^\[\]]*)?\]\]/g
    let m
    while ((m = re.exec(String(body))) !== null) {
      const t = normalizeLink(m[1])
      if (t) out.push(t)
    }
    return out
  }

  function parseTaxonomy(text) {
    const tags = new Set()
    let inSection = false
    for (const line of String(text).split('\n')) {
      if (line.charAt(0) === '#') { inSection = line.toLowerCase().indexOf('tag taxonomy') >= 0; continue }
      if (!inSection) continue
      const t = line.trim()
      if (t.charAt(0) !== '-' && t.charAt(0) !== '*') continue
      let item = t.replace(/^[-*]\s*/, '')
      const colon = item.indexOf(':')
      if (colon >= 0 && colon <= 30) item = item.slice(colon + 1)
      for (const part of item.split(',')) {
        const v = part.trim().replace(/[*`]/g, '')
        if (v && v.indexOf(' ') === -1 && v.length < 32) tags.add(v.toLowerCase())
      }
    }
    return tags
  }

  async function statDir(path) {
    try {
      const target = await fs.resolve(path)
      const info = await fs.stat(target)
      return info && info.type === 'directory' ? target : null
    } catch (e) { return null }
  }

  async function statAny(path) {
    try {
      const target = await fs.resolve(path)
      const info = await fs.stat(target)
      return info ? target : null
    } catch (e) { return null }
  }

  // ---------------------------------------------------------------------------
  // Wiki registry: which wiki roots does this workspace expose? (v1 answered
  // "always exactly one, <cwd>/wiki".) The registry unions three sources:
  // the v1 default (always listed, exists-flagged), plugin-config wikiRoots
  // (explicit, may not exist yet), and depth-1 auto-discovery of directories
  // that LOOK like a wiki — SCHEMA.md or index.md present, plus at least one
  // section/raw dir, so random project folders are never misreported.
  // ---------------------------------------------------------------------------

  // A directory looks like a wiki when it holds SCHEMA.md or index.md AND at
  // least one section (or raw/) directory. It takes the resolved FsTarget — a
  // path string would stringify to "[object Object]" and silently match
  // nothing — and lists the directory once, so the check is one backend call.
  async function looksLikeWiki(dirTarget) {
    let entries = []
    try { entries = await fs.listDir(dirTarget) } catch (e) { return false }
    let hasDoc = false
    let hasSection = false
    for (const entry of entries) {
      if (!hasDoc && (entry.name === 'SCHEMA.md' || entry.name === 'index.md')) hasDoc = true
      else if (!hasSection && entry.type === 'directory'
        && (SECTIONS.indexOf(entry.name) >= 0 || entry.name === 'raw')) hasSection = true
      if (hasDoc && hasSection) return true
    }
    return false
  }

  async function listWikis(cwd) {
    const base = String(cwd || '').replace(/\/+$/, '')
    if (!base) throw new Error('missing session cwd')
    const exclude = new Set(cfg.exclude.map((v) => String(v).replace(/\/+$/, '')).filter(Boolean))
    const found = []
    const seen = new Set()
    const push = (root, source) => {
      if (!root || root === base || root.indexOf(base + '/') !== 0) return
      if (seen.has(root)) return
      seen.add(root)
      found.push({ root, name: root.slice(root.lastIndexOf('/') + 1) || root, source })
    }
    push(base + '/wiki', 'default')
    for (const r of cfg.wikiRoots) {
      try { push(resolveWikiRoot(cwd, r), 'config') } catch (e) { /* invalid config entry: skip, never fail the whole list */ }
    }
    const baseTarget = await statDir(base)
    if (baseTarget) {
      let entries = []
      try { entries = await fs.listDir(baseTarget) } catch (e) { entries = [] }
      const candidates = []
      for (const entry of entries) {
        if (entry.type !== 'directory') continue
        if (exclude.has(entry.name)) continue
        candidates.push({ name: entry.name, target: entry.target })
      }
      candidates.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
      for (const candidate of candidates) {
        const dirTarget = candidate.target || await statDir(base + '/' + candidate.name)
        if (!dirTarget) continue
        if (await looksLikeWiki(dirTarget)) push(base + '/' + candidate.name, 'discovered')
      }
    }
    const out = []
    for (const f of found) {
      const exists = f.source === 'discovered' ? true : !!(await statDir(f.root))
      out.push({ id: f.root, root: f.root, name: f.name, exists, source: f.source })
    }
    return out
  }

  async function loadWiki(root) {
    const rootTarget = await statDir(root)
    if (!rootTarget) return { root, exists: false }
    const wiki = { root, exists: true, pages: [], raws: [], indexText: null, schemaText: null, logEntries: 0, logMissing: false }
    for (const section of SECTIONS) {
      const dirTarget = await statDir(root + '/' + section)
      if (!dirTarget) continue
      let entries = []
      try { entries = await fs.listDir(dirTarget) } catch (e) { continue }
      for (const entry of entries) {
        if (entry.type !== 'file' || entry.name.slice(-3) !== '.md') continue
        const slug = entry.name.slice(0, -3)
        const path = root + '/' + section + '/' + entry.name
        let text = ''
        try { text = await fs.readText(entry.target) } catch (e) {
          wiki.pages.push({ slug, section, path, readError: true, links: [], tags: [], sources: [], contradictions: [] })
          continue
        }
        const parsed = parseFrontmatter(text)
        const meta = parsed.meta
        const body = parsed.body
        wiki.pages.push({
          slug, section, path,
          title: meta && typeof meta.title === 'string' && meta.title !== '' ? meta.title : slug,
          created: meta ? meta.created : undefined,
          updated: meta ? meta.updated : undefined,
          tags: meta && Array.isArray(meta.tags) ? meta.tags : [],
          sources: meta && Array.isArray(meta.sources) ? meta.sources : [],
          confidence: meta && typeof meta.confidence === 'string' ? meta.confidence : undefined,
          contested: !!(meta && meta.contested === true),
          contradictions: meta && Array.isArray(meta.contradictions) ? meta.contradictions : [],
          lines: body.split('\n').length,
          links: extractLinks(body),
          hasFrontmatter: !!meta,
          fm: meta,
        })
      }
    }
    const rawDir = await statDir(root + '/raw')
    if (rawDir) {
      let top = []
      try { top = await fs.listDir(rawDir) } catch (e) { top = [] }
      for (const entry of top) {
        const files = []
        let subPrefix = ''
        if (entry.type === 'file' && entry.name.slice(-3) === '.md') files.push(entry)
        else if (entry.type === 'directory') {
          subPrefix = entry.name + '/'
          let sub = []
          try { sub = await fs.listDir(entry.target) } catch (e) { sub = [] }
          for (const s of sub) if (s.type === 'file' && s.name.slice(-3) === '.md') files.push(s)
        }
        for (const f of files) {
          let text = ''
          try { text = await fs.readText(f.target) } catch (e) { continue }
          const parsed = parseFrontmatter(text)
          const stored = parsed.meta && typeof parsed.meta.sha256 === 'string' ? parsed.meta.sha256.trim().toLowerCase() : undefined
          wiki.raws.push({
            slug: f.name.slice(0, -3),
            rel: 'raw/' + subPrefix + f.name,
            path: root + '/raw/' + subPrefix + f.name,
            ingested: parsed.meta ? parsed.meta.ingested : undefined,
            shaStored: stored,
            shaActual: createHash('sha256').update(parsed.body).digest('hex'),
          })
        }
      }
    }
    const indexTarget = await statAny(root + '/index.md')
    if (indexTarget) { try { wiki.indexText = await fs.readText(indexTarget) } catch (e) { wiki.indexText = null } }
    const schemaTarget = await statAny(root + '/SCHEMA.md')
    if (schemaTarget) { try { wiki.schemaText = await fs.readText(schemaTarget) } catch (e) { wiki.schemaText = null } }
    const logTarget = await statAny(root + '/log.md')
    if (logTarget) {
      try {
        const logText = await fs.readText(logTarget)
        wiki.logEntries = logText.split('\n').filter((l) => l.indexOf('## [') === 0).length
      } catch (e) { wiki.logMissing = true }
    } else { wiki.logMissing = true }
    return wiki
  }

  // ---------------------------------------------------------------------------
  // Handlers
  // ---------------------------------------------------------------------------

  // Shared entry for scan/lint/map: resolve the requested wiki root (v1
  // default when `wiki` is absent) and load it. Validation errors — including
  // any attempt to escape the session workspace — come back as a clean
  // { ok:false, error } payload rather than an exception.
  async function loadRequestedWiki(args) {
    const cwd = args && typeof args.cwd === 'string' ? args.cwd : ''
    if (!cwd) return { error: 'missing session cwd' }
    try {
      const root = resolveWikiRoot(cwd, args ? args.wiki : undefined)
      return { cwd, wiki: await loadWiki(root) }
    } catch (err) {
      return { error: String((err && err.message) || err) }
    }
  }

  async function wikisHandler(args) {
    const cwd = args && typeof args.cwd === 'string' ? args.cwd : ''
    if (!cwd) return { ok: false, error: 'missing session cwd' }
    try {
      return { ok: true, cwd, wikis: await listWikis(cwd) }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) }
    }
  }

  async function scanHandler(args) {
    const req = await loadRequestedWiki(args)
    if (req.error) return { ok: false, error: req.error }
    const wiki = req.wiki
    if (!wiki.exists) return { ok: true, root: wiki.root, exists: false }
    const sections = {}
    for (const s of SECTIONS) sections[s] = []
    const sorted = wiki.pages.slice().sort((a, b) => (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    for (const p of sorted) {
      if (sections[p.section]) {
        sections[p.section].push({
          slug: p.slug, path: p.path, title: p.title, updated: p.updated,
          tags: p.tags, confidence: p.confidence, contested: p.contested,
          lines: p.lines, readError: !!p.readError,
        })
      }
    }
    return {
      ok: true, root: wiki.root, exists: true, sections,
      totalPages: wiki.pages.length,
      indexMissing: wiki.indexText === null,
      schemaMissing: wiki.schemaText === null,
    }
  }

  async function lintHandler(args) {
    const req = await loadRequestedWiki(args)
    if (req.error) return { ok: false, error: req.error }
    const wiki = req.wiki
    if (!wiki.exists) return { ok: true, root: wiki.root, exists: false }
    const findings = []
    const add = (severity, category, message) => findings.push({ severity, category, message })

    const slugs = new Set(wiki.pages.map((p) => p.slug))
    const inbound = new Map()
    for (const p of wiki.pages) {
      for (const t of p.links) {
        if (!slugs.has(t)) continue
        inbound.set(t, (inbound.get(t) || 0) + 1)
      }
    }
    for (const p of wiki.pages) {
      const rel = p.section + '/' + p.slug + '.md'
      const seen = new Set()
      for (const t of p.links) {
        if (seen.has(t)) continue
        seen.add(t)
        if (!slugs.has(t)) add('error', 'broken-link', rel + ': [[' + t + ']] points to a page that does not exist')
      }
      if (!p.readError && !inbound.has(p.slug)) add('warn', 'orphan', rel + ': no inbound [[wikilinks]] (orphan)')
    }

    if (wiki.indexText === null) {
      add('warn', 'index', 'index.md is missing')
    } else {
      const indexSlugs = new Set()
      const re = /\[\[([^\[\]|#]+)(?:[|#][^\[\]]*)?\]\]/g
      let m
      while ((m = re.exec(wiki.indexText)) !== null) indexSlugs.add(normalizeLink(m[1]))
      for (const p of wiki.pages) {
        if (!indexSlugs.has(p.slug)) add('warn', 'index', p.section + '/' + p.slug + '.md: not listed in index.md')
      }
      for (const s of indexSlugs) {
        if (!slugs.has(s)) add('warn', 'index', 'index.md lists [[' + s + ']] but no such page exists')
      }
    }

    const now = Date.now()
    const rawDates = new Map()
    for (const r of wiki.raws) {
      const d = parseDate(r.ingested)
      if (d) { rawDates.set(r.slug, d); rawDates.set(normalizeLink(r.slug), d) }
    }
    for (const p of wiki.pages) {
      const rel = p.section + '/' + p.slug + '.md'
      if (p.readError) continue
      if (!p.hasFrontmatter) {
        add('warn', 'frontmatter', rel + ': no YAML frontmatter block')
      } else {
        const missing = REQUIRED_FIELDS.filter((f) => {
          const v = p.fm ? p.fm[f] : undefined
          return v === undefined || v === '' || (Array.isArray(v) && v.length === 0)
        })
        if (missing.length) add('warn', 'frontmatter', rel + ': missing required field(s): ' + missing.join(', '))
      }
      const updated = parseDate(p.updated)
      if (updated && updated > now) add('warn', 'frontmatter', rel + ': `updated` date is in the future')
      const srcDates = []
      for (const s of p.sources) {
        const d = rawDates.get(normalizeLink(String(s)))
        if (d) srcDates.push(d)
      }
      if (updated && srcDates.length) {
        const newest = Math.max.apply(null, srcDates)
        if ((newest - updated) / DAY > 90) {
          add('warn', 'stale', rel + ': updated ' + p.updated + ' is >90 days older than its newest cited source (' + new Date(newest).toISOString().slice(0, 10) + ')')
        }
      }
      if (p.contested || (p.contradictions && p.contradictions.length)) {
        add('warn', 'contested', rel + ': flagged contested — review contradictions with the user')
      }
      if (p.confidence === 'low') add('info', 'quality', rel + ': confidence: low — find corroboration or demote/merge the claim')
      const nSources = Array.isArray(p.sources) ? p.sources.length : 0
      if (nSources <= 1 && ['high', 'medium', 'low'].indexOf(p.confidence) === -1) {
        add('info', 'quality', rel + ': single-source page without a `confidence` field — set one')
      }
      if (p.lines > 200) add('info', 'size', rel + ': ' + p.lines + ' lines (>200) — split candidate')
    }

    for (const r of wiki.raws) {
      if (!r.shaStored) add('info', 'drift', r.rel + ': raw source has no `sha256` frontmatter (re-ingest drift detection disabled)')
      else if (r.shaStored !== r.shaActual) add('warn', 'drift', r.rel + ': sha256 mismatch (raw content changed after ingest; ' + r.shaStored.slice(0, 12) + '… → ' + r.shaActual.slice(0, 12) + '…)')
    }

    const taxonomy = wiki.schemaText ? parseTaxonomy(wiki.schemaText) : null
    const tagsUse = new Map()
    for (const p of wiki.pages) {
      for (const t of p.tags) {
        const k = String(t)
        tagsUse.set(k, (tagsUse.get(k) || 0) + 1)
      }
    }
    if (taxonomy) {
      for (const t of Array.from(tagsUse.keys()).sort()) {
        if (!taxonomy.has(t.toLowerCase())) add('info', 'tags', 'tag `' + t + '` is not in the SCHEMA.md taxonomy')
      }
    }

    if (wiki.logMissing) add('warn', 'log', 'log.md is missing')
    else if (wiki.logEntries > 500) add('info', 'log', 'log.md has ' + wiki.logEntries + ' entries (>500) — rotate to log-' + new Date().getFullYear() + '.md and start fresh')

    const order = { error: 0, warn: 1, info: 2 }
    findings.sort((a, b) => {
      const d = order[a.severity] - order[b.severity]
      if (d !== 0) return d
      return a.category < b.category ? -1 : a.category > b.category ? 1 : 0
    })
    const counts = { error: 0, warn: 0, info: 0 }
    for (const f of findings) counts[f.severity]++
    let wikilinks = 0
    for (const p of wiki.pages) wikilinks += p.links.length
    const orphans = findings.filter((f) => f.category === 'orphan').length
    const brokenLinks = findings.filter((f) => f.category === 'broken-link').length
    return {
      ok: true, root: wiki.root, exists: true, counts, findings,
      stats: { pages: wiki.pages.length, rawSources: wiki.raws.length, wikilinks, orphans, brokenLinks },
    }
  }

  async function mapHandler(args) {
    const req = await loadRequestedWiki(args)
    if (req.error) return { ok: false, error: req.error }
    const wiki = req.wiki
    if (!wiki.exists) return { ok: true, root: wiki.root, exists: false }
    const slugs = new Set(wiki.pages.map((p) => p.slug))
    const backlinks = {}
    for (const p of wiki.pages) {
      const seen = new Set()
      for (const t of p.links) {
        if (!slugs.has(t) || seen.has(t)) continue
        seen.add(t)
        if (!backlinks[t]) backlinks[t] = []
        backlinks[t].push(p.slug)
      }
    }
    const pages = []
    for (const p of wiki.pages) {
      if (p.readError) continue
      pages.push({ slug: p.slug, path: p.path, title: p.title, section: p.section })
    }
    return {
      ok: true, root: wiki.root, exists: true, pages, backlinks,
      raws: wiki.raws.map((r) => ({ rel: r.rel, path: r.path, slug: r.slug })),
    }
  }

  const handlers = { wikis: wikisHandler, scan: scanHandler, lint: lintHandler, map: mapHandler }

  for (const method of Object.keys(handlers)) {
    ctx.effect(() => webServer.register({
      kind: 'exact',
      path: '/llm-wiki/api/' + method,
      handler: async (req, res) => {
        try {
          if (!isTrustedApiRequest(req)) {
            sendJson(res, 403, { ok: false, error: 'forbidden' })
            return
          }
          if (req.method !== 'POST') {
            sendJson(res, 405, { ok: false, error: 'method not allowed' })
            return
          }
          const args = await readJsonBody(req)
          const result = await handlers[method](args)
          sendJson(res, 200, result)
        } catch (err) {
          sendJson(res, 400, { ok: false, error: String((err && err.message) || err) })
        }
      },
    }), 'llm-wiki-sidebar: route /llm-wiki/api/' + method)
  }
}
