#!/usr/bin/env node
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runInNewContext } from "node:vm";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(process.argv[2] ?? join(here, ".."));
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const client = readFileSync(join(root, "lib", "client.js"), "utf8");
const runtimePackage = "@deepseek-ai/dsh-client-ui-primitives";

// Optional root lets release checks inspect the installed final TGZ, not the checkout.
const server = await import(pathToFileURL(join(root, "lib", "index.js")).href);
assert.equal(pkg.name, "dsh-usage");
assert.equal(server.name, "usage");
assert.equal(typeof server.apply, "function");
assert.deepEqual(server.inject, ["webServer", "credentials", "sessions", "sessionPersistence", "settings", "llm"]);
assert.equal(server.USAGE_PATH, "/api/usage/usage");
assert.equal(server.PROVIDERS_PATH, "/api/usage/providers");
assert.equal(server.BALANCE_PATH, "/api/usage/balance");
assert.equal(pkg.dsh.client.platform, "web");
assert.deepEqual(pkg.dsh.client.inject, ["@deepseek-ai/dsh-client-locale", runtimePackage]);
assert.match(readFileSync(join(root, "cordis.patch.yml"), "utf8"), /^- insert:\r?\n    - id: usage\r?\n      name: dsh-usage\s*$/m);

assert.equal(
	pkg.dependencies?.[runtimePackage],
	"0.2.0-rc.2",
	`${runtimePackage} must be an exact runtime dependency`
);
assert.ok(
	pkg.dsh?.client?.inject?.includes(runtimePackage),
	`${runtimePackage} must remain in dsh.client.inject`
);
assert.ok(
	client.includes(`require("${runtimePackage}")`),
	"package contract test must track the real client import"
);
assert.ok(!pkg.dsh.client.inject.includes("@deepseek-ai/dsh-client-runtime"), "retired runtime must not be loaded");
{
	// Local fork: the update checker is gone on purpose. Nothing in the browser
	// half may reach the upstream repository again.
	assert.equal(/const LOCAL_VERSION/.test(client), false, "client.js must not declare an update version");
	assert.equal(/api\.github\.com/.test(client), false, "client.js must not call the GitHub API");
	assert.equal(/UPGRADE_(CMD|AI)/.test(client), false, "client.js must not carry upgrade commands");
	assert.equal(/\["']update\./.test(client), false, "client.js must not carry update copy");
}

console.log("ok package declares and injects client UI runtime dependency");
