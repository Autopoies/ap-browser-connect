// popup.js — bound to chrome.storage.local.

const labelInput = document.getElementById("label");
const instanceIdEl = document.getElementById("instanceId");
const copyBtn = document.getElementById("copyBtn");
const hostDot = document.getElementById("hostDot");
const hostState = document.getElementById("hostState");
const opsDot = document.getElementById("opsDot");
const opsCount = document.getElementById("opsCount");
const sessionsDot = document.getElementById("sessionsDot");
const sessionsCount = document.getElementById("sessionsCount");
const manageSessionsBtn = document.getElementById("manageSessionsBtn");
const settingsBtn = document.getElementById("settingsBtn");
const settingsPanel = document.getElementById("settingsPanel");
const openFullOptionsLink = document.getElementById("openFullOptionsLink");

const annotateBtn = document.getElementById("annotateBtn");
const annotateLabel = annotateBtn.querySelector(".ab-label");
const annotateCount = document.getElementById("annotateCount");

document.getElementById("annotateKbd").textContent = /Mac|iPhone|iPad/.test(navigator.platform)
	? "⌘⇧E"
	: "Alt⇧E";

annotateBtn.addEventListener("click", async () => {
	const original = annotateLabel.textContent;
	try {
		const r = await chrome.runtime.sendMessage({ method: "toggle-annotate" });
		if (r && r.ok === false && r.error) {
			annotateBtn.title = r.error;
			annotateLabel.textContent = r.error.slice(0, 22);
		} else {
			annotateLabel.textContent = "Toggled";
		}
		setTimeout(() => (annotateLabel.textContent = original), 1200);
	} catch (_) {}
	refreshAnnotateCount();
});

async function refreshAnnotateCount() {
	try {
		const r = await withTimeout(chrome.runtime.sendMessage({ method: "annotations.count" }), 1200);
		if (r && r.ok) {
			annotateCount.textContent = String(r.count);
			annotateCount.hidden = r.count === 0;
		}
	} catch (_) {}
}

async function init() {
	const stored = await chrome.storage.local.get([
		"instance_id",
		"label",
		"custom_annotate_shortcut",
	]);
	const idStr = stored.instance_id || "(not set)";
	instanceIdEl.textContent = idStr;
	instanceIdEl.title = idStr;
	labelInput.value = stored.label || "";

	if (stored.custom_annotate_shortcut?.display) {
		document.getElementById("annotateKbd").textContent = stored.custom_annotate_shortcut.display;
	}
}

// Toggle Inline Settings Panel
settingsBtn?.addEventListener("click", (e) => {
	e.preventDefault();
	settingsPanel.hidden = !settingsPanel.hidden;
	settingsBtn.textContent = settingsPanel.hidden ? "Settings" : "Close";
});

// Open Full Page Options
function openFullOptions(e) {
	e?.preventDefault?.();
	chrome.tabs.create({ url: chrome.runtime.getURL("options.html") });
}

openFullOptionsLink?.addEventListener("click", openFullOptions);
manageSessionsBtn?.addEventListener("click", (e) => {
	e?.preventDefault?.();
	chrome.tabs.create({ url: `${chrome.runtime.getURL("options.html")}#sessions` });
});

function withTimeout(p, ms) {
	return Promise.race([
		p,
		new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), ms)),
	]);
}

async function refreshStatus() {
	try {
		const s = await withTimeout(chrome.runtime.sendMessage({ method: "status" }), 1200);
		if (!s) return;
		if (s.native_host === "connected") {
			hostDot.className = "dot connected";
			hostState.textContent = "connected";
		} else {
			hostDot.className = "dot disconnected";
			hostState.textContent = "offline";
		}
		const n = s.active_ops || 0;
		opsCount.textContent = String(n);
		opsDot.className = n > 0 ? "dot connected" : "dot idle";
	} catch (_) {
		hostDot.className = "dot disconnected";
		hostState.textContent = "offline";
	}
}

labelInput.addEventListener("input", async (e) => {
	const value = e.target.value.trim().slice(0, 32);
	await chrome.storage.local.set({ label: value });
	await chrome.runtime.sendMessage({ method: "profile.set_label", label: value });
});

labelInput.addEventListener("keydown", (e) => {
	if (e.key === "Enter") window.close();
});

copyBtn.addEventListener("click", async () => {
	const { instance_id } = await chrome.storage.local.get("instance_id");
	if (instance_id) {
		try {
			await navigator.clipboard.writeText(instance_id);
			copyBtn.textContent = "Copied";
			setTimeout(() => (copyBtn.textContent = "Copy"), 1000);
		} catch (_) {
			copyBtn.textContent = "Failed";
			setTimeout(() => (copyBtn.textContent = "Copy"), 1000);
		}
	}
});

init();
refreshStatus();
refreshAnnotateCount();
setInterval(refreshStatus, 1000);

async function refreshBindings() {
	try {
		const res = await withTimeout(chrome.runtime.sendMessage({ method: "session.bindings" }), 1200);
		if (!res?.ok) throw new Error(res?.error || "Bindings unavailable");
		const bindings = Array.isArray(res.data?.bindings) ? res.data.bindings : [];
		const count = bindings.filter(
			(b) => b.health?.state === "ready" && b.health.valid_until > Date.now(),
		).length;
		sessionsDot.className = count > 0 ? "dot connected" : "dot idle";
		sessionsCount.textContent = `${count} ready / ${bindings.length} saved`;
		sessionsCount.title =
			bindings.length > 0
				? bindings
						.map(
							(b) =>
								`${b.label} (${b.scope}, ${b.health?.state === "ready" && b.health.valid_until > Date.now() ? "ready" : b.health?.state === "offline" ? "offline" : "unverified"})`,
						)
						.join(", ")
				: "No active session bindings (Pin-only mode)";
	} catch (_) {
		sessionsDot.className = "dot idle";
		sessionsCount.textContent = "Connection unverified";
	}
}
chrome.storage.onChanged.addListener((changes, area) => {
	if (area === "session" && changes.session_bindings) refreshBindings();
});
refreshBindings();
setInterval(refreshBindings, 2000);
