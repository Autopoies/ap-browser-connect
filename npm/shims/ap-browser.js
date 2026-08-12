#!/usr/bin/env node
// Executes the prebuilt platform binary bundled in ../bin/<target>/.
// npm links ap-browser / ap-browser-host / ap-browser-bridge to this file;
// the invoked name (argv[1] basename) selects which binary to run.

const { spawnSync } = require("child_process");
const path = require("path");
const fs = require("fs");

const arch =
	process.arch === "arm64"
		? "aarch64"
		: process.arch === "x64"
			? "x86_64"
			: process.arch;
const osName = {
	darwin: "apple-darwin",
	linux: "unknown-linux-gnu",
	win32: "pc-windows-msvc",
}[process.platform];
const target = `${arch}-${osName}`;
const ext = process.platform === "win32" ? ".exe" : "";
const cmd = path
	.basename(process.argv[1] || "ap-browser")
	.replace(/\.(js|cmd)$/i, "");

const bin = path.join(__dirname, "..", "bin", target, cmd + ext);
if (!fs.existsSync(bin)) {
	console.error(
		`ap-browser-connect: no prebuilt binary for ${process.platform}/${process.arch} (looked for ${target}/${cmd})`,
	);
	process.exit(1);
}

const result = spawnSync(bin, process.argv.slice(2), { stdio: "inherit" });
process.exit(result.status === null ? 1 : result.status);
