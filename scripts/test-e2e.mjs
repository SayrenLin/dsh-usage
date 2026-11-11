#!/usr/bin/env node
/**
 * dsh-usage — jsdom end-to-end client test (v0.2 widget architecture).
 * Mounts the real bundle inside a DOM, feeds it mock endpoint data shaped
 * exactly like the live server responses, and drives the customization
 * flows: dock render → open panel → pin/collapse/hide/restore → theme
 * customization → provider switch → day drilldown. No browser, no network.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { JSDOM } from "jsdom";
import react from "react";
import * as jsxRuntime from "react/jsx-runtime";
import { createRoot } from "react-dom/client";
import { Simulate, act } from "react-dom/test-utils";

const here = dirname(fileURLToPath(import.meta.url));
// A final-package check can point this UI test at the installed bundle.
const clientSource = readFileSync(process.argv[2] ?? join(here, "..", "lib", "client.js"), "utf8");
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

let passed = 0;
async function test(name, fn) {
	try {
		await fn();
		passed += 1;
		console.log(`ok ${name}`);
	} catch (error) {
		console.error(`FAIL ${name}`);
		throw error;
	}
}

//#region environment

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
		/* skip read-only built-ins */
	}
}

let declaration = null;
dom.window.__ModuleLoader__ = { load: (handoff) => { declaration = handoff; } };

//#endregion

//#region fixtures (mirror the live endpoint shapes)

const today = new Date();
const pad = (n) => String(n).padStart(2, "0");
const todayKey = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
const dayLabelOf = (date) => `${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;

const PROVIDERS = [
	{ id: "deepseek-official", displayName: "DeepSeek", scheme: "deepseek", configured: true, status: "ok", fetchedAt: Date.now(), balance: { isAvailable: true, currency: "CNY", total: "128.00", granted: "0.00", toppedUp: "128.00" } },
	{ id: "openrouter", displayName: "OpenRouter", scheme: "openrouter", configured: true, status: "not-configured", fetchedAt: Date.now(), balance: null },
	{ id: "zai", displayName: "Z.ai", scheme: "zai", configured: false, status: "not-configured", fetchedAt: Date.now(), balance: null }
];
const ACCOUNT = { id: "deepseek-official", displayName: "DeepSeek", scheme: "deepseek", mode: "balance", status: "ok", balance: { isAvailable: true, currency: "CNY", total: "128.00", granted: "0.00", toppedUp: "128.00" }, fetchedAt: Date.now() };
const OPENROUTER_ACCOUNT = { id: "openrouter", displayName: "OpenRouter", scheme: "openrouter", mode: "balance", status: "not-configured", balance: null, missingCredentials: ["OPENROUTER_MANAGEMENT_KEY"], fetchedAt: Date.now() };
const USAGE = {
	ok: true,
	days: [{
		date: todayKey,
		inputTokens: 100,
		outputTokens: 50,
		cacheReadTokens: 1000,
		cacheWriteTokens: 0,
		tokens: 1150,
		cacheHitRate: 87,
		hours: (() => {
			const hours = new Array(24).fill(0);
			hours[10] = 400;
			hours[11] = 750;
			return hours;
		})(),
		models: [{ model: "deepseek-official/deepseek-v4-pro", inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, cacheWriteTokens: 0, tokens: 1150, cacheHitRate: 87, cost: { total: 3, peak: 2, offPeak: 1 } }],
		sessions: [
			{ id: "session-alpha", title: "安装 dsh 插件", inputTokens: 100, outputTokens: 50, cacheReadTokens: 650, cacheWriteTokens: 0, tokens: 800, cacheHitRate: 80, cost: { total: 2, peak: 1.5, offPeak: 0.5 }, cwd: "C:\\Users\\pc01\\Vibe", createdAt: 1 },
			{ id: "session-beta", title: null, inputTokens: 0, outputTokens: 10, cacheReadTokens: 340, cacheWriteTokens: 0, tokens: 350, cacheHitRate: 90, cost: { total: 1, peak: 0.5, offPeak: 0.5 }, cwd: "C:\\Users\\pc01\\docs", createdAt: 2 }
		],
		cost: { total: 3, peak: 2, offPeak: 1 }
	}],
	total: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 1000, cacheWriteTokens: 0, tokens: 1150, cacheHitRate: 87, cost: { total: 3, peak: 2, offPeak: 1 } },
	costMeta: { currency: "CNY", source: "official", offPeakMultiplier: 0.5, unpriced: [] },
	claude: {
		enabled: true,
		files: 1,
		days: [{
			date: todayKey,
			inputTokens: 300,
			outputTokens: 120,
			cacheReadTokens: 0,
			cacheWriteTokens: 0,
			tokens: 420,
			cacheHitRate: 0,
			hours: new Array(24).fill(0)
		}],
		total: { inputTokens: 300, outputTokens: 120, cacheReadTokens: 0, cacheWriteTokens: 0, tokens: 420, cacheHitRate: 0 }
	},
	updatedAt: Date.now()
};

const fetchCalls = [];
const okResponse = (data) => ({ ok: true, status: 200, json: async () => data });
let usageResponse = () => okResponse(USAGE);
/** Overrides the /api/usage/balance account for one test (null = healthy fixture). */
let balanceAccount = null;
dom.window.fetch = async (input) => {
	const url = String(input);
	fetchCalls.push(url);
	if (url.includes("/api/usage/providers")) return okResponse({ ok: true, providers: PROVIDERS });
	if (url.includes("/api/usage/balance")) {
		const account = balanceAccount ?? (url.includes("openrouter") ? OPENROUTER_ACCOUNT : ACCOUNT);
		return okResponse({ ok: true, account });
	}
	if (url.includes("/api/usage/usage")) return usageResponse();
	throw new Error(`unexpected fetch: ${url}`);
};

//#endregion

//#region primitives mock + bundle load

function iconComponent(name) {
	return function Icon(props) {
		return react.createElement("span", { "data-icon": name, "data-size": props.size ?? null });
	};
}
const primitives = new Proxy({}, {
	get: (_target, name) => name === "Tooltip"
		? function Tooltip(props) {
			return react.createElement(react.Fragment, null, props.children);
		}
		: iconComponent(String(name))
});
const mockRequire = (name) => {
	if (name === "react") return react;
	if (name === "react/jsx-runtime") return jsxRuntime;
	if (name === "@deepseek-ai/dsh-client-ui-primitives") return primitives;
	throw new Error(`unexpected require: ${name}`);
};

//#endregion

dom.window.eval(clientSource);
assert.ok(declaration !== null, "bundle registered on the mock sink");
const clientExports = declaration.factory(mockRequire);
const { UsagePanel } = clientExports;

// Dictionaries captured from the plugin body.
const captured = { dictionaries: null };
const captureCtx = {
	effect: (fn) => fn(),
	locale: { register: (ns, dicts) => { captured.dictionaries = dicts; } },
	slots: {
		inject: (_name, callback) => { callback(); },
		register: (spec) => spec
	}
};
clientExports.apply(captureCtx);
const t = (key) => captured.dictionaries?.zh[key] ?? key;

let currentRoot = null;
const freshMount = async () => {
	dom.window.localStorage.clear();
	if (currentRoot !== null) currentRoot.unmount();
	const container = document.getElementById("root");
	container.innerHTML = "";
	currentRoot = createRoot(container);
	currentRoot.render(react.createElement(UsagePanel, { wide: true, t }));
	await sleep(180);
};

function setNativeValue(element, value) {
	const proto = Object.getPrototypeOf(element);
	const setter = Object.getOwnPropertyDescriptor(proto, "value").set;
	setter.call(element, value);
}

const q = (selector) => document.querySelector(selector);

/** Open the detail panel the only way that still exists: the balance row. */
async function openPanel() {
	q(".u_balanceLine").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
	await sleep(120);
}
const qa = (selector) => [...document.querySelectorAll(selector)];

//#region flows

await test("dock renders today's spend card with the billing band", async () => {
	await freshMount();
	const dock = q("[data-dsh-usage-dock]");
	assert.ok(dock !== null, "dock rendered");
	assert.equal(q(".u_dockItem"), null, "the four text rows are gone");
	assert.ok(q(".u_dockCard") !== null, "spend card rendered");
	assert.equal(q(".u_costValue").textContent, "¥3.00", "today's spend in CNY");
	// The peak/off-peak split lives in an instant hover card, not on the card.
	assert.equal(q(".u_costSplit"), null, "no split text on the card");
	const costValue = q(".u_costValue");
	costValue.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true }));
	await sleep(30);
	const costTip = q("[data-dsh-usage-dock] .u_heatTip");
	assert.ok(costTip !== null, "hover card appears");
	assert.ok(costTip.textContent.includes("¥3.0000"), "hover card keeps the exact amount");
	assert.ok(costTip.textContent.includes("峰 ¥2.00") && costTip.textContent.includes("谷 ¥1.00"), "hover card carries both shares");
	costValue.dispatchEvent(new dom.window.MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
	await sleep(30);
	assert.equal(q("[data-dsh-usage-dock] .u_heatTip"), null, "hover card hides on leave");
	assert.equal(qa(".u_bandEdge").length, 4, "four clock labels under the band");
	assert.deepEqual(qa(".u_bandEdge").map((el) => el.textContent), ["9时", "12时", "14时", "18时"], "boundary times in order");
	assert.ok(q(".u_bandZone") !== null, "billing band rendered");
	assert.equal(qa(".u_bandZone[data-kind=peak]").length, 2, "two peak windows");
	assert.equal(qa(".u_bandZone[data-active]").length, 0, "no text inside the band");
	assert.equal(qa(".u_bandZone[data-kind=off]").length, 3, "three off-peak zones");
	assert.equal(qa(".u_bandZone").reduce((sum, el) => sum + el.textContent.length, 0), 0, "zones stay unlabelled");
	assert.ok(q(".u_bandNow") !== null, "current-time marker");
	const metrics = qa(".u_metricValue").map((el) => el.textContent);
	assert.equal(metrics.length, 2, "today usage + cache hit rate");
	assert.equal(metrics[0], "1.1k", "today tokens");
	assert.equal(metrics[1], "87%", "today cache hit rate");
	assert.ok(q(".u_dockBar") !== null, "today's composition bar");
	assert.equal(qa(".u_dockLegend .u_legendItem").length, 3, "dock bar legend has three entries");
	assert.equal(q(".u_balanceLineValue").textContent, "¥128.00", "balance reminder");
	assert.equal(q(".u_balanceLineValue").getAttribute("data-tone"), "ok");
});

await test("the dock card is display-only; only the gear opens the panel", async () => {
	await freshMount();
	q(".u_dockCard").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
	await sleep(150);
	assert.equal(q("[data-dsh-usage-panel]"), null, "card clicks do nothing");
	await openPanel();
	assert.ok(q("[data-dsh-usage-panel]") !== null, "gear opens the panel");
});

await test("the panel shows two cards in a fixed order", async () => {
	await freshMount();
	await openPanel();
	const panel = q("[data-dsh-usage-panel]");
	assert.ok(panel !== null, "panel rendered");
	const cards = qa("[data-dsh-usage-panel] .u_card");
	assert.deepEqual(cards.map((el) => el.getAttribute("data-widget")), ["balance", "heatmap"], "fixed card order");
	assert.ok(panel.textContent.includes("¥128.00"), "balance detail shown");
	assert.ok(panel.textContent.includes(t("widget.heatmap")), "heatmap card titled");
});

await test("heatmap renders 8 weeks × 7 weekdays with a 少→多 legend", async () => {
	await freshMount();
	await openPanel();
	await sleep(100);
	const card = "[data-dsh-usage-panel] .u_card[data-widget=heatmap]";
	assert.ok(q(`${card} .u_heatCalendar`) !== null, "calendar grid rendered");
	const cells = qa(`${card} .u_heatCell`);
	assert.equal(cells.length, 8 * 7, "8 week columns × 7 weekday rows");
	const weekdays = qa(`${card} .u_heatWeekday`).map((el) => el.textContent);
	assert.equal(weekdays.length, 7, "seven weekday rows");
	assert.equal(weekdays[0], t("heat.wd.0"), "Monday labelled");
	assert.equal(weekdays[1], t("heat.wd.1"), "Tuesday labelled");
	assert.equal(weekdays[6], t("heat.wd.6"), "Sunday labelled");
	assert.deepEqual(weekdays, [0, 1, 2, 3, 4, 5, 6].map((row) => t(`heat.wd.${row}`)), "all seven weekday labels");
	// Month labels sit above the columns; at least the first week carries one.
	const months = qa(`${card} .u_heatMonth`);
	assert.equal(months.length, 8);
	assert.ok(months[0].textContent.endsWith("月"), "first week labelled with a month");
	assert.ok(months.some((label) => label.textContent !== ""), "month boundaries labelled");
	// Today's cell exists and is marked.
	const todayCell = q(`${card} .u_heatCell.u_heatToday`);
	assert.ok(todayCell !== null, "today cell present");
	// Future cells stay blank inside the current week.
	assert.ok(qa(`${card} .u_heatFuture`).length >= 1, "future days are not painted");
	// Legend: 少 → 5 swatches → 多.
	const legend = q(`${card} .u_heatLegend`);
	assert.ok(legend !== null, "legend rendered");
	assert.ok(legend.textContent.includes(t("heat.less")) && legend.textContent.includes(t("heat.more")), "legend end labels");
	assert.equal(legend.querySelectorAll(".u_heatLegendCell").length, 5, "five legend steps");
	// Hover card: date + exact tokens (+ spend when the day is priced).
	todayCell.dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true }));
	await sleep(30);
	const tip = q(".u_heatTip");
	assert.ok(tip !== null, "hover card appears");
	assert.ok(tip.textContent.includes(todayKey), "hover card shows the date");
	assert.ok(tip.textContent.includes("token"), "hover card shows the token count");
	assert.ok(tip.textContent.includes("¥3.00"), "hover card shows the day spend");
	q(`${card} .u_heatCell`).dispatchEvent(new dom.window.MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
	await sleep(30);
	assert.equal(q(".u_heatTip"), null, "hover card disappears");
});

await test("a card header toggles its body and no drag/pin/hide controls exist", async () => {
	await freshMount();
	await openPanel();
	const head = q("[data-dsh-usage-panel] .u_card[data-widget=heatmap] .u_cardHead");
	assert.ok(head !== null, "header is a button");
	assert.equal(head.tagName, "BUTTON", "whole header row is the click target");
	assert.equal(head.getAttribute("aria-expanded"), "true");
	assert.equal(qa("[data-dsh-usage-panel] .u_wIconBtn").length, 0, "no pin/hide buttons");
	assert.equal(qa("[data-dsh-usage-panel] [draggable]").length, 0, "cards are not draggable");
	assert.equal(qa("[data-dsh-usage-panel] .u_ghost").length, 0, "no drag ghost");
	head.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
	await sleep(60);
	assert.equal(q("[data-dsh-usage-panel] .u_card[data-widget=heatmap]").getAttribute("data-collapsed"), "true");
	assert.equal(q("[data-dsh-usage-panel] .u_card[data-widget=heatmap] .u_cardBody"), null, "body removed when collapsed");
	assert.equal(head.getAttribute("aria-expanded"), "false");
});

await test("the heatmap card shows the selected day's sessions", async () => {
	await freshMount();
	await openPanel();
	await sleep(80);
	const detail = q("[data-dsh-usage-panel] .u_heatDetail");
	assert.ok(detail !== null, "detail area rendered");
	assert.ok(detail.querySelector(".u_detailDay").textContent.length > 0, "day label");
	assert.equal(detail.querySelector(".u_detailCost").textContent, "¥3.00", "day spend");
	const meta = detail.querySelector(".u_detailMeta").textContent;
	assert.ok(meta.includes("1.1k") && meta.includes("87%"), "tokens and hit rate in the summary");
	const row = detail.querySelector(".u_modelRow");
	assert.ok(row !== null, "session row rendered");
	assert.ok(row.querySelector(".u_modelName").textContent.includes("安装 dsh 插件"), "session title");
	assert.equal(row.querySelector(".u_modelTokens").textContent, "800", "session tokens");
	assert.equal(row.querySelector(".u_modelCost").textContent, "¥2.00", "session spend");
	assert.equal(row.querySelectorAll(".u_barSeg").length, 3, "session composition bar");
	assert.equal(qa("[data-dsh-usage-panel] .u_detailLegend .u_legendItem").length, 3, "three-segment legend");
	const foot = q("[data-dsh-usage-panel] .u_footerNote");
	assert.ok(foot.textContent.includes(t("usage.cumulativeTokens").replace("{value}", "")), "cumulative tokens in the panel footer");
	assert.ok(foot.textContent.includes("¥3.00"), "cumulative spend in the panel footer");
});

await test("hit-rate arrow compares against the previous refresh", async () => {
	await freshMount();
	await sleep(120);
	assert.equal(q("[data-dsh-usage-dock] .u_trend"), null, "no arrow before a second refresh");
	const bumped = JSON.parse(JSON.stringify(USAGE));
	bumped.days[0].cacheHitRate = 90;
	bumped.days[0].tokens = 5000;
	bumped.total.cacheHitRate = 90;
	usageResponse = () => okResponse(bumped);
	dom.window.dispatchEvent(new dom.window.Event("focus"));
	await sleep(150);
	const up = q("[data-dsh-usage-dock] .u_trend");
	assert.ok(up !== null && up.getAttribute("data-trend") === "up", "rise is reported as up");
	assert.equal(up.textContent, "", "geometry only, no glyph");
	const baseline = JSON.parse(JSON.stringify(USAGE));
	usageResponse = () => okResponse(JSON.parse(JSON.stringify(baseline)));
	dom.window.dispatchEvent(new dom.window.Event("focus"));
	await sleep(150);
	const down = q("[data-dsh-usage-dock] .u_trend");
	assert.equal(down.getAttribute("data-trend"), "down", "fall is reported as down");
	// Same rate again → flat square.
	dom.window.dispatchEvent(new dom.window.Event("focus"));
	await sleep(150);
	const flat = q("[data-dsh-usage-dock] .u_trend");
	assert.equal(flat.getAttribute("data-trend"), "flat", "unchanged rate is flat");
	assert.equal(flat.textContent, "");
	usageResponse = () => okResponse(USAGE);
});

await test("the balance row toggles the panel", async () => {
	await freshMount();
	assert.equal(q(".u_dockRefresh"), null, "no refresh button in the dock");
	assert.equal(q(".u_dockSettings"), null, "no gear in the dock");
	await openPanel();
	assert.ok(q("[data-dsh-usage-panel]") !== null, "panel opened from the balance row");
	q(".u_balanceLine").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
	await sleep(80);
	assert.equal(q("[data-dsh-usage-panel]"), null, "a second click closes it again");
});

await test("rail mode: balance button reveals the dock and scrim closes it", async () => {
	await freshMount();
	// Remount with wide=false for the rail flow.
	dom.window.localStorage.clear();
	if (currentRoot !== null) currentRoot.unmount();
	const container = document.getElementById("root");
	container.innerHTML = "";
	currentRoot = createRoot(container);
	currentRoot.render(react.createElement(UsagePanel, { wide: false, t }));
	await sleep(150);
	const railBtn = q("[data-dsh-usage-rail]");
	assert.ok(railBtn !== null, "rail button rendered");
	assert.ok(railBtn.textContent.includes("余额"), "balance label shown");
	assert.equal(q("[data-dsh-usage-dock]"), null, "dock hidden initially");
	railBtn.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
	await sleep(80);
	assert.ok(q("[data-dsh-usage-dock]") !== null, "dock revealed on click");
	assert.ok(q(".u_railScrim") !== null, "scrim present");
	// The dock gear opens the detail panel.
	q(".u_balanceLine").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
	await sleep(100);
	assert.ok(q("[data-dsh-usage-panel]") !== null, "detail panel opened from dock gear");
	// Close the panel; scrim click collapses the dock back to the button.
	document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	await sleep(80);
	q(".u_railScrim").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
	await sleep(80);
	assert.equal(q("[data-dsh-usage-dock]"), null, "dock collapsed after scrim click");
	assert.ok(q("[data-dsh-usage-rail]") !== null, "rail button back");
});

await test("collapsing a card persists across remounts", async () => {
	await freshMount();
	await openPanel();
	q("[data-dsh-usage-panel] .u_card[data-widget=heatmap] .u_cardHead").dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
	await sleep(60);
	assert.equal(q("[data-dsh-usage-panel] .u_card[data-widget=heatmap]").getAttribute("data-collapsed"), "true");
	// Remount keeps the preference (localStorage), without opening the panel.
	if (currentRoot !== null) currentRoot.unmount();
	const container = document.getElementById("root");
	container.innerHTML = "";
	currentRoot = createRoot(container);
	currentRoot.render(react.createElement(UsagePanel, { wide: true, t }));
	await sleep(150);
	await openPanel();
	assert.equal(q("[data-dsh-usage-panel] .u_card[data-widget=heatmap]").getAttribute("data-collapsed"), "true", "collapsed state persisted");
});

await test("Escape and an outside click close the panel", async () => {
	await freshMount();
	await openPanel();
	assert.ok(q("[data-dsh-usage-panel]") !== null, "open first");
	document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	await sleep(60);
	assert.equal(q("[data-dsh-usage-panel]"), null, "Escape closes");
	await openPanel();
	q("[data-dsh-usage-dock]").dispatchEvent(new dom.window.PointerEvent("pointerdown", { bubbles: true }));
	await sleep(60);
	assert.ok(q("[data-dsh-usage-panel]") !== null, "clicking the dock keeps the panel open");
	document.body.dispatchEvent(new dom.window.PointerEvent("pointerdown", { bubbles: true }));
	await sleep(60);
	assert.equal(q("[data-dsh-usage-panel]"), null, "a pointerdown elsewhere closes");
});

await test("colors come from the DSH theme, with no customizer left", async () => {
	await freshMount();
	await openPanel();
	// The palette is gone: no swatches, no color inputs, no opacity slider.
	assert.equal(q("[data-dsh-usage-panel] .u_themeBox"), null, "no theme box");
	assert.equal(qa("[data-dsh-usage-panel] .u_swatch").length, 0, "no swatches");
	assert.equal(qa("[data-dsh-usage-panel] .u_range").length, 0, "no opacity slider");
	assert.equal(q("[data-dsh-usage-panel] .u_iconButton[data-active]"), null, "no customize toggle");
	// The dock carries no inline color overrides; it inherits the host tokens.
	const dock = q("[data-dsh-usage-dock]");
	assert.equal(dock.style.getPropertyValue("--u-accent"), "", "no private accent variable");
	assert.equal(dock.style.getPropertyValue("--u-bg"), "", "no private background variable");
	assert.equal(dock.style.opacity, "", "no private opacity");
	assert.ok(document.head.textContent.includes("var(--dsw-alias-state-business-primary)"), "accent resolves through the DSH token");
	assert.ok(document.head.textContent.includes("var(--dsw-alias-bg-base)"), "surface resolves through the DSH token");
});

await test("a failed balance query names the real reason instead of a generic error", async () => {
	balanceAccount = {
		id: "deepseek-official",
		displayName: "DeepSeek",
		scheme: "deepseek",
		mode: "balance",
		status: "unauthorized",
		balance: null,
		error: "balance API returned HTTP 401",
		fetchedAt: Date.now()
	};
	await freshMount();
	// Dock: a neutral dash plus a warning dot that keeps the reason in a tooltip.
	const value = q(".u_balanceLineValue");
	assert.equal(value.textContent, "—", "dock shows a neutral dash");
	assert.equal(value.getAttribute("data-tone"), null, "a credential failure is not painted red");
	const warn = q(".u_warnDot");
	assert.ok(warn !== null, "warning dot present");
	assert.ok((warn.getAttribute("title") ?? "").includes("HTTP 401"), "reason kept as a tooltip");
	await openPanel();
	const text = q("[data-dsh-usage-panel]").textContent;
	assert.ok(text.includes(t("balance.unauthorized")), "status label shown");
	assert.ok(text.includes(t("balance.hintUnauthorized")), "actionable hint shown");
	assert.ok(text.includes("HTTP 401"), "raw upstream error shown");
	balanceAccount = null;
});

await test("switching provider shows its not-configured state", async () => {
	await freshMount();
	await openPanel();
	await sleep(100);
	const select = q("[data-dsh-usage-panel] .u_providerSelect");
	setNativeValue(select, "openrouter");
	select.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
	await sleep(100);
	const panel = q("[data-dsh-usage-panel]");
	assert.ok(panel.textContent.includes("OPENROUTER_MANAGEMENT_KEY"), "missing credential ref shown");
	assert.ok(fetchCalls.some((url) => url.includes("/api/usage/balance?provider=openrouter")), "balance fetched for switched provider");
	const options = [...q("[data-dsh-usage-panel] .u_providerSelect").options].map((option) => option.value);
	assert.deepEqual(options, ["deepseek-official", "openrouter"], "only configured providers are listed");
	assert.ok(!options.includes("zai"), "unconfigured providers never appear");
});

await test("clicking a heat cell selects that day", async () => {
	await freshMount();
	await openPanel();
	await sleep(100);
	const selected = q("[data-dsh-usage-panel] .u_heatCell[data-selected]");
	assert.ok(selected !== null, "today is selected by default");
	selected.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
	await sleep(50);
	assert.ok(q("[data-dsh-usage-panel] .u_heatCell[data-selected]") !== null, "click keeps a selection");
	assert.ok(q("[data-dsh-usage-panel] .u_heatDetail") !== null, "detail stays visible");
	const panel = q("[data-dsh-usage-panel]");
	assert.ok(panel.querySelector(".u_modelCost") !== null, "session spend rendered");
});

await test("closing the panel keeps the dock alive", async () => {
	await freshMount();
	await openPanel();
	await sleep(100);
	assert.ok(q("[data-dsh-usage-panel]") !== null, "panel open");
	document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
	await sleep(80);
	assert.equal(q("[data-dsh-usage-panel]"), null, "panel closed");
	assert.ok(q("[data-dsh-usage-dock]") !== null, "dock persists");
	assert.ok(q(".u_dockCard") !== null, "spend card persists");
});

await test("legacy-only coverage stays quiet: exact subtotals, disclosure without warning dot", async () => {
	usageResponse = () => okResponse({ ...USAGE, coverage: { status: "partial", totalSessions: 3, countedSessions: 2, skippedSessions: [{ sessionId: "old", reason: "unsupported-format" }] } });
	await freshMount();
	await openPanel();
	await sleep(100);
	const notice = q('.u_coverage');
	assert.equal(notice.tagName, "DETAILS");
	assert.ok(notice.classList.contains("u_coverageQuiet"), "legacy-only uses the quiet style");
	assert.equal(q('.u_coverageDot'), null, "no warning dot for legacy-only coverage");
	assert.equal(notice.open, false, "full explanation starts collapsed");
	assert.equal(q('.u_coverageLabel').textContent, "旧格式会话 1 条未计入");
	assert.equal(q('.u_coverageLabel').getAttribute("role"), "status");
	assert.equal(q('.u_error'), null, "partial coverage is not styled as an error banner");
	assert.equal(getComputedStyle(notice).backgroundColor, "rgba(0, 0, 0, 0)", "no yellow background");
	assert.equal(getComputedStyle(q('.u_coverageDetails')).display, "none");
	const callsBeforeExpand = fetchCalls.length;
	q('.u_coverageSummary').click();
	assert.equal(notice.open, true, "summary click opens the native disclosure");
	assert.equal(getComputedStyle(q('.u_coverageDetails')).display, "flex");
	assert.equal(q('.u_coverageText').textContent, "0.1 旧格式（压缩）会话无法被当前宿主读取，已排除在可读小计之外。");
	assert.equal(getComputedStyle(q('.u_coverageDetails')).alignItems, "center", "explanation and retry share one centered row");
	assert.equal(getComputedStyle(q('.u_coverageDetails .u_retry')).lineHeight, "18px", "retry matches the explanation line height");
	q('.u_coverageSummary').click();
	assert.equal(notice.open, false, "second click collapses the explanation");
	assert.equal(fetchCalls.length, callsBeforeExpand, "disclosure does not reload data");
	assert.equal(q(".u_metricValue").textContent, "1.1k");
	assert.equal(qa(".u_metricValue")[1].textContent, "87%");
	assert.ok(!q('[data-dsh-usage-panel]').textContent.includes("≥"), "values are exact subtotals, not lower bounds");
	await sleep(60);
	assert.equal(q('.u_card[data-widget=balance] .u_balanceAmount').textContent, "¥128.00");
	usageResponse = () => okResponse(USAGE);
	q('.u_coverageSummary').click();
	q('.u_coverageDetails .u_retry').click();
	await sleep(100);
	assert.equal(q('.u_coverage'), null, "retry removes the notice when coverage recovers");
	assert.equal(q(".u_metricValue").textContent, "1.1k");
});

await test("non-legacy coverage keeps the warning dot and the partial explanation", async () => {
	usageResponse = () => okResponse({ ...USAGE, coverage: { status: "partial", totalSessions: 3, countedSessions: 2, skippedSessions: [{ sessionId: "broken", reason: "read-failed" }] } });
	await freshMount();
	await openPanel();
	await sleep(100);
	const notice = q('.u_coverage');
	assert.ok(notice !== null, "coverage notice rendered");
	assert.ok(!notice.classList.contains("u_coverageQuiet"), "warning variant, not quiet");
	assert.ok(q('.u_coverageDot') !== null, "warning dot present for actionable skips");
	assert.equal(q('.u_coverageLabel').textContent, "部分统计 · 1 条会话未计入");
	q('.u_coverageSummary').click();
	assert.equal(q('.u_coverageText').textContent, "已排除无法读取的会话，数值为可读小计");
	await sleep(60);
});

await test("all unreadable records show unavailable, never zero tokens or a zero activity heatmap", async () => {
	usageResponse = () => okResponse({ ok: true, days: [], total: null, coverage: { status: "unavailable", totalSessions: 1, countedSessions: 0, skippedSessions: [{ sessionId: "old", reason: "read-failed" }] } });
	await freshMount();
	await openPanel();
	await sleep(100);
	assert.equal(q(".u_metricValue").textContent, "—");
	assert.equal(q(".u_costValue").textContent, "—", "no spend without data");
	assert.equal(q('.u_coverageLabel').textContent, "用量暂不可用 · 1 条会话未计入");
	assert.ok(q('.u_coverageDetails').textContent.includes("未按零用量计算"));
	assert.equal(q('.u_coverage').open, false);
	assert.ok(q('.u_card[data-widget=heatmap]').textContent.includes(t("usage.unavailable")));
	assert.equal(q('.u_heatGrid'), null);
	usageResponse = () => okResponse(USAGE);
});

await test("HTTP failure shows unavailable and balance stays independent", async () => {
	usageResponse = () => ({ ok: false, status: 500 });
	await freshMount();
	await openPanel();
	await sleep(100);
	assert.ok(q('.u_error').textContent.includes("HTTP 500"));
	assert.equal(q(".u_metricValue").textContent, "—");
	assert.equal(q('.u_card[data-widget=balance] .u_balanceAmount').textContent, "¥128.00");
	usageResponse = () => okResponse(USAGE);
	q('.u_error .u_retry').click();
	await sleep(100);
	assert.equal(q('.u_error'), null);
	assert.equal(q(".u_metricValue").textContent, "1.1k");
});

await test("failed refresh clears stale totals instead of presenting them as current statistics", async () => {
	await freshMount();
	await openPanel();
	await sleep(100);
	usageResponse = () => ({ ok: false, status: 500 });
	// No in-panel refresh control any more: remount, which refetches and must clear.
	await freshMount();
	await sleep(120);
	assert.equal(q(".u_metricValue").textContent, "—");
	usageResponse = () => okResponse(USAGE);
});

await test("genuinely empty successful usage still displays zero, without a coverage warning", async () => {
	usageResponse = () => okResponse({ ok: true, days: [], total: { tokens: 0 }, coverage: { status: "complete", totalSessions: 0, countedSessions: 0, skippedSessions: [] } });
	await freshMount();
	await openPanel();
	await sleep(100);
	assert.equal(q(".u_metricValue").textContent, "0", "empty usage shows a real zero");
	assert.equal(q(".u_costValue").textContent, "—", "no priced day means no spend");
	assert.equal(q(".u_error"), null);
	usageResponse = () => okResponse(USAGE);
});

//#region empty states and keyboard

const EMPTY_USAGE = { ...USAGE, days: [], total: { tokens: 0 } };

await test("an undefined hit rate reads as a dash, with no invented trend chip", async () => {
	usageResponse = () => okResponse(EMPTY_USAGE);
	await freshMount();
	const hit = qa(".u_metricValue")[1];
	assert.equal(hit.textContent, "—", "no requests means no rate, not 0%");
	assert.equal(q(".u_trend"), null, "Number(null) must not draw a flat chip");
	assert.ok((hit.getAttribute("title") ?? "").includes(t("usage.noRequestsToday")), "the dash explains itself");
	usageResponse = () => okResponse(USAGE);
});

await test("a priced provider covering an idle day spends a real zero", async () => {
	usageResponse = () => okResponse(EMPTY_USAGE);
	await freshMount();
	assert.equal(q(".u_costValue").textContent, "¥0.00", "nothing spent is a number, not a dash");
	assert.equal(qa(".u_metricValue")[0].textContent, "0", "an idle day still counts zero tokens");
	usageResponse = () => okResponse(USAGE);
});

await test("an unpriced provider keeps the dash instead of claiming zero spend", async () => {
	usageResponse = () => okResponse({ ...EMPTY_USAGE, costMeta: void 0 });
	await freshMount();
	assert.equal(q(".u_costValue").textContent, "—", "no pricing table means no number at all");
	usageResponse = () => okResponse(USAGE);
});

await test("an empty window explains itself and drops the meaningless legend", async () => {
	usageResponse = () => okResponse(EMPTY_USAGE);
	await freshMount();
	await openPanel();
	assert.equal(q(".u_heatEmpty")?.textContent, t("heat.noData"), "the empty grid says so in words");
	assert.equal(q(".u_heatLegend"), null, "a legend with nothing to explain is noise");
	assert.ok(q(".u_heatDetail")?.textContent.includes(t("usage.noDay")), "a day without records resolves its text");
	assert.ok(!q("[data-dsh-usage-panel]").textContent.includes("usage.noDay"), "never a raw key");
	usageResponse = () => okResponse(USAGE);
});

await test("the balance row opens the panel from the keyboard", async () => {
	await freshMount();
	const line = q(".u_balanceLine");
	assert.equal(line.getAttribute("role"), "button", "declared as a control");
	assert.equal(line.getAttribute("tabindex"), "0", "reachable by Tab");
	line.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
	await sleep(150);
	assert.ok(q("[data-dsh-usage-panel]") !== null, "Enter opens the panel");
	assert.equal(q(".u_panel").getAttribute("role"), "dialog", "the panel carries dialog semantics");
	assert.equal(q(".u_balanceLine").getAttribute("aria-expanded"), "true");
});

await test("arrow keys move one cell in the direction the grid is drawn", async () => {
	await freshMount();
	await openPanel();
	const grid = q(".u_heatCalendar");
	assert.equal(grid.getAttribute("role"), "grid");
	assert.equal(qa(".u_heatCell[tabindex='0']").length, 1, "roving tab stop: exactly one cell");
	const keyOf = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
	// Three weeks back lands in the middle of the window and is never future.
	const base = new Date();
	base.setHours(12, 0, 0, 0);
	base.setDate(base.getDate() - 21);
	const start = keyOf(base);
	const cell = q(`.u_heatCell[data-heat-date="${start}"]`);
	assert.ok(cell !== null, "the base cell is inside the eight-week window");
	cell.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
	await sleep(60);
	assert.equal(q(".u_heatCell[data-selected]").getAttribute("data-heat-date"), start);
	// Right/Left change the week, Up/Down change the weekday: columns are weeks.
	grid.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
	await sleep(60);
	const nextWeek = new Date(base);
	nextWeek.setDate(nextWeek.getDate() + 7);
	assert.equal(q(".u_heatCell[data-selected]").getAttribute("data-heat-date"), keyOf(nextWeek), "ArrowRight advances one week");
	grid.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
	await sleep(60);
	const nextDay = new Date(nextWeek);
	nextDay.setDate(nextDay.getDate() + 1);
	assert.equal(q(".u_heatCell[data-selected]").getAttribute("data-heat-date"), keyOf(nextDay), "ArrowDown advances one weekday");
	grid.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }));
	await sleep(60);
	assert.equal(q(".u_heatCell[data-selected]").getAttribute("data-heat-date"), keyOf(nextWeek), "ArrowUp comes back");
	assert.equal(qa(".u_heatCell[tabindex='0']").length, 1, "still a single tab stop");
});

await test("the spend figure wears a peak/off-peak badge", async () => {
	await freshMount();
	const peak = q(".u_costValue").getAttribute("data-peak");
	const pill = q(".u_peakPill");
	assert.ok(pill !== null, "badge sits beside the spend");
	assert.equal(pill.getAttribute("data-peak"), peak, "same state as the figure it labels");
	assert.equal(pill.textContent, peak === "yellow" ? t("cost.peak") : t("cost.offPeak"));
	// A missing price is a dash; a peak/off-peak badge would explain nothing there.
	usageResponse = () => okResponse({ ...EMPTY_USAGE, costMeta: void 0 });
	await freshMount();
	assert.equal(q(".u_costValue").textContent, "—");
	assert.equal(q(".u_peakPill"), null, "no badge next to a dash");
	usageResponse = () => okResponse(USAGE);
});

await test("a session row explains itself on hover, with no session id anywhere", async () => {
	await freshMount();
	await openPanel();
	assert.equal(q(".u_modelName").getAttribute("title"), null, "the raw session id is gone");
	q(".u_modelRow").dispatchEvent(new dom.window.MouseEvent("mouseover", { bubbles: true }));
	await sleep(40);
	const tip = q(".u_sessionTip");
	assert.ok(tip !== null, "hovering the row opens one card");
	const lines = [...tip.children].map((el) => el.textContent);
	assert.deepEqual(lines.length, 3, "three lines");
	assert.equal(lines[0], "800 tokens", "exact count, plural unit");
	assert.equal(lines[1], "输入 100 · 输出 50", "input and output split, compact above 1000");
	assert.equal(lines[2], "峰 ¥1.50 · 谷 ¥0.50", "peak and off-peak split");
	q(".u_modelRow").dispatchEvent(new dom.window.MouseEvent("mouseout", { bubbles: true, relatedTarget: document.body }));
	await sleep(30);
	assert.equal(q(".u_sessionTip"), null, "card hides on leave");
});

//#endregion

if (currentRoot !== null) currentRoot.unmount();
dom.window.close();
console.log(`\n${passed} e2e tests passed`);
process.exit(0);
