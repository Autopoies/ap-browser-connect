// Exercise the public CLI and its actual page-evaluation code without Chrome or live credentials.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, readFile, writeFile, readdir, mkdir } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve, delimiter } from "node:path";
import { promisify } from "node:util";
import vm from "node:vm";
import test from "node:test";

const exec = promisify(execFile);
const cli = process.env.CAPTURE_TEST_CLI || resolve(process.env.CARGO_TARGET_DIR || "target", "debug/ap-browser");
const master = "https://media.example.invalid/master.m3u8?signature=fixture";
const dash = "https://media.example.invalid/master.mpd?signature=fixture";
const manifest = `#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",DEFAULT=YES,URI="audio.m3u8?signature=fixture"
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,FRAME-RATE=30,AUDIO="audio"
360.m3u8?signature=fixture
#EXT-X-STREAM-INF:BANDWIDTH=3600000,RESOLUTION=1280x720,FRAME-RATE=30,AUDIO="audio"
720.m3u8?signature=fixture
`;

async function harness(t, { config = true, network = [], links = [], masterUrl = master, manifestText = manifest, embedded = false, performanceUrls = [] } = {}) {
	const root = await mkdtemp(join(tmpdir(), "capture-test-"));
	const video = { src: "blob:https://player.vimeo.com/fixture", currentSrc: "blob:https://player.vimeo.com/fixture", readyState: 4, querySelectorAll: () => [] };
	const location = new URL("https://player.vimeo.com/video/42?h=fixture");
	const document = { title: "Fixture video", querySelectorAll: selector => ({ "a[href]": links, video: [video], "video, audio": [video], "iframe[src]": embedded ? [{ src: "https://player.vimeo.com/video/42?h=fixture" }] : [] })[selector] || [] };
	const context = { document, location, URL, navigator: { userAgent: "capture-fixture" }, performance: { getEntriesByType: () => performanceUrls.map(name => ({ name })) }, AbortSignal, setTimeout, clearTimeout };
	context.window = context;
	context.frames = [];
	const playerConfig = { video: { title: "Fixture video", width: 1280, height: 720 }, request: { files: {
		hls: { default_cdn: "default", cdns: { default: { url: masterUrl }, backup: { url: "https://backup.example.invalid/master.m3u8" } }, streams: [{ quality: "720p", fps: 30 }, { quality: "360p", fps: 30 }] },
		dash: { default_cdn: "default", cdns: { default: { url: dash } } },
	} } };
	if (config) context.playerConfig = playerConfig;
	const fetched = [];
	context.fetch = async url => { fetched.push(String(url)); return { ok: true, status: 200, url: String(url), text: async () => manifestText }; };
	const page = vm.createContext(context);
	const requests = [];
	const server = createServer(socket => {
		let buffer = Buffer.alloc(0), authed = false;
		const send = value => { const payload = Buffer.from(JSON.stringify(value)); const header = Buffer.alloc(4); header.writeUInt32LE(payload.length); socket.write(Buffer.concat([header, payload])); };
		socket.on("error", () => {});
		socket.on("data", chunk => {
			buffer = Buffer.concat([buffer, chunk]);
			while (buffer.length >= 4 && buffer.length >= buffer.readUInt32LE(0) + 4) {
				const size = buffer.readUInt32LE(0), request = JSON.parse(buffer.subarray(4, size + 4)); buffer = buffer.subarray(size + 4);
				if (!authed) { authed = true; send({ ok: true }); continue; }
				requests.push(request);
				(async () => {
					if (request.method === "info") return { ok: true, data: { instance_id: "fixture", active_tab: { id: 42 } } };
					if (request.method === "tabs.new") { context.playerConfig = playerConfig; return { ok: true, data: { id: 101 } }; }
					if (request.method === "tabs.close") return { ok: true, data: { closed: request.params.tab_id } };
					if (request.method === "wait") return { ok: true, data: { matched: true } };
					if (request.method === "dev.network.list") return { ok: true, data: { requests: network } };
					if (request.method === "cdp") {
						const p = request.params;
						if (p.method === "Runtime.evaluate") {
							const value = await vm.runInContext(p.params.expression, page, { timeout: 1000 });
							return { ok: true, data: { result: { result: { value } } } };
						}
						if (p.method === "Network.getCookies") return { ok: true, data: { result: { cookies: [] } } };
					}
					throw new Error(`unexpected RPC ${request.method}: ${request.params?.method}`);
				})().then(result => send({ result })).catch(error => send({ result: { ok: false, error: { message: error.message } } }));
			}
		});
	});
	await new Promise(r => server.listen(0, "127.0.0.1", r));
	t.after(async () => { await new Promise(r => server.close(r)); await rm(root, { recursive: true, force: true }); });
	const env = { ...process.env, HOME: root, TMPDIR: root, AP_BROWSER_REMOTE: `tcp://127.0.0.1:${server.address().port}?token=fixture` };
	return { root, requests, fetched, env, run: async args => JSON.parse((await exec(cli, args, { env, timeout: 20000 })).stdout) };
}

test("download --list discovers loaded MSE playerConfig HLS/DASH, not just anchors", async t => {
	const h = await harness(t);
	const result = await h.run(["download", "--list", "--tab", "42"]);
	assert.equal(result.ok, true);
	assert.ok(result.data.items.some(i => i.url === master), "HLS master missing for blob video");
	assert.ok(result.data.items.some(i => i.url === dash), "DASH master missing for blob video");
	assert.ok(!result.data.items.some(i => i.url.startsWith("blob:")), "MSE blob is not a downloadable source");
	const high = result.data.items.find(i => i.height === 720 && i.program_index === 1);
	assert.equal(high.url, master, "variant uses master so external audio is retained");
	assert.equal(high.variant_url, "https://media.example.invalid/720.m3u8?signature=fixture");
	assert.equal(high.resolution, "1280x720");
	assert.equal(high.bandwidth, 3600000);
	assert.match(high.label, /1280x720.*3600 kbps/);
	assert.deepEqual(h.fetched, [master], "only preferred CDN is fetched, never /config");
});

test("media --type video discovers MSE manifests", async t => {
	const h = await harness(t);
	const result = await h.run(["media", "--type", "video", "--tab", "42"]);
	assert.ok(result.data.media.some(i => i.url === master), "media cannot see the HLS behind MSE");
	assert.ok(result.data.media.every(i => i.type === "video"));
});

test("network MIME and resource timing fallback work without playerConfig", async t => {
	const extensionless = "https://media.example.invalid/manifest?signature=fixture";
	const h = await harness(t, { config: false, performanceUrls: [master], network: [
		{ url: extensionless, mime_type: "application/dash+xml", status: 200 },
		{ url: master, mime_type: "application/vnd.apple.mpegurl", status: 200 },
		{ url: "https://example.invalid/failed.m3u8", status: 403 },
	] });
	const items = (await h.run(["download", "--list", "--tab", "42"])).data.items;
	assert.equal(items.filter(i => i.url === master && i.program_index === undefined).length, 1, "timing/network duplicates collapse");
	assert.equal(items.find(i => i.url === extensionless).format, "dash");
	assert.ok(!items.some(i => i.url.includes("failed")));
});

test("image-only media avoids fetching video manifests", async t => {
	const h = await harness(t);
	assert.deepEqual((await h.run(["media", "--type", "image", "--tab", "42"])).data.media, []);
	assert.deepEqual(h.fetched, []);
});

test("ordinary links, video extensions and manifest links remain discoverable", async t => {
	const urls = ["https://example.invalid/paper.pdf?x=1", "https://example.invalid/video.mp4", master];
	const links = urls.map(href => ({ href, textContent: "Download", hasAttribute: () => false }));
	const h = await harness(t, { config: false, links });
	const items = (await h.run(["download", "--list", "--tab", "42"])).data.items;
	for (const url of urls) assert.ok(items.some(i => i.url === url), url);
	assert.equal(items.find(i => i.type === "pdf").priority, 1);
});

test("cross-origin Vimeo iframe preserves hash and only closes its own silent tab", async t => {
	const h = await harness(t, { config: false, embedded: true });
	const items = (await h.run(["download", "--list", "--tab", "42"])).data.items;
	assert.ok(items.some(i => i.url === master));
	const opened = h.requests.find(r => r.method === "tabs.new");
	assert.equal(opened.params.url, "https://player.vimeo.com/video/42?h=fixture");
	assert.equal(opened.params.active, false);
	assert.deepEqual(h.requests.filter(r => r.method === "tabs.close").map(r => r.params.tab_id), [101]);
});

test("invalid ranges and conflicting selectors fail before any browser request", async t => {
	const h = await harness(t);
	for (const args of [["--start", "NaN"], ["--duration", "0"], ["--start", "1:60"], ["--start", "5", "--end", "4"], ["--duration", "2", "--end", "3"], ["--list", "--hls", master]]) {
		await assert.rejects(h.run(["download", ...args]), e => JSON.parse(e.stdout).ok === false);
	}
	assert.equal(h.requests.length, 0);
});

test("empty list clears stale --pick state and explicit profiles are retained", async t => {
	const h = await harness(t, { config: false });
	await writeFile(join(h.root, "ap-browser-download-list.json"), JSON.stringify({ items: [{ url: master }], tab: 42, profile: "fixture" }));
	const result = await h.run(["download", "--list", "--tab", "42", "--profile", "fixture"]);
	assert.deepEqual(result.data.items, []);
	const cache = JSON.parse(await readFile(join(h.root, "ap-browser-download-list.json"), "utf8"));
	assert.equal(cache.profile, "fixture");
	assert.deepEqual(cache.items, []);
	await assert.rejects(h.run(["download", "--pick", "0", "--tab", "42", "--profile", "fixture"]), e => JSON.parse(e.stdout).ok === false);
});

async function hlsFixture(t) {
	const root = await mkdtemp(join(tmpdir(), "capture-hls-"));
	const ffmpeg = async args => exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", ...args], { timeout: 20000 });
	await ffmpeg(["-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", "8", "-c:v", "libx264", "-preset", "ultrafast", "-g", "30", "-sc_threshold", "0", "-c:a", "aac", join(root, "source.mp4")]);
	const source = join(root, "source.mp4");
	for (const [name, mapping] of [["high", ["-map", "0:v:0", "-c", "copy"]], ["low", ["-map", "0:v:0", "-vf", "scale=160:90", "-c:v", "libx264", "-g", "30", "-sc_threshold", "0"]], ["audio", ["-map", "0:a:0", "-c", "copy"]]]) {
		await ffmpeg(["-i", source, ...mapping, "-hls_time", "1", "-hls_playlist_type", "vod", join(root, `${name}.m3u8`)]);
	}
	const text = `#EXTM3U\n#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio",NAME="English",DEFAULT=YES,AUTOSELECT=YES,URI="audio.m3u8"\n#EXT-X-STREAM-INF:BANDWIDTH=200000,RESOLUTION=160x90,AUDIO="audio"\nlow.m3u8\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=320x180,AUDIO="audio"\nhigh.m3u8\n`;
	await writeFile(join(root, "master.m3u8"), text);
	const server = createHttpServer(async (req, res) => {
		try {
			const path = join(root, new URL(req.url, "http://localhost").pathname.split("/").pop());
			const bytes = await readFile(path);
			const range = req.headers.range?.match(/^bytes=(\d+)-(\d*)$/);
			const start = range ? Number(range[1]) : 0, end = range?.[2] ? Number(range[2]) : bytes.length - 1;
			const headers = { "Content-Length": end - start + 1, "Accept-Ranges": "bytes", "Content-Type": path.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t" };
			if (range) headers["Content-Range"] = `bytes ${start}-${end}/${bytes.length}`;
			res.writeHead(range ? 206 : 200, headers); createReadStream(path, { start, end }).pipe(res);
		} catch { res.writeHead(404); res.end(); }
	});
	await new Promise(r => server.listen(0, "127.0.0.1", r));
	t.after(async () => { await new Promise(r => server.close(r)); await rm(root, { recursive: true, force: true }); });
	return { root, url: `http://127.0.0.1:${server.address().port}/master.m3u8`, text };
}

for (const [site, url] of [["YouTube", "https://www.youtube.com/watch?v=fixture"], ["Bilibili", "https://www.bilibili.com/video/BVfixture/"]]) {
	test(`${site}: --video downloads only the requested interval and keeps stdout JSON`, { timeout: 30000 }, async t => {
		const fixture = await hlsFixture(t), h = await harness(t);
		const bin = join(h.root, "bin"); await mkdir(bin);
		const stub = `#!/usr/bin/env node
import { appendFileSync, copyFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if(args.includes('--version')) { console.log('2026.07.04'); process.exit(0); }
appendFileSync(process.env.EXTRACTOR_LOG, JSON.stringify(args)+'\\n');
if(process.env.EXTRACTOR_FAIL) { console.error(process.env.EXTRACTOR_FAIL); process.exit(1); }
const output = args[args.indexOf('--output')+1];
if(args.includes('--download-sections')) {
  const section = args[args.indexOf('--download-sections')+1];
  if(section !== '*2.500000-4.500000' || !args.includes('--force-keyframes-at-cuts')) { console.error('missing bounded extraction'); process.exit(1); }
  const result = spawnSync('ffmpeg', ['-hide_banner','-loglevel','error','-y','-ss','2.5','-i',process.env.EXTRACTOR_FIXTURE,'-t','2','-c:v','libx264','-c:a','aac',output]);
  if(result.status !== 0) process.exit(1);
} else { copyFileSync(process.env.EXTRACTOR_FIXTURE, output); }
if(!args.includes('--quiet')) console.log('[download] 100% (extractor progress)');
if(args.includes('--print')) console.log(JSON.stringify(output));
`;
		await writeFile(join(bin, "yt-dlp"), stub, { mode: 0o755 });
		h.env.PATH = bin + delimiter + process.env.PATH;
		h.env.EXTRACTOR_FIXTURE = join(fixture.root, "source.mp4");
		h.env.EXTRACTOR_LOG = join(h.root, "extractor.jsonl");
		const out = join(fixture.root, `${site.toLowerCase()}-clip.mp4`);
		const result = await h.run(["download", url, "--video", "--start", "2.5", "--duration", "2", "--out", out]);
		assert.equal(result.data.method, "yt-dlp");
		const args = JSON.parse((await readFile(h.env.EXTRACTOR_LOG, "utf8")).trim());
		assert.ok(args.includes(url)); assert.ok(args.includes("--no-playlist"));
		assert.deepEqual(args.slice(args.indexOf("--cookies-from-browser"), args.indexOf("--cookies-from-browser")+2), ["--cookies-from-browser", "chrome"]);
		assert.equal(h.requests.length, 0, "external extractor does not require the browser extension");
		const probe = JSON.parse((await exec("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=codec_type,nb_read_frames:format=duration", "-of", "json", out])).stdout);
		assert.equal(probe.streams.find(s => s.codec_type === "video").nb_read_frames, "60");
		assert.ok(probe.streams.some(s => s.codec_type === "audio"));
		assert.ok(Math.abs(Number(probe.format.duration)-2)<0.1);
		const whole = join(fixture.root, `${site.toLowerCase()}-whole.mp4`);
		assert.equal((await h.run(["download", url, "--video", "--cookies-from", "firefox", "--out", whole])).ok, true);
		const calls = (await readFile(h.env.EXTRACTOR_LOG, "utf8")).trim().split("\n").map(JSON.parse);
		assert.equal(calls[1].filter(a => a === "--cookies-from-browser").length, 1);
		assert.ok(calls[1].includes("firefox")); assert.ok(!calls[1].includes("--download-sections"));
		h.env.EXTRACTOR_FAIL = site === "YouTube" ? "Signature solving failed: https://cdn.invalid/video?secret=fixture-token" : "Unable to extract initial state: https://cdn.invalid/video?secret=fixture-token";
		const failed = join(fixture.root, `${site.toLowerCase()}-failed.mp4`);
		await assert.rejects(h.run(["download", url, "--video", "--start", "2.5", "--duration", "2", "--out", failed]), e => {
			const error = JSON.parse(e.stdout);
			assert.equal(error.ok, false); assert.ok(!e.stdout.includes("fixture-token"));
			assert.match(error.error.message, site === "YouTube" ? /challenge\/signature/ : /initial state/);
			return true;
		});
		assert.ok(!(await readdir(fixture.root)).some(f => f.startsWith(".ap-browser-extractor-") || f.endsWith("-failed.mp4")), "extractor failure publishes nothing and cleans temporary files");
	});
}

test("real ffmpeg: bounded non-keyframe HLS clip, --auto and --pick retain separate audio", { timeout: 60000 }, async t => {
	const fixture = await hlsFixture(t);
	const h = await harness(t, { masterUrl: fixture.url, manifestText: fixture.text });
	const check = async (file, width) => {
		const { stdout } = await exec("ffprobe", ["-v", "error", "-count_frames", "-show_entries", "stream=codec_type,width,nb_read_frames:format=duration", "-of", "json", file]);
		const probe = JSON.parse(stdout), video = probe.streams.find(s => s.codec_type === "video");
		assert.equal(video.width, width); assert.equal(video.nb_read_frames, "60");
		assert.ok(probe.streams.some(s => s.codec_type === "audio"), "external audio group was lost");
		assert.ok(Math.abs(Number(probe.format.duration) - 2) < 0.1);
	};
	const direct = join(fixture.root, "direct.mp4");
	const result = await h.run(["download", "--hls", fixture.url, "--start", "00:00:02.500", "--duration", "2", "--out", direct]);
	assert.equal(result.data.method, "ffmpeg"); await check(direct, 320);
	assert.equal(h.requests.length, 0, "explicit HLS does not require Chrome");
	const auto = join(fixture.root, "auto.mp4");
	await h.run(["download", "--auto", "--tab", "42", "--ss", "2.5", "--to", "4.5", "--out", auto]);
	await check(auto, 320);
	const items = (await h.run(["download", "--list", "--tab", "42"])).data.items;
	const low = items.find(i => i.program_index === 0);
	const picked = join(fixture.root, "picked.mp4");
	await h.run(["download", "--pick", String(low.id), "--tab", "42", "--start", "2.5", "--duration", "2", "--out", picked]);
	await check(picked, 160);
	const otherProfile = ["download", "--pick", String(low.id), "--tab", "42", "--profile", "other"];
	await assert.rejects(h.run(otherProfile), e => /another tab\/profile/.test(e.stdout));
	await assert.rejects(h.run(["download", "--hls", fixture.url, "--duration", "2", "--out", direct]), e => /already exists/.test(e.stdout));
	const short = join(fixture.root, "short.mp4");
	await assert.rejects(h.run(["download", "--hls", fixture.url, "--duration", "20", "--out", short]), e => /incomplete stream clip/.test(e.stdout));
	assert.ok(!(await readdir(fixture.root)).includes("short.mp4"));
	assert.ok(!(await readdir(fixture.root)).some(f => f.startsWith(".ap-browser-stream-")), "partial files are cleaned");
});
