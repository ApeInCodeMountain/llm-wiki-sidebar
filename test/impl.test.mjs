// 实现级测试：不经文档提取，直接加载实施后的 lib/client.js（ModuleLoader stub），
// 对 exports._internal 跑与 test-mdlink-v2.mjs 等价的 6 组断言。
import { readFileSync, existsSync } from "node:fs";
import assert from "node:assert";

const src = readFileSync(new URL("../lib/client.js", import.meta.url), "utf8");

let exports_ = null;
const windowStub = {
	__ModuleLoader__: {
		load(def) {
			exports_ = def.factory((name) => {
				if (name === "react") return { createElement: (t, p, ...c) => ({ t, p, c }) };
				throw new Error("unexpected require: " + name);
			});
		},
	},
};
new Function("window", src)(windowStub);
assert.ok(exports_, "factory did not return module.exports");
assert.equal(exports_.inject[0], "betterSidebar", "inject preserved");
const internal = exports_._internal;
for (const k of ["makeLinkResolver", "collapsePath", "plainify", "collectSourceLinks", "decorateMarkdownLinks", "unwrapMdLinks"]) {
	assert.equal(typeof internal[k], "function", "_internal." + k + " exported");
}
const { plainify, collectSourceLinks, makeLinkResolver, decorateMarkdownLinks, unwrapMdLinks } = internal;
console.log("LOAD lib/client.js via ModuleLoader stub — PASS (_internal complete)");

// ---- mini DOM stub (same fidelity as the doc-level test) ----
class Doc {
	createTextNode(v) { return new TextNode(v); }
	createElement(tag) { return new Element(tag); }
	createDocumentFragment() { const f = new Element("#fragment"); f.nodeType = 11; return f; }
}
class TextNode {
	constructor(v) { this.nodeType = 3; this.nodeValue = v; this.parentNode = null; this.parentElement = null; }
	get textContent() { return this.nodeValue; }
	set textContent(v) { this.nodeValue = v; }
}
class Element {
	constructor(tag) {
		this.nodeType = 1; this.tagName = tag.toUpperCase(); this.childNodes = [];
		this.parentNode = null; this.ownerDocument = new Doc();
		this.parentElement = null;
		this._attrs = {}; this._cls = new Set(); this.className = "";
		this._listeners = {};
	}
	set className(v) { this._cls = new Set(String(v).split(/\s+/).filter(Boolean)); }
	get className() { return [...this._cls].join(" "); }
	get classList() { const s = this._cls; return { contains: (c) => s.has(c) }; }
	matches(sel) {
		for (const part of sel.split(",")) {
			const p = part.trim();
			if (p.startsWith(".")) { if (this._cls.has(p.slice(1))) return true; }
			else if (p.startsWith("#")) { if (this._attrs.id === p.slice(1)) return true; }
			else if (this.tagName === p.toUpperCase()) return true;
		}
		return false;
	}
	closest(sel) { let e = this; while (e) { if (e.matches && e.matches(sel)) return e; e = e.parentNode; } return null; }
	contains(n) { for (let e = n; e; e = e.parentNode) if (e === this) return true; return false; }
	setAttribute(k, v) { this._attrs[k] = v; if (k === "class") this.className = v; }
	getAttribute(k) { return this._attrs[k] ?? null; }
	addEventListener(t, f) { (this._listeners[t] ??= []).push(f); }
	click() { for (const f of this._listeners.click ?? []) f({ preventDefault() {}, stopPropagation() {} }); }
	get textContent() { return this.childNodes.map((c) => c.textContent).join(""); }
	set textContent(v) { this.childNodes = [new TextNode(v)]; this.childNodes[0].parentNode = this; }
	appendChild(c) { return this.insertBefore(c, null); }
	insertBefore(c, ref) {
		const kids = c.nodeType === 11 ? [...c.childNodes] : [c];
		for (const k of kids) { k.parentNode = this; k.parentElement = this; }
		const i = ref === null ? this.childNodes.length : this.childNodes.indexOf(ref);
		this.childNodes.splice(i < 0 ? this.childNodes.length : i, 0, ...kids);
		return c;
	}
	replaceChild(nu, old) {
		const i = this.childNodes.indexOf(old);
		if (i < 0) throw new Error("replaceChild: node not a child");
		const kids = nu.nodeType === 11 ? [...nu.childNodes] : [nu];
		this.childNodes.splice(i, 1, ...kids);
		old.parentNode = null;
		for (const k of kids) { k.parentNode = this; k.parentElement = this; } // real DOM: fragment children reparent on insertion
	}
	removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); }
	querySelectorAll(sel) {
		if (sel !== "[data-llmw-mdlink]") throw new Error("stub only supports [data-llmw-mdlink]");
		const out = [];
		(function walk(n) { for (const c of n.childNodes) { if (c.nodeType === 1) { if (c._attrs["data-llmw-mdlink"]) out.push(c); walk(c); } } })(this);
		return out;
	}
}
const doc = new Doc();

// ---- preview DOM mirroring MarkdownText's rendering ----
const P = (kids) => { const p = doc.createElement("p"); for (const k of kids) p.appendChild(k); return p; };
const T = (v) => doc.createTextNode(v);
const wlink = (label) => { const s = doc.createElement("span"); s.className = "llmw-wlink"; s.textContent = label; return s; };

const root = doc.createElement("div");
root.appendChild(P([T("神话要渗入世界而非停留于背景：环境叙事反复强化^("), T("来源"), T(")。")]));
root.appendChild(P([T("相关概念见"), wlink("worldbuilding"), T("一章^"), T("来源"), T("。")]));
{ const pre = doc.createElement("pre"); const code = doc.createElement("code"); code.appendChild(T("[a](b.md)")); pre.appendChild(code); root.appendChild(pre); }
root.appendChild(P([T("连续：^("), T("来源"), T(")^("), T("来源"), T(") 完。")]));
root.appendChild(P([T("前段。")]));
root.appendChild(P([T("^("), T("来源"), T(")继续正文")])); // 段首标记：before 以 "\n^(" 结尾（段落边界）
{ const pre2 = doc.createElement("pre"); pre2.appendChild(T("围栏里也有 来源 字样")); root.appendChild(pre2); }

const content = [
	"神话要渗入世界而非停留于背景：环境叙事反复强化^([来源](raw/articles/gameres-worldview-lego.md))。",
	"相关概念见[[worldbuilding]]一章^[来源](raw/articles/wikipedia-worldbuilding-en.md)。",
	"```",
	"[a](b.md)",
	"```",
	"连续：^([来源](a.md))^([来源](b.md)) 完。",
	"前段。",
	"^([来源](z.md))继续正文",
].join("\n");

const opts = {
	wikiRoot: "/w/wiki/",
	pageDir: "/w/wiki/concepts/",
	pages: [
		{ slug: "a", path: "/w/wiki/entities/a.md", title: "A页" },
		{ slug: "b", path: "/w/wiki/entities/b.md", title: "B页" },
		{ slug: "z", path: "/w/wiki/queries/z.md", title: "Z页" },
	],
	raws: [
		{ rel: "raw/articles/gameres-worldview-lego.md", path: "/w/wiki/raw/articles/gameres-worldview-lego.md" },
		{ rel: "raw/articles/wikipedia-worldbuilding-en.md", path: "/w/wiki/raw/articles/wikipedia-worldbuilding-en.md" },
	],
};
const opened = [];
const resolveLink = makeLinkResolver(opts);
const onOpenTarget = (t) => opened.push(t.path);

// ---- A. collector ----
const links = collectSourceLinks(content);
assert.equal(links.length, 5, "collector: expect 5 links, got " + links.length);
assert.deepEqual(links.map((l) => l.dest), [
	"raw/articles/gameres-worldview-lego.md",
	"raw/articles/wikipedia-worldbuilding-en.md",
	"a.md", "b.md", "z.md",
]);
assert.ok(links[0].before.endsWith("^("));
assert.ok(links[1].before.endsWith("一章^") && links[1].before.includes("worldbuilding"));
assert.ok(links[3].before.endsWith("))^("));
assert.ok(links[4].before.endsWith("\n^("));
console.log("A. collectSourceLinks — PASS");

// ---- B. resolver ----
assert.deepEqual(resolveLink("raw/articles/gameres-worldview-lego.md"), { kind: "file", path: "/w/wiki/raw/articles/gameres-worldview-lego.md", title: "raw/articles/gameres-worldview-lego.md" });
assert.deepEqual(resolveLink("a.md"), { kind: "page", path: "/w/wiki/entities/a.md", title: "A页" });
assert.equal(resolveLink("https://x.com"), null);
assert.equal(resolveLink("raw/not-in-map.md"), null);
assert.equal(plainify("见[[worldbuilding]]一章"), "见worldbuilding一章");
assert.equal(plainify("[[page|别名]]"), "别名");
console.log("B. makeLinkResolver + plainify — PASS");

// ---- C. end-to-end decoration ----
const n = decorateMarkdownLinks(root, links, resolveLink, onOpenTarget);
assert.equal(n, 5, "decorated count, got " + n);
const spans = root.querySelectorAll("[data-llmw-mdlink]");
assert.equal(spans.length, 5, "span count");
assert.deepEqual(spans.map((s) => s.title), [
	"→ raw/articles/gameres-worldview-lego.md",
	"→ raw/articles/wikipedia-worldbuilding-en.md",
	"→ A页", "→ B页", "→ Z页",
]);
for (const s of spans) {
	assert.equal(s.tagName, "SPAN");
	assert.equal(s.textContent, "来源");
	assert.notEqual(s.parentNode.tagName, "PRE");
}
assert.equal(spans[4].parentNode.childNodes[1], spans[4], "fuzzy-boundary label wrapped after '^(' literal");
assert.ok(root.childNodes[2].textContent.includes("[a](b.md)"), "fence text untouched");
console.log("C. end-to-end decoration — PASS");

// ---- D. click behavior ----
spans[0].click();
assert.deepEqual(opened, ["/w/wiki/raw/articles/gameres-worldview-lego.md"]);
spans[3].click();
assert.deepEqual(opened, ["/w/wiki/raw/articles/gameres-worldview-lego.md", "/w/wiki/entities/b.md"]);
console.log("D. click → openFile targets — PASS");

// ---- E. re-run self-healing ----
unwrapMdLinks(root);
assert.equal(root.querySelectorAll("[data-llmw-mdlink]").length, 0);
root.childNodes[0].childNodes[0].nodeValue = "神话要渗入世界而非停留于背景：环境叙事反复强化^(";
const n2 = decorateMarkdownLinks(root, links, resolveLink, onOpenTarget);
assert.equal(n2, 5, "second pass re-wraps all 5, got " + n2);
assert.equal(root.querySelectorAll("[data-llmw-mdlink]").length, 5, "no duplicates after second pass");
console.log("E. re-run self-healing — PASS");

// ---- F. prose disambiguation ----
const root2 = doc.createElement("div");
root2.appendChild(P([T("本章讲述来源的流变，见下。")]));
root2.appendChild(P([T("而来源这个概念最重要。")]));
root2.appendChild(P([T("定论^("), T("来源"), T(")。")]));
const links2 = collectSourceLinks("本章讲述来源的流变，见下。\n而来源这个概念最重要。\n定论^([来源](raw/articles/x.md))。");
assert.equal(links2.length, 1);
const resolveX = (d) => (d === "raw/articles/x.md" ? { kind: "file", path: "/w/wiki/raw/articles/x.md", title: "raw/articles/x.md" } : null);
assert.equal(decorateMarkdownLinks(root2, links2, resolveX, () => {}), 1);
const spans3 = root2.querySelectorAll("[data-llmw-mdlink]");
assert.equal(spans3.length, 1);
assert.equal(spans3[0].parentNode, root2.childNodes[2], "the REAL marker paragraph got the span, not the prose");
console.log("F. prose disambiguation — PASS");

// ---- G. real-wiki smoke: runs only when the author's local wiki is present ----
if (!existsSync("/home/roy/dsh_work/wiki/concepts/mythopoeia-foundation.md")) {
	console.log("G. real-wiki smoke — SKIPPED (local wiki fixture not present)");
} else {
const realPages = [
	["concepts/mythopoeia-foundation.md", "raw/articles/gcores-game-worldview-example.md"],
	["concepts/worldbuilding.md", "raw/articles/gcores-weaving-world-latlon.md"],
];
const wikiRoot = "/home/roy/dsh_work/wiki/";
const realContent = readFileSync(wikiRoot + "concepts/mythopoeia-foundation.md", "utf8");
const realLinks = collectSourceLinks(realContent);
assert.equal(realLinks.length, 5, "real page: 5 provenance links, got " + realLinks.length);
assert.ok(realLinks.every((l) => l.label === "来源" && l.dest.startsWith("raw/articles/")), "all provenance-shaped");
const realResolver = makeLinkResolver({
	wikiRoot,
	pageDir: wikiRoot + "concepts/",
	pages: [{ slug: "mythopoeia-foundation", path: wikiRoot + "concepts/mythopoeia-foundation.md", title: "神话造世" }],
	raws: realLinks.map((l) => ({ rel: l.dest, path: wikiRoot + l.dest })),
});
assert.equal(realResolver("raw/articles/gcores-game-worldview-example.md").kind, "file");
assert.equal(realResolver("raw/articles/gcores-game-worldview-example.md").path, wikiRoot + "raw/articles/gcores-game-worldview-example.md");
console.log("G. real-wiki smoke (mythopoeia-foundation.md) — PASS");
}

// ---- H. regression: CodeMirror source copy must never carry decorations ----
// Real structure: .llmw-viewerhost hosts the HIDDEN CodeMirror source (raw
// markdown with frontmatter/line-numbers/URLs) BEFORE the rendered preview.
// The pairing must bind the PREVIEW labels only — never the editor copy.
const cmRoot = doc.createElement("div");
cmRoot.className = "cm-editor";
const cmContent = doc.createElement("div");
cmContent.className = "cm-content";
cmRoot.appendChild(cmContent);
cmContent.appendChild(T("---\ntitle: 神话奠基法\n---\n1 《死亡搁浅》有埃及神话的影子^([来源](raw/articles/gcores-game-worldview-example.md))。"));
cmContent.appendChild(T("2 托尔金（他称之为\"次创造 Sub-Creation\"）^([来源](raw/articles/wikipedia-worldbuilding-en.md))。"));
cmContent.appendChild(T("31 反复强化^([来源](raw/articles/gameres-worldview-lego.md))。"));
cmContent.appendChild(T("36 神话只解释\"例外\"的来源^([来源](raw/articles/wikipedia-worldbuilding-en.md))。"));
cmContent.appendChild(T("37 天然伏笔^([来源](raw/articles/gameres-worldview-lego.md))。"));
const host3 = doc.createElement("div");
host3.appendChild(cmRoot); // editor copy FIRST — the DOM-order pollution vector
const preview3 = doc.createElement("div");
host3.appendChild(preview3);
preview3.appendChild(P([T("神话要渗入世界而非停留于背景：改用开场 CG、神庙建筑语言等**环境叙事**反复强化^("), T("来源"), T(")。")]));
preview3.appendChild(P([T("《死亡搁浅》有埃及神话的影子^("), T("来源"), T(")。")]));
preview3.appendChild(P([T("托尔金（他称之为\"次创造 Sub-Creation\"）^("), T("来源"), T(")。")]));
preview3.appendChild(P([T("与世界默认按现实规律运作，神话只解释\"例外\"的来源^("), T("来源"), T(")。")]));
preview3.appendChild(P([T("神话史天然充当\"史诗方块\"：神仙打架式的历史事件是换地图与续作的天然伏笔^("), T("来源"), T(")。")]));
const links3 = collectSourceLinks(content);
const n4 = decorateMarkdownLinks(host3, links3, resolveLink, () => {});
assert.equal(n4, 5, "regression: preview labels wrapped, got " + n4);
const spans4 = [...host3.querySelectorAll("[data-llmw-mdlink]")];
assert.equal(spans4.length, 5, "exactly 5 spans");
assert.ok(spans4.every((s) => !s.parentElement.closest(".cm-editor")), "no span inside the CodeMirror copy");
assert.ok(spans4.every((s) => preview3.contains(s)), "all spans in the preview");
console.log("H. CodeMirror copy excluded — PASS (preview wrapped, editor untouched)");

console.log("\nALL IMPLEMENTATION TESTS PASSED ✅ (lib/client.js + lib/index.js contract)");
