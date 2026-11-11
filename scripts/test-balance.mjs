#!/usr/bin/env node
/**
 * dsh-usage — offline balance scheme tests.
 * Runs against a mock fetch; no network, no harness.
 */
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { balanceSchemeOf, queryBalance, supportedBalanceSchemes } from "../lib/balance.js";
import { safeFetch } from "../lib/safe-fetch.js";

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

/** A fetch stub that records the request and returns a canned response. */
function stubFetch(record, status, body, contentType = "application/json") {
	return async (url, init) => {
		record.url = url;
		record.init = init;
		return {
			ok: status >= 200 && status < 300,
			status,
			async json() {
				if (contentType !== "application/json") throw new SyntaxError("not json");
				return typeof body === "string" ? JSON.parse(body) : body;
			}
		};
	};
}

await test("deepseek scheme: CNY entry preferred, fields normalized", async () => {
	const record = {};
	const result = await queryBalance("deepseek", "https://api.deepseek.com", "sk-test", 15000, stubFetch(record, 200, {
		is_available: true,
		balance_infos: [
			{ currency: "USD", total_balance: "1.00" },
			{ currency: "CNY", total_balance: "110.00", granted_balance: "10.00", topped_up_balance: "100.00" }
		]
	}));
	assert.equal(record.url, "https://api.deepseek.com/user/balance");
	assert.equal(record.init.headers.authorization, "Bearer sk-test");
	assert.equal(record.init.signal instanceof AbortSignal, true);
	assert.deepEqual(result, {
		isAvailable: true,
		currency: "CNY",
		total: "110.00",
		granted: "10.00",
		toppedUp: "100.00"
	});
});

await test("deepseek scheme: first entry fallback when no CNY", async () => {
	const record = {};
	const result = await queryBalance("deepseek", "https://api.deepseek.com", "sk-test", 15000, stubFetch(record, 200, {
		is_available: false,
		balance_infos: [{ currency: "USD", total_balance: "3.50" }]
	}));
	assert.equal(result.currency, "USD");
	assert.equal(result.total, "3.50");
	assert.equal(result.isAvailable, false);
});

await test("openrouter scheme: remaining = credits - usage", async () => {
	const record = {};
	const result = await queryBalance("openrouter", "https://openrouter.ai/api", "sk-mgmt", 15000, stubFetch(record, 200, {
		data: { total_credits: 500, total_usage: 12.3 }
	}));
	assert.equal(record.url, "https://openrouter.ai/api/v1/credits");
	assert.deepEqual(result, {
		isAvailable: true,
		currency: "USD",
		total: 487.7,
		used: 12.3,
		limit: 500,
		granted: void 0,
		toppedUp: void 0
	});
});

await test("moonshot scheme: available/cash/voucher", async () => {
	const record = {};
	const result = await queryBalance("moonshot", "https://api.moonshot.cn", "sk-m", 15000, stubFetch(record, 200, {
		data: { available_balance: 42.5, cash_balance: 30, voucher_balance: 12.5, currency: "CNY" }
	}));
	assert.equal(record.url, "https://api.moonshot.cn/v1/users/me/balance");
	assert.deepEqual(result, {
		isAvailable: true,
		currency: "CNY",
		total: 42.5,
		granted: 12.5,
		toppedUp: 30
	});
});

await test("zai scheme: total + available", async () => {
	const record = {};
	const result = await queryBalance("zai", "https://api.z.ai", "sk-z", 15000, stubFetch(record, 200, {
		data: { total_balance: 88, available_balance: 77, currency: "CNY" }
	}));
	assert.equal(record.url, "https://api.z.ai/api/paas/v4/balance");
	assert.deepEqual(result, {
		isAvailable: true,
		currency: "CNY",
		total: 88,
		granted: void 0,
		toppedUp: 77
	});
});

await test("HTTP status mapping: 401 → unauthorized, 429 → rate-limited, 500 → unavailable, 404 → invalid-response", async () => {
	for (const [status, expected] of [[401, "unauthorized"], [403, "unauthorized"], [429, "rate-limited"], [500, "unavailable"], [404, "invalid-response"]]) {
		const record = {};
		await assert.rejects(
			() => queryBalance("deepseek", "https://api.deepseek.com", "sk", 15000, stubFetch(record, status, {})),
			(error) => error.providerStatus === expected && error.httpStatus === status
		);
	}
});

await test("invalid JSON body → invalid-response", async () => {
	const record = {};
	await assert.rejects(
		() => queryBalance("deepseek", "https://api.deepseek.com", "sk", 15000, stubFetch(record, 200, "<html>", "text/html")),
		(error) => error.providerStatus === "invalid-response"
	);
});

await test("missing fields stay undefined, zero balance is not available", async () => {
	const record = {};
	const result = await queryBalance("moonshot", "https://api.moonshot.cn", "sk", 15000, stubFetch(record, 200, { data: {} }));
	assert.deepEqual(result, {
		isAvailable: void 0,
		currency: void 0,
		total: void 0,
		granted: void 0,
		toppedUp: void 0
	});
	const zero = await queryBalance("moonshot", "https://api.moonshot.cn", "sk", 15000, stubFetch(record, 200, { data: { available_balance: 0 } }));
	assert.equal(zero.isAvailable, false);
});

await test("unknown scheme throws", async () => {
	await assert.rejects(() => queryBalance("nope", "https://x", "sk", 15000, stubFetch({}, 200, {})), /no balance scheme/);
});

await test("balanceSchemeOf maps adapter ids and pi-ai routes", () => {
	assert.equal(balanceSchemeOf("deepseek-official"), "deepseek");
	assert.equal(balanceSchemeOf("deepseek"), "deepseek");
	assert.equal(balanceSchemeOf("openrouter"), "openrouter");
	assert.equal(balanceSchemeOf("moonshotai"), "moonshot");
	assert.equal(balanceSchemeOf("moonshotai-cn"), "moonshot");
	assert.equal(balanceSchemeOf("kimi"), "moonshot");
	assert.equal(balanceSchemeOf("kimi-coding"), "moonshot");
	assert.equal(balanceSchemeOf("zai"), "zai");
	assert.equal(balanceSchemeOf("zai-coding-cn"), "zai");
	assert.equal(balanceSchemeOf("ark"), null);
	assert.equal(balanceSchemeOf("openai"), null);
});

await test("supportedBalanceSchemes lists exactly four", () => {
	assert.deepEqual(supportedBalanceSchemes().sort(), ["deepseek", "moonshot", "openrouter", "zai"]);
});

/** A transport whose request answers only when the test says so. */
function hangingTransport() {
	const record = {};
	const transport = {
		httpsRequest: (url, options, callback) => {
			record.url = url;
			const request = new EventEmitter();
			request.end = () => {
				record.ended = true;
				if (record.onEnd !== void 0) record.onEnd(callback, request);
			};
			request.destroy = (error) => {
				record.destroyed = error;
			};
			record.request = request;
			record.callback = callback;
			return request;
		},
		httpRequest: () => {
			throw new Error("http transport must not be used");
		}
	};
	return { transport, record };
}

const safeDeps = (transport, timeoutMs = 500) => ({
	transport,
	lookup: async () => [{ address: "1.2.3.4", family: 4 }],
	timeoutMs
});

await test("safeFetch rejects when the response aborts mid-body", async () => {
	const { transport, record } = hangingTransport();
	record.onEnd = (callback) => {
		const response = new EventEmitter();
		response.statusCode = 200;
		response.headers = {};
		response.resume = () => {};
		callback(response);
		response.emit("data", Buffer.from('{"total":'));
		response.emit("aborted");
	};
	await assert.rejects(
		safeFetch("https://api.deepseek.com/user/balance", {}, safeDeps(transport, 5000)),
		(error) => error.providerStatus === "unavailable" && /aborted/.test(error.message),
		"an aborted body must settle instead of hanging the refresh"
	);
});

await test("safeFetch rejects when the socket closes without end", async () => {
	const { transport, record } = hangingTransport();
	record.onEnd = (callback) => {
		const response = new EventEmitter();
		response.statusCode = 200;
		response.headers = {};
		response.resume = () => {};
		callback(response);
		response.emit("close");
	};
	await assert.rejects(
		safeFetch("https://api.deepseek.com/user/balance", {}, safeDeps(transport, 5000)),
		(error) => error.providerStatus === "unavailable" && /closed/.test(error.message),
		"a premature close must settle instead of hanging"
	);
});

await test("safeFetch times out a request that never answers", async () => {
	const { transport, record } = hangingTransport();
	await assert.rejects(
		safeFetch("https://api.deepseek.com/user/balance", {}, safeDeps(transport, 40)),
		(error) => error.providerStatus === "unavailable" && /timed out/.test(error.message),
		"a silent upstream must not pin the promise forever"
	);
	assert.ok(record.destroyed !== void 0, "the dead request is destroyed");
});

await test("safeFetch resolves a complete body", async () => {
	const { transport, record } = hangingTransport();
	record.onEnd = (callback) => {
		const response = new EventEmitter();
		response.statusCode = 200;
		response.headers = { "content-type": "application/json" };
		callback(response);
		response.emit("data", Buffer.from('{"is_available":true}'));
		response.emit("end");
	};
	const result = await safeFetch("https://api.deepseek.com/user/balance", {}, safeDeps(transport, 5000));
	assert.equal(result.status, 200);
	assert.equal(result.ok, true);
	assert.deepEqual(await result.json(), { is_available: true });
});

console.log(`\n${passed} balance tests passed`);
