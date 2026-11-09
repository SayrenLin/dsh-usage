#!/usr/bin/env node
/**
 * Deploy this local fork into a DSH profile.
 *
 * Why a script instead of a plain `cp`: pnpm materialises profile packages as
 * hard links into its content-addressed store. Writing into the linked file in
 * place would mutate the shared store (corrupting the cached package for every
 * profile). This script writes a sibling temp file, checks it, then renames it
 * over the target — the rename swaps the directory entry, so the store blob
 * keeps its pristine bytes while the profile gets the fork.
 *
 * Usage:
 *   node deploy.mjs                 # deploy into the desktop profile
 *   node deploy.mjs --check-only    # syntax/content check, no write
 *   node deploy.mjs --profile web   # another profile
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const PACKAGE = "dsh-usage";
const FILES = ["lib/client.js", "lib/usage.js", "lib/index.js", "lib/safe-fetch.js"];

const argv = process.argv.slice(2);
const checkOnly = argv.includes("--check-only");
const profileFlag = argv.indexOf("--profile");
const profile = profileFlag >= 0 ? argv[profileFlag + 1] : "desktop";
if (typeof profile !== "string" || profile === "") {
	console.error("deploy: --profile needs a value");
	process.exit(2);
}

/** Resolve DSH_HOME the same way the host does, so relative homes keep working. */
function dshHome() {
	const raw = process.env.DSH_HOME;
	const home = typeof raw === "string" && raw.trim() !== "" ? raw.trim() : join(homedir(), ".dsh");
	if (home === "~") return homedir();
	if (home.startsWith("~/") || home.startsWith("~\\")) return join(homedir(), home.slice(2));
	return resolve(home);
}

const target = join(dshHome(), "profiles", profile, "node_modules", PACKAGE);
if (!existsSync(target)) {
	console.error(`deploy: ${PACKAGE} is not installed in profile "${profile}" (${target})`);
	process.exit(2);
}

const scratch = mkdtempSync(join(target, ".deploy-"));
let deployed = 0;
try {
	for (const relative of FILES) {
		const source = join(here, relative);
		const destination = join(target, relative);
		if (!existsSync(source)) {
			console.error(`deploy: missing source ${source}`);
			process.exit(2);
		}
		const sourceText = readFileSync(source, "utf8");
		const staged = join(scratch, "staged.js");
		writeFileSync(staged, sourceText, "utf8");
		// Fail before touching the live file: a syntax error here would leave the
		// window without a working bundle until the next manual fix.
		execFileSync(process.execPath, ["--check", staged], { stdio: "pipe" });
		const current = existsSync(destination) ? readFileSync(destination, "utf8") : "";
		if (current === sourceText) {
			console.log(`deploy: ${relative} already up to date`);
			continue;
		}
		if (checkOnly) {
			console.log(`deploy: ${relative} would be updated (check-only)`);
			continue;
		}
		// Same-directory rename: atomic on NTFS, and it gives the target a fresh
		// inode so the pnpm store blob stays untouched.
		renameSync(staged, destination);
		deployed += 1;
		const links = statSync(destination).nlink;
		console.log(`deploy: ${relative} -> ${destination} (nlink=${links})`);
	}
} finally {
	rmSync(scratch, { recursive: true, force: true });
}

if (deployed > 0) {
	console.log("deploy: done — the host polls client bundles every 500ms and hot-reloads this one.");
	console.log("deploy: if the dock still shows the old UI, press Ctrl+R once.");
} else if (!checkOnly) {
	console.log("deploy: nothing to do.");
}
