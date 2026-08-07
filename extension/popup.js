// popup.js — bound to chrome.storage.local.

const labelInput = document.getElementById("label");
const instanceIdEl = document.getElementById("instanceId");
const copyBtn = document.getElementById("copyBtn");
const hostDot = document.getElementById("hostDot");
const hostState = document.getElementById("hostState");
const opsDot = document.getElementById("opsDot");
const opsCount = document.getElementById("opsCount");

const annotateBtn = document.getElementById("annotateBtn");
const annotateLabel = annotateBtn.querySelector(".ab-label");
const annotateCount = document.getElementById("annotateCount");
// Shortcut differs by platform: mac uses Command+Shift+A (Option+Shift is
// swallowed by input-method switching), everything else Alt+Shift+A.
document.getElementById("annotateKbd").textContent = /Mac|iPhone|iPad/.test(
	navigator.platform,
)
	? "⌘⇧A"
	: "Alt⇧A";

annotateBtn.addEventListener("click", async () => {
	const original = annotateLabel.textContent;
	try {
		const r = await chrome.runtime.sendMessage({ method: "toggle-annotate" });
		if (r && r.ok === false && r.error) {
			annotateBtn.title = r.error;
			annotateLabel.textContent = "✗ " + r.error.slice(0, 22);
		} else {
			annotateLabel.textContent = "✓ Toggled";
		}
		setTimeout(() => (annotateLabel.textContent = original), 1200);
	} catch (_) {}
	refreshAnnotateCount();
});

async function refreshAnnotateCount() {
	try {
		const r = await withTimeout(
			chrome.runtime.sendMessage({ method: "annotations.count" }),
			1200,
		);
		if (r && r.ok) {
			annotateCount.textContent = String(r.count);
			annotateCount.hidden = r.count === 0;
		}
	} catch (_) {}
}

async function init() {
	const { instance_id, label } = await chrome.storage.local.get([
		"instance_id",
		"label",
	]);
	const idStr = instance_id || "(not set)";
	instanceIdEl.textContent = idStr;
	instanceIdEl.title = idStr;
	labelInput.value = label || "";
	labelInput.focus();
	labelInput.select();
}

// Popup UI must render instantly even when the SW is cold-starting: bound
// every background round-trip with a timeout and show offline until it
// answers (next 1s tick retries).
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
		// SW may be down; show offline until it responds.
		hostDot.className = "dot disconnected";
		hostState.textContent = "offline";
	}
}

labelInput.addEventListener("input", async (e) => {
	const value = e.target.value.trim().slice(0, 32);
	await chrome.storage.local.set({ label: value });
});

labelInput.addEventListener("keydown", (e) => {
	if (e.key === "Enter") window.close();
});

copyBtn.addEventListener("click", async () => {
	const { instance_id } = await chrome.storage.local.get("instance_id");
	if (instance_id) {
		try {
			await navigator.clipboard.writeText(instance_id);
			copyBtn.textContent = "✓";
			setTimeout(() => (copyBtn.textContent = "Copy"), 1000);
		} catch (_) {
			copyBtn.textContent = "✗";
			setTimeout(() => (copyBtn.textContent = "Copy"), 1000);
		}
	}
});

init();
refreshStatus();
refreshAnnotateCount();
const statusInterval = setInterval(refreshStatus, 1000);
