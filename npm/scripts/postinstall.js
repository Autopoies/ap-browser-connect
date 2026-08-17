#!/usr/bin/env node
// Package self-check, run by npm after install. The observed breakage this
// guards against (2026-08-15): shims/ap-browser.js overwritten by a native
// Mach-O binary — every `ap-browser` call then hung waiting on stdin because
// the "shim" was actually the native messaging host. Fail the install loudly
// instead of leaving a silently-broken CLI on PATH.
const { spawnSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const shim = path.join(__dirname, "..", "shims", "ap-browser.js");
const problems = [];

if (!fs.existsSync(shim)) {
	problems.push(`missing shim: ${shim}`);
} else {
	const head = Buffer.alloc(4);
	const fd = fs.openSync(shim, "r");
	fs.readSync(fd, head, 0, 4, 0);
	fs.closeSync(fd);
	const magic = head.toString("hex");
	const binaryMagics = new Set([
		"cffaedfe", // Mach-O 64 (byte-swapped)
		"feedfacf", // Mach-O 64
		"feedface", // Mach-O 32
		"cafebabe", // universal/fat binary
		"7f454c46", // ELF
		"4d5a9000", // PE (Windows)
	]);
	if (binaryMagics.has(magic)) {
		problems.push(
			`shims/ap-browser.js is a native binary (magic ${magic}) — corrupted package, not the Node launcher`,
		);
	}
}

if (problems.length === 0) {
	const r = spawnSync(process.execPath, [shim, "--version"], {
		timeout: 15000,
		encoding: "utf8",
	});
	if (r.status !== 0) {
		problems.push(
			`shim self-check failed (exit ${r.status}): ${(r.stderr || "").trim().slice(0, 300)}`,
		);
	}
}

if (problems.length > 0) {
	console.error("ap-browser-connect: postinstall self-check FAILED");
	for (const p of problems) console.error(`  - ${p}`);
	console.error("The package on disk is corrupted. Reinstall it:");
	console.error("  npm install -g ap-browser-connect");
	process.exit(1);
}
console.log("ap-browser-connect: postinstall self-check ok");
