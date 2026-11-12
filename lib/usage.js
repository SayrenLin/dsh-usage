/**
 * dsh-usage — pure per-day, per-model token-usage aggregation over session
 * event logs. Kept free of cordis imports so it can be unit-tested and
 * validated against real logs outside the running harness.
 *
 * Aggregation semantics mirror the DSH token projection (as implemented by
 * dsh-token-meter and dsh-usage-stats, MIT):
 *   - a usage sample rides an `assistant/chunk` (`data.chunk.type === "usage"`)
 *     or an `assistant/message` (`data.usage`); v2 settlements also embed
 *     the last sample in `data.stream`, including `assistant/attempt`;
 *   - `llm/retry-started` closes the replacement slot: retries add their own
 *     reported usage, rather than overwriting the failed attempt;
 *   - a repeated sample for the same (turn, step) REPLACES the earlier value
 *     instead of double counting it, and the replacement is re-attributed to
 *     the day of the later event;
 *   - `assistant/message` names its provider/model via `data.message.source`;
 *     usage chunks fall back to the last `request/header`
 *     `data.header.config`; samples with no model information land in the
 *     `unknown/unknown` bucket.
 *
 * @module dsh-usage/usage
 */

/** Local-calendar `YYYY-MM-DD` key for a millisecond epoch. */
export function dayKey(timeMs) {
	const date = new Date(timeMs);
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	return `${date.getFullYear()}-${month}-${day}`;
}

/** Empty token bucket. */
export function zeroBuckets() {
	return {
		inputTokens: 0,
		outputTokens: 0,
		cacheReadTokens: 0,
		cacheWriteTokens: 0
	};
}

/** Provider usage → buckets (missing cache fields are absent in some reports). */
export function bucketsOf(usage) {
	return {
		inputTokens: usage.inputTokens ?? 0,
		outputTokens: usage.outputTokens ?? 0,
		cacheReadTokens: usage.cacheReadTokens ?? 0,
		cacheWriteTokens: usage.cacheWriteTokens ?? 0
	};
}

/** Total tokens across all buckets. */
export function totalTokens(buckets) {
	return buckets.inputTokens + buckets.outputTokens + buckets.cacheReadTokens + buckets.cacheWriteTokens;
}

/**
 * Prompt-side cache hit rate in percent (0–100, one decimal), or null when
 * no prompt tokens were reported at all. Hits over the whole prompt side:
 * cacheRead / (input + cacheRead + cacheWrite).
 */
export function cacheHitRate(buckets) {
	const input = buckets.inputTokens ?? 0;
	const cacheRead = buckets.cacheReadTokens ?? 0;
	const cacheWrite = buckets.cacheWriteTokens ?? 0;
	const promptTokens = input + cacheRead + cacheWrite;
	if (promptTokens <= 0) return null;
	return Math.round((cacheRead / promptTokens) * 1000) / 10;
}

function addInto(target, source) {
	target.inputTokens += source.inputTokens;
	target.outputTokens += source.outputTokens;
	target.cacheReadTokens += source.cacheReadTokens;
	target.cacheWriteTokens += source.cacheWriteTokens;
	return target;
}

function subtractFrom(target, source) {
	target.inputTokens -= source.inputTokens;
	target.outputTokens -= source.outputTokens;
	target.cacheReadTokens -= source.cacheReadTokens;
	target.cacheWriteTokens -= source.cacheWriteTokens;
	return target;
}

/** Extract the usage sample an event carries, if any. */
function sampleOf(event) {
	if (event.type === "assistant/chunk" && event.data?.chunk?.type === "usage") {
		return {
			key: `${event.data.turn}:${event.data.step}`,
			usage: event.data.chunk.usage
		};
	}
	if (event.type === "assistant/message" && event.data?.usage !== void 0) {
		return {
			key: `${event.data.turn}:${event.data.step}`,
			usage: event.data.usage
		};
	}
	if ((event.type === "assistant/message" || event.type === "assistant/attempt") && Array.isArray(event.data?.stream)) {
		for (let i = event.data.stream.length - 1; i >= 0; i -= 1) {
			const record = event.data.stream[i];
			if (record.type === "chunk" && record.chunk?.type === "usage") {
				return { key: `${event.data.turn}:${event.data.step}`, usage: record.chunk.usage };
			}
		}
	}
	return void 0;
}

/**
 * The `provider/model` attribution key of a usage sample: the exact provider
 * route (dsh adapter id or pi-ai route) plus the model id, so the SAME model
 * served by different providers stays distinct.
 */
function modelOf(event) {
	const source = event.data?.message?.source;
	if (source !== void 0 && typeof source.model === "string") {
		return `${typeof source.provider === "string" && source.provider.length > 0 ? source.provider : "unknown"}/${source.model}`;
	}
	const config = event.data?.header?.config;
	if (config !== void 0 && typeof config.model === "string") {
		return `${typeof config.provider === "string" && config.provider.length > 0 ? config.provider : "unknown"}/${config.model}`;
	}
	return void 0;
}

/** Day entry: totals plus a per-model bucket map. */
function entryOf(byDay, day) {
	let entry = byDay.get(day);
	if (entry === void 0) {
		entry = {
			totals: zeroBuckets(),
			models: new Map(),
			peakTotals: zeroBuckets(),
			peakModels: new Map(),
			sessions: new Map()
		};
		byDay.set(day, entry);
	}
	return entry;
}

/**
 * One session's incremental fold state. `days` holds the already-folded
 * per-day entries; `lastSample`/`currentModel` let a later event slice keep
 * the replace-last-sample semantics and model attribution across fold
 * boundaries without replaying the whole log.
 */
export function createUsageState() {
	return {
		days: new Map(),
		lastSample: null,
		currentModel: null,
		consumed: 0
	};
}

/**
 * Peak windows are judged on the Beijing clock, not the host clock:
 * Monday–Friday 09:00–12:00 and 14:00–18:00 are peak, everything else
 * (including weekends) is off-peak. DeepSeek bills off-peak at half price.
 *
 * Statutory holidays are billed off-peak all day even when they fall on a
 * weekday, so they live here as `YYYY-MM-DD`. The 调休 make-up weekends are
 * NOT listed: DeepSeek keeps them off-peak too, and the weekend branch below
 * already returns false for them.
 *
 * Source for 2026: 国办发明电〔2025〕7号 (published 2025-11-04). Add the next
 * year's notice here when it lands — the list is the only place to touch.
 */
export const PEAK_HOLIDAYS = new Set([
	// 元旦 1/1–1/3
	"2026-01-01", "2026-01-02", "2026-01-03",
	// 春节 2/15–2/23
	"2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19",
	"2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
	// 清明 4/4–4/6
	"2026-04-04", "2026-04-05", "2026-04-06",
	// 劳动节 5/1–5/5
	"2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
	// 端午 6/19–6/21
	"2026-06-19", "2026-06-20", "2026-06-21",
	// 中秋 9/25–9/27
	"2026-09-25", "2026-09-26", "2026-09-27",
	// 国庆 10/1–10/7
	"2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05",
	"2026-10-06", "2026-10-07"
]);

/** Off-peak multiplier applied to the peak price. */
export const OFF_PEAK_MULTIPLIER = 0.5;

/** Beijing years the statutory-holiday table covers, derived so it cannot drift. */
const PEAK_HOLIDAY_YEARS = new Set([...PEAK_HOLIDAYS].map((date) => date.slice(0, 4)));

/**
 * Whether the holiday table can answer for one instant's Beijing year.
 *
 * `isPeakAt` still returns a verdict outside the covered years — it just
 * assumes no holiday, which bills a weekday holiday at peak. Callers surface
 * that gap (`costMeta.holidayCoverage`) instead of letting a stale table look
 * like a correct number.
 * @param timeMs - event or clock timestamp.
 * @param holidays - the table in use (`YYYY-MM-DD` dates).
 * @returns `{ covered, year }` for the Beijing year containing `timeMs`.
 */
export function holidayCoverageAt(timeMs, holidays = PEAK_HOLIDAYS) {
	const beijing = new Date(timeMs + 8 * 60 * 60 * 1000);
	const year = beijing.getUTCFullYear();
	if (holidays === PEAK_HOLIDAYS) return { covered: PEAK_HOLIDAY_YEARS.has(String(year)), year };
	for (const date of holidays) if (date.startsWith(`${year}-`)) return { covered: true, year };
	return { covered: false, year };
}

/**
 * Whether one instant falls inside a billed peak window.
 * @param timeMs - event timestamp.
 * @param holidays - `YYYY-MM-DD` dates billed as off-peak all day.
 * @returns true for peak.
 */
export function isPeakAt(timeMs, holidays = PEAK_HOLIDAYS) {
	const beijing = new Date(timeMs + 8 * 60 * 60 * 1000);
	const weekday = beijing.getUTCDay();
	if (weekday === 0 || weekday === 6) return false;
	const hour = beijing.getUTCHours();
	if (!((hour >= 9 && hour < 12) || (hour >= 14 && hour < 18))) return false;
	const month = String(beijing.getUTCMonth() + 1).padStart(2, "0");
	const day = String(beijing.getUTCDate()).padStart(2, "0");
	return !holidays.has(`${beijing.getUTCFullYear()}-${month}-${day}`);
}

/**
 * Cost of one bucket set at a per-million-token price, in the price's currency.
 * @param buckets - token buckets.
 * @param price - `{ input, output, cacheRead, cacheWrite }` per 1M tokens.
 * @returns cost, or null when no price is known.
 */
export function bucketsCost(buckets, price) {
	if (price === void 0 || price === null) return null;
	return ((buckets.inputTokens ?? 0) * (price.input ?? 0)
		+ (buckets.outputTokens ?? 0) * (price.output ?? 0)
		+ (buckets.cacheReadTokens ?? 0) * (price.cacheRead ?? 0)
		+ (buckets.cacheWriteTokens ?? 0) * (price.cacheWrite ?? 0)) / 1e6;
}

/**
 * Fold a slice of NEW events onto an existing session state (mutating).
 * Replacements for the same (turn, step) subtract the previous sample's
 * buckets from the day/model bucket they were attributed to, so a slice
 * starting mid-step (e.g. a usage chunk at the tail of the previous fold)
 * stays exact.
 * @param state - session fold state (mutated in place).
 * @param events - the new events, in seq order, starting after the last fold.
 */
export function applyUsageDelta(state, events) {
	let last = state.lastSample;
	let currentModel = state.currentModel;
	for (const event of events) {
		if (event.type === "llm/retry-started" && last?.key === `${event.data.turn}:${event.data.step}`) last = null;
		if (event.type === "request/header") {
			const model = modelOf(event);
			if (model !== void 0) currentModel = model;
		}
		const sample = sampleOf(event);
		if (sample === void 0) continue;
		const buckets = bucketsOf(sample.usage);
		const model = modelOf(event) ?? currentModel ?? "unknown/unknown";
		const day = dayKey(event.time);
		const peak = isPeakAt(event.time);
		const entry = entryOf(state.days, day);
		if (last !== null && last.key === sample.key) {
			// Same turn/step re-reported: replace instead of double counting.
			const previous = state.days.get(last.day);
			if (previous !== void 0) {
				subtractFrom(previous.totals, last.buckets);
				const previousModel = previous.models.get(last.model);
				if (previousModel !== void 0) subtractFrom(previousModel, last.buckets);
				if (last.peak === true) {
					subtractFrom(previous.peakTotals, last.buckets);
					const previousPeakModel = previous.peakModels.get(last.model);
					if (previousPeakModel !== void 0) subtractFrom(previousPeakModel, last.buckets);
				}
			}
		}
		addInto(entry.totals, buckets);
		let modelBucket = entry.models.get(model);
		if (modelBucket === void 0) {
			modelBucket = zeroBuckets();
			entry.models.set(model, modelBucket);
		}
		addInto(modelBucket, buckets);
		if (peak) {
			addInto(entry.peakTotals, buckets);
			let peakBucket = entry.peakModels.get(model);
			if (peakBucket === void 0) {
				peakBucket = zeroBuckets();
				entry.peakModels.set(model, peakBucket);
			}
			addInto(peakBucket, buckets);
		}
		last = { key: sample.key, day, model, buckets, peak };
	}
	state.lastSample = last;
	state.currentModel = currentModel;
}

/**
 * Fold one session's events into per-day, per-model token buckets.
 * @param events - session event log in seq order.
 * @returns Map<`YYYY-MM-DD`, { totals, models: Map<model, buckets> }> with
 *   only days that saw usage.
 */
export function foldUsage(events) {
	const state = createUsageState();
	applyUsageDelta(state, events);
	return state.days;
}

/**
 * Merge one session's folded days into a global per-day map.
 * @param byDay - global map to mutate.
 * @param sessionDays - session day map (from foldUsage or a state).
 */
export function mergeInto(byDay, sessionDays, sessionId) {
	for (const [day, entry] of sessionDays) {
		const target = entryOf(byDay, day);
		addInto(target.totals, entry.totals);
		for (const [model, buckets] of entry.models) {
			let modelBucket = target.models.get(model);
			if (modelBucket === void 0) {
				modelBucket = zeroBuckets();
				target.models.set(model, modelBucket);
			}
			addInto(modelBucket, buckets);
		}
		if (sessionId !== void 0) target.sessions.set(sessionId, entry);
		addInto(target.peakTotals, entry.peakTotals);
		for (const [model, buckets] of entry.peakModels) {
			let peakBucket = target.peakModels.get(model);
			if (peakBucket === void 0) {
				peakBucket = zeroBuckets();
				target.peakModels.set(model, peakBucket);
			}
			addInto(peakBucket, buckets);
		}
	}
}

/** Split total buckets into their off-peak remainder (never negative). */
function offPeakBuckets(total, peak) {
	return {
		inputTokens: Math.max(0, (total.inputTokens ?? 0) - (peak.inputTokens ?? 0)),
		outputTokens: Math.max(0, (total.outputTokens ?? 0) - (peak.outputTokens ?? 0)),
		cacheReadTokens: Math.max(0, (total.cacheReadTokens ?? 0) - (peak.cacheReadTokens ?? 0)),
		cacheWriteTokens: Math.max(0, (total.cacheWriteTokens ?? 0) - (peak.cacheWriteTokens ?? 0))
	};
}

/** Price lookup for one model key (exact key first, then the bare model id). */
function priceLookup(pricing) {
	if (pricing === null || pricing === void 0) return () => null;
	const prices = pricing.prices ?? pricing;
	return (model) => {
		const direct = typeof prices.get === "function" ? prices.get(model) : prices[model];
		if (direct !== void 0) return direct;
		if (!model.includes("/")) return null;
		const bare = model.slice(model.indexOf("/") + 1);
		return typeof prices.get === "function" ? prices.get(bare) ?? null : prices[bare] ?? null;
	};
}

/**
 * Effective off-peak rate for one price.
 * `peakAware: false` marks a flat catalog price: it has no published off-peak
 * half price, so its off-peak spend stays at the full rate.
 */
function offPeakRate(price, multiplier) {
	return price.peakAware === false ? 1 : multiplier;
}

/**
 * Cost of one model map at the given prices, splitting peak and off-peak.
 * A single unpriced model makes the whole sum untrustworthy, so it returns
 * null instead of a partial number (and records the model in `unpriced`).
 * @param models - Map<model, buckets>.
 * @param peakModels - Map<model, peak buckets>.
 * @param pricing - `{ prices: Map<model, price>, currency, source }` or null.
 * @param multiplier - off-peak price multiplier.
 * @param unpriced - collector for model keys without a price.
 * @returns `{ total, peak, offPeak }` or null.
 */
function costOf(models, peakModels, pricing, multiplier, unpriced) {
	if (pricing === null || pricing === void 0) return null;
	const lookup = priceLookup(pricing);
	let total = 0;
	let peak = 0;
	let offPeak = 0;
	let priced = false;
	let missing = false;
	for (const [model, buckets] of models) {
		const price = lookup(model);
		if (price === null || price === void 0) {
			unpriced.add(model);
			missing = true;
			continue;
		}
		priced = true;
		const peakBuckets = peakModels?.get(model) ?? zeroBuckets();
		const peakCost = bucketsCost(peakBuckets, price) ?? 0;
		const offCost = (bucketsCost(offPeakBuckets(buckets, peakBuckets), price) ?? 0) * offPeakRate(price, multiplier);
		peak += peakCost;
		offPeak += offCost;
		total += peakCost + offCost;
	}
	if (!priced || missing) return null;
	return { total, peak, offPeak };
}

/**
 * Render a global per-day map into the wire shape for the usage endpoint.
 *
 * `days` is windowed (`options.windowDays`, 0 = everything): the panel's
 * heatmap spans eight weeks, so a multi-year array would make every poll carry
 * history nothing draws. `total` always aggregates every day.
 * @param byDay - day → entry map.
 * @param now - the instant the aggregation ran; it anchors the window and is
 *   not echoed into the payload (a changing timestamp would defeat the ETag).
 * @param options - `{ pricing, offPeakMultiplier, holidayCoverage, windowDays }`.
 * @returns `{ days, total, costMeta, peak }`; `days` sorted ascending, each
 *   carrying its token totals, `cacheHitRate`, per-session rows and a `cost`
 *   split into peak/off-peak. `updatedAt` stays a parameter (it anchors the
 *   window) but is not echoed: the client stamps its own fetch time, and a
 *   changing timestamp would defeat the response ETag.
 */
export function renderUsage(byDay, now = Date.now(), options = {}) {
	const pricing = options.pricing ?? null;
	const multiplier = Number.isFinite(options.offPeakMultiplier) ? options.offPeakMultiplier : OFF_PEAK_MULTIPLIER;
	const coverage = options.holidayCoverage;
	const windowDays = Number.isFinite(options.windowDays) && options.windowDays > 0 ? Math.floor(options.windowDays) : 0;
	const unpriced = new Set();
	let entries = [...byDay.entries()];
	if (windowDays > 0) {
		const cutoff = new Date(now);
		cutoff.setDate(cutoff.getDate() - windowDays);
		const cutoffKey = dayKey(cutoff.getTime());
		entries = entries.filter(([date]) => date >= cutoffKey);
	}
	const days = entries
		.map(([date, entry]) => ({
			date,
			...entry.totals,
			tokens: totalTokens(entry.totals),
			cacheHitRate: cacheHitRate(entry.totals),
			sessions: entry.sessions === void 0 ? [] : [...entry.sessions.entries()].map(([id, session]) => ({
				id,
				...session.totals,
				tokens: totalTokens(session.totals),
				cacheHitRate: cacheHitRate(session.totals),
				cost: costOf(session.models, session.peakModels, pricing, multiplier, unpriced)
			})).sort((a, b) => b.tokens - a.tokens),
			cost: costOf(entry.models, entry.peakModels, pricing, multiplier, unpriced)
		}))
		.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
	const total = zeroBuckets();
	const allModels = new Map();
	const allPeak = new Map();
	for (const [, entry] of byDay) {
		addInto(total, entry.totals);
		for (const [model, buckets] of entry.models) {
			let merged = allModels.get(model);
			if (merged === void 0) {
				merged = zeroBuckets();
				allModels.set(model, merged);
			}
			addInto(merged, buckets);
			let peakMerged = allPeak.get(model);
			if (peakMerged === void 0) {
				peakMerged = zeroBuckets();
				allPeak.set(model, peakMerged);
			}
			addInto(peakMerged, entry.peakModels.get(model) ?? zeroBuckets());
		}
	}
	return {
		days,
		total: {
			...total,
			tokens: totalTokens(total),
			cacheHitRate: cacheHitRate(total),
			cost: costOf(allModels, allPeak, pricing, multiplier, unpriced)
		},
		costMeta: pricing === null
			? null
			: {
				currency: typeof pricing.currency === "string" ? pricing.currency : "CNY",
				source: typeof pricing.source === "string" ? pricing.source : "unknown",
				offPeakMultiplier: multiplier,
				unpriced: [...unpriced].sort(),
				// "uncovered" means the holiday table ends before this year, so a
				// weekday holiday is billed as peak. Never reported as "covered"
				// unless the caller actually checked.
				holidayCoverage: coverage === void 0 ? "unknown" : coverage.covered === false ? "uncovered" : "covered",
				...(coverage !== void 0 && coverage.covered === false ? { holidayYear: coverage.year } : {})
			},
		// Which band the clock is in right now, judged by the same table that
		// splits the cost. `null` when the caller did not supply a verdict.
		peak: options.peakNow === void 0 ? null : options.peakNow === true ? "yellow" : "green"
	};
}
