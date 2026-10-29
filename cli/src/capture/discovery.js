// Evaluated in the page's MAIN world via CDP. Never fetch Vimeo's /config endpoint.
(async function discoverCapture(options) {
    const downloads = [], media = [], player_frames = [], seenDownloads = new Set(), seenMedia = new Set();
    const wantImages = options.mode === "media" && ["all", "image"].includes(options.media_type);
    const wantVideo = options.mode === "downloads" || ["all", "video"].includes(options.media_type);
    const wantAudio = options.mode === "downloads" || ["all", "audio"].includes(options.media_type);
    const http = (url, base = location.href) => {
        if (typeof url !== "string" || !url) return null;
        try { const u = new URL(url, base); return ["http:", "https:"].includes(u.protocol) ? u.href : null; } catch { return null; }
    };
    const formatOf = (url, mime = "") => {
        const path = url.split(/[?#]/)[0].toLowerCase();
        if (path.endsWith(".m3u8") || /mpegurl/i.test(mime)) return "hls";
        if (path.endsWith(".mpd") || /dash\+xml/i.test(mime)) return "dash";
        return null;
    };
    const filename = url => url.split(/[?#]/)[0].split("/").pop() || "download";
    const addDownload = item => {
        const url = http(item.url);
        if (!url) return;
        const key = `${url}|${item.program_index ?? "master"}`;
        if (seenDownloads.has(key)) return;
        seenDownloads.add(key);
        downloads.push({ ...item, url, id: downloads.length });
    };
    const addMedia = item => {
        const url = http(item.url);
        if (!url) return; // blob: is a browser-local MSE handle, not a source URL.
        const key = `${item.type}|${url}|${item.program_index ?? "master"}`;
        if (seenMedia.has(key)) return;
        seenMedia.add(key);
        media.push({ filename: filename(url), ...item, url });
    };
    const addStream = (item, type = "video") => {
        if (type === "video" ? !wantVideo : !wantAudio) return;
        const format = item.format || formatOf(item.url);
        const details = { label: filename(item.url), priority: 9, ...item, ...(format ? { format } : {}) };
        addDownload({ ...details, type: format || type });
        addMedia({ ...details, type });
    };
    const manifests = [];
    const scan = win => {
        const doc = win.document, referer = win.location.href;
        if (options.mode === "downloads") for (const a of doc.querySelectorAll("a[href]")) {
            const url = http(a.href, referer), label = (a.textContent || "").trim().slice(0, 100);
            if (!url || /share|tweet|facebook|twitter|linkedin|wechat|weibo/i.test(label)) continue;
            const path = url.split(/[?#]/)[0].toLowerCase();
            const ext = options.extensions.find(([ext]) => path.endsWith(ext));
            const pattern = options.url_patterns.find(([pat]) => path.includes(pat));
            const format = formatOf(url);
            if (format) addStream({ url, label, format, source: "href-extension", priority: 4, referer });
            else if (ext || a.hasAttribute("download") || pattern) addDownload({ url, label, referer,
                type: ext?.[1] || pattern?.[1] || "unknown",
                source: ext ? "href-extension" : a.hasAttribute("download") ? "download-attr" : "url-pattern",
                priority: ext?.[1] === "pdf" || pattern?.[1] === "pdf" ? 1 : a.hasAttribute("download") ? 2 : ext ? 3 : 4 });
        }
        if (wantImages) {
            for (const el of doc.querySelectorAll("img")) if (el.src) addMedia({ type: "image", url: el.src, source: "img" });
            for (const el of doc.querySelectorAll('[style*="background-image"]')) {
                const match = el.style.backgroundImage.match(/url\(["']?(.+?)["']?\)/);
                if (match) addMedia({ type: "image", url: match[1], source: "css" });
            }
            for (const el of doc.querySelectorAll("source[srcset]")) for (const src of el.srcset.split(",")) {
                const url = src.trim().split(/\s+/)[0];
                if (url) addMedia({ type: "image", url, source: "srcset" });
            }
        }
        for (const type of ["video", "audio"]) {
            for (const el of doc.querySelectorAll(type)) {
                const url = http(el.currentSrc || el.src, referer);
                if (url) addStream({ url, source: type, referer }, type);
                for (const source of el.querySelectorAll("source")) if (source.src) {
                    addStream({ url: source.src, source: `${type}-source`, referer }, type);
                }
            }
        }
        if (wantVideo) {
            for (const iframe of doc.querySelectorAll("iframe[src]")) {
                const url = http(iframe.src, referer);
                if (url && new URL(url).hostname === "player.vimeo.com" && /^\/video\/\d+/.test(new URL(url).pathname)) player_frames.push(url);
            }
            const config = win.playerConfig, files = config?.request?.files;
            if (files && !files.drm && !config?.video?.drm) {
                const title = String(config.video?.title || doc.title || "Video").slice(0, 100);
                for (const format of ["hls", "dash"]) {
                    const file = files[format];
                    if (!file?.cdns) continue;
                    const cdns = Object.entries(file.cdns);
                    const preferred = cdns.some(([name]) => name === file.default_cdn) ? file.default_cdn : cdns[0]?.[0];
                    for (const [cdn, entry] of cdns) {
                        const url = http(entry.avc_url || entry.url, referer);
                        if (!url) continue;
                        const qualities = [...new Set([...(file.streams || []), ...(file.streams_avc || [])].map(s => s.quality).filter(Boolean))];
                        const item = { url, format, label: `${title} — ${format.toUpperCase()} (${qualities.join(", ") || "master"})`,
                            source: "player-config", cdn, referer, priority: cdn === preferred ? (format === "hls" ? 5 : 6) : 7,
                            qualities, width: config.video?.width, height: config.video?.height };
                        addStream(item);
                        if (format === "hls" && cdn === preferred) manifests.push(item);
                    }
                }
                for (const file of files.progressive || []) if (file.url) addStream({
                    url: file.url, label: `${title} — ${file.quality || "MP4"}`, source: "player-config", referer,
                    width: file.width, height: file.height, priority: 7,
                });
            }
            for (const entry of win.performance?.getEntriesByType("resource") || []) {
                if (formatOf(entry.name)) addStream({ url: entry.name, source: "performance", referer });
            }
        }
    };
    const queue = [window], visited = new Set();
    while (queue.length && visited.size < 16) {
        const win = queue.shift();
        if (visited.has(win)) continue;
        visited.add(win);
        try { scan(win); for (let i = 0; i < win.frames.length; i++) queue.push(win.frames[i]); } catch { /* cross-origin frames: network fallback below */ }
    }
    if (wantVideo) for (const request of options.network || []) {
        const format = formatOf(request.url || "", request.mime_type);
        if (format && !request.failed && (!request.status || request.status < 400)) {
            addStream({ url: request.url, format, source: "network", referer: location.href });
        }
    }
    if (!manifests.length && wantVideo) manifests.push(...downloads.filter(i => i.format === "hls" && i.program_index === undefined).slice(0, 2));
    // Only preferred HLS masters are fetched (bounded); variants keep the master URL
    // and program index, so --pick retains EXT-X-MEDIA audio instead of downloading silent video.
    for (const item of manifests.slice(0, 2)) {
        try {
            const response = await fetch(item.url, { signal: AbortSignal.timeout(5000) });
            if (!response.ok) continue;
            const text = await response.text();
            if (text.length > 1024 * 1024 || !text.trimStart().startsWith("#EXTM3U")) continue;
            const lines = text.split(/\r?\n/).map(s => s.trim());
            let program_index = 0;
            for (let i = 0; i < lines.length; i++) {
                if (!lines[i].startsWith("#EXT-X-STREAM-INF:")) continue;
                const attrs = Object.fromEntries([...lines[i].matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)].map(m => [m[1], m[2].replace(/^"|"$/g, "")]));
                const next = lines.slice(i + 1).find(s => s && !s.startsWith("#"));
                const variant_url = next && http(next, response.url || item.url);
                const index = program_index++;
                if (!variant_url) continue;
                const [width, height] = (attrs.RESOLUTION || "").split("x").map(Number);
                const bandwidth = Number(attrs.BANDWIDTH) || undefined;
                const resolution = width && height ? `${width}x${height}` : "unknown";
                addStream({ ...item, variant_url, program_index: index, width, height, bandwidth,
                    resolution, fps: Number(attrs["FRAME-RATE"]) || undefined, priority: 8,
                    label: `${resolution} ${bandwidth ? `${Math.round(bandwidth / 1000)} kbps` : ""} — HLS`.trim() });
            }
        } catch { /* Config master remains usable if manifest fetch/CORS is denied. */ }
    }
    return { items: downloads, media, page_url: location.href, player_frames: [...new Set(player_frames)], user_agent: navigator.userAgent };
})
