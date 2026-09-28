// Implementation tests for the DeepSeek-Harness-native sidebar build.
//
// Loads the built lib/client.js through a ModuleLoader stub (no browser) and
// exercises the pure surface plus the markdown pipeline. The plugin no longer
// touches another plugin's DOM: wiki pages are rendered by markdown-it with a
// `[[wikilink]]` rule, and navigation is a resource open, so the old
// decoration/pairing tests are replaced by rendering and address tests.
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
assert.deepEqual(
	exports_.inject,
	["slots", "locale", "sidebarRightTabs", "remote", "remote.workspaceFiles"],
	"cordis service injection",
);
const internal = exports_._internal;
for (const k of [
	"collapsePath", "makeLinkResolver", "pickWikiRoot",
	"parseFileAddress", "sessionFileAddress", "isWikiMdPath", "warmWikiRoots",
	"makeWikiTargetResolver", "parseFrontmatter", "slugify", "splitFragment",
	"findHeading", "getMd",
]) {
	assert.equal(typeof internal[k], "function", "_internal." + k + " exported");
}
const {
	makeLinkResolver, pickWikiRoot, parseFileAddress, sessionFileAddress,
	isWikiMdPath, warmWikiRoots, makeWikiTargetResolver, parseFrontmatter,
	slugify, splitFragment, findHeading, getMd,
} = internal;
console.log("LOAD lib/client.js via ModuleLoader stub — PASS (_internal complete)");

// ---- A. file addresses: grammar, encoding, round trip ----
{
	const addr = sessionFileAddress("s-1", "/home/roy/dsh_work/wiki/concepts/a b.md");
	assert.equal(addr, "dsh-resource://file/session/s-1//home/roy/dsh_work/wiki/concepts/a%20b.md");
	assert.deepEqual(parseFileAddress(addr), {
		scope: "session", sessionId: "s-1", path: "/home/roy/dsh_work/wiki/concepts/a b.md",
	});
	assert.deepEqual(parseFileAddress("dsh-resource://file/session/s1/wiki2/entities/x.md"), {
		scope: "session", sessionId: "s1", path: "wiki2/entities/x.md",
	});
	assert.deepEqual(parseFileAddress("dsh-resource://file/absolute/home/ys/notes.txt"), {
		scope: "absolute", path: "/home/ys/notes.txt",
	});
	// `#` and `?` in a filename survive the round trip
	const odd = sessionFileAddress("s", "wiki/concepts/a#b?c.md");
	assert.equal(parseFileAddress(odd).path, "wiki/concepts/a#b?c.md");
	assert.equal(parseFileAddress("https://example.com/x.md"), null);
	assert.equal(parseFileAddress("dsh-resource://other/session/s/x.md"), null);
	console.log("A. file address grammar + encoding — PASS");
}

// ---- B. resource-type routing: only wiki markdown is claimed ----
{
	assert.equal(isWikiMdPath("wiki/concepts/a.md"), true, "default wiki, relative");
	assert.equal(isWikiMdPath("/home/roy/dsh_work/wiki2/entities/a.md"), true, "sibling wiki, absolute");
	assert.equal(isWikiMdPath("/home/roy/dsh_work/kb/research/x.md"), false, "unknown custom root before warming");
	warmWikiRoots([{ root: "/home/roy/dsh_work/kb/research" }]);
	assert.equal(isWikiMdPath("/home/roy/dsh_work/kb/research/x.md"), true, "custom root after warming");
	assert.equal(isWikiMdPath("/home/roy/dsh_work/docs/README.md"), false, "ordinary markdown stays native");
	assert.equal(isWikiMdPath("wiki/concepts/a.txt"), false, "only markdown");
	assert.equal(isWikiMdPath("wiki/concepts/a.md.bak"), false, "suffix match is exact");
	console.log("B. isWikiMdPath routing — PASS");
}

// ---- C. [[wikilink]] resolution against the wiki map ----
{
	const map = {
		pages: [
			{ slug: "worldbuilding", path: "/w/wiki/concepts/worldbuilding.md", title: "世界构建" },
			{ slug: "a", path: "/w/wiki/entities/a.md", title: "A页" },
		],
		raws: [{ rel: "raw/articles/x.md", path: "/w/wiki/raw/articles/x.md" }],
	};
	const resolve = makeWikiTargetResolver(map, "/w/wiki/");
	assert.deepEqual(resolve("worldbuilding"), { kind: "page", path: "/w/wiki/concepts/worldbuilding.md", title: "世界构建" });
	assert.deepEqual(resolve("concepts/worldbuilding"), { kind: "page", path: "/w/wiki/concepts/worldbuilding.md", title: "世界构建" });
	assert.deepEqual(resolve("entities/a.md"), { kind: "page", path: "/w/wiki/entities/a.md", title: "A页" });
	assert.deepEqual(resolve("worldbuilding#段落"), { kind: "page", path: "/w/wiki/concepts/worldbuilding.md", title: "世界构建" });
	assert.deepEqual(resolve("raw/articles/x.md"), { kind: "file", path: "/w/wiki/raw/articles/x.md", title: "raw/articles/x.md" });
	assert.equal(resolve("nope"), null);
	console.log("C. makeWikiTargetResolver — PASS");
}

// ---- D. markdown pipeline: wikilinks, code masking, embeds, images ----
{
	const md = getMd();
	const api = {
		resolve: (target) => (String(target).split("#")[0] === "x" ? { path: "/w/wiki/x.md", title: "X页" } : null),
		imageUrl: (dest) => (dest === "raw/img/a.png" ? "MEDIA(raw/img/a.png)" : undefined),
	};
	const html = md.render([
		"见 [[x]]、[[x|别名]] 与 [[missing]]。",
		"",
		"行内 `[[x]]` 不链接。",
		"",
		"```",
		"[[x]]",
		"```",
		"",
		"![[embed]] 保持字面量。",
		"",
		"![alt](raw/img/a.png)",
		"",
		"![remote](https://example.com/a.png)",
	].join("\n"), { llmwiki: api });
	assert.ok(html.includes('data-llmwiki="x"') === false && html.includes('data-llmw-wiki="x"'), "resolved wikilink is an anchor");
	assert.ok(html.includes(">别名</a>"), "alias label rendered");
	assert.ok(html.includes("llmw-wlink-miss"), "unresolved wikilink marked");
	assert.ok(html.includes("<code>[[x]]</code>"), "inline code untouched");
	assert.ok(html.includes("[[x]]\n</code>"), "fenced code untouched");
	assert.ok(html.includes("![[embed]]"), "embed left literal");
	assert.ok(html.includes('src="MEDIA(raw/img/a.png)"'), "local image rewritten");
	assert.ok(html.includes('src="https://example.com/a.png"'), "remote image untouched");
	assert.ok(!html.includes("<script"), "raw HTML never enters the DOM");
	// `[[page#section]]` labels the page, not the fragment; the fragment still reaches the click handler.
	const anchorHtml = md.renderInline("[[x#某节]]", { llmwiki: api });
	assert.ok(anchorHtml.includes('data-llmw-wiki="x#某节"'), "fragment kept in the target");
	assert.ok(anchorHtml.includes(">x</a>"), "fragment stripped from the label");
	// Labels are escaped, so markdown-it-wikilinks' raw-HTML interpolation cannot happen here.
	assert.ok(md.renderInline("[[x|<img src=x onerror=alert(1)>]]", { llmwiki: api }).includes("&lt;img"), "labels are escaped");
	// `[[#section]]` is an in-page anchor: it never goes through resolution.
	const selfAnchor = md.renderInline("[[#某节]]", { llmwiki: api });
	assert.ok(selfAnchor.includes('data-llmw-frag="某节"'), "self anchor carries the fragment");
	assert.ok(selfAnchor.includes(">某节</a>"), "self anchor labels the fragment");
	assert.ok(!selfAnchor.includes("llmw-wlink-miss"), "self anchor is not a broken link");
	console.log("D. markdown-it + wikilink rule — PASS");
}

// ---- E. frontmatter split ----
{
	const parsed = parseFrontmatter("---\ntitle: 神话\ntags: [a, b]\ncontested: true\n---\n正文 [[x]]\n");
	assert.equal(parsed.meta.title, "神话");
	assert.deepEqual(parsed.meta.tags, ["a", "b"]);
	assert.equal(parsed.meta.contested, true);
	assert.equal(parsed.body, "正文 [[x]]\n");
	assert.equal(parseFrontmatter("no frontmatter").meta, null);
	console.log("E. parseFrontmatter — PASS");
}

// ---- F. multi-wiki: host-side wiki-root resolution (lib/wiki-root.js) ----
{
	const { resolveWikiRoot } = await import("../lib/wiki-root.js");
	const ok = [
		["/w", undefined, "/w/wiki"],
		["/w", "", "/w/wiki"],
		["/w", "wiki-game", "/w/wiki-game"],
		["/w", "kb/research", "/w/kb/research"],
		["/w", "/w/wiki-game/", "/w/wiki-game"],
		["/w", "a/../wiki2", "/w/wiki2"],
	];
	for (const [cwd, wiki, want] of ok) {
		assert.equal(resolveWikiRoot(cwd, wiki), want, "resolveWikiRoot(" + JSON.stringify(cwd) + ", " + String(wiki) + ")");
	}
	const bad = [
		["/w", "../escape"], ["/w", "/etc"], ["/w", "file:///etc"],
		["", "wiki"], ["/w", "."], ["/w", "a/../../out"], ["/w", 42],
	];
	for (const [cwd, wiki] of bad) {
		assert.throws(() => resolveWikiRoot(cwd, wiki), "expected refusal: " + String(wiki));
	}
	console.log("F. resolveWikiRoot (default/relative/absolute + workspace containment) — PASS");
}

// ---- G. multi-wiki: pickWikiRoot longest-prefix ownership ----
{
	const wikis = [
		{ root: "/w/wiki", name: "wiki" },
		{ root: "/w/wiki-game", name: "wiki-game" },
	];
	assert.equal(pickWikiRoot("/w/wiki-game/entities/a.md", wikis, "/w/wiki/"), "/w/wiki-game/", "sibling wiki wins");
	assert.equal(pickWikiRoot("/w/wiki/concepts/b.md", wikis, null), "/w/wiki/", "default wiki matches");
	assert.equal(pickWikiRoot("/w/other/x.md", wikis, "/w/wiki/"), "/w/wiki/", "non-wiki file falls back to the legacy root");
	assert.equal(pickWikiRoot("/w/wiki-game/raw/r.md", null, "/w/wiki/"), "/w/wiki/", "registry unavailable → v1 fallback");
	assert.equal(pickWikiRoot("/w/wiki-extra/x.md", [{ root: "/w/wiki" }], null), null, "prefix boundary: 'wiki' must not own 'wiki-extra/…'");
	assert.equal(pickWikiRoot("/w/wiki-game/a.md", [{ root: "/w/wiki-game" }, { root: "/w" }], null), "/w/wiki-game/", "longest prefix wins");
	console.log("G. pickWikiRoot longest-prefix ownership — PASS");
}

// ---- H. multi-wiki: resolver generalizes the wiki-dir strip ----
{
	const gResolve = makeLinkResolver({
		wikiRoot: "/w/wiki-game/",
		pageDir: "/w/wiki-game/concepts/",
		pages: [{ slug: "a", path: "/w/wiki-game/entities/a.md", title: "A页" }],
		raws: [{ rel: "raw/articles/g.md", path: "/w/wiki-game/raw/articles/g.md" }],
	});
	assert.deepEqual(gResolve("raw/articles/g.md"), { kind: "file", path: "/w/wiki-game/raw/articles/g.md", title: "raw/articles/g.md" }, "plain relative");
	assert.deepEqual(gResolve("a.md"), { kind: "page", path: "/w/wiki-game/entities/a.md", title: "A页" }, "stem match");
	assert.deepEqual(gResolve("/wiki-game/entities/a.md"), { kind: "page", path: "/w/wiki-game/entities/a.md", title: "A页" }, "site-absolute, non-wiki basename");
	assert.deepEqual(gResolve("wiki-game/entities/a.md"), { kind: "page", path: "/w/wiki-game/entities/a.md", title: "A页" }, "root-relative, non-wiki basename");
	const wResolve = makeLinkResolver({
		wikiRoot: "/w/wiki/",
		pageDir: "/w/wiki/concepts/",
		pages: [
			{ slug: "a", path: "/w/wiki/entities/a.md", title: "A页" },
			{ slug: "z", path: "/w/wiki/queries/z.md", title: "Z页" },
		],
		raws: [
			{ rel: "raw/articles/gameres-worldview-lego.md", path: "/w/wiki/raw/articles/gameres-worldview-lego.md" },
			{ rel: "raw/articles/wikipedia-worldbuilding-en.md", path: "/w/wiki/raw/articles/wikipedia-worldbuilding-en.md" },
		],
	});
	assert.deepEqual(wResolve("/wiki/queries/z.md"), { kind: "page", path: "/w/wiki/queries/z.md", title: "Z页" }, "site-absolute, default basename");
	assert.deepEqual(wResolve("wiki/queries/z.md"), { kind: "page", path: "/w/wiki/queries/z.md", title: "Z页" }, "root-relative, default basename");
	assert.equal(gResolve("/wiki/raw/articles/g.md"), null, "default-wiki site-absolute is not stripped inside wiki-game");
	console.log("H. makeLinkResolver generalized wiki-dir stripping — PASS");
}

// ---- I. real-wiki smoke: runs only when the author's local wiki is present ----
if (!existsSync("/home/roy/dsh_work/wiki/concepts/mythopoeia-foundation.md")) {
	console.log("I. real-wiki smoke — SKIPPED (local wiki fixture not present)");
} else {
	const wikiRoot = "/home/roy/dsh_work/wiki/";
	const realContent = readFileSync(wikiRoot + "concepts/mythopoeia-foundation.md", "utf8");
	const parsed = parseFrontmatter(realContent);
	assert.ok(parsed.meta && parsed.meta.title, "frontmatter parsed");
	const resolve = makeWikiTargetResolver({
		pages: [{ slug: "mythopoeia-foundation", path: wikiRoot + "concepts/mythopoeia-foundation.md", title: "神话造世" }],
		raws: parsed.meta.sources.map ? parsed.meta.sources.map((rel) => ({ rel, path: wikiRoot + rel })) : [],
	}, wikiRoot);
	const html = getMd().render(parsed.body, { llmwiki: { resolve, imageUrl: () => undefined } });
	assert.ok(html.includes("raw/articles/"), "provenance .md links survive rendering");
	assert.ok(html.includes("href="), "links are real anchors");
	console.log("I. real-wiki smoke (mythopoeia-foundation.md) — PASS");
}

// ---- J. plugin contract: apply() + first render, against a stubbed context ----
// Catches the failure modes a browser would otherwise show as a blank slot:
// a throwing apply(), a definition the sidebar rejects, or a component that
// dereferences a missing prop on its first render.
{
	let hookIndex = 0;
	const hookStore = [];
	const ReactStub = {
		createElement: (type, props, ...children) => ({ type, props, children }),
		useState(initial) {
			const at = hookIndex++;
			if (!(at in hookStore)) hookStore[at] = typeof initial === "function" ? initial() : initial;
			const set = (value) => { hookStore[at] = typeof value === "function" ? value(hookStore[at]) : value; };
			return [hookStore[at], set];
		},
		useEffect() {},
		useMemo(factory) { hookIndex++; return factory(); },
		useCallback(fn) { hookIndex++; return fn; },
		useRef(value) { hookIndex++; return { current: value }; },
	};
	let exports2 = null;
	const documentStub = {
		baseURI: "http://127.0.0.1:3080/",
		head: { appendChild() {} },
		createElement: () => ({ setAttribute() {}, remove() {}, textContent: "" }),
	};
	new Function("window", "document", src)(
		{
			__ModuleLoader__: {
				load(def) {
					exports2 = def.factory((name) => {
						if (name === "react") return ReactStub;
						throw new Error("unexpected require: " + name);
					});
				},
			},
		},
		documentStub,
	);

	const types = [], slotRegs = [], locales = [];
	const ctx = {
		effect(fn) { const dispose = fn(); assert.equal(typeof dispose, "function", "effect returns a disposer"); return () => {}; },
		locale: {
			bind: (ns) => (key) => ns + ":" + key,
			register: (ns, dicts) => { locales.push({ ns, dicts }); return () => {}; },
		},
		sidebarRightTabs: {
			register(definition) { types.push(definition); return () => {}; },
		},
		slots: {
			inject(key, callback) { assert.ok(key, "slots.inject needs an owner key"); callback(); return () => {}; },
			register(options, Body) { slotRegs.push({ options, Body }); return () => {}; },
		},
		remote: {
			workspaceFiles: {
				read: async () => ({
					ok: true,
					value: {
						absolutePath: "/w/wiki/concepts/a.md", version: "v1", offset: 1,
						text: "---\ntitle: A\n---\n# A\n\n[[worldbuilding]]\n", lines: 5, eof: true,
					},
				}),
			},
		},
	};
	exports2.apply(ctx);

	assert.equal(types.length, 2, "two tab types registered");
	const browse = types.find((d) => d.kind === "llm-wiki");
	const page = types.find((d) => d.kind === "llm-wiki-page");
	assert.ok(browse && typeof browse.title === "function", "browse type");
	assert.ok(Array.isArray(browse.guide) && browse.guide.length === 1, "browse contributes one guide entry");
	assert.equal(page.priority, "extension");
	assert.deepEqual(page.patterns, ["dsh-resource://file/**"]);
	assert.equal(page.canOpen("dsh-resource://file/session/s/wiki/concepts/a.md"), true, "claims wiki markdown");
	assert.equal(page.canOpen("dsh-resource://file/session/s/docs/README.md"), false, "leaves ordinary markdown native");
	assert.equal(page.canOpen("dsh-resource://file/absolute/home/x/wiki/a.md"), false, "never claims a session-less address");
	assert.equal(page.canOpen("dsh-resource://file/session/s/wiki/notes.txt"), false, "only markdown");
	assert.ok(typeof page.title("dsh-resource://file/session/s/wiki/concepts/a.md") === "string", "page chip title");

	assert.equal(slotRegs.length, 2, "two bodies registered");
	for (const reg of slotRegs) {
		assert.equal(reg.options.name, "sidebar.right.pane.tab");
		assert.ok(reg.options.key === browse.id || reg.options.key === page.id, "body key matches a definition id");
		assert.equal(reg.options.locale, "llmWiki");
	}
	assert.equal(locales.length, 1, "one locale namespace registered");
	assert.ok(locales[0].dicts.en && locales[0].dicts.zh, "en + zh dictionaries");

	const actions = { openResource() {}, bindCommands() { return () => {}; } };
	const tabInfo = { useTabInfo: () => ({ tab: { contentId: "dsh-resource://file/session/s/wiki/concepts/a.md", actions } }) };
	const common = {
		t: (key) => key,
		sessionId: "s",
		useSessions: (select) => select({ byId: { s: { cwd: "/w" } } }),
		useResource: () => ({ value: { absolutePath: "/w/wiki/concepts/a.md" } }),
		...tabInfo,
	};
	for (const reg of slotRegs) {
		hookIndex = 0;
		const tree = reg.Body(common);
		assert.ok(tree && typeof tree === "object", "body " + reg.options.key + " renders an element");
	}
	console.log("J. apply() contract + first render (stubbed context) — PASS");
}

// ---- K. heading fragments: split, slug, and heading lookup ----
{
	assert.deepEqual(splitFragment("page#Signs and symptoms"), { key: "page", fragment: "Signs and symptoms" });
	assert.deepEqual(splitFragment("#某节"), { key: "", fragment: "某节" });
	assert.deepEqual(splitFragment("page"), { key: "page", fragment: "" });
	assert.deepEqual(splitFragment("  page  "), { key: "page", fragment: "" });

	assert.equal(slugify("Signs and symptoms"), "signs-and-symptoms");
	assert.equal(slugify("  C++ 入门  "), "c-入门");
	assert.equal(slugify("神话造世（Foundation）"), "神话造世foundation");
	assert.equal(slugify("a--b"), "a-b");
	assert.equal(slugify("!!!"), "");

	// findHeading only needs querySelectorAll + textContent, so a plain list works.
	const heading = (text) => ({ textContent: text });
	const container = {
		querySelectorAll: () => [
			heading("世界构建"),
			heading("Signs and symptoms"),
			heading("神话造世（Foundation）"),
			heading("重复"),
			heading("重复"),
		],
	};
	assert.equal(findHeading(container, "Signs and symptoms").textContent, "Signs and symptoms", "exact text wins");
	assert.equal(findHeading(container, "signs-and-symptoms").textContent, "Signs and symptoms", "slug match");
	assert.equal(findHeading(container, "神话造世foundation").textContent, "神话造世（Foundation）", "CJK + parentheses slug");
	assert.equal(findHeading(container, "世界构建").textContent, "世界构建", "CJK exact");
	assert.equal(findHeading(container, "重复").textContent, "重复", "first duplicate wins");
	assert.equal(findHeading(container, "nope"), null, "missing fragment");
	assert.equal(findHeading(container, ""), null, "empty fragment");
	assert.equal(findHeading(null, "x"), null, "no container");
	console.log("K. heading fragment split/slug/lookup — PASS");
}

console.log("\nALL IMPLEMENTATION TESTS PASSED ✅ (lib/client.js + lib/index.js contract)");
