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
			peakModels: new Map()
		};
		byDay.set(day, entry);
	}
	return entry;
}

/**
 * One session's incremental fold state. `days` holds the already-folded
 * per-day entries; `hours` holds per-day, per-hour token totals (24 slots)
 * for the activity heatmap; `lastSample`/`currentModel` let a later event
 * slice keep the replace-last-sample semantics and model attribution across
 * fold boundaries without replaying the whole log.
 */
export function createUsageState() {
	return {
		days: new Map(),
		hours: new Map(),
		lastSample: null,
		currentModel: null,
		consumed: 0
	};
}

/** Per-day hour array (24 slots, all zero). */
export function zeroHours() {
	return new Array(24).fill(0);
}

/** Hour slot for an event's timestamp (local time, 0–23). */
export function hourOf(timeMs) {
	return new Date(timeMs).getHours();
}

/**
 * Peak windows are judged on the Beijing clock, not the host clock:
 * Monday–Friday 09:00–12:00 and 14:00–18:00 are peak, everything else
 * (including weekends) is off-peak. DeepSeek bills off-peak at half price.
 *
 * Public holidays are excluded by the official rule; `PEAK_HOLIDAYS` is the
 * single place to add them (`YYYY-MM-DD`). It is empty for now, so a weekday
 * holiday is (incorrectly) priced as peak until dates are added.
 */
export const PEAK_HOLIDAYS = new Set();

/** Off-peak multiplier applied to the peak price. */
export const OFF_PEAK_MULTIPLIER = 0.5;

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

function hourEntryOf(state, day) {
	let hours = state.hours.get(day);
	if (hours === void 0) {
		hours = zeroHours();
		state.hours.set(day, hours);
	}
	return hours;
}

/**
 * Fold a slice of NEW events onto an existing session state (mutating).
 * Replacements for the same (turn, step) subtract the previous sample's
 * buckets from the day/model/hour bucket they were attributed to, so a slice
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
		const hour = hourOf(event.time);
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
			const previousHours = state.hours.get(last.day);
			if (previousHours !== void 0 && last.hour !== void 0) {
				previousHours[last.hour] -= totalTokens(last.buckets);
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
		const hourEntry = hourEntryOf(state, day);
		hourEntry[hour] += totalTokens(buckets);
		last = { key: sample.key, day, hour, model, buckets, peak };
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
export function mergeInto(byDay, sessionDays) {
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

/** Merge one session's per-day hour totals into a global hour map. */
export function mergeHoursInto(byHour, sessionHours) {
	for (const [day, hours] of sessionHours) {
		let target = byHour.get(day);
		if (target === void 0) {
			target = zeroHours();
			byHour.set(day, target);
		}
		for (let i = 0; i < 24; i += 1) target[i] += hours[i] ?? 0;
	}
}

/** Merge one session fold into a global per-day map (convenience wrapper). */
export function consumeEvents(byDay, events) {
	mergeInto(byDay, foldUsage(events));
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

/** Spend for one model, split at the peak/off-peak boundary. */
function modelCost(buckets, peakBuckets, price, multiplier) {
	if (price === null || price === void 0) return null;
	const peak = bucketsCost(peakBuckets, price) ?? 0;
	const offPeak = (bucketsCost(offPeakBuckets(buckets, peakBuckets), price) ?? 0) * multiplier;
	return { total: peak + offPeak, peak, offPeak };
}

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
		const offCost = (bucketsCost(offPeakBuckets(buckets, peakBuckets), price) ?? 0) * multiplier;
		peak += peakCost;
		offPeak += offCost;
		total += peakCost + offCost;
	}
	if (!priced || missing) return null;
	return { total, peak, offPeak };
}

/**
 * Render a global per-day map into the wire shape for the usage endpoint.
 * @param byDay - day → entry map.
 * @param byHour - day → 24-slot hour totals map (activity heatmap source).
 * @param updatedAt - computation timestamp.
 * @param options - `{ pricing, offPeakMultiplier }`; pricing supplies
 *   per-model per-million-token prices (CNY by default).
 * @returns `{ days, total, updatedAt, costMeta }` with `days` sorted
 *   ascending; each day carries `models` (descending by tokens), a
 *   `cacheHitRate` percent, an `hours` array (24 slots, token totals per
 *   local hour), and a `cost` split into peak/off-peak.
 */
export function renderUsage(byDay, byHour, updatedAt, options = {}) {
	const pricing = options.pricing ?? null;
	const multiplier = Number.isFinite(options.offPeakMultiplier) ? options.offPeakMultiplier : OFF_PEAK_MULTIPLIER;
	const unpriced = new Set();
	const days = [...byDay.entries()]
		.map(([date, entry]) => {
			const models = [...entry.models.entries()]
				.map(([model, buckets]) => ({
					model,
					...buckets,
					tokens: totalTokens(buckets),
					cacheHitRate: cacheHitRate(buckets),
					cost: modelCost(buckets, entry.peakModels.get(model) ?? zeroBuckets(), priceLookup(pricing)(model), multiplier)
				}))
				.sort((a, b) => b.tokens - a.tokens);
			return {
				date,
				...entry.totals,
				tokens: totalTokens(entry.totals),
				cacheHitRate: cacheHitRate(entry.totals),
				hours: byHour.get(date) ?? zeroHours(),
				models,
				cost: costOf(entry.models, entry.peakModels, pricing, multiplier, unpriced)
			};
		})
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
				unpriced: [...unpriced].sort()
			},
		updatedAt
	};
}
