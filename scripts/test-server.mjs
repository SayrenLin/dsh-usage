#!/usr/bin/env node
/**
 * dsh-usage — offline server tests.
 * Mock plugin context + fake HTTPS transport; no harness, no network.
 * DSH_HOME is redirected to a temp dir so the usage cache never touches
 * the real profile.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apply, BALANCE_PATH, PROVIDERS_PATH, USAGE_PATH, isLoopbackAddress, pricingFor } from "../lib/index.js";
import { isPrivateAddress, resolvePublicAddress, safeFetch } from "../lib/safe-fetch.js";

const testHome = await mkdtemp(join(tmpdir(), "dsh-usage-test-"));
process.env.DSH_HOME = testHome;

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

const SETTINGS = {
	get: (ns) => {
		if (ns === "llm-deepseek") return { apiKeyEnv: "DEEPSEEK_API_KEY", baseURL: "https://api.deepseek.com" };
		if (ns === "llm-pi-ai") return { providers: { ark: { displayName: "Ark", apiKeyEnv: "ARK_API_KEY", baseURL: "https://ark.example.com" } } };
		return void 0;
	}
};

function credentials(keys = {}) {
	return { resolve: async (ref) => ({ value: keys[ref] ?? "" }) };
}

function fakeTransport(respond, record = {}) {
	return {
		httpsRequest: (url, options, callback) => {
			record.url = url;
			record.options = options;
			record.calls = (record.calls ?? 0) + 1;
			const req = new EventEmitter();
			req.end = () => {};
			req.destroy = (err) => { record.destroyed = err; };
			queueMicrotask(() => {
				const res = respond(url, options);
				const response = new EventEmitter();
				response.statusCode = res.statusCode;
				response.headers = res.headers ?? {};
				callback(response);
				response.emit("data", Buffer.from(res.body ?? ""));
				response.emit("end");
			});
			return req;
		},
		httpRequest: () => {
			throw new Error("http transport must not be used");
		}
	};
}

const publicLookup = async () => [{ address: "1.2.3.4", family: 4 }];

async function boot(overrides = {}) {
	const routes = [];
	const effects = [];
	const ctx = {
		credentials: void 0,
		webServer: { register: (entry) => routes.push(entry) },
		effect: (fn, label) => {
			const cleanup = fn();
			effects.push({ label, cleanup });
		},
		logger: { warn: () => {}, info: () => {}, debug: () => {} },
		get: (service) => ({
			settings: overrides.settings ?? SETTINGS,
			credentials: overrides.credentials ?? credentials({ DEEPSEEK_API_KEY: "sk-test" }),
			sessions: overrides.sessions ?? { list: () => [] },
			sessionPersistence: overrides.persistence ?? { listSnapshots: async () => [], list: async () => [] },
			deepseekAccount: overrides.account
		})[service]
	};
	await apply(ctx, {}, {
		disableBackgroundRefresh: true,
		...(overrides.deps ?? {})
	});
	return { routes, effects };
}

function handlerOf(routes, path) {
	const route = routes.find((entry) => entry.path === path);
	assert.ok(route !== void 0, `route ${path} registered`);
	return route.handler;
}

async function call(handler, { method = "GET", url = "/", peer = "127.0.0.1", host = "localhost" } = {}) {
	const res = {
		status: null,
		headers: null,
		body: "",
		writeHead(status, headers) {
			this.status = status;
			this.headers = headers;
		},
		end(body) {
			this.body += body ?? "";
		}
	};
	const req = { method, url, headers: { host }, socket: { remoteAddress: peer } };
	await handler(req, res);
	return res;
}

function parsed(res) {
	return JSON.parse(res.body);
}

//#region routing & fence

await test("apply registers exactly three exact routes", async () => {
	const { routes } = await boot();
	assert.deepEqual(routes.map((r) => r.path).sort(), [BALANCE_PATH, PROVIDERS_PATH, USAGE_PATH].sort());
	for (const route of routes) assert.equal(route.kind, "exact");
});

await test("non-GET methods are refused with 405", async () => {
	const { routes } = await boot();
	const res = await call(handlerOf(routes, BALANCE_PATH), { method: "POST" });
	assert.equal(res.status, 405);
	assert.equal(parsed(res).error, "method-not-allowed");
});

await test("non-loopback peer is refused with 403", async () => {
	const { routes } = await boot();
	const res = await call(handlerOf(routes, BALANCE_PATH), { peer: "10.0.0.1", host: "example.com" });
	assert.equal(res.status, 403);
});

await test("loopback peer with localhost host passes the fence", async () => {
	const { routes } = await boot();
	const res = await call(handlerOf(routes, BALANCE_PATH), { peer: "127.0.0.1", host: "localhost" });
	assert.equal(res.status, 200);
});

//#endregion

//#region balance endpoint

await test("balance: successful DeepSeek query pins DNS and returns normalized view", async () => {
	const record = {};
	const { routes } = await boot({
		deps: {
			lookup: publicLookup,
			transport: fakeTransport(() => ({
				statusCode: 200,
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" }] })
			}), record)
		}
	});
	const res = await call(handlerOf(routes, BALANCE_PATH), { url: "/api/usage/balance?provider=deepseek-official" });
	assert.equal(res.status, 200);
	const body = parsed(res);
	assert.equal(body.ok, true);
	assert.equal(body.account.status, "ok");
	assert.equal(body.account.balance.total, "110.00");
	assert.equal(body.account.balance.currency, "CNY");
	assert.equal(body.account.balance.toppedUp, "100.00");
	assert.equal(String(record.url), "https://api.deepseek.com/user/balance");
	assert.equal(record.options.headers.authorization, "Bearer sk-test");
	assert.equal(record.options.servername, "api.deepseek.com");
	assert.equal(record.options.method, "GET");
	assert.equal(res.body.includes("sk-test"), false, "no key in the response");
});

await test("balance: missing credential → not-configured with the ref name", async () => {
	const { routes } = await boot({ credentials: credentials({}) });
	const res = await call(handlerOf(routes, BALANCE_PATH), { url: "/api/usage/balance?provider=deepseek-official" });
	const body = parsed(res);
	assert.equal(body.ok, true);
	assert.equal(body.account.status, "not-configured");
	assert.deepEqual(body.account.missingCredentials, ["DEEPSEEK_API_KEY"]);
	assert.equal(body.account.balance, null);
});

await test("balance: provider without a scheme is unsupported", async () => {
	const { routes } = await boot();
	const res = await call(handlerOf(routes, BALANCE_PATH), { url: "/api/usage/balance?provider=ark" });
	const body = parsed(res);
	assert.equal(body.ok, true);
	assert.equal(body.account.mode, "unsupported");
	assert.equal(body.account.scheme, null);
	assert.equal(body.account.status, "pending");
});

await test("balance: unknown provider → unknown-provider", async () => {
	const { routes } = await boot();
	const res = await call(handlerOf(routes, BALANCE_PATH), { url: "/api/usage/balance?provider=nope" });
	assert.equal(parsed(res).error, "unknown-provider");
});

await test("balance: result is cached; refresh=1 forces a second upstream query", async () => {
	const record = {};
	const transport = fakeTransport(() => ({
		statusCode: 200,
		body: JSON.stringify({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "42.00" }] })
	}), record);
	const { routes } = await boot({ deps: { lookup: publicLookup, transport } });
	const handler = handlerOf(routes, BALANCE_PATH);
	const first = await call(handler, { url: "/api/usage/balance?provider=deepseek-official" });
	assert.equal(parsed(first).account.balance.total, "42.00");
	const second = await call(handler, { url: "/api/usage/balance?provider=deepseek-official" });
	assert.equal(parsed(second).account.balance.total, "42.00");
	assert.equal(record.calls, 1, "second call served from cache");
	const forced = await call(handler, { url: "/api/usage/balance?provider=deepseek-official&refresh=1" });
	assert.equal(parsed(forced).account.balance.total, "42.00");
	assert.equal(record.calls, 2, "refresh=1 re-queries upstream");
});

await test("balance: unauthorized upstream maps to unauthorized status", async () => {
	const { routes } = await boot({
		deps: {
			lookup: publicLookup,
			transport: fakeTransport(() => ({ statusCode: 401, body: "{}" }))
		}
	});
	const res = await call(handlerOf(routes, BALANCE_PATH), { url: "/api/usage/balance?provider=deepseek-official" });
	assert.equal(parsed(res).account.status, "unauthorized");
});

//#endregion

//#region providers endpoint

await test("providers: lists official route and pi-ai profiles only", async () => {
	const { routes } = await boot();
	const res = await call(handlerOf(routes, PROVIDERS_PATH));
	const body = parsed(res);
	assert.equal(body.ok, true);
	const ids = body.providers.map((p) => p.id);
	assert.ok(ids.includes("deepseek-official"));
	assert.ok(ids.includes("ark"));
	const deepseek = body.providers.find((p) => p.id === "deepseek-official");
	assert.equal(deepseek.scheme, "deepseek");
	assert.equal(deepseek.configured, true);
	const ark = body.providers.find((p) => p.id === "ark");
	assert.equal(ark.scheme, null);
});

//#endregion

//#region usage endpoint

function usageEvent(seq, time, turn, step, usage) {
	return { seq, time, type: "assistant/chunk", data: { turn, step, chunk: { type: "usage", usage } } };
}

await test("usage: empty sessions render an empty day list", async () => {
	const { routes } = await boot();
	const res = await call(handlerOf(routes, USAGE_PATH));
	const body = parsed(res);
	assert.equal(body.ok, true);
	assert.deepEqual(body.days, []);
	assert.equal(body.total.tokens, 0);
});

await test("usage: live session events fold into per-day totals", async () => {
	const events = [
		{ seq: 1, time: Date.now(), type: "request/header", data: { header: { config: { model: "deepseek-chat", provider: "deepseek-official" } } } },
		usageEvent(2, Date.now(), 1, 1, { inputTokens: 100, outputTokens: 50 })
	];
	const { routes } = await boot({ sessions: { list: () => [{ id: "test-live-fold", events }] } });
	const res = await call(handlerOf(routes, USAGE_PATH));
	const body = parsed(res);
	assert.equal(body.total.tokens, 150);
	assert.equal(body.days.length, 1);
	assert.equal(body.days[0].models[0].model, "deepseek-official/deepseek-chat");
});

await test("usage: incremental fold only processes appended events", async () => {
	const session = {
		id: "test-live-incremental",
		events: [
			{ seq: 1, time: Date.now(), type: "request/header", data: { header: { config: { model: "deepseek-chat", provider: "deepseek-official" } } } },
			usageEvent(2, Date.now(), 1, 1, { inputTokens: 100, outputTokens: 50 })
		]
	};
	const { routes } = await boot({ sessions: { list: () => [session] } });
	const handler = handlerOf(routes, USAGE_PATH);
	const first = await call(handler);
	assert.equal(parsed(first).total.tokens, 150);
	session.events.push(usageEvent(3, Date.now(), 1, 2, { inputTokens: 10, outputTokens: 5 }));
	const second = await call(handler);
	assert.equal(parsed(second).total.tokens, 165);
});

await test("usage: persisted sessions fold via listSnapshots/readFrom", async () => {
	const events = [
		{ seq: 1, time: Date.now(), type: "request/header", data: { header: { config: { model: "deepseek-chat", provider: "deepseek-official" } } } },
		usageEvent(2, Date.now(), 1, 1, { inputTokens: 40, outputTokens: 20 })
	];
	const persistence = {
		listSnapshots: async () => [{ header: { id: "test-persisted" }, revision: "rev-1" }],
		readFrom: async (id, fromSeq) => ({ events: events.slice(fromSeq) })
	};
	const { routes } = await boot({ persistence });
	const res = await call(handlerOf(routes, USAGE_PATH));
	assert.equal(parsed(res).total.tokens, 60);
});

await test("background refresh starts immediately and schedules a timer", async () => {
	const record = {};
	const timers = [];
	const { effects } = await boot({
		credentials: credentials({ DEEPSEEK_API_KEY: "sk-test", OPENROUTER_MANAGEMENT_KEY: "sk-mgmt", ZAI_API_KEY: "sk-z" }),
		deps: {
			disableBackgroundRefresh: false,
			lookup: publicLookup,
			transport: fakeTransport(() => ({
				statusCode: 200,
				body: JSON.stringify({ is_available: true, balance_infos: [{ currency: "CNY", total_balance: "9.00" }] })
			}), record),
			setInterval: (fn, ms) => {
				timers.push({ fn, ms });
				return { unref: () => {} };
			},
			clearInterval: () => {}
		}
	});
	const background = effects.find((entry) => entry.label === "usage: background refresh");
	assert.ok(background !== void 0, "background refresh effect registered");
	await background.cleanup.ready;
	assert.ok(record.calls >= 1, "startup refresh queried the configured provider");
	assert.equal(timers.length, 1);
	assert.equal(timers[0].ms, 300000);
});

//#endregion

//#region safe-fetch policy

await test("safeFetch rejects http:// URLs", async () => {
	await assert.rejects(
		() => safeFetch("http://api.deepseek.com/user/balance", {}, { lookup: publicLookup }),
		(error) => error.providerStatus === "unsupported"
	);
});

await test("safeFetch rejects private DNS answers", async () => {
	await assert.rejects(
		() => safeFetch("https://api.deepseek.com/user/balance", {}, { lookup: async () => [{ address: "192.168.1.1", family: 4 }] }),
		(error) => error.providerStatus === "blocked"
	);
});

await test("safeFetch accepts a TUN fake-IP answer (Clash proxy) but pins it", async () => {
	const target = await resolvePublicAddress(new URL("https://api.deepseek.com/user/balance"), {
		lookup: async () => [{ address: "198.18.0.26", family: 4 }]
	});
	assert.equal(target.address, "198.18.0.26", "the fake-IP answer becomes the pinned address");
	assert.equal(target.family, 4);
	// A literal private address in the configured baseURL is never a proxy answer.
	await assert.rejects(
		() => resolvePublicAddress(new URL("https://198.18.0.26/user/balance")),
		(error) => error.providerStatus === "blocked"
	);
	// A real public answer always wins over a fake-IP entry.
	const mixed = await resolvePublicAddress(new URL("https://api.deepseek.com/user/balance"), {
		lookup: async () => [{ address: "198.18.0.26", family: 4 }, { address: "1.2.3.4", family: 4 }]
	});
	assert.equal(mixed.address, "1.2.3.4", "public answers are preferred");
});

await test("isPrivateAddress covers loopback, private, link-local, multicast, documentation", () => {
	assert.equal(isPrivateAddress("127.0.0.1"), true);
	assert.equal(isPrivateAddress("10.1.2.3"), true);
	assert.equal(isPrivateAddress("172.16.0.1"), true);
	assert.equal(isPrivateAddress("192.168.1.1"), true);
	assert.equal(isPrivateAddress("169.254.10.10"), true);
	assert.equal(isPrivateAddress("100.64.0.1"), true);
	assert.equal(isPrivateAddress("224.0.0.1"), true);
	assert.equal(isPrivateAddress("192.0.2.1"), true);
	assert.equal(isPrivateAddress("198.51.100.1"), true);
	assert.equal(isPrivateAddress("203.0.113.1"), true);
	assert.equal(isPrivateAddress("1.2.3.4"), false);
	assert.equal(isPrivateAddress("::1"), true);
	assert.equal(isPrivateAddress("fe80::1"), true);
	assert.equal(isPrivateAddress("::ffff:127.0.0.1"), true);
	assert.equal(isPrivateAddress("::ffff:192.168.0.1"), true);
	assert.equal(isPrivateAddress("2001:db8::1"), true);
	assert.equal(isPrivateAddress("2606:4700:4700::1111"), false);
});

await test("isLoopbackAddress accepts IPv4, IPv4-mapped IPv6, and ::1", () => {
	assert.equal(isLoopbackAddress("127.0.0.1"), true);
	assert.equal(isLoopbackAddress("127.255.255.255"), true);
	assert.equal(isLoopbackAddress("::ffff:127.0.0.1"), true);
	assert.equal(isLoopbackAddress("::1"), true);
	assert.equal(isLoopbackAddress("10.0.0.1"), false);
	assert.equal(isLoopbackAddress("::ffff:10.0.0.1"), false);
	assert.equal(isLoopbackAddress(undefined), false);
});

//#endregion

await rm(testHome, { recursive: true, force: true });
//#region pricing

/** Minimal context: no llm adapter, so only the official table can answer. */
const bareCtx = { get: () => void 0 };

await test("official CNY prices only apply to DeepSeek's own route", async () => {
	const official = await pricingFor(bareCtx, ["deepseek-official/deepseek-flash"]);
	const price = official.prices.get("deepseek-official/deepseek-flash");
	assert.ok(price !== void 0, "the official route is priced from the CNY list");
	assert.equal(price.peakAware, true, "the published list has an off-peak half price");
	const foreign = await pricingFor(bareCtx, ["openrouter/deepseek-flash"]);
	assert.equal(foreign.prices.get("openrouter/deepseek-flash"), void 0, "a resold DeepSeek model is not the official endpoint");
});

await test("catalog prices are converted from USD and marked flat", async () => {
	const llm = {
		registration: () => ({
			adapter: { listModels: async () => [{ id: "deepseek-chat", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 } }] }
		})
	};
	const ctx = { get: (name) => (name === "llm" ? llm : void 0) };
	// A distinct key: pricingFor memoizes by the sorted model set.
	const pricing = await pricingFor(ctx, ["openrouter/deepseek-chat"]);
	const price = pricing.prices.get("openrouter/deepseek-chat");
	assert.ok(price !== void 0, "the catalog answers when the official table refuses");
	assert.equal(price.peakAware, false, "a flat catalog rate must not get the peak discount");
	assert.equal(pricing.source, "catalog");
	const rate = price.input / 1;
	assert.ok(rate > 6 && rate < 7, "USD is converted at the documented rate");
});

//#endregion
//#region account login

function fakeAccount(state, summary) {
	return {
		calls: 0,
		async getState() {
			return { status: state };
		},
		async getBalance(client) {
			this.calls += 1;
			this.lastClient = client;
			return summary;
		}
	};
}

const ACCOUNT_SUMMARY = {
	status: "ready",
	value: [{ currency: "CNY", balance: "100.00" }],
	bonusWallets: [{ currency: "CNY", balance: "10.00" }]
};

await test("account login is listed and reports platform wallets", async () => {
	const account = fakeAccount("credential-stored", ACCOUNT_SUMMARY);
	const { routes } = await boot({ account });
	const providers = parsed(await call(handlerOf(routes, PROVIDERS_PATH))).providers;
	const entry = providers.find((provider) => provider.id === "deepseek-account");
	assert.ok(entry !== void 0, "the account route appears in the provider list");
	assert.equal(entry.configured, true);
	assert.equal(entry.mode, "account");
	const body = parsed(await call(handlerOf(routes, BALANCE_PATH), { url: "/api/usage/balance?provider=deepseek-account" }));
	assert.equal(body.account.status, "ok");
	assert.equal(body.account.mode, "account");
	assert.equal(body.account.balance.currency, "CNY");
	assert.equal(body.account.balance.total, "110.00", "topped-up plus granted");
	assert.equal(body.account.balance.toppedUp, "100.00");
	assert.equal(body.account.balance.granted, "10.00");
	assert.equal(account.calls, 1, "the host service answers instead of an HTTP key query");
	assert.equal(typeof account.lastClient.timezoneOffsetSeconds, "number", "platform metadata is supplied");
});

await test("a signed-out account is reported as signed out, not as a missing provider", async () => {
	const account = fakeAccount("signed-out", null);
	const { routes } = await boot({ account });
	const providers = parsed(await call(handlerOf(routes, PROVIDERS_PATH))).providers;
	assert.equal(providers.find((provider) => provider.id === "deepseek-account").configured, false);
	const body = parsed(await call(handlerOf(routes, BALANCE_PATH), { url: "/api/usage/balance?provider=deepseek-account" }));
	assert.equal(body.account.status, "signed-out");
	assert.equal(body.account.balance, null);
});

await test("without an account service the route is not advertised", async () => {
	const { routes } = await boot();
	const providers = parsed(await call(handlerOf(routes, PROVIDERS_PATH))).providers;
	assert.ok(!providers.some((provider) => provider.id === "deepseek-account"), "no phantom provider");
});

//#endregion

console.log(`\n${passed} server tests passed`);
