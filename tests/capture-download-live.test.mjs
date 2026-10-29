// Opt-in authenticated source-download regression. No network is used unless URLs
// are explicitly supplied; do not put signed URLs/cookies into checked-in fixtures.
// AP_BROWSER_YOUTUBE_TEST_URL=... AP_BROWSER_BILIBILI_TEST_URL=... node --test tests/capture-download-live.test.mjs
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const exec = promisify(execFile);
const cli = process.env.CAPTURE_TEST_CLI || resolve(process.env.CARGO_TARGET_DIR || "target", "debug/ap-browser");

function download(url, output) {
	return new Promise((resolveResult, reject) => {
		const child = spawn(cli, ["download", url, "--video", "--start", "2.5", "--duration", "2", "--out", output], {
			detached: process.platform !== "win32", stdio: ["ignore", "pipe", "ignore"],
		});
		let stdout = "", timedOut = false;
		const deadline = setTimeout(() => {
			timedOut = true;
			try { if (process.platform === "win32") child.kill(); else process.kill(-child.pid, "SIGKILL"); } catch { /* already exited */ }
		}, 120000);
		child.stdout.setEncoding("utf8");
		child.stdout.on("data", text => { stdout += text; });
		child.once("error", () => { clearTimeout(deadline); reject(new Error("could not start the local test CLI")); });
		child.once("close", code => {
			clearTimeout(deadline);
			if (timedOut) return reject(new Error("live extraction exceeded the 120s bound"));
			let result;
			try { result = JSON.parse(stdout); } catch { return reject(new Error("live CLI did not return one JSON envelope")); }
			// Never dump argv/stdout/stderr: they can contain an unlisted hash or signed CDN URLs.
			if (code || !result.ok) return reject(new Error(result.error?.message || "live download failed"));
			resolveResult(result.data);
		});
	});
}

for (const [site, variable] of [
	["YouTube", "AP_BROWSER_YOUTUBE_TEST_URL"],
	["Bilibili", "AP_BROWSER_BILIBILI_TEST_URL"],
	["Vimeo", "AP_BROWSER_VIMEO_TEST_URL"],
]) {
	const url = process.env[variable];
	test(`live ${site}: two-second source clip with video/audio and duration/frame checks`, {
		skip: !url ? `set ${variable} to opt in` : process.platform === "win32" ? "Windows live download is not qualified" : false,
		timeout: 130000,
	}, async t => {
		const root = await mkdtemp(join(tmpdir(), "ap-source-live-"));
		t.after(() => rm(root, { recursive: true, force: true }));
		const output = join(root, "clip.mp4"), result = await download(url, output);
		assert.ok(["ffmpeg", "yt-dlp"].includes(result.method));
		const probe = JSON.parse((await exec("ffprobe", ["-v", "error", "-count_frames", "-show_entries",
			"stream=codec_type,width,height,avg_frame_rate,nb_read_frames:format=duration", "-of", "json", output], { timeout: 10000 })).stdout);
		const video = probe.streams.find(s => s.codec_type === "video");
		assert.ok(video && video.width > 0 && video.height > 0, "video stream missing");
		assert.ok(probe.streams.some(s => s.codec_type === "audio"), "audio stream missing");
		assert.ok(Math.abs(Number(probe.format.duration) - 2) < 0.15, "clip duration mismatch");
		const [numerator, denominator] = video.avg_frame_rate.split("/").map(Number);
		assert.ok(Number.isFinite(numerator / denominator) && numerator > 0 && denominator > 0);
		assert.ok(Math.abs(Number(video.nb_read_frames) - 2 * numerator / denominator) <= 1, "clip frame count mismatch");
		t.diagnostic(`${result.method}: ${video.width}x${video.height}, ${probe.format.duration}s, ${video.nb_read_frames} frames, audio present`);
	});
}
