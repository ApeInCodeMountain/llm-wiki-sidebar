// llm-wiki-sidebar — client half SOURCE
//
// Built into lib/client.js by scripts/build-client.mjs (that step inlines the
// vendored markdown-it). Edit THIS file, then run:
//
//   node scripts/build-client.mjs
//
// Targets the sidebar shipped with DeepSeek Harness itself
// (@deepseek-ai/dsh-client-ui-sidebar-right), NOT the retired dsh-better-sidebar:
//
//   * browse tab  — a page type registered through ctx.sidebarRightTabs plus its
//     body in the keyed `sidebar.right.pane.tab` seat;
//   * wiki pages  — a resource type claiming `dsh-resource://file/**` .md files
//     that live inside a wiki root, rendering them with markdown-it and wiring
//     [[wikilinks]], relative .md links and backlinks.
//
// Both halves talk to this plugin's own host half over same-origin POST
// /llm-wiki/api/* routes (wikis/scan/lint/map); page text is read through the
// product's workspaceFiles Remote.

window.__ModuleLoader__.load({
	id: "llm-wiki-sidebar",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require("react");

		/*__LLMWIKI_MARKDOWN_IT__*/

		// -------------------------------------------------------------------
		// Identity
		// -------------------------------------------------------------------

		const NS = "llmWiki";
		/** Page type: the browse/lint workbench. */
		const BROWSE_ID = "llm-wiki-sidebar";
		const BROWSE_KIND = "llm-wiki";
		/** Resource type: wiki markdown pages. */
		const PAGE_ID = "llm-wiki-sidebar/page";
		const PAGE_KIND = "llm-wiki-page";
		const FILE_PREFIX = "dsh-resource://file/";

		const SECTIONS = ["entities", "concepts", "comparisons", "queries"];

		const mapCache = new Map();
		const wikisCache = new Map();

		/** Absolute wiki roots seen so far (lower-cased, no trailing slash) — makes `canOpen` synchronous. */
		const warmedWikiRoots = new Set();

		// -------------------------------------------------------------------
		// Pure path helpers
		// -------------------------------------------------------------------

		function isAbsoluteWorkspacePath(path) {
			const s = String(path || "");
			return s.charAt(0) === "/" || /^[A-Za-z]:[\\/]/.test(s);
		}

		function dirOf(path) {
			const s = String(path || "").replace(/\\/g, "/");
			const i = s.lastIndexOf("/");
			return i > 0 ? s.slice(0, i + 1) : "";
		}

		/** Decode the final non-empty path segment of an address. */
		function basenameOf(address) {
			const parsed = parseFileAddress(address);
			const path = parsed ? parsed.path : String(address || "");
			const segs = String(path).split("/").filter(Boolean);
			return segs.length > 0 ? segs[segs.length - 1] : String(address || "");
		}

		/** Build a `dsh-resource://file/session/<sessionId>/<path>` address (segments component-encoded; `:` stays literal). */
		function sessionFileAddress(sessionId, path) {
			const normalized = String(path == null ? "" : path).replace(/\\/g, "/").replace(/^(\.\/)+/, "");
			const segments = normalized
				.split("/")
				.map((segment) => encodeURIComponent(segment).replace(/%3A/gi, ":"));
			return FILE_PREFIX + "session/" + encodeURIComponent(String(sessionId)) + "/" + segments.join("/");
		}

		/** Read a `dsh-resource://file/…` address back into its scope, session and path. */
		function parseFileAddress(address) {
			const text = String(address || "");
			if (text.slice(0, FILE_PREFIX.length).toLowerCase() !== FILE_PREFIX) return null;
			const rest = text.slice(FILE_PREFIX.length);
			const cut = rest.search(/[?#]/);
			const segments = (cut >= 0 ? rest.slice(0, cut) : rest).split("/");
			const scope = segments.shift();
			if (scope !== "session" && scope !== "absolute") return null;
			const decoded = [];
			for (const segment of segments) {
				try { decoded.push(decodeURIComponent(segment)); } catch (e) { return null; }
			}
			if (scope === "session") {
				const sessionId = decoded.shift();
				if (!sessionId) return null;
				return { scope: "session", sessionId, path: decoded.join("/") };
			}
			const path = decoded.join("/");
			if (path === "") return { scope: "absolute", path: "/" };
			if (/^[A-Za-z]:$/.test(decoded[0])) return { scope: "absolute", path };
			return { scope: "absolute", path: "/" + path };
		}

		// Collapse '.'/'..' segments ('' leading segment = absolute marker, preserved).
		function collapsePath(p) {
			const out = [];
			for (const seg of String(p).split("/")) {
				if (seg === "") { if (out.length === 0) out.push(""); continue; }
				if (seg === ".") continue;
				if (seg === "..") { if (out.length > 0 && out[out.length - 1] !== "") out.pop(); continue; }
				out.push(seg);
			}
			return out.join("/");
		}

		/**
		 * Pure resolver for in-page markdown link destinations → wiki targets.
		 * Returns { kind: "page"|"file", path, title } or null for external/anchor/unresolvable.
		 * opts: { wikiRoot, pageDir, pages: [{slug,path,title}], raws: [{rel,path}] }
		 */
		function makeLinkResolver(opts) {
			const wikiRoot = String((opts && opts.wikiRoot) || "").replace(/\/+$/, "") + "/";
			const pageDir = String((opts && opts.pageDir) || "");
			const pages = (opts && opts.pages) || [];
			const raws = (opts && opts.raws) || [];
			const baseName = (() => {
				const trimmed = wikiRoot.replace(/\/+$/, "");
				const i = trimmed.lastIndexOf("/");
				return i >= 0 ? trimmed.slice(i + 1) : trimmed;
			})();
			const esc = baseName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
			const baseAbsRe = baseName ? new RegExp("^/" + esc + "/", "i") : null;
			const baseRelRe = baseName ? new RegExp("^" + esc + "/", "i") : null;
			const pageBySlug = new Map(), pageByRel = new Map(), fileByRel = new Map();
			for (const p of pages) {
				const slug = String(p.slug || "").toLowerCase();
				if (!slug) continue;
				pageBySlug.set(slug, p);
				const abs = String(p.path || "").replace(/\/+$/, "");
				if (wikiRoot.length > 1 && abs.toLowerCase().indexOf(wikiRoot.toLowerCase()) === 0) {
					const rel = abs.slice(wikiRoot.length).toLowerCase();
					pageByRel.set(rel, p);
					pageByRel.set(rel.replace(/\.md$/, ""), p);
				}
			}
			for (const r of raws) {
				const rel = String(r.rel || "").toLowerCase();
				if (!rel) continue;
				fileByRel.set(rel, r);
				if (r.path) fileByRel.set(String(r.path).toLowerCase(), r);
			}
			return function resolveLink(href) {
				let h = String(href || "").trim();
				if (!h || h.charAt(0) === "#") return null;
				if (/^[a-z][a-z0-9+.\-]*:/i.test(h)) return null;
				try { h = decodeURIComponent(h); } catch (e) {}
				h = h.split("#")[0].replace(/\\/g, "/");
				if (!h) return null;
				const cands = [];
				const push = (p) => {
					if (!p) return;
					if (baseAbsRe && baseAbsRe.test(p)) p = p.slice(baseName.length + 2);
					else if (p.charAt(0) === "/") return;
					p = p.replace(/^\.\/+/, "");
					if (baseRelRe) p = p.replace(baseRelRe, "");
					p = collapsePath(p);
					if (p && cands.indexOf(p) === -1) cands.push(p);
				};
				push(h);
				if (pageDir) {
					const abs = collapsePath(pageDir + h).toLowerCase();
					if (abs.toLowerCase().indexOf(wikiRoot.toLowerCase()) === 0) push(abs.slice(wikiRoot.length));
				}
				for (const c of cands) {
					const key = c.toLowerCase();
					const page = pageByRel.get(key) || pageByRel.get(key.replace(/\.md$/, ""));
					if (page) return { kind: "page", path: page.path, title: page.title || page.slug };
					const file = fileByRel.get(key) || fileByRel.get((wikiRoot + c).toLowerCase());
					if (file) return { kind: "file", path: file.path, title: file.rel };
					const stem = key.replace(/\.md$/, "").split("/").pop();
					const byStem = pageBySlug.get(stem);
					if (byStem) return { kind: "page", path: byStem.path, title: byStem.title || byStem.slug };
				}
				return null;
			};
		}

		/**
		 * Pure longest-prefix match: which registered wiki root contains path?
		 * Returns "<root>/" or the legacy fallback, or null.
		 */
		function pickWikiRoot(path, wikis, fallback) {
			const fb = fallback ? String(fallback).replace(/\/+$/, "") + "/" : null;
			const p = String(path || "");
			if (!p || !Array.isArray(wikis) || wikis.length === 0) return fb;
			const pl = p.toLowerCase();
			let best = null;
			let bestLen = -1;
			for (const w of wikis) {
				const root = String((w && w.root) || "").replace(/\/+$/, "");
				if (!root) continue;
				const rl = root.toLowerCase() + "/";
				if (rl.length > bestLen && pl.indexOf(rl) === 0) { best = root; bestLen = rl.length; }
			}
			return best ? best + "/" : fb;
		}

		/** Client-side YAML frontmatter reader (mirrors the host half's). */
		function parseFrontmatter(text) {
			const lines = String(text).split("\n");
			if (lines.length === 0 || lines[0].trim() !== "---") return { meta: null, body: String(text) };
			const meta = {};
			let closed = -1;
			for (let i = 1; i < lines.length; i++) {
				if (lines[i].trim() === "---") { closed = i; break; }
				const m = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(lines[i]);
				if (!m) continue;
				const raw = m[2].trim();
				const lm = /^\[(.*)\]$/.exec(raw);
				if (lm) {
					meta[m[1]] = lm[1].split(",").map((v) => v.trim().replace(/^['"]|['"]$/g, "")).filter(Boolean);
				} else if (raw === "true" || raw === "false") {
					meta[m[1]] = raw === "true";
				} else {
					meta[m[1]] = raw.replace(/^['"]|['"]$/g, "");
				}
			}
			if (closed === -1) return { meta: null, body: String(text) };
			return { meta, body: lines.slice(closed + 1).join("\n") };
		}

		// -------------------------------------------------------------------
		// Heading fragments: [[page#section]] and [[#section]]
		// -------------------------------------------------------------------

		/**
		 * Heading slug, GitHub-flavoured but Unicode-aware so CJK headings work:
		 * whitespace runs become `-`, everything that is not a letter, digit,
		 * `-` or `_` is dropped, runs collapse and edges are trimmed.
		 */
		function slugify(text) {
			return String(text)
				.trim()
				.toLowerCase()
				.replace(/[\s\u3000]+/g, "-")
				.replace(/[^\p{L}\p{N}\-_]/gu, "")
				.replace(/-{2,}/g, "-")
				.replace(/^-+|-+$/g, "");
		}

		/** Split `page#section` (or `#section`) into its target key and fragment. */
		function splitFragment(value) {
			const text = String(value || "");
			const at = text.indexOf("#");
			if (at < 0) return { key: text.trim(), fragment: "" };
			return { key: text.slice(0, at).trim(), fragment: text.slice(at + 1).trim() };
		}

		// A fragment addressed at a page that is not open yet travels here until
		// that page's body has rendered, then is consumed once. Entries expire so
		// an open that never lands cannot scroll a much later visit.
		const pendingFragments = new Map();
		function stashFragment(address, fragment) {
			if (address && fragment) pendingFragments.set(address, { fragment: fragment, at: Date.now() });
		}
		function takeFragment(address) {
			const entry = pendingFragments.get(address);
			if (!entry) return "";
			pendingFragments.delete(address);
			return Date.now() - entry.at < 15000 ? entry.fragment : "";
		}

		/** First heading whose text matches the fragment: exact text first, then slug. */
		function findHeading(container, fragment) {
			if (!container || typeof container.querySelectorAll !== "function") return null;
			const wantText = String(fragment || "").trim().toLowerCase();
			const wantSlug = slugify(fragment);
			if (!wantText) return null;
			const heads = container.querySelectorAll("h1,h2,h3,h4,h5,h6");
			let slugHit = null;
			for (let i = 0; i < heads.length; i++) {
				const text = String(heads[i].textContent || "").trim();
				if (text.toLowerCase() === wantText) return heads[i];
				if (!slugHit && wantSlug && slugify(text) === wantSlug) slugHit = heads[i];
			}
			return slugHit;
		}

		// -------------------------------------------------------------------
		// Wiki registry caches + host routes
		// -------------------------------------------------------------------

		function warmWikiRoots(list) {
			if (!Array.isArray(list)) return;
			for (const w of list) {
				const root = String((w && w.root) || "").replace(/\/+$/, "");
				if (root) warmedWikiRoots.add(root.toLowerCase());
			}
		}

		/** Synchronous test used by the resource type's `canOpen`. */
		function isWikiMdPath(path) {
			const p = String(path || "").replace(/\\/g, "/");
			if (!/\.(md|markdown)$/i.test(p)) return false;
			const lower = p.toLowerCase();
			for (const root of warmedWikiRoots) {
				if (lower === root || lower.indexOf(root + "/") === 0) return true;
			}
			const segs = lower.split("/").filter(Boolean);
			for (let i = 0; i < segs.length - 1; i++) {
				if (segs[i].indexOf("wiki") >= 0) return true;
			}
			return false;
		}

		function isWikiMarkdownAddress(address) {
			const parsed = parseFileAddress(address);
			if (!parsed || parsed.scope !== "session") return false;
			return isWikiMdPath(parsed.path);
		}

		async function apiCall(method, payload) {
			const response = await fetch("/llm-wiki/api/" + method, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload || {}),
			});
			let data = null;
			try { data = await response.json(); } catch (e) { data = null; }
			if (!response.ok) throw new Error((data && data.error) || "HTTP " + response.status);
			return data;
		}

		function getMap(cwd, root) {
			const key = String(root || "").replace(/\/+$/, "");
			if (mapCache.has(key)) return mapCache.get(key);
			const p = apiCall("map", { cwd: cwd, wiki: key }).then((res) => {
				if (!res || !res.ok) throw new Error((res && res.error) || "wiki map failed");
				return res;
			});
			p.catch(() => { mapCache.delete(key); });
			mapCache.set(key, p);
			return p;
		}

		function getWikis(cwd) {
			if (wikisCache.has(cwd)) return wikisCache.get(cwd);
			const p = apiCall("wikis", { cwd: cwd }).then((res) => {
				if (!res || !res.ok) throw new Error((res && res.error) || "wiki list failed");
				warmWikiRoots(res.wikis);
				return res;
			});
			p.catch(() => { wikisCache.delete(cwd); });
			wikisCache.set(cwd, p);
			return p;
		}

		function storageKey(cwd) { return "llmwiki.activeWiki:" + cwd; }
		function loadStoredWiki(cwd) {
			try { return window.localStorage.getItem(storageKey(cwd)) || ""; } catch (e) { return ""; }
		}
		function storeActiveWiki(cwd, root) {
			try { if (root) window.localStorage.setItem(storageKey(cwd), root); } catch (e) {}
		}

		// -------------------------------------------------------------------
		// Page text (product Remote: paged line reads over the session workspace)
		// -------------------------------------------------------------------

		async function readWholeText(remote, sessionId, path, signal) {
			let offset = 1;
			let text = "";
			let pages = 0;
			let absolutePath;
			let version;
			for (;;) {
				const result = await remote.workspaceFiles.read(sessionId, path, { offset: offset }, signal);
				if (!result || result.ok !== true) {
					const failure = result && result.error;
					throw new Error((failure && failure.message) || "file read failed");
				}
				const page = result.value;
				absolutePath = page.absolutePath;
				version = page.version;
				if (page.lines > 0) text += (text === "" ? "" : "\n") + page.text;
				pages++;
				if (page.eof || page.lines === 0 || pages >= 25) break;
				offset += page.lines;
			}
			return { text: text, absolutePath: absolutePath, version: version };
		}

		// -------------------------------------------------------------------
		// Markdown: markdown-it + a [[wikilink]] rule + local image rewriting
		// -------------------------------------------------------------------

		function escapeHtml(value) {
			return String(value).replace(/[&<>"']/g, (ch) => (
				ch === "&" ? "&amp;" : ch === "<" ? "&lt;" : ch === ">" ? "&gt;" : ch === '"' ? "&quot;" : "&#39;"
			));
		}

		let mdCache = null;
		function getMd() {
			if (mdCache) return mdCache;
			const md = markdownit({ html: false, linkify: false, typographer: false, breaks: false });

			md.inline.ruler.before("link", "llmwiki_wikilink", (state, silent) => {
				const src = state.src;
				const pos = state.pos;
				if (src.charCodeAt(pos) !== 91 || src.charCodeAt(pos + 1) !== 91) return false;
				// `![[…]]` is an embed, not a link; leave it literal.
				if (pos > 0 && src.charCodeAt(pos - 1) === 33) return false;
				const end = src.indexOf("]]", pos + 2);
				if (end < 0) return false;
				const inner = src.slice(pos + 2, end);
				if (inner.length === 0 || /[\[\]\n]/.test(inner)) return false;
				if (!silent) {
					const token = state.push("llmwiki_wikilink", "", 0);
					const bar = inner.indexOf("|");
					const target = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
					// The label defaults to the target WITHOUT its `#fragment`
					// (`[[page#section]]` shows "page", `[[#section]]` shows "section").
					const fallback = target.split("#")[0].trim() || target.replace(/^#+/, "").trim() || target;
					token.content = target;
					token.meta = { label: bar >= 0 ? (inner.slice(bar + 1).trim() || fallback) : fallback };
				}
				state.pos = end + 2;
				return true;
			});

			md.renderer.rules.llmwiki_wikilink = (tokens, idx, options, env) => {
				const token = tokens[idx];
				const target = token.content;
				const label = (token.meta && token.meta.label) || target;
				// `[[#section]]` addresses a heading on this page; no resource open.
				if (target.charAt(0) === "#") {
					return '<a class="llmw-wlink" href="#" data-llmw-frag="'
						+ escapeHtml(target.replace(/^#+/, "").trim()) + '">' + escapeHtml(label) + "</a>";
				}
				const api = env && env.llmwiki;
				const hit = api && api.resolve ? api.resolve(target) : null;
				if (!hit) {
					return '<span class="llmw-wlink-miss" title="' + escapeHtml("Wiki page not found: " + target) + '">' + escapeHtml(label) + "</span>";
				}
				return '<a class="llmw-wlink" href="#" data-llmw-wiki="' + escapeHtml(target) + '" title="' + escapeHtml("→ " + (hit.title || hit.path)) + '">' + escapeHtml(label) + "</a>";
			};

			const defaultImage = md.renderer.rules.image;
			md.renderer.rules.image = (tokens, idx, options, env, self) => {
				const token = tokens[idx];
				const api = env && env.llmwiki;
				if (api && api.imageUrl) {
					const at = token.attrIndex("src");
					if (at >= 0) {
						const rewritten = api.imageUrl(token.attrs[at][1]);
						if (rewritten) token.attrs[at][1] = rewritten;
					}
				}
				return defaultImage
					? defaultImage(tokens, idx, options, env, self)
					: self.renderToken(tokens, idx, options);
			};

			mdCache = md;
			return md;
		}

		/** Resolve `[[target]]` / `[[target|label]]` against the wiki map. */
		function makeWikiTargetResolver(map, wikiRoot) {
			const root = String(wikiRoot || "").replace(/\/+$/, "") + "/";
			const bySlug = new Map(), byRel = new Map(), rawByRel = new Map();
			for (const p of (map && map.pages) || []) {
				if (!p || !p.path) continue;
				if (p.slug) bySlug.set(String(p.slug).toLowerCase(), p);
				const abs = String(p.path).replace(/\\/g, "/");
				const rel = root.length > 1 && abs.toLowerCase().indexOf(root.toLowerCase()) === 0 ? abs.slice(root.length) : abs;
				byRel.set(rel.toLowerCase(), p);
				byRel.set(rel.replace(/\.md$/i, "").toLowerCase(), p);
			}
			for (const r of (map && map.raws) || []) {
				if (!r || !r.rel) continue;
				const rel = String(r.rel).toLowerCase();
				rawByRel.set(rel, r);
				rawByRel.set(rel.replace(/\.md$/i, ""), r);
			}
			return function resolveWikiTarget(target) {
				const raw = String(target || "").trim();
				if (!raw) return null;
				const key = raw.split("#")[0].trim().toLowerCase();
				if (!key) return null;
				const noExt = key.replace(/\.md$/, "");
				const page = bySlug.get(noExt) || bySlug.get(key) || byRel.get(key) || byRel.get(noExt);
				if (page) return { kind: "page", path: page.path, title: page.title || page.slug };
				const file = rawByRel.get(key) || rawByRel.get(noExt) || rawByRel.get(noExt + ".md");
				if (file) return { kind: "file", path: file.path, title: file.rel };
				const stem = noExt.split("/").pop();
				const byStem = bySlug.get(stem);
				if (byStem) return { kind: "page", path: byStem.path, title: byStem.title || byStem.slug };
				return null;
			};
		}

		/** Local image destinations → the authenticated file route (absolute paths only). */
		function makeImageUrl(absolutePath) {
			return function imageUrl(destination) {
				const suffix = String(destination || "").search(/[?#]/);
				let path;
				try {
					path = decodeURIComponent(suffix === -1 ? String(destination) : String(destination).slice(0, suffix));
				} catch (e) { return undefined; }
				if (!path) return undefined;
				if (!/^[a-z]:[\\/]/i.test(path) && /^[a-z][a-z0-9+.-]*:/i.test(path)) return undefined;
				if (!isAbsoluteWorkspacePath(path)) {
					if (!absolutePath) return undefined;
					path = dirOf(absolutePath) + path;
				}
				if (!isAbsoluteWorkspacePath(path) || /^[/\\]{2}/.test(path)) return undefined;
				const base = typeof document !== "undefined" && document.baseURI ? document.baseURI : "/";
				try { return new URL("api/file?path=" + encodeURIComponent(path), base).href; } catch (e) { return undefined; }
			};
		}

		// -------------------------------------------------------------------
		// Styles (host theme tokens only)
		// -------------------------------------------------------------------

		const css = [
			".llmw-wrap{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base,#1b1d21);color:var(--dsw-alias-label-primary,#e6e6e6);font-size:12px;}",
			".llmw-head{display:flex;align-items:center;gap:8px;padding:8px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,#2c2f34);}",
			".llmw-title{font-weight:600;font-size:12px;white-space:nowrap;}",
			".llmw-root{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#9aa0a6);font-size:10.5px;}",
			".llmw-btn{border:1px solid var(--dsw-alias-border-l2,#3a3e44);background:var(--dsw-alias-bg-layer-1,#24262b);color:var(--dsw-alias-label-primary,#e6e6e6);border-radius:6px;padding:3px 8px;cursor:pointer;font-size:11px;line-height:1.4;white-space:nowrap;}",
			".llmw-btn:hover{background:var(--dsw-alias-bg-layer-2,#2c2f35);}",
			".llmw-btn[disabled]{opacity:.5;cursor:default;}",
			".llmw-search{margin:8px 10px 2px;padding:5px 9px;border:1px solid var(--dsw-alias-border-l1,#2c2f34);border-radius:6px;background:var(--dsw-alias-bg-layer-1,#24262b);color:var(--dsw-alias-label-primary,#e6e6e6);outline:none;width:calc(100% - 20px);box-sizing:border-box;}",
			".llmw-search:focus{border-color:var(--dsw-alias-brand-primary,#4d6bfe);}",
			".llmw-body{flex:1;min-height:0;overflow:auto;padding:2px 6px 14px;}",
			".llmw-sec{display:flex;justify-content:space-between;align-items:baseline;margin:10px 6px 2px;font-size:10.5px;font-weight:600;letter-spacing:.05em;text-transform:uppercase;color:var(--dsw-alias-label-secondary,#9aa0a6);}",
			".llmw-row{padding:6px 8px;border-radius:6px;cursor:pointer;border:1px solid transparent;}",
			".llmw-row:hover{background:var(--dsw-alias-bg-layer-1,#24262b);border-color:var(--dsw-alias-border-l1,#2c2f34);}",
			".llmw-rowtitle{display:flex;justify-content:space-between;gap:8px;align-items:baseline;}",
			".llmw-name{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}",
			".llmw-date{color:var(--dsw-alias-label-secondary,#9aa0a6);font-size:10px;white-space:nowrap;}",
			".llmw-meta{display:flex;gap:5px;flex-wrap:wrap;align-items:center;margin-top:3px;}",
			".llmw-tag{background:var(--dsw-alias-bg-layer-2,#2c2f35);border-radius:4px;padding:1px 5px;font-size:10px;color:var(--dsw-alias-label-secondary,#9aa0a6);}",
			".llmw-low{color:var(--dsw-alias-state-warn-primary,#e0a03c);font-size:10px;}",
			".llmw-contested{color:var(--dsw-alias-state-error-primary,#e05c5c);font-size:10px;}",
			".llmw-empty{padding:26px 16px;color:var(--dsw-alias-label-secondary,#9aa0a6);line-height:1.7;}",
			".llmw-note{font-size:10.5px;color:var(--dsw-alias-label-secondary,#9aa0a6);padding:6px 12px;}",
			".llmw-err{margin:8px 10px;padding:8px 10px;border:1px solid var(--dsw-alias-state-error-primary,#e05c5c);border-radius:6px;color:var(--dsw-alias-state-error-primary,#e05c5c);font-size:11px;}",
			".llmw-lint{margin:8px 6px 0;border:1px solid var(--dsw-alias-border-l1,#2c2f34);border-radius:8px;overflow:hidden;}",
			".llmw-lint-head{display:flex;justify-content:space-between;align-items:center;padding:6px 10px;background:var(--dsw-alias-bg-layer-1,#24262b);font-size:11px;font-weight:600;}",
			".llmw-lint-item{padding:4px 10px;font-size:11px;line-height:1.55;border-top:1px solid var(--dsw-alias-border-l1,#2c2f34);}",
			".llmw-sev-error{color:var(--dsw-alias-state-error-primary,#e05c5c);}",
			".llmw-sev-warn{color:var(--dsw-alias-state-warn-primary,#e0a03c);}",
			".llmw-sev-info{color:var(--dsw-alias-label-secondary,#9aa0a6);}",
			".llmw-ok{color:var(--dsw-alias-state-success-primary,#4caf7d);}",
			".llmw-page{display:flex;flex-direction:column;height:100%;min-height:0;background:var(--dsw-alias-bg-base,#1b1d21);color:var(--dsw-alias-label-primary,#e6e6e6);}",
			".llmw-pagehead{display:flex;align-items:center;gap:8px;padding:7px 10px;border-bottom:1px solid var(--dsw-alias-border-l1,#2c2f34);}",
			".llmw-pagepath{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--dsw-alias-label-secondary,#9aa0a6);font-size:10.5px;}",
			".llmw-pagebody{flex:1;min-height:0;overflow:auto;}",
			".llmw-frontmatter{display:flex;gap:6px;flex-wrap:wrap;align-items:center;padding:8px 12px 0;}",
			".llmw-md{padding:10px 12px 18px;font-size:12.5px;line-height:1.72;overflow-wrap:break-word;}",
			".llmw-md h1,.llmw-md h2,.llmw-md h3,.llmw-md h4,.llmw-md h5,.llmw-md h6{margin:1.1em 0 .5em;line-height:1.35;font-weight:600;}",
			".llmw-md h1{font-size:1.5em;border-bottom:1px solid var(--dsw-alias-border-l1,#2c2f34);padding-bottom:.25em;}",
			".llmw-md h2{font-size:1.28em;}",
			".llmw-md h3{font-size:1.12em;}",
			".llmw-md p{margin:.55em 0;}",
			".llmw-md ul,.llmw-md ol{margin:.5em 0;padding-left:1.5em;}",
			".llmw-md li{margin:.22em 0;}",
			".llmw-md li input{margin-right:.4em;}",
			".llmw-md blockquote{margin:.6em 0;padding:.2em .9em;border-left:3px solid var(--dsw-alias-border-l2,#3a3e44);color:var(--dsw-alias-label-secondary,#9aa0a6);}",
			".llmw-md code{font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);background:var(--dsw-alias-bg-layer-2,#2c2f35);border-radius:4px;padding:1px 4px;font-size:.92em;}",
			".llmw-md pre{background:var(--dsw-alias-bg-layer-1,#24262b);border:1px solid var(--dsw-alias-border-l1,#2c2f34);border-radius:8px;padding:10px 12px;overflow:auto;}",
			".llmw-md pre code{background:none;padding:0;font-size:.92em;line-height:1.6;}",
			".llmw-md table{border-collapse:collapse;margin:.7em 0;display:block;overflow:auto;max-width:100%;}",
			".llmw-md th,.llmw-md td{border:1px solid var(--dsw-alias-border-l1,#2c2f34);padding:4px 9px;text-align:left;}",
			".llmw-md th{background:var(--dsw-alias-bg-layer-1,#24262b);font-weight:600;}",
			".llmw-md hr{border:none;border-top:1px solid var(--dsw-alias-border-l1,#2c2f34);margin:1.1em 0;}",
			".llmw-md img{max-width:100%;border-radius:6px;}",
			".llmw-md a{color:var(--dsw-alias-brand-primary,#4d6bfe);text-decoration:none;}",
			".llmw-md a:hover{text-decoration:underline;}",
			".llmw-wlink{color:var(--dsw-alias-brand-primary,#4d6bfe);cursor:pointer;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:2px;}",
			".llmw-wlink:hover{background:var(--dsw-alias-bg-layer-2,#2c2f35);}",
			".llmw-wlink-miss{color:var(--dsw-alias-label-secondary,#9aa0a6);text-decoration:line-through dashed;opacity:.7;}",
			".llmw-back{flex:none;display:flex;gap:5px;flex-wrap:wrap;align-items:center;padding:6px 12px;border-top:1px dashed var(--dsw-alias-border-l1,#2c2f34);color:var(--dsw-alias-label-secondary,#9aa0a6);font-size:10.5px;}",
			".llmw-backlink{color:var(--dsw-alias-brand-primary,#4d6bfe);cursor:pointer;}",
			".llmw-rawpre{margin:0;padding:12px;white-space:pre-wrap;font-family:var(--dsw-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);font-size:11.5px;}"
		].join("\n");

		function injectStyle(source) {
			const style = document.createElement("style");
			style.setAttribute("data-llm-wiki-sidebar", "");
			style.textContent = source;
			document.head.appendChild(style);
			return () => { style.remove(); };
		}

		function el(tag, cls, text) {
			return React.createElement(tag, cls ? { className: cls } : null, text);
		}

		// -------------------------------------------------------------------
		// Browse tab (page type `llm-wiki`)
		// -------------------------------------------------------------------

		function WikiTab(ctx, props) {
			const t = typeof props.t === "function" ? props.t : (key) => key;
			const { tab } = props.useTabInfo();
			const sessionId = props.sessionId;
			const cwd = props.useSessions((sessions) => (sessions && sessions.byId && sessions.byId[sessionId] ? sessions.byId[sessionId].cwd : undefined)) || "";
			const [data, setData] = React.useState(null);
			const [phase, setPhase] = React.useState("loading");
			const [err, setErr] = React.useState("");
			const [query, setQuery] = React.useState("");
			const [lint, setLint] = React.useState(null);
			const [lintLoading, setLintLoading] = React.useState(false);
			const [showLint, setShowLint] = React.useState(false);
			const [wikis, setWikis] = React.useState(null);
			const [activeWiki, setActiveWiki] = React.useState("");

			React.useEffect(() => {
				if (!cwd) return;
				let alive = true;
				setWikis(null);
				setActiveWiki("");
				getWikis(cwd).then((res) => {
					if (!alive || !res) return;
					const list = Array.isArray(res.wikis) ? res.wikis : [];
					setWikis(list);
					const stored = loadStoredWiki(cwd);
					const hit = list.find((w) => w.root === stored) || list.find((w) => w.exists) || list[0];
					if (hit) setActiveWiki(hit.root);
				}).catch(() => { if (alive) setActiveWiki(cwd.replace(/\/+$/, "") + "/wiki"); });
				return () => { alive = false; };
			}, [cwd]);

			React.useEffect(() => {
				if (!cwd || !activeWiki) return;
				let alive = true;
				setPhase("loading");
				apiCall("scan", { cwd: cwd, wiki: activeWiki }).then((res) => {
					if (!alive) return;
					if (res && res.ok) { setData(res); setPhase("ready"); setErr(""); }
					else { setPhase("error"); setErr((res && res.error) || "scan failed"); }
				}).catch((e) => { if (alive) { setPhase("error"); setErr(String((e && e.message) || e)); } });
				return () => { alive = false; };
			}, [cwd, activeWiki]);

			const refresh = React.useCallback(() => {
				if (!activeWiki) return;
				setPhase("loading");
				apiCall("scan", { cwd: cwd, wiki: activeWiki }).then((res) => {
					if (res && res.ok) { setData(res); setPhase("ready"); setErr(""); mapCache.delete(activeWiki); }
					else { setPhase("error"); setErr((res && res.error) || "scan failed"); }
				}).catch((e) => { setPhase("error"); setErr(String((e && e.message) || e)); });
				wikisCache.delete(cwd);
				getWikis(cwd).then((res) => {
					const list = res && Array.isArray(res.wikis) ? res.wikis : [];
					setWikis(list);
					if (!list.some((w) => w.root === activeWiki)) {
						const hit = list.find((w) => w.exists) || list[0];
						if (hit) { setActiveWiki(hit.root); storeActiveWiki(cwd, hit.root); }
					}
				}).catch(() => {});
			}, [cwd, activeWiki]);

			React.useEffect(() => {
				if (!tab || !tab.actions) return;
				return tab.actions.bindCommands({ refresh: refresh });
			}, [tab && tab.actions, refresh]);

			function selectWiki(root) {
				if (!root || root === activeWiki) return;
				setActiveWiki(root);
				storeActiveWiki(cwd, root);
				setLint(null);
				setShowLint(false);
			}

			function runLint() {
				if (!activeWiki) return;
				setLintLoading(true);
				apiCall("lint", { cwd: cwd, wiki: activeWiki }).then((res) => {
					setLintLoading(false);
					if (res && res.ok) { setLint(res); setShowLint(true); }
				}).catch(() => { setLintLoading(false); });
			}

			function openPage(p) {
				tab.actions.openResource(sessionFileAddress(sessionId, p.path));
			}

			function matches(p) {
				if (!query) return true;
				const q = query.toLowerCase();
				return (p.slug || "").toLowerCase().indexOf(q) >= 0
					|| (p.title || "").toLowerCase().indexOf(q) >= 0
					|| (p.tags || []).some((tag) => String(tag).toLowerCase().indexOf(q) >= 0);
			}

			let body = null;
			if (!cwd) {
				body = el("div", "llmw-empty", t("noCwd"));
			} else if (phase === "loading" && !data) {
				body = el("div", "llmw-empty", t("loading"));
			} else if (phase === "error") {
				body = el("div", "llmw-err", t("scanFailed") + ": " + err);
			} else if (data && !data.exists) {
				body = React.createElement("div", { className: "llmw-empty" },
					el("div", null, t("noWikiAt") + " " + data.root),
					el("div", null, t("initHint")));
			} else if (data) {
				const kids = [];
				if (data.indexMissing || data.schemaMissing) {
					kids.push(el("div", "llmw-note", (data.indexMissing ? "index.md missing. " : "") + (data.schemaMissing ? "SCHEMA.md missing." : "")));
				}
				const q = query.toLowerCase();
				for (const sec of SECTIONS) {
					const pages = (data.sections[sec] || []).filter(matches);
					if (pages.length === 0 && q) continue;
					kids.push(el("div", "llmw-sec", React.createElement("span", null, sec + " · " + pages.length)));
					for (const p of pages) {
						const metaBits = [];
						for (const tag of (p.tags || []).slice(0, 4)) metaBits.push(el("span", "llmw-tag", String(tag)));
						if (p.confidence === "low" || p.confidence === "medium") metaBits.push(el("span", "llmw-low", "conf: " + p.confidence));
						if (p.contested) metaBits.push(el("span", "llmw-contested", "⚠ contested"));
						if (p.readError) metaBits.push(el("span", "llmw-contested", "unreadable"));
						kids.push(React.createElement("div", {
							key: sec + "/" + p.slug,
							className: "llmw-row",
							title: p.path,
							onClick: () => openPage(p),
						},
							React.createElement("div", { className: "llmw-rowtitle" },
								el("span", "llmw-name", p.title || p.slug),
								p.updated ? el("span", "llmw-date", String(p.updated)) : null),
							metaBits.length ? React.createElement("div", { className: "llmw-meta" }, metaBits) : null));
					}
				}
				if (data.totalPages === 0) kids.push(el("div", "llmw-empty", t("emptyWiki")));
				body = React.createElement("div", null, kids);
			}

			const lintBody = [];
			if (lint) {
				if (lint.counts.error + lint.counts.warn + lint.counts.info === 0) {
					lintBody.push(el("div", "llmw-lint-item llmw-ok", t("lintHealthy")));
				} else {
					for (const f of lint.findings) {
						lintBody.push(el("div", "llmw-lint-item llmw-sev-" + f.severity, "[" + f.category + "] " + f.message));
					}
				}
				lintBody.push(el("div", "llmw-lint-item llmw-sev-info", t("lintSummary") + ": " + lint.counts.error + " / " + lint.counts.warn + " / " + lint.counts.info + (lint.stats ? " · pages " + lint.stats.pages + " · wikilinks " + lint.stats.wikilinks : "")));
			}

			const wikiSwitcher = (wikis && wikis.length > 1) ? React.createElement("select", {
				className: "llmw-btn",
				title: t("switchWiki"),
				value: activeWiki,
				onChange: (e) => selectWiki(e.target.value),
			}, wikis.map((w) => React.createElement("option", { key: w.root, value: w.root },
				(w.name || w.root) + (w.exists === false ? " (missing)" : "")))) : null;

			return React.createElement("div", { className: "llmw-wrap" },
				React.createElement("div", { className: "llmw-head" },
					el("span", "llmw-title", "📚 " + t("tabTitle")),
					el("span", "llmw-root", data && data.root ? data.root : (activeWiki || (cwd ? cwd + "/wiki" : ""))),
					wikiSwitcher,
					React.createElement("button", { className: "llmw-btn", onClick: refresh, disabled: phase === "loading" }, "↻"),
					React.createElement("button", { className: "llmw-btn", onClick: runLint, disabled: lintLoading || !activeWiki || (data && data.exists === false) }, lintLoading ? t("linting") : t("lint"))),
				cwd ? React.createElement("input", {
					className: "llmw-search",
					placeholder: t("searchPlaceholder"),
					value: query,
					onChange: (e) => setQuery(e.target.value),
				}) : null,
				React.createElement("div", { className: "llmw-body" },
					body,
					showLint && lint ? React.createElement("div", { className: "llmw-lint" },
						React.createElement("div", { className: "llmw-lint-head" },
							el("span", null, t("lintReport")),
							React.createElement("button", { className: "llmw-btn", onClick: () => setShowLint(false) }, t("hide")))) : null,
					showLint && lint ? React.createElement("div", null, lintBody) : null));
		}

		// -------------------------------------------------------------------
		// Wiki page (resource type `llm-wiki-page`)
		// -------------------------------------------------------------------

		function WikiPage(ctx, props) {
			const t = typeof props.t === "function" ? props.t : (key) => key;
			const { tab } = props.useTabInfo();
			const sessionId = props.sessionId;
			const cwd = props.useSessions((sessions) => (sessions && sessions.byId && sessions.byId[sessionId] ? sessions.byId[sessionId].cwd : undefined)) || "";
			const address = tab.contentId;
			const meta = props.useResource(address);
			const parsed = React.useMemo(() => parseFileAddress(address), [address]);
			const resourceAbsolute = meta && meta.value ? meta.value.absolutePath : undefined;

			const filePath = resourceAbsolute
				|| (parsed ? (isAbsoluteWorkspacePath(parsed.path) ? parsed.path : (cwd ? cwd.replace(/\/+$/, "") + "/" + parsed.path : parsed.path)) : "");

			const [wikis, setWikis] = React.useState(null);
			const [text, setText] = React.useState(null);
			const [map, setMap] = React.useState(null);
			const [phase, setPhase] = React.useState("loading");
			const [err, setErr] = React.useState("");
			const [sourceMode, setSourceMode] = React.useState(false);
			const [reload, setReload] = React.useState(0);

			React.useEffect(() => {
				if (!cwd) return;
				let alive = true;
				getWikis(cwd).then((res) => {
					if (alive && res && Array.isArray(res.wikis)) setWikis(res.wikis);
				}).catch(() => {});
				return () => { alive = false; };
			}, [cwd]);

			React.useEffect(() => {
				if (!ctx.remote || !parsed || parsed.scope !== "session") {
					setPhase("error");
					setErr("unsupported file address");
					return;
				}
				const controller = new AbortController();
				let alive = true;
				setPhase("loading");
				readWholeText(ctx.remote, sessionId, parsed.path, controller.signal).then((res) => {
					if (!alive) return;
					setText(res.text);
					setPhase("ready");
					setErr("");
				}).catch((e) => {
					if (!alive) return;
					setPhase("error");
					setErr(String((e && e.message) || e));
				});
				return () => { alive = false; try { controller.abort(); } catch (e) {} };
			}, [ctx, sessionId, parsed && parsed.path, reload]);

			const legacyRoot = cwd ? cwd.replace(/\/+$/, "") + "/wiki/" : null;
			const wikiRoot = pickWikiRoot(filePath, wikis, legacyRoot);
			const isWiki = !!(wikiRoot && filePath && filePath.toLowerCase().indexOf(wikiRoot.toLowerCase()) === 0);

			React.useEffect(() => {
				if (!cwd || !isWiki) return;
				let alive = true;
				getMap(cwd, wikiRoot).then((res) => { if (alive) setMap(res); }).catch(() => {});
				return () => { alive = false; };
			}, [cwd, wikiRoot, isWiki]);

			const refresh = React.useCallback(() => setReload((n) => n + 1), []);
			React.useEffect(() => {
				if (!tab || !tab.actions) return;
				return tab.actions.bindCommands({ refresh: refresh });
			}, [tab && tab.actions, refresh]);

			const openTarget = React.useCallback((target) => {
				if (!target || !target.path) return;
				tab.actions.openResource(sessionFileAddress(sessionId, target.path));
			}, [tab && tab.actions, sessionId]);

			const parsedPage = React.useMemo(() => parseFrontmatter(text == null ? "" : text), [text]);
			const slug = String(filePath || "").split("/").pop().replace(/\.md$/i, "").toLowerCase();

			const env = React.useMemo(() => {
				const resolveTarget = makeWikiTargetResolver(map, wikiRoot || "");
				return {
					resolve: (target) => resolveTarget(target),
					imageUrl: makeImageUrl(resourceAbsolute || filePath),
				};
			}, [map, wikiRoot, resourceAbsolute, filePath]);

			const resolveLink = React.useMemo(() => makeLinkResolver({
				wikiRoot: wikiRoot || "",
				pageDir: dirOf(filePath),
				pages: (map && map.pages) || [],
				raws: (map && map.raws) || [],
			}), [wikiRoot, filePath, map]);

			const html = React.useMemo(() => {
				if (sourceMode || text == null) return "";
				return getMd().render(parsedPage.body, { llmwiki: env });
			}, [sourceMode, text, parsedPage.body, env]);

			const bodyRef = React.useRef(null);
			const scrollToFragment = React.useCallback((fragment) => {
				const container = bodyRef.current;
				const heading = findHeading(container, fragment);
				if (!heading) return false;
				try {
					heading.scrollIntoView({ block: "start" });
				} catch (e) {
					if (container) container.scrollTop = heading.offsetTop || 0;
				}
				return true;
			}, []);

			// A fragment addressed at another page is stashed by the click handler
			// and consumed here once this body has rendered it — including when
			// `openResource` only focused an already-open tab (the navigation
			// revision changes, the content does not).
			React.useEffect(() => {
				if (!html) return;
				const fragment = takeFragment(address);
				if (fragment) scrollToFragment(fragment);
			}, [address, html, tab.navigation && tab.navigation.revision, scrollToFragment]);

			function onBodyClick(event) {
				const node = event.target;
				if (!node || typeof node.closest !== "function") return;
				const anchor = node.closest("a");
				if (!anchor) return;
				const fragmentOnly = anchor.getAttribute("data-llmw-frag");
				if (fragmentOnly) {
					event.preventDefault();
					scrollToFragment(fragmentOnly);
					return;
				}
				const wikiTarget = anchor.getAttribute("data-llmw-wiki");
				if (wikiTarget) {
					event.preventDefault();
					const parts = splitFragment(wikiTarget);
					const hit = parts.key && env.resolve ? env.resolve(parts.key) : null;
					if (!hit) return;
					if (parts.fragment) {
						const nextAddress = sessionFileAddress(sessionId, hit.path);
						if (nextAddress === address) { scrollToFragment(parts.fragment); return; }
						stashFragment(nextAddress, parts.fragment);
					}
					openTarget(hit);
					return;
				}
				const href = anchor.getAttribute("href") || "";
				if (!href || href.charAt(0) === "#") return;
				if (/^[a-z][a-z0-9+.\-]*:/i.test(href)) {
					if (/^https?:/i.test(href)) {
						event.preventDefault();
						try { window.open(href, "_blank", "noopener,noreferrer"); } catch (e) {}
					}
					return;
				}
				let decoded = href;
				try { decoded = decodeURIComponent(href); } catch (e) {}
				const target = resolveLink(decoded);
				if (target) {
					event.preventDefault();
					openTarget(target);
				}
			}

			const backlinks = (map && map.backlinks && map.backlinks[slug]) || [];
			const fm = parsedPage.meta;
			const fmBits = [];
			if (fm) {
				if (fm.updated) fmBits.push(el("span", "llmw-tag", "updated " + fm.updated));
				for (const tag of (Array.isArray(fm.tags) ? fm.tags : []).slice(0, 6)) fmBits.push(el("span", "llmw-tag", String(tag)));
				if (fm.confidence) fmBits.push(el("span", "llmw-low", "conf: " + fm.confidence));
				if (fm.contested === true) fmBits.push(el("span", "llmw-contested", "⚠ contested"));
			}

			let body = null;
			if (phase === "loading" && text == null) {
				body = el("div", "llmw-empty", t("loading"));
			} else if (phase === "error") {
				body = el("div", "llmw-err", t("readFailed") + ": " + err);
			} else if (sourceMode) {
				body = React.createElement("pre", { className: "llmw-rawpre" }, text == null ? "" : text);
			} else {
				body = React.createElement("div", { className: "llmw-md", onClick: onBodyClick, dangerouslySetInnerHTML: { __html: html } });
			}

			return React.createElement("div", { className: "llmw-page" },
				React.createElement("div", { className: "llmw-pagehead" },
					el("span", "llmw-title", "📄"),
					el("span", "llmw-pagepath", filePath || address),
					React.createElement("button", {
						className: "llmw-btn",
						onClick: () => setSourceMode((v) => !v),
					}, sourceMode ? t("previewMode") : t("sourceMode")),
					React.createElement("button", { className: "llmw-btn", onClick: refresh, disabled: phase === "loading" }, "↻")),
				React.createElement("div", { className: "llmw-pagebody", ref: bodyRef },
					fmBits.length ? React.createElement("div", { className: "llmw-frontmatter" }, fmBits) : null,
					body),
				backlinks.length ? React.createElement("div", { className: "llmw-back" },
					el("span", null, "🔗 " + t("linkedHere") + " (" + backlinks.length + "):"),
					backlinks.map((s) => React.createElement("span", {
						key: s, className: "llmw-backlink",
						onClick: () => {
							const page = ((map && map.pages) || []).find((p) => String(p.slug).toLowerCase() === String(s).toLowerCase());
							if (page) openTarget(page);
						},
					}, s))) : null);
		}

		// -------------------------------------------------------------------
		// Locale dictionaries
		// -------------------------------------------------------------------

		const en = {
			tabTitle: "LLM Wiki",
			guideDescription: "Browse, search and lint this workspace's LLM wikis",
			loading: "Loading…",
			noCwd: "Session workspace (cwd) is unknown; cannot locate a wiki.",
			noWikiAt: "No wiki found at",
			initHint: "Initialize one with the llm-wiki skill — say: “create a wiki here”.",
			scanFailed: "Wiki scan failed",
			emptyWiki: "Wiki directory exists but has no pages yet. Ingest a source with the llm-wiki skill.",
			searchPlaceholder: "Search pages (slug / title / tag)…",
			switchWiki: "Switch wiki",
			lint: "Lint",
			linting: "Linting…",
			lintReport: "Lint report",
			lintHealthy: "No issues found. Wiki is healthy.",
			lintSummary: "Summary (error / warn / info)",
			hide: "Hide",
			sourceMode: "Source",
			previewMode: "Preview",
			readFailed: "Could not read this page",
			linkedHere: "Linked here",
			pageNotFound: "Wiki page not found",
		};
		const zh = {
			tabTitle: "LLM 知识库",
			guideDescription: "浏览、搜索并体检本工作区的 LLM wiki",
			loading: "加载中…",
			noCwd: "会话工作区（cwd）未知，无法定位 wiki。",
			noWikiAt: "未找到 wiki：",
			initHint: "可以用 llm-wiki 技能初始化一个 —— 直接说“帮我在这个工作区初始化一个 wiki”。",
			scanFailed: "Wiki 扫描失败",
			emptyWiki: "wiki 目录存在但还没有页面。用 llm-wiki 技能开始 ingest 源材料。",
			searchPlaceholder: "搜索页面（slug / 标题 / 标签）…",
			switchWiki: "切换 wiki",
			lint: "体检",
			linting: "体检中…",
			lintReport: "体检报告",
			lintHealthy: "未发现问题，wiki 状态良好。",
			lintSummary: "汇总（错误 / 警告 / 提示）",
			hide: "收起",
			sourceMode: "源码",
			previewMode: "预览",
			readFailed: "无法读取该页面",
			linkedHere: "反向链接",
			pageNotFound: "未找到 wiki 页面",
		};

		// -------------------------------------------------------------------
		// Internals (test surface; not public API)
		// -------------------------------------------------------------------

		exports._internal = {
			collapsePath,
			makeLinkResolver,
			pickWikiRoot,
			parseFileAddress,
			sessionFileAddress,
			isWikiMdPath,
			warmWikiRoots,
			makeWikiTargetResolver,
			parseFrontmatter,
			slugify,
			splitFragment,
			findHeading,
			getMd,
		};

		exports.inject = ["slots", "locale", "sidebarRightTabs", "remote", "remote.workspaceFiles"];

		exports.apply = function apply(ctx) {
			const t = ctx.locale.bind(NS);

			ctx.effect(() => injectStyle(css), "llm-wiki-sidebar: stylesheet");
			ctx.effect(() => ctx.locale.register(NS, { zh: zh, en: en }), "llm-wiki-sidebar: dictionaries");

			// Stage one: the browse page type.
			ctx.effect(() => ctx.sidebarRightTabs.register({
				id: BROWSE_ID,
				kind: BROWSE_KIND,
				title: () => t("tabTitle"),
				guide: [{
					id: "browse",
					order: 30,
					title: () => t("tabTitle"),
					description: () => t("guideDescription"),
				}],
			}), "llm-wiki-sidebar: browse type");

			// Stage one: wiki markdown pages (only `.md` inside a wiki root).
			ctx.effect(() => ctx.sidebarRightTabs.register({
				id: PAGE_ID,
				kind: PAGE_KIND,
				patterns: [FILE_PREFIX + "**"],
				priority: "extension",
				canOpen: (address) => isWikiMarkdownAddress(address),
				title: (address) => basenameOf(address),
			}), "llm-wiki-sidebar: page type");

			// Stage two: their bodies.
			ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
				name: "sidebar.right.pane.tab",
				key: BROWSE_ID,
				locale: NS,
			}, (props) => WikiTab(ctx, props))), "llm-wiki-sidebar: browse body");

			ctx.effect(() => ctx.slots.inject("sidebar.right.pane.tab", () => ctx.slots.register({
				name: "sidebar.right.pane.tab",
				key: PAGE_ID,
				locale: NS,
			}, (props) => WikiPage(ctx, props))), "llm-wiki-sidebar: page body");
		};

		return module.exports;
	}
});
