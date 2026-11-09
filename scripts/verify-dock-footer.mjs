#!/usr/bin/env node
/**
 * Local verification (not part of the package): renders the dock footer
 * server-side and emits two standalone HTML previews (176px / 196px frame)
 * so the layout can be inspected in a real browser.
 */
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import react from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { renderToString } from "react-dom/server";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");

let capturedDeclaration = null;
globalThis.window = {
	__ModuleLoader__: {
		load: (declaration) => {
			capturedDeclaration = declaration;
		}
	}
};

const primitives = new Proxy({}, {
	get: (_target, name) => name === "Tooltip"
		? function Tooltip(props) {
			return react.createElement(react.Fragment, null, props.children);
		}
		: function Icon(props) {
			return react.createElement("span", { "data-icon": name, "data-size": props.size ?? null });
		}
});

const mockRequire = (name) => {
	if (name === "react") return react;
	if (name === "react/jsx-runtime") return jsxRuntime;
	if (name === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
	throw new Error(`unexpected require: ${name}`);
};

await import("../lib/client.js");
const clientExports = capturedDeclaration.factory(mockRequire);
const { UsagePanel, apply } = clientExports;

const captured = { dictionaries: null };
apply({
	effect: (fn) => fn(),
	locale: { register: (_ns, dicts) => { captured.dictionaries = dicts; } },
	slots: {
		inject: (_name, callback) => { callback(); },
		register: (spec, component) => ({ spec, component })
	}
});
const zhT = (key) => captured.dictionaries?.zh[key] ?? key;

const html = renderToString(react.createElement(UsagePanel, { wide: true, t: zhT }));

assert.ok(html.includes("u_dockFooter"), "footer container rendered inside the dock");
assert.ok(html.includes(zhT("peak.footerWeek")), "line 1 rendered");
assert.ok(html.includes(zhT("peak.footerHours")), "line 2 rendered");
assert.ok(html.includes("9:00-12:00  14:00-18:00"), "line 2 keeps two literal spaces");
assert.ok(!html.includes("9:00-12:00 14:00-18:00</div>"), "two spaces must not collapse to one in source");
assert.ok(html.includes("（其余为空闲时段）"), "line 3 rendered");
assert.ok(html.includes("空闲价格为高峰价格的一半"), "line 4 rendered");

// Footer must come after every pinned row inside the frame.
const frame = html.slice(html.indexOf("u_dockFrame"));
assert.ok(frame.lastIndexOf("u_dockFooter") > frame.lastIndexOf("u_dockItem"), "footer is below the pinned rows");

// Pull the real stylesheet out of the bundle so the preview matches the plugin.
const src = readFileSync(join(root, "lib/client.js"), "utf8");
const start = src.indexOf("const css = [");
const end = src.indexOf("\n\t\t];", start);
assert.ok(start > 0 && end > start, "css array located");
const css = eval(`[${src.slice(start + "const css = [".length, end)}]`).join("\n");
assert.ok(css.includes(".u_dockFooterPeak{font-size:16px"), "peak line is 16px");
assert.ok(css.includes("color:#f59e0b"), "peak line is orange");
assert.ok(css.includes("white-space:pre"), "peak line preserves whitespace");
assert.ok(css.includes(".u_dockFooterLine{font-size:10.5px"), "other lines are 10.5px");

const chromeVars = `:root{--dsw-alias-border-l2:#e3e6ea;--dsw-alias-border-l1:#eef0f3;--dsw-alias-bg-base:#fff;--dsw-alias-label-primary:#111827;--dsw-alias-label-secondary:#6b7280;--dsw-alias-label-tertiary:#9ca3af;--dsw-alias-interactive-bg-hover:#f3f4f6;--dsw-alias-fill-l1:#f3f4f6;--dsw-alias-fill-l2:#e5e7eb;--dsw-shadow-lv2:0 8px 24px rgba(0,0,0,.12);font-family:"Segoe UI",system-ui,sans-serif}
body{margin:0;padding:32px;background:#f7f8fa;color:#111827}`;

for (const [name, width] of [["footer-176", 176], ["footer-196", 196]]) {
	const override = `.u_dock{position:static;margin:0;bottom:auto;left:auto;width:${width}px}`;
	const doc = `<!doctype html><html lang="zh"><head><meta charset="utf-8"><title>${name}</title>
<style>${chromeVars}</style><style>${css}</style><style>${override}</style></head>
<body><p style="font:12px/18px 'Segoe UI';color:#6b7280;margin:0 0 12px">frame width ${width}px</p>${html}</body></html>`;
	writeFileSync(join(root, "..", `${name}.html`), doc, "utf8");
	console.log(`wrote ${name}.html`);
}

console.log("ok footer assertions passed");
