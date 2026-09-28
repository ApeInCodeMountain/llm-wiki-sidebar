// llm-wiki-sidebar — pure wiki-root resolution (shared by lib/index.js and tests)
//
// The plugin originally hard-coded exactly one wiki per session workspace
// (`<cwd>/wiki`). Multi-wiki support generalizes that to any directory inside
// the session workspace. This module is dependency-free on purpose: it must be
// importable from a bare `node test/impl.test.mjs` run and stay free of host
// service assumptions; everything here is pure string handling.
//
// The containment rule is the security boundary's second layer (the first is
// the sandbox-aware `fs` service): a wiki root may only ever resolve to a
// directory INSIDE the session workspace, never to a sibling, a parent, or an
// unrelated absolute path.

// Collapse '.'/'..' segments. A leading '' segment (absolute marker) is kept;
// a LEADING '..' (empty stack) is silently dropped — the same quirk as the
// client half's collapsePath. Harmless here because the containment check in
// resolveWikiRoot() runs on the COLLAPSED result.
export function collapsePath(p) {
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
 * Resolve the wiki root for a request.
 * - `wiki` missing/empty   → `<cwd>/wiki` (v1 behavior, fully backward compatible)
 * - relative ("wiki-game", "kb/research") → joined onto `<cwd>`
 * - absolute ("/abs/path") → kept as-is
 * - scheme urls (file://, http://), the workspace root itself, and any path
 *   escaping `<cwd>` are refused with an Error carrying a user-facing message.
 */
export function resolveWikiRoot(cwd, wiki) {
	const base = String(cwd || "").replace(/\/+$/, "").replace(/\\/g, "/");
	if (!base) throw new Error("missing session cwd");
	let root;
	if (wiki === undefined || wiki === null || String(wiki).trim() === "") {
		root = base + "/wiki";
	} else {
		if (typeof wiki !== "string") throw new Error("invalid wiki root: not a string");
		const w = wiki.trim().replace(/\\/g, "/").replace(/\/+$/, "");
		if (w === "") {
			root = base + "/wiki";
		} else {
			if (/^[a-z][a-z0-9+.\-]*:/i.test(w)) throw new Error("invalid wiki root: scheme urls are not supported");
			root = w.charAt(0) === "/" ? collapsePath(w) : collapsePath(base + "/" + w);
		}
	}
	if (root === base || root.indexOf(base + "/") !== 0) {
		throw new Error("wiki root must be a directory inside the session workspace, got: " + (root || "(empty)"));
	}
	return root;
}
