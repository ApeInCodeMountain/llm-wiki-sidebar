# llm-wiki-sidebar 插件改进方案 v2：溯源/站内相对链接可点击（修订版）

> **已作废（v2.0.0）。** 本文描述的是 v1.x 的 DOM 文本配对装饰方案，它建立在
> `dsh-better-sidebar` 的 `betterSidebar` 文件查看器之上。DSH 自带右侧边栏后，插件改为
> 「自己渲染 wiki 页面」（`ctx.sidebarRightTabs` 资源类型 + markdown-it + `[[wikilink]]`
> 规则 + `tab.actions.openResource`），不再读取或改写任何其它插件的 DOM。本文仅作历史记录。

> 日期：2026-09-05 ｜ 状态：**已实施（v1.1.1 已部署；v1.1.0 首轮实测发现 CM 污染缺陷，见 §7）** ｜ 取代：`improvement-source-link-navigation.md`（v1）的**客户端设计部分**
> 目标包：`formal-package/llm-wiki-sidebar`（package.json 1.0.0 → 1.1.0）
> v1 保留：§3.1 服务端改造、§3.2(a) CSS、§3.2(b) resolver、§3.4 版本文档、§4.1 部署、§P3/P4/P5 调查结论
> v1 废弃：§3.2(c) `decorateAnchor`（`<a>` 点击拦截）——其前提被证伪，见 §1
> v1 新增替代：**预览 DOM 文本配对装饰**（不改源码、不依赖 `<a>` 渲染、编辑保存零污染）

---

## 0. TL;DR

- **v1 的致命误判**：宿主共享渲染器 `MarkdownText` 对相对链接目标做白名单过滤（只放行 `http/https/mailto`），**过滤失败时连 `<a>` 元素都不渲染**，只渲染标签纯文本，URL 从 DOM 中彻底丢失。v1 的 `decorateAnchor` 拦截方案因此是死代码。
- **为什么不能改源码绕过**：插件把改写后的 `fp.content` 传给查看器后，编辑模式的 CodeMirror 文档就是改写后的文本，`Ctrl+S` 会把改写后的 URL 写回 wiki 源文件；保存路径在 TextEditor 内部（`api.fsWrite(scope, path, view.state.doc.toString())`），插件没有任何 save 钩子。源码重写路线在插件侧不可行（上游侧可行，见 §5.8）。
- **v2 核心机制**：URL 在插件手里（`fp.content`），标签文本在 DOM 里（渲染后的纯文本节点）。按文档顺序把"源码解析出的链接序"与"预览拼接文本"配对，用与现有 `[[wikilink]]` 装饰完全相同的 text-node 替换手法把标签包成可点 span。**零源码污染、零编辑态影响、不依赖 MarkdownText 的任何渲染行为假设。**
- **改动量**：`lib/index.js` 约 +6 行（同 v1）；`lib/client.js` 约 +240 行（v1 估 +90，但机制无效；v2 的增量来自配对算法本身）。

---

## 1. v1 判断的修正（为什么 v1 客户端方案不可行）

### 1.1 真正的渲染链路与证据（v1 查错了产物）

v1 检查的 `dsh-web-frontend/dist/assets/langs/markdown-*.js` / `mdx-*.js` 是 **shiki 语言高亮分包**，不是链接渲染器。真实链路：

1. better-sidebar markdown 预览复用共享组件 `MarkdownText`
   （`dsh-better-sidebar/lib/client-editor.js`：`_deepseek_ai_dsh_client_ui_primitives.MarkdownText`，仅传 `text` + `labels`，**无 urlTransform**）；
2. 该模块由宿主主 bundle 提供（`@deepseek-ai/dsh-web-frontend/dist/assets/index-Df-65__b.js` 的模块表
   `"@deepseek-ai/dsh-client-ui-primitives": Fp`，导出 `MarkdownText: ic`）；
3. 其链接渲染器带 URL 白名单：

```js
// Ku：解析不出 http/https/mailto 的目标 → 返回 ""（相对路径在此处 throw → catch → ""）
function Ku(n){try{switch(new URL(n).protocol){case"http:":case"https:":case"mailto:":return n;default:return""}}catch{return""}}
// Xu：目标为空 → 渲染 Fragment（纯文本，非 <a>）；命中 → <a target="_blank">
function Xu(n,i,o){const l=Ku(n);return l===""?jsx(Fragment,{children:i}):jsx("a",{href:l,...target:"_blank"...})}
```

4. node 精确复现结果：

| 输入 dest | 渲染结果 |
|---|---|
| `raw/articles/x.md` | **Fragment 纯文本，无 `<a>`，URL 丢失** |
| `../raw/a.md` / `concepts/myth.md` / `/wiki/raw/a.md` / `#anchor` | 同上 |
| `https://…` / `mailto:…` | `<a target="_blank">`（唯一存活场景） |

5. 旁证：better-sidebar 自己对图片就是这么绕的——`src/client/markdown-images.ts` 注释原文：本地图片路径被改写为 GUI origin 前缀的绝对 URL，"*so the shared MarkdownText http(s) allowlist accepts them*"。**图片有源码级重写，链接没有。**

### 1.2 由此 v1 §3.2(c) 是死代码

- 相对链接 → DOM 里没有 `<a>` → walk 的 `tag === "A"` 分支永远遇不到它们；
- 唯一渲染成 `<a>` 的是外链，而 `resolveLink` 对带 scheme 的输入返回 null（不拦截）;
- 两者交集为空 → `decorateAnchor` 对所有输入 no-op，§3.3 行为表全部不会发生；
- 且 URL 已从 DOM 丢失，**纯客户端 DOM 拦截在原理上走不通**。

### 1.3 为什么"改写源码让链接活过白名单"也不可行（插件侧）

思路（对齐图片的重写做法）：把 `fp.content` 中相对 dest 改写为 GUI origin 前缀绝对 URL → 渲染成真 `<a>` → 再拦截点击。

致命伤：`save()` 直接写 CodeMirror 文档——

```ts
// dsh-better-sidebar/src/client/TextEditor.tsx:292
const save = (): void => {
  ...
  api.fsWrite(scope, path, view.state.doc.toString())   // ← CM 文档即插件传入的（已改写）文本
```

插件传什么 `fp.content`，CM 文档就是什么；`Ctrl+S` 会把改写后的 URL 写回 wiki 源文件，**破坏纯 markdown 可移植性**（Obsidian/GitHub 里变成死链），且保存路径在 TextEditor 内部，插件无 save 钩子可拦。故插件侧唯一安全层是**渲染后的 DOM**——这正是 v2 的设计空间。

---

## 2. 新方案总览

### 2.1 设计原则

1. **不碰 `fp.content`**：装饰只发生在预览 DOM 的文本节点上（与现有 `[[wikilink]]` 装饰同层、同手法）。编辑模式、保存路径零影响。
2. **不依赖 `<a>` 渲染**：配对基于"拼接文本 + 节点偏移表"，对 React 如何切分文本节点不敏感。
3. **失败降级**：任何配对不确信的链接保持纯文本（延续 v1"未命中不劫持"哲学）。配对错位的后果上限是"点的是同页另一处同文出现"——**指向不会错**（dest 来自源码解析而非 DOM 猜测）。
4. **解析与拦截分离**：v1 的 `makeLinkResolver`（dest → 页面/raw 文件 → 绝对路径）与拦截机制无关，原样保留。

### 2.2 保留 / 废弃 / 新增对照

| v1 条目 | v2 处置 | 说明 |
|---|---|---|
| §3.1 服务端 raws+`path`、map+`raws` | ✅ 原样保留 | 无争议 |
| §3.2(a) CSS `.llmw-mdlink` | ✅ 原样保留 | — |
| §3.2(b) `collapsePath` + `makeLinkResolver` | ✅ 原样保留（全文内联） | 解析逻辑与拦截无关 |
| §3.2(c) `decorateAnchor` / walk A 分支改造 | ❌ 废弃 | §1.2 死代码；walk 的 `tag === "A" → continue` 维持原状 |
| §3.2(d) 接线 | 🔧 重写 | 传 `fp.content` 给配对装饰器 |
| §3.2(e) `_internal` 导出 | 🔧 扩充 | 增加 `collectSourceLinks`/`plainify` |
| §3.3 行为规则表 | 🔧 更新 | 见 §3.3 |
| §3.4 版本与 README | ✅ 原样保留 | 1.0.0 → 1.1.0 |
| §4.1 部署步骤 | ✅ 原样保留 | 服务端/客户端两半一起拷 |
| §4.2 生效验证 | 🔧 修正 | 搜 bundle 字符串只能证明部署，不能证明行为（v1 会假阳性） |
| §4.3 单测 | 🔧 扩充 | 交付可执行 `test-mdlink-v2.mjs`（从文档提取代码端到端验证）；用例表见 §4.3 |
| §4.4 GUI 验收 | 🔧 扩充 | 新增"编辑保存后文件字节不变"等检查 |
| （无） | ➕ 新增 | `plainify` / `collectSourceLinks` / `buildTextIndex` / `unwrapMdLinks` / `decorateMarkdownLinks` |

---

## 3. 详细设计

### 3.1 服务端 `lib/index.js`（同 v1 §3.1，原文保留）

**(a) raw 条目补 `path`**（`loadWiki` 内 `raws.push`，现 255 行附近）：

```js
          wiki.raws.push({
            slug: f.name.slice(0, -3),
            rel: 'raw/' + subPrefix + f.name,
            path: root + '/raw/' + subPrefix + f.name,   // ← 新增
            ingested: parsed.meta ? parsed.meta.ingested : undefined,
            shaStored: stored,
            shaActual: createHash('sha256').update(parsed.body).digest('hex'),
          })
```

**(b) map 响应带上 raws**（`mapHandler` 末行，现 453 行）：

```js
    return {
      ok: true, root: wiki.root, exists: true, pages, backlinks,
      raws: wiki.raws.map((r) => ({ rel: r.rel, path: r.path, slug: r.slug })),   // ← 新增
    }
```

### 3.2 客户端 `lib/client.js`

#### (a) CSS（同 v1 §3.2(a)）

在 `.llmw-wlink-miss`（现 80 行）之后插入：

```js
			".llmw-mdlink{color:var(--dsw-alias-brand-primary,#4d6bfe);cursor:pointer;text-decoration:underline;text-decoration-style:dotted;text-underline-offset:2px;}",
			".llmw-mdlink:hover{background:var(--dsw-alias-bg-layer-2,#2c2f35);}",
```

#### (b) `collapsePath` + `makeLinkResolver`（同 v1 §3.2(b)，全文内联以便自包含实施）

落点：`el()` 帮助函数之后（现 86 行附近），与 (c) 相邻。

```js
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
```

#### (c) 新增纯函数：`plainify` + `collectSourceLinks`

落点：`el()` 帮助函数之后（现 86 行附近），与 (b) 相邻。

```js
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
			// [[wikilink]] and never match the preview's joined text).
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
```

设计要点：

- `before`/`after` 是匹配上下文签名（16/6 字符），`plainify` 后与渲染文本对齐（含 wikilink 别名还原——本 wiki 每页都有 `[[wikilink]]`，此步显著提高签名命中率）；
- label 过滤掉含格式化字符者（`[**来源**](x.md)` 不装饰，优雅降级为纯文本）；
- dest 只保留**相对** `.md` 目标——外链本来就渲染成真 `<a>`，无需管；`#锚点` 渲染同样被 MarkdownText 丢弃，但预览没有可跳转的锚点目标，明确出圈。

#### (d) 新增 DOM 层：文本索引 + 配对装饰

落点：`renderBuiltin` 之后、`decorateWikiLinks` 之前（现 121 行附近）。**`decorateWikiLinks` 本体一行不改**（v1 对 A 分支的改动废弃）。

```js
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
						// hidden editor text and starves the visible preview.
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
```

机制说明（为什么这样配对是稳的）：

- **拼接文本对节点切分不敏感**：`^([来源](raw/x.md))` 渲染为文本节点序列 `"^("`、`"来源"`、`")"`，拼接后 `"^(来源)"` 与源码 plainify 形态一致——React/MarkdownText 怎么切节点都无所谓；
- **上下文签名消歧**：正文散文里恰好出现"来源"二字的误配，被"前 16 字符签名 + 锚点后紧跟标签"挡住（签名含 `^(` 时基本唯一命中）；签名匹配是空白模糊的（`\s*`），段落边界丢 `\n`、软换行变空格都不影响命中；
- **上下文从 plainify 后全文切取**：避免窗口切进 `[[wikilink]]` 中间导致签名永远失配（plainify 先把 wikilink 折叠为渲染标签，再切窗口）；
- **包装保持文本不变**：`before + label + after` 三段 replaceChild 后整树 `textContent` 不变，故 `cursor`（拼接文本偏移）在重建索引后依然有效；
- **失败也推进 cursor**：找到了文本但不可安全包装（跨节点/受控容器）时，跳过该位置，防止后续链接回绑同一处；
- **与 wikilink 装饰的顺序**：wikilink **先**跑、mdlink **后**跑——wlink 标签文本要留在拼接文本里，源码签（含 wikilink 别名还原）才能在首轮与 observer 重跑轮次都稳定命中；`buildTextIndex` 只排除 `.llmw-mdlink`（自身产物），纳入 wlink 文本。mdlink label 过滤掉了 `[[`，不会与 wlink span 交叠。

#### (e) `run()` 接线（改现 248-252 行）

```js
				const run = () => {
					if (disposed || !container) return;
					mutating = true;
					try {
						unwrapMdLinks(container);
						decorateWikiLinks(container, map ? bySlug : null, openBySlug);
						if (map) decorateMarkdownLinks(container, sourceLinks, resolveLink, onOpenTarget);
					} catch (e) {} finally { mutating = false; }
				};
```

现有的 late timers（400/1500ms）、MutationObserver、`mutating` 防回环、`[isWiki, mode, fp.path, fp.content, map]` 依赖数组**全部沿用不动**；shiki/Mermaid 异步重建后 observer 触发 run() → unwrap 恢复原始文本 → 重建索引 → 重新配对，行为自愈。

#### (f) `WikiPageViewer` 接线（改现 232-240 行之后）

```js
			const bySlug = {};
			if (map && map.pages) {
				for (const p of map.pages) bySlug[p.slug.toLowerCase()] = p;
			}
			const slug = String(fp.path || "").split("/").pop().replace(/\.md$/i, "").toLowerCase();
			const openBySlug = (target) => {
				const hit = bySlug[String(target).split("#")[0]];
				if (hit) sidebar.openFile(scope, hit.path, hit.title);
			};
			// --- v2 新增 ---
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
```

说明：`wikiRoot`（201 行）、`scope`（199 行）已存在；`map.raws` 由 §3.1 提供，`Array.isArray` 守卫使新旧服务端版本兼容（旧版下 raw 链接不装饰，行为同"未命中不劫持"）。

#### (g) 可测性导出（`exports.apply` 之前）

```js
		exports._internal = { makeLinkResolver, collapsePath, plainify, collectSourceLinks, decorateMarkdownLinks, unwrapMdLinks };
```

### 3.3 解析与拦截规则汇总（v2 版）

| 源文本 | 预览渲染形态 | v2 行为 |
|---|---|---|
| `^([来源](raw/articles/x.md))` | 纯文本 `^(来源)`（无 `<a>`） | 配对成功 → 可点 span → `openFile(<wiki>/raw/articles/x.md)` |
| `[页面](concepts/myth.md)` | 纯文本 | 同上 → `openFile` 打开该页 |
| `../raw/a.md`（自 `concepts/` 页发出） | 纯文本 | resolver 候选(2) 命中 → 打开 |
| `concepts/myth.md#简介` | 纯文本 | dest 剥 `#` 后命中页面 → 打开页面 |
| `[[wikilink]]` | 文本节点 | 现状不变（`decorateWikiLinks` 原样） |
| `https://…` / `mailto:…` | 真 `<a target="_blank">` | 不拦截（浏览器新标签，现状即正确） |
| `raw/not-in-map.md` / 深层 `raw/a/b/c.md` | 纯文本 | resolver 未命中 → **不包装**（不劫持，同 v1 哲学） |
| 围栏/行内码里的 `[a](b.md)` | 字面文本 | 不包装（collectSourceLinks 已 mask） |
| `![说明](raw/assets/x.png)` | `<img>`（better-sidebar 已重写可显示） | 不涉及 |
| `[**来源**](x.md)`（格式化 label） | 渲染为粗体文本 | 不包装（label 过滤，优雅降级） |
| `#anchor` / `/abs/path` | 纯文本 | 不处理——预览无锚点目标，明确出圈（见 §5.6） |

### 3.4 版本与包文档（同 v1 §3.4）

- `package.json`：`"version": "1.0.0" → "1.1.0"`。
- `README.md` Features 加一条：**Clickable provenance & relative `.md` links** — 溯源标记（`^([来源](raw/...))`）与任何站内相对 markdown 链接在预览中可点击，经与目录页相同的 `openFile` 通路打开；不修改源文件、编辑模式零影响。

---

## 4. 部署与验证

### 4.1 部署步骤（同 v1 §4.1）

```bash
S=/home/roy/dsh_work/llm-wiki-migration/formal-package/llm-wiki-sidebar
I=/home/roy/.dsh/profiles/web/llm-wiki-sidebar
node --check $S/lib/client.js && node --check $S/lib/index.js   # 先过语法
cp $S/lib/client.js $S/lib/index.js $I/lib/                      # 安装副本（node_modules 是它的 symlink）
# 服务端与客户端两半一起部署：map.raws 缺失时客户端优雅降级（raw 链接不装饰）
```

生效机制沿用 v1 §P5 结论：bundle 缓存到重启，改完需重启 DSH 服务。

### 4.2 生效验证（修正 v1 §4.2 的假阳性）

1. DevTools → Sources 搜 `data-llmw-mdlink`：**只能证明新 bundle 已被服务**，不能证明行为生效；
2. **必须做 §4.3 GUI 实测**才算验证通过。

### 4.3 单元测试

**已随本方案交付两套可执行测试（与本文件同目录）**：

- `test-mdlink-impl.mjs` —— **实现级（权威）**：以 ModuleLoader stub 直接加载实施后的 `lib/client.js`，对 `exports._internal` 跑同样的断言，另含真实 wiki 页（`concepts/mythopoeia-foundation.md`，5 处溯源链接）冒烟。实施后回归跑这个。
- `test-mdlink-v2.mjs` —— 规格级：从本文档 js 代码块逐函数提取（含 `MDLINK_TAGS` 常量）在迷你 DOM stub 上运行，保证文档与实现不漂移。

- A. `collectSourceLinks`：5 条链接收集、上下文对齐（wikilink 折叠 / 连续标记 / 段落边界 `\n` 保留）
- B. `makeLinkResolver`：页面/raw 解析、外链与未命中返回 null
- C. stub DOM 端到端装饰：5 个 span、标题按文档序、围栏内容不触碰
- D. click → `openFile` 目标正确
- E. 重跑自愈：unwrap → 重包装，无重复嵌套
- F. 散文同名词不劫持（上下文签名胜出，span 落在真实标记段落）

实施后回归：`node test-mdlink-impl.mjs && node test-mdlink-v2.mjs`。新增用例时参照下表：

**A. `collectSourceLinks` 用例表**：

| # | 输入（片段） | 期望 |
|---|---|---|
| 1 | `强化^([来源](raw/articles/a.md))。` | 1 条：`label="来源"`，`dest="raw/articles/a.md"`，`before` 以 `^(` 结尾，`after` 以 `。` 开头 |
| 2 | `[外](https://x.com)` | 0 条（带 scheme） |
| 3 | 围栏代码块内的 `[a](b.md)` | 0 条 |
| 4 | 行内码 `` `[a](b.md)` `` | 0 条 |
| 5 | frontmatter 内 `sources: [raw/a.md]` | 0 条 |
| 6 | `![说明](raw/assets/x.png)` | 0 条（图片） |
| 7 | `[**来源**](b.md)` | 0 条（格式化 label） |
| 8 | `[上页](concepts/myth.md#简介)` | 1 条，dest 含 `#简介` |
| 9 | `…^([来源](a.md))^([来源](b.md))…` 连续两标记 | 2 条且顺序保持；第 2 条 `before` 以 `))^(` 结尾 |
| 10 | 正文含 `见[[worldbuilding]]一章` 后随溯源标记 | `before` 中 wikilink 已折叠为标签文本（先 plainify 后切窗，签名与渲染文本对齐） |
| 11 | `[[]](b.md)` / `[]()` | 0 条（空 label） |
| 12 | 段首标记（`before` 以 `\n` 结尾） | 1 条，`before` 保留 `\n`（空白模糊在配对阶段处理，收集阶段不做归一化） |

**B. `makeLinkResolver` 用例表**：沿用 v1 §4.3 的 8 条（wikiRoot=`/w/wiki/`，pageDir=`/w/wiki/concepts/`），期望不变。

### 4.4 GUI 手动验收清单（在 v1 §4.4 基础上扩充）

- [ ] 打开 `concepts/mythopoeia-foundation.md` → 预览 → 段末「来源」为点状下划线可点样式，悬停提示 `→ raw/articles/…`；
- [ ] 点击后内置查看器打开对应 raw 文件，↩ 可返回原页；
- [ ] `concepts/worldbuilding.md`（4 处）与 `comparisons/process-first-…`（3 处）同样可点；
- [ ] **wikilink（如 `[[worldbuilding]]`）与背链行为不变**（回归项）；
- [ ] 文内外链（如有 https 链接）仍为新标签打开，行为不变；
- [ ] 切编辑模式：**源码仍是原始的 `^([来源](raw/…))` 文本**；Ctrl/Cmd+S 保存后 `sha256sum` 与打开前一致（**零源码污染**——本方案与"源码重写"路线的分界线）；
- [ ] 预览 ↔ 编辑往返多次后，DevTools 检查无嵌套的 `[data-llmw-mdlink]`（重包装防护生效）；
- [ ] CLI `wiki_lint.py` 结果与改动前一致（0 错误）。

---

## 5. 风险与边界

1. **配对是启发式，但有界**：三级降级（完整签名 → 前 8 字符 + 标签 → 标签顺序）。最坏情形是"同页另一处同文出现"被包装成可点——**dest 来自源码解析，指向永远正确**，错的只是可点位置。上下文签名 + 本 wiki `^(` 惯例 + wikilink 别名还原（plainify）把该风险压到极低。
2. **draft 窗口**：TextEditor 的预览渲染"draft 优先于已存内容"（`previewMdText = markdownPreviewSource(mdText)`，draft 胜出）。用户在编辑态打字产生 draft 后切回预览，预览显示 draft 文本而配对用的 `fp.content` 仍是已存内容 → 可能漏配/错位。保存后 `fp.content` 刷新即自愈。影响限于"编辑未保存就切预览看链接"的场景，可接受；后续可观测上游是否暴露 draft 读取口。
3. **上游渲染行为变化**：本方案依赖"相对链接渲染为纯文本标签"这一现状。若未来上游把相对 dest 渲染为真 `<a>`（例如 better-sidebar 在 preview 层补了链接重写），标签文本会进入 A 容器——`buildTextIndex` 跳过 A，装饰自动静默退化为不包装；届时 v1 式的 `<a>` 拦截反而成立，可二选一。两个机制不会打架。
4. **shiki/Mermaid 异步重建**：现有 late timers + MutationObserver + 每轮 unwrap→重建→重包装，行为自愈（沿用现有机制）。
5. **性能**：每次成功包装后重建一次文本索引（页级文本 ≤200K 字符、节点 ≤6000 上限内，O(链接×节点) 最坏 3.6M 步量级，实测页远小于此）。`replaced > 600` / `visited > 6000` 上限沿用现有量级。
6. **明确出圈**：`#锚点` 跳转（预览无锚点目标，需先做 heading id 方案）、绝对站内路径以外资源的预览（如相对 pdf），本期不做。
7. **raw 深层目录盲区**：同 v1（`raw/a/b/c.md` 不进 map → 不拦截），后续可把服务端扫描改递归。
8. **上游化路径（更新）**：better-sidebar 侧的最终修法是在 `markdownPreviewSource` 同层做 **preview-only 的链接重写**（与 frontmatter 隐藏同层、与图片重写同思路，编辑态零污染）。本插件方案可独立生存，亦可作为上游落地前的过渡；上游落地后本装饰器自动退役（见风险 3）。

---

## 6. 与 v1 的关键差异一句话版

> v1 想在 DOM 里拦 `<a>`，但相对链接根本没被渲染成 `<a>`，URL 也没进 DOM——拦截无对象。
> v2 改为：URL 一直在插件手里（`fp.content`），标签文本一直在 DOM 里（渲染后的纯文本节点），
> 按文档顺序配对后用与 `[[wikilink]]` 完全相同的 text-node 包装手法补上可点性。
> 不改源码 → 编辑保存零污染；不看 `<a>` 脸色 → 不依赖上游渲染行为。

## 附录：本次调查涉及的关键位置（2026-09-05 版本）

| 位置 | 内容 |
|---|---|
| `@deepseek-ai/dsh-web-frontend/dist/assets/index-Df-65__b.js` | 模块表 `"@deepseek-ai/dsh-client-ui-primitives": Fp`；导出 `MarkdownText: ic`；`Ku`（URL 白名单）/`Xu`（""→Fragment）——§1.1 证据 |
| `dsh-better-sidebar/lib/client-editor.js`（约 2080298 偏移） | 预览经 `_deepseek_ai_dsh_client_ui_primitives.MarkdownText` 渲染，仅传 text+labels |
| `dsh-better-sidebar/src/client/markdown-images.ts` | 图片源码级重写注释——"so the shared MarkdownText http(s) allowlist accepts them" |
| `dsh-better-sidebar/src/client/markdown-html.ts` | HTML 路径 postProcessSanitized 强制 `target="_blank"`（与 markdown 链接无关） |
| `dsh-better-sidebar/src/client/TextEditor.tsx` 292 / 314 行 | `save()` 写 CM 文档（§1.3 证据）；`previewMdText = markdownPreviewSource(mdText)`（draft 优先、preview-only 变换层） |
| `lib/client.js` 189 行 | `tag === "A" → continue` —— v2 保持原状（v1 的改动废弃） |
| `lib/index.js` 255-261 / 453 | §3.1 两处落点（同 v1） |
| `~/.dsh/profiles/web/` | 安装布局同 v1 §P5（已复核 `diff -r` 一致） |

---

## 7. 实施后修正（v1.1.1，2026-09-05 首轮实测发现）

### 7.1 缺陷：CodeMirror 源码副本污染配对（用户实测 5 处溯源链接仅 3 处可点）

**现象**：`mythopoeia-foundation.md` 预览中前 2 处溯源链接缺失、后 3 处可点。

**根因**（headless Chrome 驱动真实 GUI + 生产 MarkdownText 实测确认）：

1. better-sidebar 的 TextEditor 在 `.llmw-viewerhost` 内**同时**挂载两份文本：隐藏的 CodeMirror
   源码编辑器（`.cm-editor`，含 frontmatter、行号、原始 markdown 全语法、URL）**在前**，渲染后的
   预览（URL 被 MarkdownText 白名单丢弃，标签为纯文本）**在后**。
2. `buildTextIndex` 的拼接文本因此 = **CM 源码副本 + 预览副本**，CM 副本排在前面。配对从 cursor=0
   开始，签名/label-only 全部先命中 CM 副本，把**隐藏编辑器里的"来源"**包掉并消耗 cursor——预览里
   用户可见的标签反而得不到包装。
3. CM 有视口虚拟化：用户窄侧栏只渲染文件前 ~30 行 → #0/#1（L17/L19）的 CM 副本存在（被隐形消费）、
   #2-4（L31-37）的 CM 副本被虚拟化 → 预览副本被包装 → **恰好"2 缺失、3 可点"**。探针高窗口里 CM
   渲染整个文件 → 节点数打爆 `visited > 6000` 上限，walk 死在 CM 内部，join 只剩源码（joinLen≈源文件
   大小）→ 全部不装饰。两个方向的现象由同一根因解释。
4. 附带发现：v1 的 `decorateWikiLinks` 同样行走 CM 副本（隐性缺陷），本次一并修复。

**修复**：`buildTextIndex` 与 `decorateWikiLinks` 的 walk 均跳过 `.cm-editor` 子树（CodeMirror 自身
稳定类名，非 CSS-module 哈希）。装饰只作用于渲染后的预览。

**加固**：`WikiPageViewer` 的 map 拉取从一次性改为 [0, 800, 2400]ms 三次退避重试（失败时
`getMap` 会清掉缓存条目，重试即重新拉取）——消除"首次打开 map 瞬时失败 → 整页无装饰直到重开"的
用户实测现象。

**验证**：实现级测试新增 H 组回归（CM 副本在前 + 预览在后的 DOM 结构，断言 5/5 包装且无一落在
CM 内）；headless GUI 探针复核真实页面 5/5 可见包装。
