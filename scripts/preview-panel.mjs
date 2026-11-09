#!/usr/bin/env node
/**
 * Local preview generator (not part of the test suite).
 *
 * Mounts the real client bundle in jsdom, opens the panel, and writes
 * standalone HTML files that can be screenshotted in a real browser. The host
 * theme is faked with two `:root` palettes so the "colors follow DSH" change
 * can be eyeballed in both light and dark mode.
 *
 * Usage: node scripts/preview-panel.mjs
 */
import { writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import react from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { createRoot } from "react-dom/client";

const here = dirname(fileURLToPath(import.meta.url));
const { mkdirSync } = await import("node:fs");
const root = join(here, "..");
mkdirSync(join(root, ".preview"), { recursive: true });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
	url: "http://127.0.0.1:3080/",
	runScripts: "dangerously",
	pretendToBeVisual: true
});
const globals = {
	window: dom.window,
	document: dom.window.document,
	HTMLElement: dom.window.HTMLElement,
	HTMLSelectElement: dom.window.HTMLSelectElement,
	HTMLInputElement: dom.window.HTMLInputElement,
	SVGElement: dom.window.SVGElement,
	Event: dom.window.Event,
	MouseEvent: dom.window.MouseEvent,
	CustomEvent: dom.window.CustomEvent,
	Node: dom.window.Node,
	MessageChannel: dom.window.MessageChannel,
	getComputedStyle: dom.window.getComputedStyle.bind(dom.window),
	requestAnimationFrame: dom.window.requestAnimationFrame.bind(dom.window),
	cancelAnimationFrame: dom.window.cancelAnimationFrame.bind(dom.window),
	IS_REACT_ACT_ENVIRONMENT: false
};
for (const [key, value] of Object.entries(globals)) {
	try {
		Object.defineProperty(globalThis, key, { value, writable: true, configurable: true });
	} catch {
		/* read-only built-ins */
	}
}

let declaration = null;
dom.window.__ModuleLoader__ = { load: (handoff) => { declaration = handoff; } };
dom.window.eval(await (await import("node:fs/promises")).readFile(join(root, "lib", "client.js"), "utf8"));

const icon = (name) => function Icon(props) {
	return react.createElement("span", { "data-icon": name, "data-size": props.size ?? null });
};
const primitives = new Proxy({}, {
	get: (_t, name) => name === "Tooltip" ? (props) => react.createElement(react.Fragment, null, props.children) : icon(String(name))
});
const mockRequire = (name) => {
	if (name === "react") return react;
	if (name === "react/jsx-runtime") return jsxRuntime;
	if (name === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
	throw new Error(`unexpected require: ${name}`);
};

const clientExports = declaration.factory(mockRequire);
const { UsagePanel } = clientExports;
const captured = { dictionaries: null };
clientExports.apply({
	effect: (fn) => fn(),
	locale: { register: (_ns, dicts) => { captured.dictionaries = dicts; } },
	slots: { inject: (_n, cb) => { cb(); }, register: (spec) => spec }
});
const t = (key) => captured.dictionaries?.zh[key] ?? key;

const now = new Date();
const pad = (n) => String(n).padStart(2, "0");
const todayKey = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const PROVIDERS = [
	{ id: "deepseek-official", displayName: "DeepSeek", scheme: "deepseek", configured: true, status: "ok" },
	{ id: "openrouter", displayName: "OpenRouter", scheme: "openrouter", configured: false, status: "not-configured" }
];
const healthyAccount = {
	id: "deepseek-official", displayName: "DeepSeek", scheme: "deepseek", mode: "balance", status: "ok",
	balance: { isAvailable: true, currency: "CNY", total: "128.00", granted: "0.00", toppedUp: "128.00" },
	fetchedAt: Date.now()
};
let account = healthyAccount;
dom.window.fetch = async (input) => {
	const url = String(input);
	const ok = (data) => ({ ok: true, status: 200, json: async () => data });
	if (url.includes("/api/usage/providers")) return ok({ ok: true, providers: PROVIDERS });
	if (url.includes("/api/usage/balance")) return ok({ ok: true, account });
	if (url.includes("/api/usage/usage")) {
		return ok({
			ok: true,
			days: [...Array.from({ length: 40 }, (_, index) => {
				const date = new Date();
				date.setDate(date.getDate() - (40 - index));
				const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
				const tokens = [0, 0, 120000, 480000, 900000, 1500000, 2300000][index % 7];
				return { date: key, tokens, cacheHitRate: 80 + (index % 15), inputTokens: Math.round(tokens * 0.1), outputTokens: Math.round(tokens * 0.05), cacheReadTokens: Math.round(tokens * 0.85), cacheWriteTokens: 0, hours: new Array(24).fill(0), models: [] };
			}), {
				date: todayKey, inputTokens: 120000, outputTokens: 48000, cacheReadTokens: 820000, cacheWriteTokens: 0,
				tokens: 988000, cacheHitRate: 84,
				hours: Array.from({ length: 24 }, (_, i) => (i >= 9 && i < 12) || (i >= 14 && i < 18) ? 40000 : 6000),
				models: [{ model: "deepseek-official/deepseek-v4-pro", inputTokens: 120000, outputTokens: 48000, cacheReadTokens: 820000, cacheWriteTokens: 0, tokens: 988000, cacheHitRate: 84, cost: { total: 3.42, peak: 2.31, offPeak: 1.11 } }],
				sessions: [
					{ id: "session-alpha", title: "安装 dsh 插件并添加悬浮窗文字", inputTokens: 120000, outputTokens: 48000, cacheReadTokens: 820000, cacheWriteTokens: 0, tokens: 988000, cacheHitRate: 84, cost: { total: 3.42, peak: 2.31, offPeak: 1.11 }, cwd: "C:\\Users\\pc01\\Vibe" }
				],
				cost: { total: 3.42, peak: 2.31, offPeak: 1.11 }
			}],
			total: { inputTokens: 120000, outputTokens: 48000, cacheReadTokens: 820000, cacheWriteTokens: 0, tokens: 988000, cacheHitRate: 84, cost: { total: 3.42, peak: 2.31, offPeak: 1.11 } },
			costMeta: { currency: "CNY", source: "official", offPeakMultiplier: 0.5, unpriced: [] },
			updatedAt: Date.now()
		});
	}
	throw new Error(`unexpected fetch: ${url}`);
};

let currentRoot = null;
async function render() {
	dom.window.localStorage.clear();
	if (currentRoot !== null) currentRoot.unmount();
	const container = document.getElementById("root");
	container.innerHTML = "";
	currentRoot = createRoot(container);
	currentRoot.render(react.createElement(UsagePanel, { wide: true, t }));
	await sleep(220);
	document.querySelector(".u_dockSettings").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
	await sleep(200);
	return { body: document.getElementById("root").innerHTML, css: document.head.textContent };
}

const lightVars = `:root{
--dsw-alias-bg-base:#ffffff;--dsw-alias-border-l1:#eef0f3;--dsw-alias-border-l2:#e3e6ea;
--dsw-alias-label-primary:#111827;--dsw-alias-label-secondary:#6b7280;--dsw-alias-label-tertiary:#9ca3af;
--dsw-alias-interactive-bg-hover:#f3f4f6;--dsw-alias-interactive-bg-hover-danger:#fdecec;
--dsw-alias-bg-layer-2:#ffffff;--dsw-alias-label-caption:#81858c;
--dsw-alias-state-business-primary:#4d6bfe;--dsw-alias-state-success-primary:#1f883d;
--dsw-alias-state-error-primary:#d1242f;--dsw-alias-state-warn-primary:#d29922;
--dsw-alias-state-accent-primary:#4d6bfe;--dsw-shadow-lv2:0 8px 24px rgba(15,23,42,.12);
font-family:"Segoe UI",system-ui,sans-serif;color:#111827;background:#f7f8fa}`;
const darkVars = `:root{
--dsw-alias-bg-base:#17181b;--dsw-alias-border-l1:#2a2c31;--dsw-alias-border-l2:#34373d;
--dsw-alias-label-primary:#f2f3f5;--dsw-alias-label-secondary:#a9aeb8;--dsw-alias-label-tertiary:#7c828d;
--dsw-alias-interactive-bg-hover:#26282d;--dsw-alias-interactive-bg-hover-danger:#3a2326;
--dsw-alias-bg-layer-2:#2c2c2e;--dsw-alias-label-caption:#adb2b8;
--dsw-alias-state-business-primary:#8ea2ff;--dsw-alias-state-success-primary:#4ac26b;
--dsw-alias-state-error-primary:#ff7b81;--dsw-alias-state-warn-primary:#e3b341;
--dsw-alias-state-accent-primary:#8ea2ff;--dsw-shadow-lv2:0 8px 24px rgba(0,0,0,.5);
font-family:"Segoe UI",system-ui,sans-serif;color:#f2f3f5;background:#0e0f11}`;
const overrides = `
body{margin:0;padding:28px;background:inherit}
.u_dock{position:static!important;margin:0 0 20px}
.u_panel{position:relative!important;max-height:none!important;left:auto!important;right:auto!important;top:auto!important;bottom:auto!important;width:100%!important}
.u_dock,.u_panel{box-shadow:0 8px 24px rgba(15,23,42,.12)}
/* the mocked icon components render empty spans; give them a visible body */
[data-icon]{display:inline-block;width:12px;height:12px;border-radius:3px;background:currentColor;opacity:.55}`;

function doc(name, vars, body, css) {
	return `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${name}</title>
<style>${vars}</style><style>${css}</style><style>${overrides}</style></head>
<body>${body}</body></html>`;
}

const healthy = await render();
writeFileSync(join(root, ".preview", "panel-light.html"), doc("panel-light", lightVars, healthy.body, healthy.css), "utf8");
writeFileSync(join(root, ".preview", "panel-dark.html"), doc("panel-dark", darkVars, healthy.body, healthy.css), "utf8");

// Drilldown preview: click the first usage row so the model view is captured.
const detail = await (async () => {
	const snap = await render();
	const row = document.querySelector(".u_day");
	if (row !== null) {
		row.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
	}
	await sleep(150);
	return { body: document.getElementById("root").innerHTML, css: document.head.textContent };
})();
writeFileSync(join(root, ".preview", "panel-detail.html"), doc("panel-detail", lightVars, detail.body, detail.css), "utf8");

account = {
	id: "deepseek-official", displayName: "DeepSeek", scheme: "deepseek", mode: "balance",
	status: "unauthorized", balance: null, error: "balance API returned HTTP 401", fetchedAt: Date.now()
};
const failed = await render();
writeFileSync(join(root, ".preview", "panel-failed.html"), doc("panel-failed", lightVars, failed.body, failed.css), "utf8");

console.log("wrote .preview/panel-light.html, .preview/panel-dark.html, .preview/panel-failed.html");
dom.window.close();
process.exit(0);
