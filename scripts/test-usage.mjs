#!/usr/bin/env node
/**
 * dsh-usage — offline token-usage aggregation tests.
 * Pure event logs; no harness, no network.
 */
import assert from "node:assert/strict";
import {
	applyUsageDelta,
	bucketsOf,
	cacheHitRate,
	createUsageState,
	dayKey,
	foldUsage,
	mergeInto,
	renderUsage,
	totalTokens,
	isPeakAt,
	bucketsCost,
	holidayCoverageAt,
	OFF_PEAK_MULTIPLIER,
	PEAK_HOLIDAYS
} from "../lib/usage.js";

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

const DAY1 = Date.UTC(2025, 0, 10, 3, 0, 0);
const DAY2 = Date.UTC(2025, 0, 11, 3, 0, 0);

function header(time, model, provider = "deepseek-official") {
	return { seq: 1, time, type: "request/header", data: { header: { config: { model, provider } } } };
}

function usageChunk(seq, time, turn, step, usage) {
	return { seq, time, type: "assistant/chunk", data: { turn, step, chunk: { type: "usage", usage } } };
}

function message(seq, time, turn, step, usage, source) {
	return { seq, time, type: "assistant/message", data: { turn, step, usage, message: { source } } };
}

await test("dayKey uses local calendar boundaries", () => {
	assert.equal(dayKey(new Date(2025, 0, 10, 23, 59).getTime()).length, 10);
	assert.match(dayKey(DAY1), /^\d{4}-\d{2}-\d{2}$/);
});

await test("basic fold: header model attribution + chunk usage", () => {
	const events = [
		header(DAY1, "deepseek-chat"),
		usageChunk(2, DAY1, 1, 1, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20 })
	];
	const days = foldUsage(events);
	const entry = days.get(dayKey(DAY1));
	assert.equal(entry.totals.inputTokens, 100);
	assert.equal(entry.totals.outputTokens, 50);
	assert.equal(entry.totals.cacheReadTokens, 20);
	const model = entry.models.get("deepseek-official/deepseek-chat");
	assert.equal(model.outputTokens, 50);
});

await test("assistant/message usage path with explicit source attribution", () => {
	const events = [
		header(DAY1, "deepseek-chat"),
		message(2, DAY1, 1, 1, { inputTokens: 10, outputTokens: 5 }, { provider: "ark", model: "deepseek-chat" })
	];
	const entry = foldUsage(events).get(dayKey(DAY1));
	assert.equal(entry.totals.outputTokens, 5);
	assert.equal(entry.models.has("ark/deepseek-chat"), true);
	assert.equal(entry.models.has("deepseek-official/deepseek-chat"), false);
});

await test("same turn/step re-reported replaces instead of double counting", () => {
	const events = [
		header(DAY1, "deepseek-chat"),
		usageChunk(2, DAY1, 1, 1, { inputTokens: 100, outputTokens: 50 }),
		usageChunk(3, DAY1, 1, 1, { inputTokens: 120, outputTokens: 80 })
	];
	const entry = foldUsage(events).get(dayKey(DAY1));
	assert.equal(entry.totals.inputTokens, 120);
	assert.equal(entry.totals.outputTokens, 80);
	assert.equal(entry.models.get("deepseek-official/deepseek-chat").outputTokens, 80);
});

await test("replacement re-attributed to the later day across fold boundaries", () => {
	const state = createUsageState();
	// First slice ends with a partial sample on day 1.
	applyUsageDelta(state, [
		header(DAY1, "deepseek-chat"),
		usageChunk(2, DAY1, 1, 1, { inputTokens: 100, outputTokens: 50 })
	]);
	// Second slice continues the same turn/step on day 2 with a bigger sample.
	applyUsageDelta(state, [
		usageChunk(3, DAY2, 1, 1, { inputTokens: 150, outputTokens: 90 })
	]);
	const day1 = state.days.get(dayKey(DAY1));
	const day2 = state.days.get(dayKey(DAY2));
	assert.equal(day1.totals.inputTokens, 0, "day 1 sample subtracted back to zero");
	assert.equal(day1.totals.outputTokens, 0);
	assert.equal(day2.totals.inputTokens, 150);
	assert.equal(day2.totals.outputTokens, 90);
});

await test("distinct turn/step keys accumulate independently", () => {
	const events = [
		header(DAY1, "deepseek-chat"),
		usageChunk(2, DAY1, 1, 1, { inputTokens: 100, outputTokens: 50 }),
		usageChunk(3, DAY1, 1, 2, { inputTokens: 30, outputTokens: 10 }),
		usageChunk(4, DAY1, 2, 1, { inputTokens: 5, outputTokens: 2 })
	];
	const entry = foldUsage(events).get(dayKey(DAY1));
	assert.equal(entry.totals.inputTokens, 135);
	assert.equal(entry.totals.outputTokens, 62);
});

await test("samples without model info land in unknown/unknown", () => {
	const events = [usageChunk(2, DAY1, 1, 1, { inputTokens: 7, outputTokens: 3 })];
	const entry = foldUsage(events).get(dayKey(DAY1));
	assert.equal(entry.models.get("unknown/unknown").inputTokens, 7);
});

await test("cacheHitRate over the whole prompt side, null without prompt tokens", () => {
	assert.equal(cacheHitRate(bucketsOf({ inputTokens: 40, cacheReadTokens: 40, cacheWriteTokens: 20, outputTokens: 999 })), 40);
	assert.equal(cacheHitRate(bucketsOf({ outputTokens: 999 })), null);
	assert.equal(cacheHitRate(bucketsOf({ cacheReadTokens: 0, inputTokens: 10 })), 0);
});

await test("totalTokens sums every bucket", () => {
	assert.equal(totalTokens(bucketsOf({ inputTokens: 1, outputTokens: 2, cacheReadTokens: 3, cacheWriteTokens: 4 })), 10);
});

await test("mergeInto combines sessions per day", () => {
	const byDay = new Map();
	const a = foldUsage([
		header(DAY1, "deepseek-chat"),
		usageChunk(2, DAY1, 1, 1, { inputTokens: 100, outputTokens: 50 })
	]);
	const b = foldUsage([
		header(DAY1, "deepseek-chat"),
		usageChunk(2, DAY1, 1, 1, { inputTokens: 20, outputTokens: 10 }),
		usageChunk(3, DAY2, 2, 1, { inputTokens: 5, outputTokens: 2 })
	]);
	mergeInto(byDay, a);
	mergeInto(byDay, b);
	assert.equal(byDay.get(dayKey(DAY1)).totals.inputTokens, 120);
	assert.equal(byDay.get(dayKey(DAY2)).totals.outputTokens, 2);
});

await test("renderUsage sorts days ascending and models by tokens descending", () => {
	const byDay = new Map();
	mergeInto(byDay, foldUsage([
		header(DAY2, "deepseek-chat"),
		usageChunk(2, DAY2, 1, 1, { inputTokens: 5, outputTokens: 2 })
	]));
	mergeInto(byDay, foldUsage([
		header(DAY1, "deepseek-chat"),
		usageChunk(2, DAY1, 1, 1, { inputTokens: 100, outputTokens: 50 }),
		usageChunk(3, DAY1, 1, 2, { inputTokens: 10, outputTokens: 3 })
	]));
	const rendered = renderUsage(byDay, 42);
	assert.deepEqual(rendered.days.map((d) => d.date), [dayKey(DAY1), dayKey(DAY2)]);
	assert.equal(rendered.days[0].tokens, 163);
	assert.equal("models" in rendered.days[0], false, "no per-model array on the wire");
	assert.equal("hours" in rendered.days[0], false, "no per-hour array on the wire");
	assert.equal(rendered.total.tokens, 170);
	assert.equal("updatedAt" in rendered, false, "the aggregate timestamp stays off the wire");
});

await test("a day sums its models into one priced cost", () => {
	const byDay = new Map();
	mergeInto(byDay, foldUsage([
		header(DAY1, "big-model"),
		usageChunk(2, DAY1, 1, 1, { inputTokens: 10, outputTokens: 90 }),
		header(DAY1, "small-model"),
		usageChunk(3, DAY1, 2, 1, { inputTokens: 5, outputTokens: 5 })
	]));
	const priced = {
		currency: "CNY",
		source: "official",
		prices: new Map([
			["deepseek-official/big-model", { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 }],
			["deepseek-official/small-model", { input: 2, output: 8, cacheRead: 0, cacheWrite: 0 }]
		])
	};
	const rendered = renderUsage(byDay, 0, { pricing: priced });
	assert.equal(rendered.days[0].tokens, 110);
	assert.ok(rendered.days[0].cost.total > 0, "the day is priced without shipping a model breakdown");
	assert.deepEqual(rendered.costMeta.unpriced, []);
});

await test("the fold no longer tracks hour buckets", () => {
	assert.equal("hours" in createUsageState(), false, "hour tracking left the fold state");
	const byDay = foldUsage([
		header(DAY1, "deepseek-chat"),
		usageChunk(2, DAY1, 1, 1, { inputTokens: 100, outputTokens: 50 })
	]);
	const rendered = renderUsage(byDay, Date.now());
	assert.equal("hours" in rendered.days[0], false, "nothing re-adds an hour array");
});

await test("the wire window drops old days but keeps the lifetime total", () => {
	const byDay = new Map();
	const old = DAY1 - 400 * 24 * 60 * 60 * 1000;
	mergeInto(byDay, foldUsage([
		header(old, "deepseek-flash"),
		usageChunk(2, old, 1, 1, { inputTokens: 100, outputTokens: 50 })
	]));
	mergeInto(byDay, foldUsage([
		header(DAY1, "deepseek-flash"),
		usageChunk(2, DAY1, 1, 1, { inputTokens: 10, outputTokens: 5 })
	]));
	const now = DAY1;
	const windowed = renderUsage(byDay, now, { windowDays: 63 });
	assert.deepEqual(windowed.days.map((day) => day.date), [dayKey(DAY1)], "only the window leaves the server");
	assert.equal(windowed.total.tokens, 165, "the total still covers every day");
	assert.equal(renderUsage(byDay, now).days.length, 2, "windowDays=0 keeps everything");
});

await test("peak windows follow the Beijing clock, not the host clock", () => {
	// 2026-11-09 is a Monday. 02:00Z = 10:00 Beijing.
	assert.equal(isPeakAt(Date.parse("2026-11-09T02:00:00Z")), true, "10:00 Beijing is peak");
	assert.equal(isPeakAt(Date.parse("2026-11-09T03:59:00Z")), true, "11:59 Beijing is peak");
	assert.equal(isPeakAt(Date.parse("2026-11-09T04:00:00Z")), false, "12:00 Beijing is off-peak");
	assert.equal(isPeakAt(Date.parse("2026-11-09T05:59:00Z")), false, "13:59 Beijing is off-peak");
	assert.equal(isPeakAt(Date.parse("2026-11-09T06:00:00Z")), true, "14:00 Beijing is peak");
	assert.equal(isPeakAt(Date.parse("2026-11-09T10:00:00Z")), false, "18:00 Beijing is off-peak");
	assert.equal(isPeakAt(Date.parse("2026-11-14T02:00:00Z")), false, "Saturday is off-peak");
	// Friday 16:30 UTC is Saturday 00:30 Beijing: a UTC-based check would say peak.
	assert.equal(isPeakAt(Date.parse("2026-11-13T16:30:00Z")), false, "Beijing weekend wins over the UTC weekday");
	// Holidays are billed as off-peak when listed.
	assert.equal(isPeakAt(Date.parse("2026-11-09T02:00:00Z"), new Set(["2026-11-09"])), false, "listed holiday is off-peak");
});

await test("statutory holidays are off-peak even on a weekday", () => {
	// 2026-02-17 is the Spring Festival, a Tuesday; 10:00 Beijing would be peak.
	assert.equal(isPeakAt(Date.parse("2026-02-17T02:00:00Z")), false, "Spring Festival Tuesday is off-peak");
	// The first working day after it (2026-02-24, Tuesday) is peak again.
	assert.equal(isPeakAt(Date.parse("2026-02-24T02:00:00Z")), true, "the Tuesday after the break is peak");
	assert.equal(isPeakAt(Date.parse("2026-10-05T02:00:00Z")), false, "National Day Monday is off-peak");
	assert.equal(isPeakAt(Date.parse("2026-10-08T02:00:00Z")), true, "the Thursday after National Day is peak");
	// 调休 make-up weekends stay off-peak: the weekend branch wins.
	assert.equal(isPeakAt(Date.parse("2026-02-14T02:00:00Z")), false, "make-up Saturday is off-peak");
	assert.equal(isPeakAt(Date.parse("2026-10-10T02:00:00Z")), false, "make-up Saturday in October is off-peak");
	assert.equal(PEAK_HOLIDAYS.size, 33, "the 2026 table covers every statutory day");
});

await test("the holiday table reports the years it cannot price", () => {
	// 2026-11-09 10:00 Beijing is inside the covered year.
	assert.deepEqual(holidayCoverageAt(Date.parse("2026-11-09T02:00:00Z")), { covered: true, year: 2026 });
	// 2027-01-04 10:00 Beijing is a Monday in a year with no dates: peak it is,
	// but the payload must say the answer is unsupported rather than implied.
	assert.deepEqual(holidayCoverageAt(Date.parse("2027-01-04T02:00:00Z")), { covered: false, year: 2027 });
	// A caller-supplied table is judged on its own dates.
	assert.equal(holidayCoverageAt(Date.parse("2025-03-03T02:00:00Z"), new Set(["2025-03-03"])).covered, true);
	assert.equal(holidayCoverageAt(Date.parse("2025-03-03T02:00:00Z"), new Set()).covered, false);
	const state = createUsageState();
	applyUsageDelta(state, [header(Date.parse("2026-02-17T02:00:00Z"), "deepseek-flash")]);
	const priced = { currency: "CNY", source: "official", prices: new Map() };
	// No verdict supplied = "unknown", never a claim of coverage.
	assert.equal(renderUsage(state.days, Date.now(), { pricing: priced }).costMeta.holidayCoverage, "unknown");
	const gap = renderUsage(state.days, Date.now(), { pricing: priced, holidayCoverage: { covered: false, year: 2027 } });
	assert.equal(gap.costMeta.holidayCoverage, "uncovered");
	assert.equal(gap.costMeta.holidayYear, 2027);
	assert.equal(renderUsage(state.days, Date.now(), { pricing: priced, holidayCoverage: { covered: true, year: 2026 } }).costMeta.holidayCoverage, "covered");
});

await test("a weekday holiday is billed entirely at the off-peak price", () => {	const state = createUsageState();
	applyUsageDelta(state, [
		header(Date.parse("2026-02-17T02:00:00Z"), "deepseek-flash"),
		usageChunk(2, Date.parse("2026-02-17T02:00:00Z"), 1, 1, { inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
	]);
	const pricing = { currency: "CNY", source: "official", prices: new Map([["deepseek-official/deepseek-flash", { input: 2, output: 8, cacheRead: 0.04, cacheWrite: 0 }]]) };
	const out = renderUsage(state.days, Date.now(), { pricing });
	assert.deepEqual(out.days[0].cost, { total: 1, peak: 0, offPeak: 1 }, "Spring Festival 10:00 is billed at half");
});

await test("spend splits peak at full price and off-peak at half", () => {
	const state = createUsageState();
	applyUsageDelta(state, [
		header(Date.parse("2026-11-09T02:00:00Z"), "deepseek-flash"),
		usageChunk(2, Date.parse("2026-11-09T02:00:00Z"), 1, 1, { inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
		usageChunk(3, Date.parse("2026-11-09T05:00:00Z"), 1, 2, { inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
	]);
	const pricing = { currency: "CNY", source: "official", prices: new Map([["deepseek-official/deepseek-flash", { input: 2, output: 8, cacheRead: 0.04, cacheWrite: 0 }]]) };
	const out = renderUsage(state.days, Date.now(), { pricing });
	assert.equal(out.costMeta.currency, "CNY");
	assert.deepEqual(out.days[0].cost, { total: 3, peak: 2, offPeak: 1 }, "1M peak @2 + 1M off-peak @1");
	assert.deepEqual(out.total.cost, { total: 3, peak: 2, offPeak: 1 });
	assert.equal(OFF_PEAK_MULTIPLIER, 0.5);
	// The multiplier is a parameter, not a hard-coded 0.5.
	const doubled = renderUsage(state.days, Date.now(), { pricing, offPeakMultiplier: 1 });
	assert.deepEqual(doubled.days[0].cost, { total: 4, peak: 2, offPeak: 2 });
	// The billing band travels with the payload so the dock cannot disagree.
	assert.equal(renderUsage(state.days, Date.now(), { pricing }).peak, null, "no verdict unless asked");
	assert.equal(renderUsage(state.days, Date.now(), { pricing, peakNow: true }).peak, "yellow");
	assert.equal(renderUsage(state.days, Date.now(), { pricing, peakNow: false }).peak, "green");
});

await test("unpriced models never produce a partial spend number", () => {
	const state = createUsageState();
	applyUsageDelta(state, [
		header(DAY1, "mystery-model", "custom-provider"),
		usageChunk(2, DAY1, 1, 1, { inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
	]);
	const noPricing = renderUsage(state.days, Date.now(), { pricing: null });
	assert.equal(noPricing.days[0].cost, null, "no price table means no cost");
	assert.equal(noPricing.costMeta, null);
	const emptyPricing = renderUsage(state.days, Date.now(), { pricing: { currency: "CNY", source: "official", prices: new Map() } });
	assert.equal(emptyPricing.days[0].cost, null, "unknown model means null, not zero");
	assert.deepEqual(emptyPricing.costMeta.unpriced, ["custom-provider/mystery-model"]);
	assert.equal(bucketsCost({ inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, { input: 9, output: 27, cacheRead: 0.3, cacheWrite: 0 }), 9);
});

await test("a flat catalog price keeps its full rate off-peak", () => {
	const state = createUsageState();
	applyUsageDelta(state, [
		header(Date.parse("2026-11-09T02:00:00Z"), "deepseek-chat", "openrouter"),
		usageChunk(2, Date.parse("2026-11-09T02:00:00Z"), 1, 1, { inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
		usageChunk(3, Date.parse("2026-11-09T05:00:00Z"), 1, 2, { inputTokens: 1000000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 })
	]);
	const pricing = {
		currency: "CNY",
		source: "catalog",
		prices: new Map([["openrouter/deepseek-chat", { input: 2, output: 8, cacheRead: 0.04, cacheWrite: 0, peakAware: false }]])
	};
	const out = renderUsage(state.days, Date.now(), { pricing });
	// Both bands bill at the full rate; the split still follows the clock.
	assert.deepEqual(out.days[0].cost, { total: 4, peak: 2, offPeak: 2 }, "a flat rate is not discounted at night");
});

console.log(`\n${passed} usage tests passed`);
