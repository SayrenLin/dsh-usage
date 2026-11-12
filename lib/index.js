/**
 * dsh-usage — server half.
 *
 * Registers three read-only, loopback-only endpoints on the web server:
 *   GET /api/usage/providers — configured providers + balance scheme/status
 *   GET /api/usage/balance   — balance for one provider (?provider=<id>)
 *   GET /api/usage/usage     — per-day token usage across every session
 *
 * Provider configuration is read straight from the harness settings
 * (`llm-deepseek` for the official DeepSeek route, `llm-pi-ai` for every
 * configured pi-ai provider profile), and each provider's API key is resolved
 * through the credentials seam at request time — nothing secret is stored by
 * this plugin. Upstream balance queries go through lib/safe-fetch.js (HTTPS,
 * private-network rejection, DNS pinning).
 *
 * The endpoints live under the `/api` prefix as exact routes, so they win
 * over the connection plugin's `/api` prefix handler; each handler applies
 * its own peer-socket loopback fence. Host is checked only as an additional
 * defense.
 *
 * Usage aggregation is INCREMENTAL: per-session fold state (day/model
 * buckets plus the last usage sample) is cached in memory and persisted to
 * `<DSH_HOME>/storages/usage-cache.json`, so steady-state cost stays
 * O(new events) on the legacy reader. On 0.2, unchanged session revisions
 * are reused; changed sessions are refolded because a revision change does
 * not guarantee the old prefix survived a rewrite or truncation.
 *
 * Background refresh queries every configured balance and folds token usage
 * immediately at startup and then every five minutes.
 *
 * @module dsh-usage
 */

import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { balanceSchemeOf, queryBalance } from "./balance.js";
import { safeFetch } from "./safe-fetch.js";
import { applyUsageDelta, createUsageState, holidayCoverageAt, isPeakAt, mergeInto, renderUsage, totalTokens } from "./usage.js";

/** Stable Cordis plugin name. */
const name = "usage";

/** Services required before this plugin activates. */
const inject = ["webServer", "credentials", "sessions", "sessionPersistence", "settings", "llm"];

const USAGE_PATH = "/api/usage/usage";
const PROVIDERS_PATH = "/api/usage/providers";
const BALANCE_PATH = "/api/usage/balance";
const UPSTREAM_TIMEOUT_MS = 15000;
const REFRESH_MS = 300000;
const CACHE_VERSION = 6;
/**
 * Days of per-day detail sent to the client. The panel draws eight weeks of
 * heatmap; anything older would only grow every poll's payload, while `total`
 * still aggregates the full history server-side.
 */
const USAGE_WINDOW_DAYS = 63;
/**
 * Tail folds allowed before a session is re-derived from its whole log.
 *
 * The tail path trusts "the log only grew" — an opaque revision does not
 * prove the prefix survived, so a host that rewrites a growing log would
 * leave the fold silently wrong. Twenty appends (~10 minutes of polling) is
 * cheap to verify and bounds how long such a drift could survive.
 */
const MODERN_EXTENSION_LIMIT = 20;
/** Provider enumeration hits two async host services; the panel polls every 30s. */
const PROVIDERS_TTL_MS = 60000;
/** The cache is a materialized view of the logs; rewriting it every 30s is waste. */
const CACHE_WRITE_INTERVAL_MS = 300000;
/** Above this the per-session fold state is worth archiving; warn once, do not prune. */
const CACHE_SIZE_WARN_BYTES = 2 * 1024 * 1024;
/** Inference route served by account login instead of an API key. */
const ACCOUNT_PROVIDER_ID = "deepseek-account";

/** Default DeepSeek connection facts when the settings namespace is absent. */
const DEEPSEEK_DEFAULTS = {
	apiKeyEnv: "DEEPSEEK_API_KEY",
	baseURL: "https://api.deepseek.com"
};

/** Legacy balance providers shown even without a pi-ai profile. */
// No hardcoded provider defaults: only what DSH is configured with is listed.
const LEGACY_PROVIDERS = [];

/**
 * DeepSeek's official price list, CNY per 1M tokens at the PEAK rate
 * (https://api-docs.deepseek.com/zh-cn/quick_start/pricing). Off-peak is
 * exactly half. Model ids match the catalog ids DSH uses.
 */
const OFFICIAL_PRICES = new Map([
	["deepseek-flash", { input: 2, output: 8, cacheRead: 0.04, cacheWrite: 0 }],
	["deepseek-v4-pro", { input: 9, output: 27, cacheRead: 0.3, cacheWrite: 0 }]
]);

/** DSH's model catalog quotes USD; it is the official CNY list divided by this. */
const USD_CNY = 6.667;
const PRICING_TTL_MS = 300000;
/**
 * Single-slot price cache. The key is the ENTIRE model set seen in history, so
 * it only changes when a model appears or disappears. If pricing ever moves to
 * per-day/per-session subsets, those keys would alternate and this slot would
 * miss on every poll — switch it to a bounded Map at that point.
 */
let pricingCache = null;
/** Last year the missing-holiday warning was logged for (one line per year, not per poll). */
let warnedHolidayYear = null;

/**
 * Content-derived ETag for a JSON body. Deterministic because the payload has
 * no timestamps: two identical polls produce the same tag, so the client can
 * turn "nothing changed" into a 304 instead of re-transferring the window.
 * @param body - serialized response body.
 * @returns quoted ETag value.
 */
function bodyEtag(body) {
	let hash = 0x811c9dc5;
	for (let index = 0; index < body.length; index += 1) {
		hash ^= body.charCodeAt(index);
		hash = Math.imul(hash, 0x01000193);
	}
	return `"${(hash >>> 0).toString(16)}"`;
}

/** Write a JSON response, honouring If-None-Match. */
function jsonCached(req, res, value) {
	const body = JSON.stringify(value);
	const etag = bodyEtag(body);
	if (req.headers["if-none-match"] === etag) {
		res.writeHead(304, { etag, "cache-control": "no-cache" });
		res.end();
		return;
	}
	res.writeHead(200, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-cache",
		etag
	});
	res.end(body);
}

/** Write a JSON response. */
function json(res, status, value) {
	const body = JSON.stringify(value);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-cache"
	});
	res.end(body);
}

/**
 * Loopback fence, primary on the PEER SOCKET address (not the
 * client-controllable Host header): the request must come from a loopback
 * interface. IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is normalized. The Host
 * header is kept as an additional check, never as the deciding one.
 */
export function isLoopbackAddress(address) {
	if (typeof address !== "string") return false;
	const a = address.toLowerCase();
	if (a === "::1") return true;
	const ipv4 = a.startsWith("::ffff:") ? a.slice(7) : a;
	const octets = ipv4.split(".");
	return octets.length === 4 && octets[0] === "127" && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** Parse a Host header without breaking bracketed or bare IPv6 literals. */
function hostNameOf(value) {
	if (typeof value !== "string") return null;
	const host = value.trim().toLowerCase();
	if (host.startsWith("[")) {
		const close = host.indexOf("]");
		if (close <= 1) return null;
		const suffix = host.slice(close + 1);
		if (suffix !== "" && !/^:\d+$/.test(suffix)) return null;
		return host.slice(1, close);
	}
	const firstColon = host.indexOf(":");
	const lastColon = host.lastIndexOf(":");
	if (firstColon !== lastColon) return host;
	if (lastColon === -1) return host.replace(/\.$/, "");
	if (!/^\d+$/.test(host.slice(lastColon + 1))) return null;
	return host.slice(0, lastColon).replace(/\.$/, "");
}

function isLoopbackHostHeader(req) {
	const name = hostNameOf(req.headers.host);
	return name === "localhost" || isLoopbackAddress(name);
}

/** Refuse non-loopback callers and non-GET methods before any work. */
export function rejectForeignCaller(req, res) {
	if (req.method !== "GET") {
		res.writeHead(405, { "content-type": "application/json; charset=utf-8" });
		res.end(JSON.stringify({ ok: false, error: "method-not-allowed" }));
		return true;
	}
	const peer = req.socket?.remoteAddress;
	if (isLoopbackAddress(peer) && isLoopbackHostHeader(req)) return false;
	json(res, 403, { ok: false, error: "forbidden" });
	return true;
}

//#region balance service

/** Resolve a credential reference through the harness credentials seam. */
async function resolveCredential(credentials, ref) {
	if (typeof ref !== "string" || ref === "") return "";
	if (credentials === null || credentials === void 0 || typeof credentials.resolve !== "function") return "";
	try {
		const hit = await credentials.resolve(ref);
		const value = typeof hit?.value === "string" ? hit.value.trim() : "";
		return value;
	} catch {
		return "";
	}
}

/** Only API-key records are understood; OAuth/grant payloads stay opaque. */
async function providerCredential(credentials, provider) {
	if (typeof provider.apiKeyEnv === "string") return resolveCredential(credentials, provider.apiKeyEnv);
	if (typeof provider.credentialRecord !== "string" || typeof credentials?.readRecord !== "function") return "";
	try {
		const record = await credentials.readRecord(provider.credentialRecord);
		return record?.kind === "api-key" && typeof record.key === "string" ? record.key.trim() : "";
	} catch {
		return "";
	}
}

/**
 * Enumerate the harness's configured providers: the official DeepSeek route
 * (`llm-deepseek` settings namespace) plus every pi-ai provider profile
 * (`llm-pi-ai` settings namespace), plus legacy balance providers when no
 * pi-ai profile of the same id exists. Each entry carries the connection
 * facts (credential ref + base URL) needed to query a balance — no keys.
 */
export async function configuredProviders(ctx) {
	const settings = ctx.get("settings");
	if (typeof settings?.describe === "function") {
		// 0.2 forms are keyed by profile entry id, not a fixed plugin namespace.
		// Request redaction even on the server; only endpoint/ref metadata is used.
		const forms = await settings.describe({ redactSecrets: true });
		const sections = new Map(forms.map((entry) => [entry.ns, entry.value]));
		const llm = ctx.get("llm");
		if (typeof llm?.listConfigurableProviders !== "function") throw new Error("usage: provider directory unavailable");
		const modern = [];
		for (const entry of await llm.listConfigurableProviders()) {
			let profile = sections.get(entry.settingsNs);
			for (const part of entry.settingsPath) profile = profile !== null && typeof profile === "object" && Object.hasOwn(profile, part) ? profile[part] : void 0;
			if (profile === null || typeof profile !== "object") continue;
			// Account login owns its credential inside the host: no API key, no
			// base URL of our own to read, so it is listed and answered by the
			// host's deepseekAccount service instead of the HTTP balance path.
			if (entry.provider === ACCOUNT_PROVIDER_ID) {
				modern.push({ id: ACCOUNT_PROVIDER_ID, displayName: entry.displayName ?? "DeepSeek 账户", accountMode: true });
				continue;
			}
			const legacy = LEGACY_PROVIDERS.find((provider) => provider.id === entry.provider);
			modern.push({
				id: entry.provider,
				displayName: entry.displayName,
				apiKeyEnv: typeof profile.apiKeyEnv === "string" ? profile.apiKeyEnv : entry.provider === "deepseek-official" ? DEEPSEEK_DEFAULTS.apiKeyEnv : legacy?.apiKeyEnv,
				baseURL: typeof profile.baseURL === "string" ? profile.baseURL : entry.provider === "deepseek-official" ? DEEPSEEK_DEFAULTS.baseURL : legacy?.baseURL,
				// Do not use an OpenRouter inference record as a Management Key.
				credentialRecord: entry.settingsPath[0] === "providers" && entry.provider !== "openrouter" && /^[a-z][a-z0-9-]*$/.test(entry.provider) ? `llm-pi-ai/${entry.provider}` : void 0
			});
		}
		// The official route is always listed (it is the built-in default); every
		// other provider must come from the host profile. Legacy ids are NOT
		// appended here — the UI only shows what the user actually configured.
		if (!modern.some((provider) => provider.id === "deepseek-official")) modern.unshift({ id: "deepseek-official", displayName: "DeepSeek", ...DEEPSEEK_DEFAULTS });
		return withAccountProvider(ctx, modern);
	}
	const providers = [];
	const deepseek = settings?.get?.("llm-deepseek");
	if (deepseek !== void 0 && deepseek !== null && typeof deepseek === "object") {
		providers.push({
			id: "deepseek-official",
			displayName: "DeepSeek",
			apiKeyEnv: typeof deepseek.apiKeyEnv === "string" ? deepseek.apiKeyEnv : DEEPSEEK_DEFAULTS.apiKeyEnv,
			baseURL: typeof deepseek.baseURL === "string" ? deepseek.baseURL : DEEPSEEK_DEFAULTS.baseURL
		});
	} else {
		providers.push({
			id: "deepseek-official",
			displayName: "DeepSeek",
			apiKeyEnv: DEEPSEEK_DEFAULTS.apiKeyEnv,
			baseURL: DEEPSEEK_DEFAULTS.baseURL
		});
	}
	const pi = settings?.get?.("llm-pi-ai");
	if (pi !== void 0 && pi !== null && typeof pi === "object" && pi.providers !== void 0 && typeof pi.providers === "object") {
		for (const [route, profile] of Object.entries(pi.providers)) {
			if (profile === null || typeof profile !== "object") continue;
			providers.push({
				id: route,
				displayName: typeof profile.displayName === "string" && profile.displayName.length > 0 ? profile.displayName : route,
				apiKeyEnv: typeof profile.apiKeyEnv === "string" ? profile.apiKeyEnv : void 0,
				baseURL: typeof profile.baseURL === "string" ? profile.baseURL : void 0
			});
		}
	}
	for (const legacy of LEGACY_PROVIDERS) {
		if (!providers.some((provider) => provider.id === legacy.id)) providers.push({ ...legacy });
	}
	return withAccountProvider(ctx, providers);
}

/**
 * Append the account-login route when the host owns that credential. The list
 * itself never carries the token: only the service can sign a platform request.
 * @param ctx - host context.
 * @param providers - provider entries built so far.
 * @returns the same list, with the account route when it is usable.
 */
function withAccountProvider(ctx, providers) {
	if (providers.some((provider) => provider.accountMode === true)) return providers;
	const accountService = ctx.get?.("deepseekAccount");
	if (accountService === null || accountService === void 0) return providers;
	providers.push({ id: ACCOUNT_PROVIDER_ID, displayName: "DeepSeek 账户", accountMode: true });
	return providers;
}

/**
 * Normalize the host account service's wallet projection into this plugin's
 * balance view. Strings stay strings (the platform sends exact decimals), and
 * only wallets of the reporting currency are summed.
 * @param normalWallets - topped-up wallets.
 * @param bonusWallets - granted wallets.
 * @returns normalized balance view.
 */
function walletsToBalance(normalWallets, bonusWallets) {
	const topped = Array.isArray(normalWallets) ? normalWallets : [];
	const bonus = Array.isArray(bonusWallets) ? bonusWallets : [];
	const currency = topped[0]?.currency ?? bonus[0]?.currency ?? "CNY";
	const sumOf = (wallets) => wallets
		.filter((wallet) => wallet?.currency === currency)
		.reduce((total, wallet) => total + (Number(wallet.balance) || 0), 0);
	const toppedUp = sumOf(topped);
	const granted = sumOf(bonus);
	return {
		isAvailable: toppedUp + granted > 0,
		currency,
		total: (toppedUp + granted).toFixed(2),
		toppedUp: toppedUp.toFixed(2),
		granted: granted.toFixed(2)
	};
}

/** Client metadata the platform expects on every account request. */
function accountClientMetadata(deps) {
	const locale = typeof Intl === "object" && typeof Intl.DateTimeFormat === "function"
		? Intl.DateTimeFormat().resolvedOptions().locale
		: "en-US";
	return deps.accountClient ?? {
		version: "dsh-usage-dock",
		locale,
		timezoneOffsetSeconds: -new Date().getTimezoneOffset() * 60
	};
}

/**
 * In-memory balance cache with per-provider single-flight and forced bulk
 * refresh. Background scheduling is owned by the server plugin so it can also
 * refresh local token-usage aggregation in the same five-minute cycle.
 */
export function createBalanceService({ credentials, getProviders, getAccountService = () => null, deps = {} }) {
	const cache = new Map();
	const inflight = new Map();
	const refreshMs = deps.refreshMs ?? REFRESH_MS;

	/** How a provider reports balance: account-login, HTTP scheme, or nothing. */
	function balanceModeOf(provider) {
		if (provider.accountMode === true) return "account";
		return balanceSchemeOf(provider.id) === null ? null : "balance";
	}

	async function queryOne(provider, force) {
		const scheme = balanceSchemeOf(provider.id);
		const mode = balanceModeOf(provider);
		const configKey = `${mode ?? "none"}|${scheme ?? "none"}|${provider.baseURL ?? ""}|${provider.apiKeyEnv ?? ""}|${provider.credentialRecord ?? ""}`;
		const hit = cache.get(provider.id);
		const age = (deps.now ?? Date.now)() - (hit?.account?.fetchedAt ?? 0);
		if (!force && hit?.configKey === configKey && age >= 0 && age < refreshMs) return hit.account;
		const existing = inflight.get(provider.id);
		if (existing !== void 0) return existing;
		const promise = (async () => {
			const account = {
				id: provider.id,
				displayName: provider.displayName,
				scheme,
				mode: mode ?? "unsupported",
				status: "pending",
				balance: null,
				fetchedAt: (deps.now ?? Date.now)()
			};
			if (mode === null) return account;
			if (deps.disabled === true) {
				account.status = "disabled";
				return account;
			}
			if (mode === "account") {
				const accountService = getAccountService();
				if (accountService === null || accountService === void 0 || typeof accountService.getBalance !== "function") {
					account.status = "unsupported";
					return account;
				}
				try {
					const state = typeof accountService.getState === "function" ? await accountService.getState() : null;
					if (state !== null && state !== void 0 && state.status !== "credential-stored") {
						account.status = "signed-out";
						return account;
					}
					// The host reads the grant and signs the platform request; this
					// plugin never sees that token.
					const summary = await accountService.getBalance(accountClientMetadata(deps));
					if (summary === null) {
						account.status = "signed-out";
						return account;
					}
					if (summary.status !== "ready") {
						account.status = "unavailable";
						account.error = "account balance is unavailable";
						return account;
					}
					account.balance = walletsToBalance(summary.value, summary.bonusWallets);
					account.status = "ok";
				} catch (error) {
					account.status = "unavailable";
					account.error = error instanceof Error ? error.message : String(error);
				}
				return account;
			}
			if (typeof provider.baseURL !== "string" || provider.baseURL === "") {
				account.status = "not-configured";
				account.missingCredentials = ["baseURL"];
				return account;
			}
			const apiKey = await providerCredential(credentials, provider);
			if (apiKey === "") {
				account.status = "not-configured";
				account.missingCredentials = [provider.apiKeyEnv ?? provider.credentialRecord ?? "apiKey"];
				return account;
			}
			try {
				const fetchImpl = deps.fetchImpl ?? ((url, init) => safeFetch(url, init, deps));
				account.balance = await queryBalance(scheme, provider.baseURL, apiKey, deps.timeoutMs ?? UPSTREAM_TIMEOUT_MS, fetchImpl);
				account.status = "ok";
			} catch (error) {
				account.status = error?.providerStatus ?? (error?.name === "TimeoutError" || error?.name === "AbortError" ? "unavailable" : "unavailable");
				account.error = error instanceof Error ? error.message : String(error);
			}
			return account;
		})();
		inflight.set(provider.id, promise);
		try {
			const account = await promise;
			cache.set(provider.id, { configKey, account });
			return account;
		} finally {
			inflight.delete(provider.id);
		}
	}

	async function get(providerId, { force = false } = {}) {
		const provider = (await getProviders()).find((entry) => entry.id === providerId);
		if (provider === void 0) return null;
		return queryOne(provider, force);
	}

	async function refreshAll() {
		if (deps.disabled === true) return [];
		const providers = await getProviders();
		return Promise.allSettled(providers.filter((provider) => balanceModeOf(provider) !== null).map((provider) => queryOne(provider, true)));
	}

	async function providerViews() {
		const providers = await getProviders();
		return Promise.all(providers.map(async (provider) => {
			const cached = cache.get(provider.id)?.account;
			const scheme = balanceSchemeOf(provider.id);
			const mode = balanceModeOf(provider);
			let configured = false;
			if (deps.disabled === true) configured = false;
			else if (mode === "account") {
				const accountService = getAccountService();
				const state = accountService !== null && accountService !== void 0 && typeof accountService.getState === "function"
					? await accountService.getState().catch(() => null)
					: null;
				configured = state?.status === "credential-stored";
			} else if (cached !== void 0) configured = cached.status !== "not-configured";
			else if (mode === "balance") configured = await providerCredential(credentials, provider) !== "";
			return {
				id: provider.id,
				displayName: provider.displayName,
				scheme,
				mode,
				configured,
				status: deps.disabled === true && mode !== null ? "disabled" : cached?.status ?? "pending",
				fetchedAt: cached?.fetchedAt ?? null,
				balance: cached?.balance ?? null
			};
		}));
	}

	return {
		get,
		refreshAll,
		providerViews,
		validate: async () => { await getProviders(); },
		cached: (providerId) => cache.get(providerId)?.account ?? null
	};
}

//#endregion

//#region incremental usage cache

/** Cache file location under the dsh home. */
export function dshHomeOf() {
	const raw = process.env.DSH_HOME;
	const home = typeof raw === "string" && raw.trim().length > 0 ? raw : join(homedir(), ".dsh");
	return resolve(home === "~" ? homedir() : home.startsWith("~/") || home.startsWith("~\\") ? join(homedir(), home.slice(2)) : home);
}

function cachePath() {
	return join(dshHomeOf(), "storages", "usage-cache.json");
}

/**
 * Human title for a session. The persistence header has no title, but the
 * host's projection cache stores one (record.rows.title.val). Read it with an
 * mtime guard and fall back to null so the client can use its own label.
 */
const titleCache = new Map();
async function sessionTitleOf(_ctx, sessionId) {
	const key = String(sessionId);
	const file = join(dshHomeOf(), "storages", "session_projcache", "sessions", `${key}.json`);
	try {
		const info = await stat(file);
		const cached = titleCache.get(key);
		if (cached !== void 0 && cached.mtimeMs === info.mtimeMs) return cached.title;
		const parsed = JSON.parse(await readFile(file, "utf8"));
		const raw = parsed?.record?.rows?.title?.val;
		const title = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : null;
		titleCache.set(key, { mtimeMs: info.mtimeMs, title });
		return title;
	} catch {
		return null;
	}
}

let loadedCache = null;
let loadPromise = null;
/**
 * Whether the in-memory fold differs from what is on disk. A poll that folds
 * nothing (the common case between turns) must not rewrite the cache file.
 */
let cacheDirty = false;
/** Last successful cache write, and the session set that was written. */
let lastCacheWriteAt = 0;
let lastSessionKeys = "";
let warnedCacheSize = false;
let inflight = null;
let loadedCachePath = null;
// Handle-API revisions are process/service-local. Never serialize them.
let modernPersistenceIdentity = null;
let modernRevisions = new Map();

/** Serialize one session's fold state (Maps → plain objects). */
function serializeSession(state) {
	const days = {};
	for (const [date, entry] of state.days) {
		const models = {};
		for (const [model, buckets] of entry.models) models[model] = { ...buckets };
		const peakModels = {};
		for (const [model, buckets] of entry.peakModels ?? new Map()) peakModels[model] = { ...buckets };
		days[date] = { totals: { ...entry.totals }, models, peakTotals: { ...entry.peakTotals }, peakModels };
	}
	return {
		kind: state.kind ?? "persisted",
		consumed: state.consumed ?? 0,
		...(state.revision === void 0 ? {} : { revision: state.revision }),
		...(Number.isSafeInteger(state.inherited) ? { inherited: state.inherited } : {}),
		days,
		lastSample: state.lastSample === null ? null : {
			key: state.lastSample.key,
			day: state.lastSample.day,
			model: state.lastSample.model,
			buckets: { ...state.lastSample.buckets },
			peak: state.lastSample.peak === true
		},
		currentModel: state.currentModel
	};
}

/** Parse a serialized session entry back into fold state (lenient). */
function parseSession(raw) {
	const state = createUsageState();
	if (raw === null || typeof raw !== "object") return state;
	state.kind = typeof raw.kind === "string" ? raw.kind : "persisted";
	state.consumed = Number.isSafeInteger(raw.consumed) ? raw.consumed : 0;
	if (typeof raw.revision === "string") state.revision = raw.revision;
	if (Number.isSafeInteger(raw.inherited) && raw.inherited >= 0) state.inherited = raw.inherited;
	if (raw.days !== null && typeof raw.days === "object") {
		for (const [date, entry] of Object.entries(raw.days)) {
			if (entry === null || typeof entry !== "object") continue;
			const target = { totals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, models: new Map(), peakTotals: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, peakModels: new Map() };
			const totals = entry.totals;
			if (totals !== null && typeof totals === "object") {
				target.totals.inputTokens = Number.isFinite(totals.inputTokens) ? totals.inputTokens : 0;
				target.totals.outputTokens = Number.isFinite(totals.outputTokens) ? totals.outputTokens : 0;
				target.totals.cacheReadTokens = Number.isFinite(totals.cacheReadTokens) ? totals.cacheReadTokens : 0;
				target.totals.cacheWriteTokens = Number.isFinite(totals.cacheWriteTokens) ? totals.cacheWriteTokens : 0;
			}
			if (entry.models !== null && typeof entry.models === "object") {
				for (const [model, buckets] of Object.entries(entry.models)) {
					if (buckets === null || typeof buckets !== "object") continue;
					target.models.set(model, {
						inputTokens: Number.isFinite(buckets.inputTokens) ? buckets.inputTokens : 0,
						outputTokens: Number.isFinite(buckets.outputTokens) ? buckets.outputTokens : 0,
						cacheReadTokens: Number.isFinite(buckets.cacheReadTokens) ? buckets.cacheReadTokens : 0,
						cacheWriteTokens: Number.isFinite(buckets.cacheWriteTokens) ? buckets.cacheWriteTokens : 0
					});
				}
			}
			const peakTotals = entry.peakTotals;
			if (peakTotals !== null && typeof peakTotals === "object") {
				target.peakTotals.inputTokens = Number.isFinite(peakTotals.inputTokens) ? peakTotals.inputTokens : 0;
				target.peakTotals.outputTokens = Number.isFinite(peakTotals.outputTokens) ? peakTotals.outputTokens : 0;
				target.peakTotals.cacheReadTokens = Number.isFinite(peakTotals.cacheReadTokens) ? peakTotals.cacheReadTokens : 0;
				target.peakTotals.cacheWriteTokens = Number.isFinite(peakTotals.cacheWriteTokens) ? peakTotals.cacheWriteTokens : 0;
			}
			if (entry.peakModels !== null && typeof entry.peakModels === "object") {
				for (const [model, buckets] of Object.entries(entry.peakModels)) {
					if (buckets === null || typeof buckets !== "object") continue;
					target.peakModels.set(model, {
						inputTokens: Number.isFinite(buckets.inputTokens) ? buckets.inputTokens : 0,
						outputTokens: Number.isFinite(buckets.outputTokens) ? buckets.outputTokens : 0,
						cacheReadTokens: Number.isFinite(buckets.cacheReadTokens) ? buckets.cacheReadTokens : 0,
						cacheWriteTokens: Number.isFinite(buckets.cacheWriteTokens) ? buckets.cacheWriteTokens : 0
					});
				}
			}
			state.days.set(date, target);
		}
	}
	if (raw.lastSample !== null && raw.lastSample !== void 0 && typeof raw.lastSample === "object" && typeof raw.lastSample.key === "string" && typeof raw.lastSample.day === "string") {
		const buckets = raw.lastSample.buckets ?? {};
		state.lastSample = {
			key: raw.lastSample.key,
			day: raw.lastSample.day,
			model: typeof raw.lastSample.model === "string" ? raw.lastSample.model : "unknown",
			buckets: {
				inputTokens: Number.isFinite(buckets.inputTokens) ? buckets.inputTokens : 0,
				outputTokens: Number.isFinite(buckets.outputTokens) ? buckets.outputTokens : 0,
				cacheReadTokens: Number.isFinite(buckets.cacheReadTokens) ? buckets.cacheReadTokens : 0,
				cacheWriteTokens: Number.isFinite(buckets.cacheWriteTokens) ? buckets.cacheWriteTokens : 0
			},
			peak: raw.lastSample.peak === true
		};
	}
	if (typeof raw.currentModel === "string") state.currentModel = raw.currentModel;
	return state;
}

/** Load the cache once per process; any corruption degrades to a fresh cache. */
async function loadCache() {
	const path = cachePath();
	if (loadedCachePath !== path) {
		loadedCachePath = path;
		loadedCache = null;
		loadPromise = null;
		modernRevisions = new Map();
		lastCacheWriteAt = 0;
		lastSessionKeys = "";
	}
	if (loadedCache !== null) return loadedCache;
	loadPromise ??= (async () => {
		const fresh = { version: CACHE_VERSION, sessions: {} };
		try {
			const raw = await readFile(cachePath(), "utf8");
			const parsed = JSON.parse(raw);
			if (parsed !== null && typeof parsed === "object" && parsed.version === CACHE_VERSION && parsed.sessions !== null && typeof parsed.sessions === "object") {
				const sessions = {};
				for (const [id, entry] of Object.entries(parsed.sessions)) {
					if (typeof id === "string" && id.length > 0) sessions[id] = parseSession(entry);
				}
				return { version: CACHE_VERSION, sessions };
			}
		} catch {
			/* first run or corrupt cache */
		}
		cacheDirty = true;
		return fresh;
	})();
	loadedCache = await loadPromise;
	return loadedCache;
}

/** Persist the cache atomically (temp + rename); failures are logged, never fatal. */
async function saveCache(ctx, cache) {
	if (!cacheDirty) return;
	// The file is a materialized view of the session logs: losing recent folds
	// costs one refold, not data. So content-only updates ride a five-minute
	// window instead of rewriting the whole file on every poll; a session
	// appearing or disappearing is structural and writes immediately.
	const keys = Object.keys(cache.sessions).sort().join("|");
	const structural = keys !== lastSessionKeys;
	const now = Date.now();
	if (!structural && lastCacheWriteAt !== 0 && now - lastCacheWriteAt < CACHE_WRITE_INTERVAL_MS) return;
	try {
		const path = cachePath();
		await mkdir(dirname(path), { recursive: true });
		const serialized = { version: CACHE_VERSION, sessions: {} };
		for (const [id, state] of Object.entries(cache.sessions)) serialized.sessions[id] = serializeSession(state);
		const body = JSON.stringify(serialized);
		// The serialization is already paid for here, so the size check is free.
		// Growth is driven by session count, not by days: a retention window on
		// days would remove nothing. Warn instead of guessing a cutoff.
		if (!warnedCacheSize && Buffer.byteLength(body, "utf8") > CACHE_SIZE_WARN_BYTES) {
			warnedCacheSize = true;
			ctx.logger.warn(`usage: usage cache is over ${CACHE_SIZE_WARN_BYTES / 1048576} MB; per-day detail for old sessions is now worth archiving`);
		}
		const tmp = `${path}.tmp`;
		await writeFile(tmp, body, "utf8");
		await rename(tmp, path);
		cacheDirty = false;
		lastCacheWriteAt = Date.now();
		lastSessionKeys = keys;
	} catch (error) {
		ctx.logger.warn(`usage: saving usage cache failed: ${String(error)}`);
	}
}

/** Single-flight guard: concurrent requests share one aggregation run. */
function withLock(run) {
	if (inflight !== null) return inflight;
	inflight = run().finally(() => {
		inflight = null;
	});
	return inflight;
}

/** Token total of one fold state, used to compare an incremental fold with a full one. */
function dayTokensOf(state) {
	let total = 0;
	for (const entry of state.days.values()) total += totalTokens(entry.totals);
	return total;
}

/** Report coverage separately from totals: an unreadable session is never billed as zero. */
function usageCoverage(totalSessions, skippedSessions) {
	const countedSessions = totalSessions - skippedSessions.length;
	return {
		status: skippedSessions.length === 0 ? "complete" : countedSessions === 0 ? "unavailable" : "partial",
		totalSessions, countedSessions, skippedSessions
	};
}

function readFailureReason(error) {
	return error?.name === "SessionFormatUnsupportedError" || error?.name === "SessionFormatUnsupportedMigrationError"
		? "unsupported-format" : "read-failed";
}

/**
 * Read one live session's event log across Session API generations.
 *
 * 0.1.x exposed a readable `events` array. 0.1.5 replaced it with
 * `snapshotEvents(fromSeq, toSeqExclusive)` (plus `eventAt(seq)` and the `seq`
 * high-water mark), and forked sessions may expose `ownEvents()`. Anything this
 * build cannot recognize yields null so the caller skips that single session
 * instead of failing every usage request with a 500.
 */
function sessionEventLog(session) {
	const direct = session?.events;
	if (Array.isArray(direct)) return direct;
	if (direct !== null && direct !== void 0 && typeof direct.length === "number") {
		try {
			return Array.from(direct);
		} catch {
			return null;
		}
	}
	if (typeof session?.snapshotEvents === "function") {
		try {
			const full = session.snapshotEvents();
			if (Array.isArray(full)) return full;
		} catch {
			/* ranged fallback below */
		}
		const seq = Number.isSafeInteger(session.seq) ? session.seq : null;
		if (seq !== null) {
			try {
				const full = session.snapshotEvents(0, seq + 1);
				if (Array.isArray(full)) return full;
			} catch {
				/* fall through */
			}
		}
	}
	if (typeof session?.ownEvents === "function") {
		try {
			const own = session.ownEvents();
			if (Array.isArray(own)) return own;
		} catch {
			/* fall through */
		}
	}
	return null;
}

/** Does this host expose a persisted-log reader at all? */
function canReadPersistedLog(persistence) {
	return persistence !== void 0 && typeof persistence.readFrom === "function";
}

/** 0.2: list includes live writers; read handles never claim or modify them. */
async function collectModernUsage(ctx, cache, persistence) {
	const identity = persistence.identity ?? persistence;
	if (modernPersistenceIdentity !== identity) {
		modernPersistenceIdentity = identity;
		modernRevisions = new Map();
	}
	const snapshots = await persistence.list();
	const present = new Set();
	const skippedSessions = [];
	for (const snapshot of snapshots) {
		const id = snapshot.header.id;
		present.add(id);
		const previous = cache.sessions[id];
		const seen = modernRevisions.get(id);
		if (previous?.kind === "modern" && seen !== void 0 && seen.revision === snapshot.revision && seen.eventCount === snapshot.eventCount) continue;
		let handle;
		let next;
		let failureReason = null;
		// A pure append — same process, longer log, unchanged fork prefix — folds
		// only the tail. Anything else (rewrite, truncation, cold start) refolds
		// from zero: an opaque revision does not promise the prefix survived.
		const extensions = seen?.extensions ?? 0;
		// Re-derive from the whole log once the tail path has run long enough to
		// matter; the open question is whether the log is really append-only.
		const verifying = extensions >= MODERN_EXTENSION_LIMIT;
		let canExtend = previous?.kind === "modern"
			&& seen !== void 0
			&& !verifying
			&& Number.isSafeInteger(previous.consumed)
			&& Number.isSafeInteger(previous.inherited)
			&& snapshot.eventCount > previous.consumed
			&& snapshot.eventCount >= seen.eventCount;
		try {
			handle = await persistence.open(id, "read");
			const inherited = handle.inheritedEventCount;
			let tail = null;
			let base = previous?.consumed ?? 0;
			if (canExtend && inherited === previous.inherited) {
				const { events: raw } = await handle.read(previous.consumed);
				const fresh = (Array.isArray(raw) ? raw : []).filter((event) => Number.isSafeInteger(event?.seq) && event.seq >= previous.consumed);
				if (fresh.length > 0) {
					base = fresh[0].seq;
					// The reader may start on the from-seq or just after it; a wider
					// gap means events were skipped, so refold instead of guessing.
					if (base <= previous.consumed + 1 && fresh.every((event, index) => event.seq === base + index)) tail = fresh;
				}
			}
			if (tail !== null) {
				// Fold onto the cached state. A later failure deletes it, so the
				// next refresh starts from zero rather than from a partial fold.
				applyUsageDelta(previous, tail);
				previous.consumed = base + tail.length;
				previous.inherited = inherited;
				next = previous;
			} else {
				const { events } = await handle.read(0);
				if (events.some((event, index) => event.seq !== index)) throw new Error("non-contiguous session log");
				if (!Number.isSafeInteger(inherited) || inherited < 0 || inherited > events.length) throw new Error("invalid inherited event count");
				next = createUsageState();
				// Inherited requests establish model attribution, not new spending.
				applyUsageDelta(next, events.slice(0, inherited).filter((event) => event.type === "request/header"));
				applyUsageDelta(next, events.slice(inherited));
				next.kind = "modern";
				next.consumed = events.length;
				next.inherited = inherited;
			}
		} catch (error) {
			failureReason = readFailureReason(error);
		} finally {
			if (handle !== void 0) {
				try { await handle.close(); }
				catch (error) { failureReason ??= readFailureReason(error); }
			}
		}
		if (failureReason !== null) {
			// Drop stale counts and do not remember the failed revision: retry next refresh.
			delete cache.sessions[id];
			cacheDirty = true;
			modernRevisions.delete(id);
			skippedSessions.push({ sessionId: id, reason: failureReason });
			ctx.logger.warn(`usage: session "${id}" excluded from totals (${failureReason})`);
			continue;
		}
		// A verification refold is the check on the tail path: when it disagrees
		// with the folded totals, say so instead of silently trusting either.
		if (verifying && previous !== void 0) {
			const before = dayTokensOf(previous);
			const after = dayTokensOf(next);
			if (before !== after) {
				ctx.logger.warn(`usage: session "${id}" tail fold drifted (${before} vs ${after} tokens); totals re-derived from the log`);
			}
		}
		// Changed revisions can mean rewrite/truncation, not only append. Refold
		// the changed session; unchanged ones stay cached. Commit only after close.
		cache.sessions[id] = next;
		cacheDirty = true;
		modernRevisions.set(id, {
			revision: snapshot.revision,
			eventCount: snapshot.eventCount,
			extensions: next === previous ? extensions + 1 : 0
		});
	}
	for (const id of Object.keys(cache.sessions)) {
		if (present.has(id)) continue;
		delete cache.sessions[id];
		cacheDirty = true;
	}
	for (const id of modernRevisions.keys()) if (!present.has(id)) modernRevisions.delete(id);
	return usageCoverage(present.size, skippedSessions);
}

/**
 * Read one model's catalog cost from the llm adapter.
 * The public service strips cost from its detached metadata, but the adapter's
 * own model objects keep it (USD per 1M tokens). Treated as best-effort: any
 * failure is simply "no catalog price".
 * @param ctx - host context.
 * @param provider - provider route id.
 * @param model - exact model id.
 * @returns cost object or null.
 */
async function catalogCost(ctx, provider, model) {
	if (provider === "" || provider === "unknown") return null;
	const llm = ctx.get("llm");
	if (llm === null || typeof llm !== "object" || typeof llm.registration !== "function") return null;
	try {
		const adapter = llm.registration(provider)?.adapter;
		if (adapter === null || adapter === void 0) return null;
		if (typeof adapter.listModels === "function") {
			const models = await adapter.listModels(provider);
			if (Array.isArray(models)) {
				const hit = models.find((entry) => entry?.id === model);
				if (hit?.cost !== void 0) return hit.cost;
			}
		}
		if (typeof adapter.resolveModel === "function") {
			const hit = await adapter.resolveModel(provider, model);
			if (hit?.cost !== void 0) return hit.cost;
		}
	} catch {
		/* catalog price is optional */
	}
	return null;
}

/**
 * Resolve CNY prices for the model keys that actually appeared in the usage
 * data. Official DeepSeek ids use the published CNY list; anything else falls
 * back to the DSH catalog price converted from USD. Cached for five minutes.
 * @param ctx - host context.
 * @param modelKeys - `provider/model` keys seen in the fold.
 * @returns `{ currency, source, prices: Map<model, price> }`.
 */
export async function pricingFor(ctx, modelKeys) {
	const key = [...modelKeys].sort().join("|");
	if (pricingCache !== null && pricingCache.key === key && Date.now() - pricingCache.at < PRICING_TTL_MS) return pricingCache.pricing;
	const prices = new Map();
	let usedCatalog = false;
	for (const modelKey of modelKeys) {
		const provider = modelKey.includes("/") ? modelKey.slice(0, modelKey.indexOf("/")) : "";
		const bare = modelKey.includes("/") ? modelKey.slice(modelKey.indexOf("/") + 1) : modelKey;
		// The published CNY list belongs to DeepSeek's own route only. Matching a
		// bare model name would price `openrouter/deepseek-flash` as the official
		// endpoint and then hand it the peak/off-peak discount as well.
		if (provider === "" || balanceSchemeOf(provider) === "deepseek") {
			const official = OFFICIAL_PRICES.get(bare) ?? OFFICIAL_PRICES.get(modelKey);
			if (official !== void 0) {
				// peakAware: this price has a published off-peak half price.
				prices.set(modelKey, { ...official, peakAware: true });
				continue;
			}
		}
		const cost = await catalogCost(ctx, provider, bare);
		if (cost !== null && typeof cost === "object") {
			// Catalog prices are flat rates: no peak/off-peak discount applies.
			prices.set(modelKey, {
				input: (Number(cost.input) || 0) * USD_CNY,
				output: (Number(cost.output) || 0) * USD_CNY,
				cacheRead: (Number(cost.cacheRead) || 0) * USD_CNY,
				cacheWrite: (Number(cost.cacheWrite) || 0) * USD_CNY,
				peakAware: false
			});
			usedCatalog = true;
		}
	}
	const pricing = { currency: "CNY", source: usedCatalog ? "catalog" : "official", prices };
	pricingCache = { key, at: Date.now(), pricing };
	return pricing;
}

/**
 * Collect per-day usage across live and persisted sessions, incrementally.
 * Live sessions fold only the in-memory events added since the last fold;
 * persisted sessions are skipped when the backend's opaque revision is
 * unchanged, and a gap or truncation triggers a full refold of that session.
 */
export async function collectUsage(ctx) {
	return withLock(async () => {
		const cache = await loadCache();
		const persistence = ctx.get("sessionPersistence");
		let coverage;
		if (typeof persistence?.open === "function") {
			coverage = await collectModernUsage(ctx, cache, persistence);
		} else {
			const live = ctx.get("sessions");
			const attached = new Set();
			const skippedSessions = [];
			if (live !== void 0) {
				for (const session of live.list()) {
					attached.add(session.id);
					let events;
					try {
						events = sessionEventLog(session);
					} catch {
						events = null;
					}
					if (events === null) {
						// Unknown session contract: skip this session only, never
						// let it take the whole usage endpoint down.
						delete cache.sessions[session.id];
						cacheDirty = true;
						skippedSessions.push({ sessionId: session.id, reason: "unsupported-session-api" });
						ctx.logger.warn(`usage: session "${session.id}" skipped (unsupported session API)`);
						continue;
					}
					const state = cache.sessions[session.id] ?? createUsageState();
					const transitioned = state.kind !== "live";
					if (transitioned) {
						// Live/persisted transition: refold the whole in-memory log.
						state.days = new Map();
						state.lastSample = null;
						state.currentModel = null;
						state.consumed = 0;
					}
					const count = events.length;
					const grew = (state.consumed ?? 0) < count;
					if (grew) {
						applyUsageDelta(state, events.slice(state.consumed ?? 0));
						state.consumed = count;
					}
					state.kind = "live";
					cache.sessions[session.id] = state;
					if (transitioned || grew) cacheDirty = true;
				}
			}
			const persistedIds = new Set();
			if (persistence !== void 0) {
				let snapshots = null;
				if (typeof persistence.listSnapshots === "function") {
					try {
						snapshots = await persistence.listSnapshots();
					} catch (error) {
						ctx.logger.warn(`usage: listSnapshots failed, falling back to list(): ${String(error)}`);
					}
				}
				const metas = snapshots !== null ? snapshots.map((entry) => entry.header) : await persistence.list();
				const revisionOf = new Map();
				if (snapshots !== null) for (const entry of snapshots) revisionOf.set(entry.header.id, entry.revision);
				const canRead = canReadPersistedLog(persistence);
				for (const meta of metas) {
					persistedIds.add(meta.id);
					if (attached.has(meta.id)) continue;
					if (!canRead) {
						// Host exposes no readable log API (e.g. 0.1.5 removed
						// readFrom): report the session as skipped instead of
						// inventing a zero or crashing.
						skippedSessions.push({ sessionId: meta.id, reason: "unsupported-host" });
						delete cache.sessions[meta.id];
						cacheDirty = true;
						continue;
					}
					const state = cache.sessions[meta.id] ?? createUsageState();
					const revision = revisionOf.get(meta.id);
					const changed = state.kind !== "persisted" || revision !== void 0 && revision !== state.revision || revision === void 0;
					if (changed) {
						try {
							const wasPersisted = state.kind === "persisted";
							const fromSeq = wasPersisted ? state.consumed : 0;
							const { events } = await persistence.readFrom(meta.id, fromSeq);
							if (!wasPersisted) {
								state.days = new Map();
								state.lastSample = null;
								state.currentModel = null;
								state.consumed = 0;
							}
							const fresh = wasPersisted ? events.filter((event) => event.seq > (state.consumed ?? 0)) : events;
							const contiguous = fresh.length === 0 ? state.consumed === 0 : fresh[0].seq === state.consumed + 1;
							if (!contiguous && state.consumed > 0) {
								// Log truncated or rewritten: refold the whole log.
								state.days = new Map();
								state.lastSample = null;
								state.currentModel = null;
								state.consumed = 0;
								const { events: allEvents } = await persistence.readFrom(meta.id, 0);
								applyUsageDelta(state, allEvents);
								state.consumed = allEvents.length > 0 ? allEvents[allEvents.length - 1].seq : 0;
							} else if (fresh.length > 0) {
								applyUsageDelta(state, fresh);
								state.consumed = fresh[fresh.length - 1].seq;
							}
							state.kind = "persisted";
							if (revision !== void 0) state.revision = revision;
							cacheDirty = true;
						} catch (error) {
							const reason = readFailureReason(error);
							delete cache.sessions[meta.id];
							cacheDirty = true;
							skippedSessions.push({ sessionId: meta.id, reason });
							ctx.logger.warn(`usage: session "${meta.id}" excluded from totals (${reason})`);
							continue;
						}
					}
					cache.sessions[meta.id] = state;
				}
			}
			for (const id of Object.keys(cache.sessions)) {
				if (attached.has(id) || persistedIds.has(id)) continue;
				delete cache.sessions[id];
				cacheDirty = true;
			}
			coverage = usageCoverage(new Set([...attached, ...persistedIds]).size, skippedSessions);
		}
		const byDay = new Map();
		for (const [id, state] of Object.entries(cache.sessions)) mergeInto(byDay, state.days, id);
		// Keep the atomic cache write inside the single-flight section. Otherwise
		// overlapping saves can race on the same temporary file.
		await saveCache(ctx, cache);
		const modelKeys = new Set();
		for (const entry of byDay.values()) for (const model of entry.models.keys()) modelKeys.add(model);
		const pricing = await pricingFor(ctx, modelKeys);
		// The billing band is judged on the server so the dock can never disagree
		// with the cost split: one holiday table, one verdict, cached or not.
		const now = Date.now();
		const holidayCoverage = holidayCoverageAt(now);
		if (!holidayCoverage.covered && warnedHolidayYear !== holidayCoverage.year) {
			warnedHolidayYear = holidayCoverage.year;
			ctx.logger.warn(`usage: PEAK_HOLIDAYS has no ${holidayCoverage.year} dates, so statutory holidays bill as peak this year`);
		}
		const result = renderUsage(byDay, now, { pricing, peakNow: isPeakAt(now), holidayCoverage, windowDays: USAGE_WINDOW_DAYS });
		// Session labels: the header carries no title, but the host's projection
		// cache does (record.rows.title.val). Resolve each id once — a session that
		// ran for a week appears on every one of those days — and in parallel,
		// because a sequential stat chain made this the slowest part of a poll.
		const ids = new Set();
		for (const day of result.days) for (const session of day.sessions) ids.add(session.id);
		const titles = new Map();
		await Promise.all([...ids].map(async (id) => {
			titles.set(id, await sessionTitleOf(ctx, id));
		}));
		for (const id of titleCache.keys()) if (!ids.has(id)) titleCache.delete(id);
		for (const day of result.days) {
			for (const session of day.sessions) session.title = titles.get(session.id) ?? null;
		}
		return { ...result, ...(coverage.status === "unavailable" ? { total: null } : {}), coverage };
	});
}

//#endregion

//#region route handlers

async function handleUsage(ctx, req, res, deps = {}) {
	if (rejectForeignCaller(req, res)) return;
	try {
		const result = await collectUsage(ctx);
		jsonCached(req, res, { ok: true, ...result });
	} catch (error) {
		ctx.logger.warn(`usage: usage aggregation failed: ${String(error)}`);
		json(res, 500, { ok: false, error: "internal", message: error instanceof Error ? error.message : String(error) });
	}
}

async function handleProviders(ctx, service, req, res) {
	if (rejectForeignCaller(req, res)) return;
	try {
		json(res, 200, { ok: true, providers: await service.providerViews() });
	} catch (error) {
		ctx.logger.warn(`usage: providers enumeration failed: ${String(error)}`);
		json(res, 500, { ok: false, error: "internal", message: error instanceof Error ? error.message : String(error) });
	}
}

async function selectedProviderId(req, service) {
	const url = new URL(req.url ?? "/", "http://x");
	const requested = url.searchParams.get("provider");
	if (requested !== null && requested !== "") return requested;
	const providers = await service.providerViews();
	return providers.find((entry) => entry.id === "deepseek-official")?.id
		?? providers.find((entry) => entry.configured)?.id
		?? providers[0]?.id
		?? null;
}

async function handleBalance(ctx, service, req, res) {
	if (rejectForeignCaller(req, res)) return;
	try {
		const url = new URL(req.url ?? "/", "http://x");
		const providerId = await selectedProviderId(req, service);
		const account = providerId === null ? null : await service.get(providerId, { force: url.searchParams.get("refresh") === "1" });
		if (account === null) {
			json(res, 200, { ok: false, error: "unknown-provider", message: `provider "${providerId}" is not configured` });
			return;
		}
		json(res, 200, { ok: true, account });
	} catch (error) {
		ctx.logger.warn(`usage: balance fetch failed: ${String(error)}`);
		json(res, 502, { ok: false, error: "failed", message: error instanceof Error ? error.message : String(error) });
	}
}

//#endregion

/** Start an immediate refresh and repeat account + local usage refresh every 5 minutes. */
export function startBackgroundRefresh(ctx, service, deps = {}) {
	let running = false;
	let stopped = false;
	let active = Promise.resolve();
	const run = async () => {
		if (running || stopped) return;
		running = true;
		active = (async () => {
			const results = await Promise.allSettled([service.refreshAll(), collectUsage(ctx)]);
			for (const result of results) if (result.status === "rejected") ctx.logger.warn(`usage: background refresh failed: ${String(result.reason)}`);
		})().finally(() => {
			running = false;
		});
		return active;
	};
	void run();
	const setTimer = deps.setInterval ?? setInterval;
	const clearTimer = deps.clearInterval ?? clearInterval;
	const timer = setTimer(run, deps.intervalMs ?? REFRESH_MS);
	timer?.unref?.();
	const stop = async () => {
		stopped = true;
		clearTimer(timer);
		await active;
	};
	stop.refreshNow = async () => {
		await active;
		return run();
	};
	/** Resolves when the startup refresh round settles (test seam + diagnostics). */
	stop.ready = active;
	return stop;
}

/** Plugin config schema: everything is optional; unknown keys are tolerated. */
const Config = {
	"~standard": {
		version: 1,
		vendor: "dsh-usage",
		validate(value) {
			const config = value !== null && typeof value === "object" ? value : {};
			if (config.balanceEnabled !== void 0 && typeof config.balanceEnabled !== "boolean") return { issues: [{ message: "balanceEnabled must be boolean", path: ["balanceEnabled"] }] };
			return { value: config };
		}
	}
};

/**
 * Plugin body: register the three exact routes and start background refresh.
 * @param ctx - plugin context carrying webServer, credentials, sessions, sessionPersistence, and settings.
 * @param deps - test seams: {service, disableBackgroundRefresh, intervalMs, setInterval, clearInterval, lookup, transport, fetchImpl}.
 */
/**
 * Memoize one async provider enumeration for `ttlMs`.
 * @param load - producer of the provider list.
 * @param ttlMs - how long a result is reused.
 * @returns loader with the same contract as `load`.
 */
function memoProviders(load, ttlMs) {
	let cached = null;
	let cachedAt = 0;
	let inflight = null;
	return async () => {
		if (cached !== null && Date.now() - cachedAt < ttlMs) return cached;
		inflight ??= load().then((providers) => {
			cached = providers;
			cachedAt = Date.now();
			return providers;
		}).finally(() => {
			inflight = null;
		});
		return inflight;
	};
}

async function apply(ctx, rawConfig = {}, deps = {}) {
	const service = deps.service ?? createBalanceService({
		credentials: ctx.get("credentials") ?? ctx.credentials,
		getProviders: memoProviders(() => configuredProviders(ctx), PROVIDERS_TTL_MS),
		getAccountService: () => ctx.get("deepseekAccount"),
		deps: { timeoutMs: UPSTREAM_TIMEOUT_MS, lookup: deps.lookup, transport: deps.transport, fetchImpl: deps.fetchImpl, disabled: rawConfig.balanceEnabled === false }
	});
	// Provider ids come from the async Harness settings service, so this
	// dynamic part of config validation must finish before routes start.
	await service.validate();
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: USAGE_PATH,
		handler: (req, res) => handleUsage(ctx, req, res, deps)
	}), "usage: usage route");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: PROVIDERS_PATH,
		handler: (req, res) => handleProviders(ctx, service, req, res)
	}), "usage: providers route");
	ctx.effect(() => ctx.webServer.register({
		kind: "exact",
		path: BALANCE_PATH,
		handler: (req, res) => handleBalance(ctx, service, req, res)
	}), "usage: balance route");
	if (deps.disableBackgroundRefresh !== true) ctx.effect(() => startBackgroundRefresh(ctx, service, deps), "usage: background refresh");
}

export { apply, Config, inject, name, USAGE_PATH, PROVIDERS_PATH, BALANCE_PATH };
