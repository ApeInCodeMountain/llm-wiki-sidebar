// Host-half tests: load lib/index.js against a real-filesystem-backed `fs`
// service stub, capture the routes it registers, and call them. This is where
// multi-wiki discovery lives, so the sibling-directory cases are covered with
// the author's real workspace shape (wiki/ + wiki2/).
import { readFile, readdir, stat as statPath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import assert from "node:assert";

const fsStub = {
	async resolve(path) {
		return { targetKey: "k:" + path, displayPath: String(path) };
	},
	async stat(target) {
		try {
			const info = await statPath(target.displayPath);
			return {
				version: "v1",
				type: info.isDirectory() ? "directory" : info.isFile() ? "file" : "other",
				size: info.size,
			};
		} catch (e) {
			return undefined;
		}
	},
	async listDir(target) {
		const entries = await readdir(target.displayPath, { withFileTypes: true });
		return entries.map((entry) => ({
			name: entry.name,
			type: entry.isDirectory() ? "directory" : entry.isFile() ? "file" : "other",
			target: {
				targetKey: "k:" + target.displayPath + "/" + entry.name,
				displayPath: target.displayPath + "/" + entry.name,
			},
		}));
	},
	async readText(target) {
		return readFile(target.displayPath, "utf8");
	},
};

const routes = new Map();
const ctx = {
	fs: fsStub,
	webServer: {
		register(route) { routes.set(route.path, route.handler); return () => {}; },
	},
	get() { return undefined; },
	effect(fn) { fn(); return () => {}; },
};

const { apply } = await import("../lib/index.js");
apply(ctx, {});

function call(path, body) {
	const handler = routes.get(path);
	assert.ok(handler, "route registered: " + path);
	return new Promise((resolve, reject) => {
		const req = {
			method: "POST",
			headers: { host: "127.0.0.1:3080" },
			async *[Symbol.asyncIterator]() { yield JSON.stringify(body); },
		};
		const res = {
			statusCode: 0,
			writeHead() {},
			end(text) { resolve(JSON.parse(text)); },
		};
		Promise.resolve(handler(req, res)).catch(reject);
	});
}

// ---- A. route surface ----
for (const method of ["wikis", "scan", "lint", "map"]) {
	assert.ok(routes.has("/llm-wiki/api/" + method), "route /llm-wiki/api/" + method);
}
console.log("A. host route surface — PASS");

// ---- B. synthetic workspace: default wiki + a sibling wiki + a non-wiki dir ----
const root = join(tmpdir(), "llmwiki-host-test-" + process.pid);
await rm(root, { recursive: true, force: true });
async function seedWiki(dir, slug) {
	await mkdir(join(dir, "concepts"), { recursive: true });
	await mkdir(join(dir, "raw", "articles"), { recursive: true });
	await writeFile(join(dir, "SCHEMA.md"), "# Schema\n\n## Tag taxonomy\n\n- topic\n");
	await writeFile(join(dir, "index.md"), "# Index\n\n- [[" + slug + "]]\n");
	await writeFile(join(dir, "log.md"), "## [2026-01-01] create\n");
	await writeFile(join(dir, "concepts", slug + ".md"), [
		"---",
		"title: " + slug,
		"created: 2026-01-01",
		"updated: 2026-01-01",
		"type: concept",
		"tags: [topic]",
		"sources: [raw/articles/src.md]",
		"---",
		"# " + slug,
		"",
		"Body of [[" + slug + "]].",
		"",
	].join("\n"));
	await writeFile(join(dir, "raw", "articles", "src.md"), "---\ningested: 2026-01-01\n---\nsource\n");
}
await seedWiki(join(root, "wiki"), "alpha");
await seedWiki(join(root, "wiki2"), "beta");
await seedWiki(join(root, "kb", "research"), "gamma");
await mkdir(join(root, "src"), { recursive: true });
await writeFile(join(root, "src", "index.md"), "# not a wiki\n");

{
	const res = await call("/llm-wiki/api/wikis", { cwd: root });
	assert.equal(res.ok, true);
	const roots = res.wikis.map((w) => w.root).sort();
	assert.ok(roots.includes(join(root, "wiki")), "default wiki listed");
	assert.ok(roots.includes(join(root, "wiki2")), "sibling wiki auto-discovered");
	assert.ok(!roots.includes(join(root, "kb", "research")), "depth-2 wikis need explicit wikiRoots, not discovery");
	assert.ok(!roots.includes(join(root, "src")), "a directory with index.md but no section dir is not a wiki");
	const byRoot = Object.fromEntries(res.wikis.map((w) => [w.root, w]));
	assert.equal(byRoot[join(root, "wiki")].source, "default");
	assert.equal(byRoot[join(root, "wiki2")].source, "discovered");
	console.log("B. wikis: default + depth-1 sibling discovery — PASS");
}

// ---- C. plugin-config roots are listed even before they exist, and excluded names are skipped ----
{
	routes.clear();
	const ctx2 = {
		fs: fsStub,
		webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
		get() { return undefined; },
		effect(fn) { fn(); return () => {}; },
	};
	const mod = await import("../lib/index.js");
	mod.apply(ctx2, { wikiRoots: ["kb/research", "not-created-yet"], exclude: ["wiki2"] });
	const res = await call("/llm-wiki/api/wikis", { cwd: root });
	const roots = res.wikis.map((w) => w.root);
	assert.ok(roots.includes(join(root, "kb", "research")), "config root listed");
	assert.ok(roots.includes(join(root, "not-created-yet")), "config root listed before it exists");
	assert.equal(res.wikis.find((w) => w.root === join(root, "not-created-yet")).exists, false, "missing root flagged");
	assert.ok(!roots.includes(join(root, "wiki2")), "excluded basename skipped during discovery");
	console.log("C. config roots + exclude — PASS");
}

// ---- D. scan/lint/map read a discovered wiki ----
{
	routes.clear();
	const ctx3 = {
		fs: fsStub,
		webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; } },
		get() { return undefined; },
		effect(fn) { fn(); return () => {}; },
	};
	const mod = await import("../lib/index.js");
	mod.apply(ctx3, {});
	const wiki = join(root, "wiki2");
	const scan = await call("/llm-wiki/api/scan", { cwd: root, wiki });
	assert.equal(scan.ok, true);
	assert.equal(scan.exists, true);
	assert.deepEqual(scan.sections.concepts.map((p) => p.slug), ["beta"]);
	const lint = await call("/llm-wiki/api/lint", { cwd: root, wiki });
	assert.equal(lint.ok, true);
	const map = await call("/llm-wiki/api/map", { cwd: root, wiki });
	assert.equal(map.ok, true);
	assert.deepEqual(map.pages.map((p) => p.slug), ["beta"]);
	console.log("D. scan/lint/map on a discovered wiki — PASS");
}

// ---- E. workspace containment still refuses an escaping root ----
{
	const res = await call("/llm-wiki/api/scan", { cwd: root, wiki: "../outside" });
	assert.equal(res.ok, false, "escaping wiki root refused");
	console.log("E. workspace containment — PASS");
}

// ---- F. browser-trust fence: loopback / configured trustedHosts / bind IP, and the refusals ----
// Regression for the fence reading its trusted hosts from a non-existent
// `webRuntime` service and degrading to loopback-only: the /llm-wiki/api
// routes 403'd when the GUI was reached through a non-loopback Host
// (reverse proxy / tunnel), while 127.0.0.1 kept working.
{
	// `apply` (top of this file) re-runs the whole plugin per call, so each
	// fenceCtx swaps in a fresh route table + webServer identity.
	const fenceCtx = (config, webServer) => {
		routes.clear();
		const ctxF = {
			fs: fsStub,
			webServer: { register(route) { routes.set(route.path, route.handler); return () => {}; }, ...webServer },
			get() { return undefined; },
			effect(fn) { fn(); return () => {}; },
		};
		apply(ctxF, config);
	};
	const fenceCall = (headers) => new Promise((resolve, reject) => {
		const handler = routes.get("/llm-wiki/api/wikis");
		assert.ok(handler, "route registered: /llm-wiki/api/wikis");
		const req = {
			method: "POST",
			headers: { "content-type": "application/json", ...headers },
			async *[Symbol.asyncIterator]() { yield JSON.stringify({ cwd: root }); },
		};
		const res = {
			statusCode: 0,
			writeHead(status) { this.statusCode = status; },
			end(text) { resolve({ status: this.statusCode, body: JSON.parse(text) }); },
		};
		Promise.resolve(handler(req, res)).catch(reject);
	});

	// F1. default (no trustedHosts): loopback passes, a remote host stays fenced
	fenceCtx({}, { host: "127.0.0.1", protocol: "http:" });
	assert.equal((await fenceCall({ host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080" })).status, 200, "default: loopback passes");
	assert.equal((await fenceCall({ host: "app.example", origin: "https://app.example" })).status, 403, "default: remote host fenced");

	// F2. configured trustedHosts: the remote host passes, like the product fence
	fenceCtx({ trustedHosts: ["app.example"] }, { host: "127.0.0.1", protocol: "http:" });
	assert.equal((await fenceCall({ host: "app.example", origin: "https://app.example" })).status, 200, "the bug: trusted remote host + same-origin Origin");
	assert.equal((await fenceCall({ host: "app.example" })).status, 200, "trusted remote host, no Origin (CLI client)");
	assert.equal((await fenceCall({ host: "app.example:443", origin: "https://app.example:443" })).status, 200, "port-less entry matches any port");
	assert.equal((await fenceCall({ host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080" })).status, 200, "loopback still passes with the config");

	// F3. the security refusals hold with the config
	assert.equal((await fenceCall({ host: "evil.example", origin: "https://evil.example" })).status, 403, "untrusted host fenced");
	assert.equal((await fenceCall({ host: "app.example", origin: "http://127.0.0.1:3080" })).status, 403, "cross-origin Origin fenced");
	assert.equal((await fenceCall({ host: "app.example", origin: "null" })).status, 403, "opaque Origin fenced");
	assert.equal((await fenceCall({ host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080", "sec-fetch-site": "cross-site" })).status, 403, "sec-fetch-site: cross-site fenced");
	assert.equal((await fenceCall({ origin: "http://127.0.0.1:3080" })).status, 403, "missing Host fenced");

	// F4. the listener's bind IP literal is accepted on any port, like the product
	fenceCtx({}, { host: "10.0.0.7", protocol: "http:" });
	assert.equal((await fenceCall({ host: "10.0.0.7:9999", origin: "http://10.0.0.7:9999" })).status, 200, "bind IP literal passes on any port");
	assert.equal((await fenceCall({ host: "10.0.0.7.evil.example" })).status, 403, "a host merely starting with the bind IP is fenced");

	// F5. malformed entries fail the load loudly instead of quietly changing the grant
	{
		const ctxF = {
			fs: fsStub,
			webServer: { register() { return () => {}; }, host: "127.0.0.1", protocol: "http:" },
			get() { return undefined; },
			effect(fn) { fn(); return () => {}; },
		};
		const mod = await import("../lib/index.js");
		assert.throws(() => mod.apply(ctxF, { trustedHosts: ["evil.example/path"] }), /not a bare host\[:port\] authority/);
		assert.throws(() => mod.apply(ctxF, { trustedHosts: [" app.example "] }), /not a bare host\[:port\] authority/);
		mod.apply(ctxF, { trustedHosts: ["app.example", "app.example:443", "localhost"] });
	}
	console.log("F. browser-trust fence (loopback / trustedHosts / bind IP / refusals / malformed config) — PASS");
}

await rm(root, { recursive: true, force: true });
console.log("\nALL HOST TESTS PASSED ✅ (lib/index.js routes)");
