// llm-wiki-sidebar — client half
//
// Browser bundle for the dsh client module system:
//   window.__ModuleLoader__.load({ id, factory(require) }) → { inject, apply }
//
// Consumes the `betterSidebar` service (declared as a hard cordis dependency,
// so this plugin waits for dsh-better-sidebar instead of failing when absent)
// and talks to its own host half over same-origin POST /llm-wiki/api/* routes.

window.__ModuleLoader__.load({
	id: "llm-wiki-sidebar",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		const React = require("react");

		const TAB_ID = "llm-wiki:browse";
		const VIEWER_ID = "llm-wiki:md";
		const SECTIONS = ["entities", "concepts", "comparisons", "queries"];
		let badgeIssues = 0;
		const mapCache = new Map();

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

		function injectStyle(css) {
			const style = document.createElement("style");
			style.setAttribute("data-llm-wiki-sidebar", "");
			style.textContent = css;
			document.head.appendChild(style);
			return () => { style.remove(); };
		}

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
			".llmw-viewer{flex:1;min-height:0;display:flex;flex-direction:column;position:relative;}",
			".llmw-viewerhost{display:contents;}",
			".llmw-back{flex:none;display:flex;gap:5px;flex-wrap:wrap;align-items:center;margin:0;padding:5px 12px;border-top:1px dashed var(--dsw-alias-border-l1,#2c2f34);color:var(--dsw-alias-label-secondary,#9aa0a6);font-size:10.5px;}",
			".llmw-backlink{color:var(--dsw-alias-brand-primary,#4d6bfe);cursor:pointer;}",
			".llmw-wlink{color:var(--dsw-alias-brand-primary,#4d6bfe);cursor:pointer;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:2px;}",
			".llmw-wlink:hover{background:var(--dsw-alias-bg-layer-2,#2c2f35);}",
			".llmw-wlink-miss{color:var(--dsw-alias-label-secondary,#9aa0a6);text-decoration:line-through dashed;opacity:.7;}",
			".llmw-mdlink{color:var(--dsw-alias-brand-primary,#4d6bfe);cursor:pointer;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:2px;}",
			".llmw-mdlink:hover{background:var(--dsw-alias-bg-layer-2,#2c2f35);}",
			".llmw-rawpre{margin:0;padding:12px;white-space:pre-wrap;font-size:11.5px;}"
		].join("\n");

		function el(tag, cls, text) {
			return React.createElement(tag, cls ? { className: cls } : null, text);
		}

		// Collapse '.'/'..' segments ('' leading segment = absolute marker, preserved).
		// Note: a LEADING '..' (empty stack) is silently dropped — with this
		// wiki's flat global-slug namespace the resolver still lands on the
		// right target ('../raw/a.md' → 'raw/a.md'), so the quirk is kept.
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

		// Pure resolver for in-page markdown links → internal wiki targets.
		// Returns { kind: "page"|"file", path, title } or null for external/anchor/unresolvable.
		// opts: { wikiRoot, pageDir, pages: [{slug,path,title}], raws: [{rel,path}] }
		function makeLinkResolver(opts) {
			const wikiRoot = String((opts && opts.wikiRoot) || "").replace(/\/+$/, "") + "/";
			const pageDir = String((opts && opts.pageDir) || "");
			const pages = (opts && opts.pages) || [];
			const raws = (opts && opts.raws) || [];
			const pageBySlug = new Map(), pageByRel = new Map(), fileByRel = new Map();
			for (const p of pages) {
				const slug = String(p.slug || "").toLowerCase();
				if (!slug) continue;
				pageBySlug.set(slug, p);
				const abs = String(p.path || "").replace(/\/+$/, "");
				if (wikiRoot.length > 1 && abs.toLowerCase().indexOf(wikiRoot.toLowerCase()) === 0) {
					const rel = abs.slice(wikiRoot.length).toLowerCase();      // "concepts/x.md"
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
				if (!h || h.charAt(0) === "#") return null;                    // in-page anchor
				if (/^[a-z][a-z0-9+.\-]*:/i.test(h)) return null;              // any scheme: http/mailto/tel/data/blob/js
				try { h = decodeURIComponent(h); } catch (e) {}                // %20 / 中文文件名
				h = h.split("#")[0].replace(/\\/g, "/");
				if (!h) return null;
				const cands = [];
				const push = (p) => {
					if (!p) return;
					if (/^\/wiki\//i.test(p)) p = p.slice(5);                  // site-absolute "/wiki/..."
					else if (p.charAt(0) === "/") return;                      // other site-absolute → not a wiki file
					p = p.replace(/^\.\/+/, "").replace(/^wiki\//i, "");       // "./x" / "wiki/x" → root-relative
					p = collapsePath(p);
					if (p && cands.indexOf(p) === -1) cands.push(p);
				};
				push(h);                                                        // (1) root-relative guess
				if (pageDir) {                                                  // (2) page-dir-relative guess
					const abs = collapsePath(pageDir + h).toLowerCase();
					if (abs.toLowerCase().indexOf(wikiRoot.toLowerCase()) === 0) push(abs.slice(wikiRoot.length));
				}
				for (const c of cands) {
					const key = c.toLowerCase();
					const page = pageByRel.get(key) || pageByRel.get(key.replace(/\.md$/, ""));
					if (page) return { kind: "page", path: page.path, title: page.title || page.slug };
					const file = fileByRel.get(key) || fileByRel.get((wikiRoot + c).toLowerCase());
					if (file) return { kind: "file", path: file.path, title: file.rel };
					const stem = key.replace(/\.md$/, "").split("/").pop();    // last-resort page-stem match
					const byStem = pageBySlug.get(stem);
					if (byStem) return { kind: "page", path: byStem.path, title: byStem.title || byStem.slug };
				}
				return null;
			};
		}

		// Source text → what rendering leaves as plain text. Strips markdown
		// emphasis markers and resolves [[wikilink]]/[[page|alias]] to its
		// rendered label, so match-context signatures taken from the SOURCE
		// line up with the RENDERED preview text.
		function plainify(s) {
			return String(s)
				.replace(/\[\[([^\]\|]+)(?:\|([^\]]+))?\]\]/g, (m0, page, alias) => alias || page)
				.replace(/[`*_~\\]/g, "")
				.replace(/\u0000/g, "");
		}

		// Parse the ORIGINAL markdown into the document-ordered list of inline
		// links whose destination is a relative .md path — the pairing input for
		// preview decoration. Fenced blocks, inline code spans and the YAML
		// frontmatter block are masked first; image links and labels that
		// rendering would re-interpret (formatting/entities) are skipped so
		// decoration only ever wraps text the preview shows verbatim.
		function collectSourceLinks(text) {
			const all = String(text || "").split("\n");
			// Mask the frontmatter block (--- ... ---).
			let start = 0;
			if ((all[0] || "").trim() === "---") {
				for (let i = 1; i < all.length; i++) {
					if (all[i].trim() === "---") { start = i + 1; break; }
				}
			}
			const lines = start > 0 ? all.slice(start) : all;
			// Mask fenced code blocks (keep line structure).
			let fence = null;
			for (let i = 0; i < lines.length; i++) {
				const open = /^ {0,3}(`{3,}|~{3,})/.exec(lines[i]);
				if (fence === null) {
					if (open) { fence = open[1].charAt(0); lines[i] = ""; }
				} else if (open && open[1].charAt(0) === fence) {
					fence = null; lines[i] = "";
				} else {
					lines[i] = "";
				}
			}
			// Strip inline code spans BEFORE plainify (plainify would eat the
			// backticks and unmask them), THEN plainify the whole body: wikilinks
			// collapse to their rendered labels and emphasis markers vanish, so
			// context windows sliced around a match line up with the RENDERED
			// preview text (a window cut from raw source could start mid-
			// [[wikilink]] and never match).
			const flat = plainify(lines.join("\n").replace(/(`+)[\s\S]*?\1/g, ""));
			const out = [];
			const re = /(!?)\[([^\]\n]{1,120})\]\(([^()\s]+)(?:\s+"[^"]*")?\)/g;
			let m;
			while ((m = re.exec(flat)) !== null) {
				if (m[1] === "!") continue;                                   // image
				const label = m[2];
				const dest = m[3];
				if (label.trim() === "") continue;
				if (/[`*_~[\]()<>|!#\\&]/.test(label)) continue;              // formatting label → renders differently
				if (/^[a-z][a-z0-9+.\-]*:/i.test(dest)) continue;             // scheme: external/mailto → real <a> already
				if (dest.charAt(0) === "#") continue;                         // in-page anchor → out of scope
				out.push({
					label,
					dest,
					before: flat.slice(Math.max(0, m.index - 16), m.index),
					after: flat.slice(m.index + m[0].length, m.index + m[0].length + 6),
				});
				if (out.length >= 600) break;
			}
			return out;
		}

		function getMap(cwd) {
			if (mapCache.has(cwd)) return mapCache.get(cwd);
			const p = apiCall("map", { cwd: cwd }).then((res) => {
				if (!res || !res.ok) throw new Error((res && res.error) || "wiki map failed");
				return res;
			});
			p.catch(() => { mapCache.delete(cwd); });
			mapCache.set(cwd, p);
			return p;
		}

		let builtinMdCache;
		function builtinMarkdown(sidebar) {
			if (builtinMdCache !== undefined) return builtinMdCache;
			try {
				const viewers = sidebar.getFileViewers();
				for (const v of viewers) {
					if (v && v.id === "markdown" && typeof v.component === "function") { builtinMdCache = v; break; }
				}
			} catch (e) { builtinMdCache = undefined; }
			return builtinMdCache;
		}

		function renderBuiltin(sidebar, fp) {
			const md = builtinMarkdown(sidebar);
			if (md) {
				const p = {};
				for (const k in fp) p[k] = fp[k];
				p.viewerId = "markdown";
				p.key = "md:" + fp.path;
				return React.createElement(md.component, p);
			}
			return React.createElement("pre", { className: "llmw-rawpre" }, String(fp.content || ""));
		}

		// Text containers whose contents must never be wrapped as md-links.
		// (a: real anchors — wrapping inside would fight the anchor's own
		// behavior; .llmw-mdlink: our own output, excluded so the rebuilt index
		// stays consistent within one pass. .llmw-wlink text is deliberately
		// INCLUDED — the wikilink decorator runs first, and its labels are part
		// of the rendered text the source-derived context signatures match
		// against, on the first run and on every observer-triggered re-run.)
		const MDLINK_TAGS = { CODE: 1, PRE: 1, TEXTAREA: 1, SCRIPT: 1, STYLE: 1, A: 1 };

		// Depth-first joined text of the preview's renderable text nodes, with a
		// node-start offset table. Matching runs on the joined string (robust to
		// how React/MarkdownText split text nodes); wrapping only needs the one
		// node covering the label range.
		function buildTextIndex(root) {
			const pieces = [];
			const nodes = [];
			let total = 0;
			let visited = 0;
			(function walk(node) {
				const children = node.childNodes;
				for (let i = 0; i < children.length; i++) {
					if (++visited > 6000 || total > 200000) return;
					const child = children[i];
					if (child.nodeType === 3) {
						if (child.nodeValue) {
							nodes.push({ node: child, start: total });
							pieces.push(child.nodeValue);
							total += child.nodeValue.length;
						}
					} else if (child.nodeType === 1) {
						const tag = (child.tagName || "").toUpperCase();
						if (MDLINK_TAGS[tag]) continue;
						// The TextEditor hosts the CodeMirror SOURCE copy before the
						// rendered preview — walking it binds every match to the
						// hidden editor text (frontmatter, line numbers, raw
						// syntax) and starves the visible preview of matches.
						// "cm-editor" is CodeMirror's own stable class, not a
						// hashed module name.
						if (child.classList && (child.classList.contains("cm-editor") || child.classList.contains("llmw-mdlink"))) continue;
						walk(child);
					}
				}
			})(root);
			return { text: pieces.join(""), nodes };
		}

		function nodeAt(index, offset) {
			let lo = 0, hi = index.nodes.length - 1, best = null;
			while (lo <= hi) {
				const mid = (lo + hi) >> 1;
				if (index.nodes[mid].start <= offset) { best = index.nodes[mid]; lo = mid + 1; }
				else hi = mid - 1;
			}
			return best;
		}

		// Remove spans created by a previous decoration pass so every run
		// re-binds from a pristine tree (self-healing across re-renders).
		function unwrapMdLinks(root) {
			if (!root || !root.querySelectorAll) return;
			const spans = root.querySelectorAll("[data-llmw-mdlink]");
			for (let i = 0; i < spans.length; i++) {
				const span = spans[i];
				if (span.parentNode) span.parentNode.replaceChild(span.ownerDocument.createTextNode(span.textContent || ""), span);
			}
		}

		// Source text → regex fragment safe to embed, with whitespace runs made
		// fuzzy: block boundaries DROP newlines in the rendered text and soft
		// breaks may turn into spaces, so the preview's joined text can hold
		// less whitespace than the source — `\s*` absorbs both directions.
		function fuzzyNeedle(s) {
			return String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
		}

		// Pair source-parsed links with their rendered label text and wrap the
		// labels into clickable spans. Match order: full 16-char before-signature
		// (label pinned right after the anchor) → 8-char before-tail (same
		// pinning) → label-only SEARCH from the cursor (document order).
		// Whitespace-fuzzy throughout. A match that cannot be wrapped safely
		// (label straddling nodes, guarded container) still advances the cursor
		// so later links cannot rebind it.
		function decorateMarkdownLinks(root, sourceLinks, resolveLink, onOpenTarget) {
			if (!root || !sourceLinks || sourceLinks.length === 0 || typeof resolveLink !== "function") return 0;
			const doc = root.ownerDocument;
			if (!doc) return 0;
			let wrapped = 0;
			let cursor = 0;
			let index = buildTextIndex(root);
			for (let i = 0; i < sourceLinks.length && wrapped < 600; i++) {
				const link = sourceLinks[i];
				const target = resolveLink(link.dest);
				if (!target) continue;                                    // unresolvable → leave plain (no hijack)
				const label = link.label;
				const labelNeedle = "^\\s*" + fuzzyNeedle(label);
				const heads = [];
				if (link.before) {
					heads.push(fuzzyNeedle(link.before));                 // full 16-char signature
					heads.push(fuzzyNeedle(link.before.slice(-8)));       // 8-char tail
				}
				heads.push(null);                                         // label-only fallback
				let hit = -1;
				for (const head of heads) {
					if (head !== null) {
						const re = new RegExp(head, "g");
						re.lastIndex = cursor;
						const m = re.exec(index.text);
						if (!m) continue;
						const anchor = m.index + m[0].length;
						// Context head found → the label must start right at the
						// anchor (leading whitespace tolerated): pin it instead of
						// searching on, or prose containing the same word would
						// steal the match.
						const m2 = new RegExp(labelNeedle).exec(index.text.slice(anchor, anchor + label.length + 8));
						if (!m2 || m2[0].length < label.length) continue;
						hit = anchor + m2[0].length - label.length;
					} else {
						// Label-only fallback: SEARCH the first occurrence at/after
						// the cursor (document order) — the accepted heuristic when
						// no context signature is available. Already-wrapped labels
						// are excluded from the join, so the search self-corrects
						// past previous bindings.
						const re = new RegExp(fuzzyNeedle(label), "g");
						re.lastIndex = cursor;
						const m = re.exec(index.text);
						if (!m) continue;
						hit = m.index;
					}
					break;
				}
				if (hit < 0) continue;
				const entry = nodeAt(index, hit);
				let ok = false;
				if (entry) {
					const inOff = hit - entry.start;
					const value = entry.node.nodeValue || "";
					if (value.slice(inOff, inOff + label.length) === label) {  // label must sit in ONE text node
						const parent = entry.node.parentNode;
						if (parent) {
							const beforeText = value.slice(0, inOff);
							const afterText = value.slice(inOff + label.length);
							const span = doc.createElement("span");
							span.setAttribute("data-llmw-mdlink", "1");
							span.className = "llmw-mdlink";
							span.title = "→ " + (target.title || target.path);
							span.textContent = label;
							span.addEventListener("click", (e) => {
								e.preventDefault();
								e.stopPropagation();
								try { onOpenTarget(target); } catch (err) {}
							});
							const frag = doc.createDocumentFragment();
							if (beforeText !== "") frag.appendChild(doc.createTextNode(beforeText));
							frag.appendChild(span);
							if (afterText !== "") frag.appendChild(doc.createTextNode(afterText));
							parent.replaceChild(frag, entry.node);
							wrapped++;
							cursor = hit + label.length;
							index = buildTextIndex(root);   // node boundaries changed; joined text unchanged
							ok = true;
						}
					}
				}
				if (!ok) cursor = hit + label.length;
			}
			return wrapped;
		}

		function decorateWikiLinks(root, bySlug, openBySlug) {
			if (!root || !bySlug) return;
			const doc = root.ownerDocument;
			if (!doc) return;
			let visited = 0;
			let replaced = 0;
			const WIKI_RE = /\[\[([^\[\]]+?)\]\]/g;

			function linkifyText(node) {
				const value = node.nodeValue;
				if (!value || value.indexOf("[[") === -1) return;
				WIKI_RE.lastIndex = 0;
				let m = WIKI_RE.exec(value);
				if (!m) return;
				const frag = doc.createDocumentFragment();
				let last = 0;
				while (m) {
					const start = m.index;
					if (start > 0 && value.charAt(start - 1) === "!") {
						frag.appendChild(doc.createTextNode(value.slice(last, start + m[0].length)));
						last = start + m[0].length;
						m = WIKI_RE.exec(value);
						continue;
					}
					if (start > last) frag.appendChild(doc.createTextNode(value.slice(last, start)));
					const inner = m[1];
					const bar = inner.indexOf("|");
					const rawTarget = (bar >= 0 ? inner.slice(0, bar) : inner).trim();
					const label = bar >= 0 ? (inner.slice(bar + 1).trim() || inner.trim()) : inner.trim();
					const target = rawTarget.split("#")[0].toLowerCase();
					const hit = bySlug[target];
					const span = doc.createElement("span");
					span.textContent = label;
					if (hit) {
						span.className = "llmw-wlink";
						span.title = "→ " + hit.title;
						span.addEventListener("click", (e) => {
							e.preventDefault();
							e.stopPropagation();
							openBySlug(target);
						});
					} else {
						span.className = "llmw-wlink-miss";
						span.title = "Wiki page not found: " + target;
					}
					frag.appendChild(span);
					last = start + m[0].length;
					m = WIKI_RE.exec(value);
					replaced++;
					if (replaced > 600) break;
				}
				if (last < value.length) frag.appendChild(doc.createTextNode(value.slice(last)));
				if (node.parentNode) node.parentNode.replaceChild(frag, node);
			}

			function walk(node) {
				if (visited > 6000 || replaced > 600) return;
				const children = node.childNodes;
				if (!children) return;
				for (let i = 0; i < children.length; i++) {
					visited++;
					if (visited > 6000 || replaced > 600) return;
					const child = children[i];
					if (child.nodeType === 3) linkifyText(child);
					else if (child.nodeType === 1) {
						const tag = (child.tagName || "").toUpperCase();
						if (tag === "CODE" || tag === "PRE" || tag === "TEXTAREA" || tag === "SCRIPT" || tag === "STYLE" || tag === "A") continue;
						// Same CodeMirror exclusion as buildTextIndex: the hidden
						// source copy must never carry decorations (v1 also walked
						// it — latent bug, only visible since the editor + preview
						// share this container).
						if (child.classList && child.classList.contains("cm-editor")) continue;
						walk(child);
					}
				}
			}

			walk(root);
		}

		function WikiPageViewer(ctx, sidebar, fp) {
			const scope = fp.scope || {};
			const cwd = typeof scope.cwd === "string" ? scope.cwd : "";
			const wikiRoot = cwd ? cwd.replace(/\/+$/, "") + "/wiki/" : null;
			const isWiki = !!(wikiRoot && typeof fp.path === "string" && fp.path.indexOf(wikiRoot) === 0);
			const [mode, setMode] = React.useState("preview");
			const [map, setMap] = React.useState(null);
			const [mapErr, setMapErr] = React.useState("");
			let container = null;

			React.useEffect(() => {
				if (!isWiki) return;
				let alive = true;
				const timers = [];
				// A transient map failure would otherwise leave this page view
				// undecorated until it is reopened (the one-shot fetch caches
				// nothing on failure). Retry twice with backoff; getMap drops
				// its failed cache entry, so each attempt refetches fresh.
				const delays = [0, 800, 2400];
				const attempt = (i) => {
					timers.push(setTimeout(() => {
						if (!alive) return;
						getMap(cwd).then((res) => {
							if (alive) { setMap(res); setMapErr(""); }
						}).catch((e) => {
							if (alive && i + 1 < delays.length) attempt(i + 1);
							else if (alive) setMapErr(String((e && e.message) || e));
						});
					}, delays[i]));
				};
				attempt(0);
				return () => { alive = false; for (const t of timers) clearTimeout(t); };
			}, [cwd, isWiki]);

			const wrapToolbarState = (s) => {
				try { if (s && s.mode) setMode(s.mode); } catch (e) {}
				if (typeof fp.onToolbarState === "function") fp.onToolbarState(s);
			};
			const wrapToolbarControls = (c) => {
				if (typeof fp.onToolbarControls === "function") fp.onToolbarControls(c);
			};
			const childProps = {};
			for (const k in fp) childProps[k] = fp[k];
			childProps.onToolbarState = wrapToolbarState;
			childProps.onToolbarControls = wrapToolbarControls;
			childProps.viewerId = "markdown";

			const bySlug = {};
			if (map && map.pages) {
				for (const p of map.pages) bySlug[p.slug.toLowerCase()] = p;
			}
			const slug = String(fp.path || "").split("/").pop().replace(/\.md$/i, "").toLowerCase();
			const openBySlug = (target) => {
				const hit = bySlug[String(target).split("#")[0]];
				if (hit) sidebar.openFile(scope, hit.path, hit.title);
			};
			// md-link decoration wiring: parse the ORIGINAL markdown for relative
			// .md links, resolve them against the wiki map, and pair them with
			// their rendered label text in the preview (see decorateMarkdownLinks).
			// fp.content is never modified — editing/saving stays byte-identical.
			const sourceLinks = collectSourceLinks(typeof fp.content === "string" ? fp.content : "");
			const pageDir = (() => {
				const p = String(fp.path || "");
				const i = p.lastIndexOf("/");
				return i > 0 ? p.slice(0, i + 1) : "";
			})();
			const resolveLink = makeLinkResolver({
				wikiRoot: wikiRoot || "",
				pageDir,
				pages: map && Array.isArray(map.pages) ? map.pages : [],
				raws: map && Array.isArray(map.raws) ? map.raws : [],
			});
			const onOpenTarget = (t) => { try { sidebar.openFile(scope, t.path, t.title); } catch (e) {} };

			React.useEffect(() => {
				if (!isWiki || mode !== "preview" || !container) return;
				let disposed = false;
				let mutating = false;
				let pendingTimer = null;
				let observer = null;
				const run = () => {
					if (disposed || !container) return;
					mutating = true;
					try {
						unwrapMdLinks(container);
						decorateWikiLinks(container, map ? bySlug : null, openBySlug);
						if (map) decorateMarkdownLinks(container, sourceLinks, resolveLink, onOpenTarget);
					} catch (e) {} finally { mutating = false; }
				};
				run();
				const lateTimers = [400, 1500].map((ms) => {
					const t = setTimeout(run, ms);
					return () => clearTimeout(t);
				});
				try {
					if (typeof MutationObserver === "function") {
						observer = new MutationObserver(() => {
							if (disposed || mutating) return;
							if (pendingTimer) { clearTimeout(pendingTimer); }
							pendingTimer = setTimeout(() => { pendingTimer = null; run(); }, 120);
						});
						observer.observe(container, { childList: true, subtree: true });
					}
				} catch (e) { observer = null; }
				return () => {
					disposed = true;
					for (const t of lateTimers) t();
					if (pendingTimer) clearTimeout(pendingTimer);
					if (observer) { try { observer.disconnect(); } catch (e) {} }
				};
			}, [isWiki, mode, fp.path, fp.content, map]);

			if (!isWiki) return renderBuiltin(sidebar, fp);

			const md = builtinMarkdown(sidebar);
			if (!md) return React.createElement("pre", { className: "llmw-rawpre" }, String(fp.content || ""));

			const backlinks = (map && map.backlinks && map.backlinks[slug]) || [];
			return React.createElement("div", { className: "llmw-viewer" },
				mapErr ? el("div", "llmw-note", "Wiki map unavailable (" + mapErr + ") — wikilinks stay plain text.") : null,
				React.createElement("div", { className: "llmw-viewerhost", ref: (n) => { container = n; } },
					React.createElement(md.component, Object.assign({ key: "md:" + fp.path }, childProps))),
				backlinks.length ? React.createElement("div", { className: "llmw-back" },
					el("span", null, "🔗 Linked here (" + backlinks.length + "):"),
					backlinks.map((s) => React.createElement("span", {
						key: s, className: "llmw-backlink",
						onClick: () => openBySlug(s),
					}, s))) : null);
		}

		function WikiTab(ctx, sidebar, props) {
			const scope = props.scope || {};
			const cwd = typeof scope.cwd === "string" ? scope.cwd : "";
			const [data, setData] = React.useState(null);
			const [phase, setPhase] = React.useState("loading");
			const [err, setErr] = React.useState("");
			const [query, setQuery] = React.useState("");
			const [lint, setLint] = React.useState(null);
			const [lintLoading, setLintLoading] = React.useState(false);
			const [showLint, setShowLint] = React.useState(false);

			React.useEffect(() => {
				let alive = true;
				setPhase("loading");
				apiCall("scan", { cwd: cwd }).then((res) => {
					if (!alive) return;
					if (res && res.ok) { setData(res); setPhase("ready"); setErr(""); }
					else { setPhase("error"); setErr((res && res.error) || "scan failed"); }
				}).catch((e) => { if (alive) { setPhase("error"); setErr(String((e && e.message) || e)); } });
				return () => { alive = false; };
			}, [cwd]);

			function refresh() {
				setPhase("loading");
				apiCall("scan", { cwd: cwd }).then((res) => {
					if (res && res.ok) { setData(res); setPhase("ready"); setErr(""); mapCache.delete(cwd); }
					else { setPhase("error"); setErr((res && res.error) || "scan failed"); }
				}).catch((e) => { setPhase("error"); setErr(String((e && e.message) || e)); });
			}

			function runLint() {
				setLintLoading(true);
				apiCall("lint", { cwd: cwd }).then((res) => {
					setLintLoading(false);
					if (res && res.ok) {
						setLint(res);
						setShowLint(true);
						badgeIssues = res.counts.error + res.counts.warn;
					}
				}).catch(() => { setLintLoading(false); });
			}

			function openPage(p) {
				sidebar.openFile(scope, p.path, p.title || p.slug);
			}

			function matches(p) {
				if (!query) return true;
				const q = query.toLowerCase();
				return (p.slug || "").toLowerCase().indexOf(q) >= 0
					|| (p.title || "").toLowerCase().indexOf(q) >= 0
					|| (p.tags || []).some((t) => String(t).toLowerCase().indexOf(q) >= 0);
			}

			let body = null;
			if (!cwd) {
				body = el("div", "llmw-empty", "Session workspace (cwd) is unknown; cannot locate a wiki. Open this tab from a session with a workspace.");
			} else if (phase === "loading" && !data) {
				body = el("div", "llmw-empty", "Loading wiki…");
			} else if (phase === "error") {
				body = el("div", "llmw-err", "Wiki scan failed: " + err);
			} else if (data && !data.exists) {
				body = React.createElement("div", { className: "llmw-empty" },
					el("div", null, "No wiki found at " + data.root),
					el("div", null, "Initialize one with the llm-wiki skill — just say: “帮我在这个工作区初始化一个 wiki” or “create a wiki here”."));
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
						for (const t of (p.tags || []).slice(0, 4)) metaBits.push(el("span", "llmw-tag", String(t)));
						if (p.confidence === "low" || p.confidence === "medium") metaBits.push(el("span", "llmw-low", "conf: " + p.confidence));
						if (p.contested) metaBits.push(el("span", "llmw-contested", "⚠ contested"));
						if (p.readError) metaBits.push(el("span", "llmw-contested", "unreadable"));
						kids.push(React.createElement("div", {
							key: sec + "/" + p.slug,
							className: "llmw-row",
							title: p.path + "\nClick to open in the markdown preview/editor",
							onClick: () => openPage(p),
						},
							React.createElement("div", { className: "llmw-rowtitle" },
								el("span", "llmw-name", p.title || p.slug),
								p.updated ? el("span", "llmw-date", String(p.updated)) : null),
							metaBits.length ? React.createElement("div", { className: "llmw-meta" }, metaBits) : null));
					}
				}
				if (data.totalPages === 0) kids.push(el("div", "llmw-empty", "Wiki directory exists but has no pages yet. Ingest a source with the llm-wiki skill."));
				body = React.createElement("div", null, kids);
			}

			const lintBody = [];
			if (lint) {
				if (lint.counts.error + lint.counts.warn + lint.counts.info === 0) {
					lintBody.push(el("div", "llmw-lint-item llmw-ok", "No issues found. Wiki is healthy."));
				} else {
					for (const f of lint.findings) {
						lintBody.push(el("div", "llmw-lint-item llmw-sev-" + f.severity, "[" + f.category + "] " + f.message));
					}
				}
				lintBody.push(el("div", "llmw-lint-item llmw-sev-info", "Summary: " + lint.counts.error + " errors, " + lint.counts.warn + " warnings, " + lint.counts.info + " info" + (lint.stats ? " · pages " + lint.stats.pages + " · wikilinks " + lint.stats.wikilinks : "")));
				if (lint.driftNote) lintBody.push(el("div", "llmw-lint-item llmw-sev-info", lint.driftNote));
			}

			return React.createElement("div", { className: "llmw-wrap" },
				React.createElement("div", { className: "llmw-head" },
					el("span", "llmw-title", "📚 LLM Wiki"),
					el("span", "llmw-root", data && data.root ? data.root : (cwd ? cwd + "/wiki" : "")),
					React.createElement("button", { className: "llmw-btn", onClick: refresh, disabled: phase === "loading" }, "↻"),
					React.createElement("button", { className: "llmw-btn", onClick: runLint, disabled: lintLoading || !cwd || (data && data.exists === false) }, lintLoading ? "Linting…" : "Lint")),
				cwd ? React.createElement("input", {
					className: "llmw-search",
					placeholder: "Search pages (slug / title / tag)…",
					value: query,
					onChange: (e) => setQuery(e.target.value),
				}) : null,
				React.createElement("div", { className: "llmw-body" },
					body,
					showLint && lint ? React.createElement("div", { className: "llmw-lint" },
						React.createElement("div", { className: "llmw-lint-head" },
							el("span", null, "Lint report"),
							React.createElement("button", { className: "llmw-btn", onClick: () => setShowLint(false) }, "Hide"))) : null,
					showLint && lint ? React.createElement("div", null, lintBody) : null));
		}

		// Internal test surface (exercised by test-mdlink-impl.mjs; not part of
		// the plugin's public API).
		exports._internal = { makeLinkResolver, collapsePath, plainify, collectSourceLinks, decorateMarkdownLinks, unwrapMdLinks };

		exports.inject = ["betterSidebar"];
		exports.apply = function apply(ctx) {
			const sidebar = ctx.get("betterSidebar");
			if (sidebar === undefined) {
				console.error("[llm-wiki-sidebar] betterSidebar service not found; install/enable dsh-better-sidebar");
				return;
			}
			if (Array.isArray(sidebar.features) && sidebar.features.indexOf("openFile") === -1) {
				console.error("[llm-wiki-sidebar] sidebar service lacks the openFile capability (dsh-better-sidebar too old)");
				return;
			}

			ctx.effect(() => injectStyle(css), "llm-wiki-sidebar: stylesheet");

			function WikiTabBridge(tabProps) {
				return WikiTab(ctx, sidebar, tabProps);
			}
			function WikiPageViewerBridge(fp) {
				return WikiPageViewer(ctx, sidebar, fp);
			}

			ctx.effect(() => sidebar.registerTab({
				id: TAB_ID,
				title: "LLM Wiki",
				icon: (size) => React.createElement("span", { style: { fontSize: size } }, "📚"),
				single: true,
				order: 150,
				badge: () => (badgeIssues > 0 ? badgeIssues : null),
				component: WikiTabBridge,
			}), "llm-wiki-sidebar: browse tab");

			ctx.effect(() => sidebar.registerFileViewer({
				id: VIEWER_ID,
				title: "LLM Wiki Markdown",
				exts: ["md", "markdown"],
				priority: 10,
				fetchStrategy: "fsRead",
				component: WikiPageViewerBridge,
			}), "llm-wiki-sidebar: markdown viewer");
		};

		return module.exports;
	}
});
