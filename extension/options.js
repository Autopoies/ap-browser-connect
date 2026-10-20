// options.js — Settings controller for AP Browser Connect

const isMacPlatform = navigator.platform.includes("Mac");
const DEFAULT_SHORTCUT = {
	key: "E",
	altKey: !isMacPlatform,
	shiftKey: true,
	ctrlKey: false,
	metaKey: isMacPlatform,
	display: isMacPlatform ? "⌘ Cmd + ⇧ Shift + E" : "Alt + Shift + E",
};

let currentShortcut = { ...DEFAULT_SHORTCUT };
let isRecording = false;

// DOM Elements
const hostStatusDot = document.getElementById("hostStatusDot");
const hostStatusText = document.getElementById("hostStatusText");
const profileLabelInput = document.getElementById("profileLabel");
const instanceIdCode = document.getElementById("instanceId");
const copyInstanceBtn = document.getElementById("copyInstanceBtn");
const shortcutDisplay = document.getElementById("shortcutDisplay");
const recordShortcutBtn = document.getElementById("recordShortcutBtn");
const resetShortcutBtn = document.getElementById("resetShortcutBtn");
const openChromeShortcutsLink = document.getElementById("openChromeShortcutsLink");
const saveBtn = document.getElementById("saveBtn");
const saveMsg = document.getElementById("saveMsg");

function formatShortcutDisplay(sc) {
	if (!sc) return DEFAULT_SHORTCUT.display;
	if (sc.display) return sc.display;
	const parts = [];
	const isMac = navigator.platform.includes("Mac");
	if (sc.metaKey) parts.push(isMac ? "⌘ Cmd" : "Meta");
	if (sc.ctrlKey) parts.push(isMac ? "⌃ Ctrl" : "Ctrl");
	if (sc.altKey) parts.push(isMac ? "⌥ Option" : "Alt");
	if (sc.shiftKey) parts.push(isMac ? "⇧ Shift" : "Shift");
	if (sc.key && !["Control", "Alt", "Shift", "Meta"].includes(sc.key)) {
		parts.push(sc.key.toUpperCase());
	}
	return parts.join(" + ");
}

// ─── Bootstrap ─────────────────────────────────────────────────────────────
async function init() {
	// 1. Load stored configuration
	const stored = await chrome.storage.local.get([
		"instance_id",
		"label",
		"custom_annotate_shortcut",
	]);

	instanceIdCode.textContent = stored.instance_id || "—";
	instanceIdCode.title = stored.instance_id || "";
	profileLabelInput.value = stored.label || "";

	if (stored.custom_annotate_shortcut) {
		currentShortcut = stored.custom_annotate_shortcut;
	}
	shortcutDisplay.textContent = formatShortcutDisplay(currentShortcut);

	const status = await chrome.runtime.sendMessage({ method: "status" });
	const connected = status?.native_host === "connected";
	hostStatusDot.className = `status-dot ${connected ? "connected" : "disconnected"}`;
	hostStatusText.textContent = connected ? "Native Host Connected" : "Native Host Disconnected";
}

// ─── Shortcut Recorder ────────────────────────────────────────────────────
recordShortcutBtn.addEventListener("click", () => {
	isRecording = true;
	shortcutDisplay.classList.add("recording");
	shortcutDisplay.textContent = "Press key combination...";
	recordShortcutBtn.disabled = true;
});

window.addEventListener("keydown", (e) => {
	if (!isRecording) return;
	e.preventDefault();
	e.stopPropagation();

	// Ignore modifier-only presses
	if (["Control", "Alt", "Shift", "Meta"].includes(e.key)) {
		return;
	}

	const hasModifier = e.ctrlKey || e.altKey || e.shiftKey || e.metaKey;
	if (!hasModifier) {
		// Must include at least one modifier
		return;
	}

	currentShortcut = {
		key: e.key,
		ctrlKey: e.ctrlKey,
		altKey: e.altKey,
		shiftKey: e.shiftKey,
		metaKey: e.metaKey,
	};
	currentShortcut.display = formatShortcutDisplay(currentShortcut);

	shortcutDisplay.classList.remove("recording");
	shortcutDisplay.textContent = currentShortcut.display;
	isRecording = false;
	recordShortcutBtn.disabled = false;
});

resetShortcutBtn.addEventListener("click", () => {
	currentShortcut = { ...DEFAULT_SHORTCUT };
	shortcutDisplay.classList.remove("recording");
	shortcutDisplay.textContent = currentShortcut.display;
	isRecording = false;
	recordShortcutBtn.disabled = false;
});

openChromeShortcutsLink.addEventListener("click", (e) => {
	e.preventDefault();
	chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

// ─── Copy Instance ID ─────────────────────────────────────────────────────
copyInstanceBtn.addEventListener("click", () => {
	const val = instanceIdCode.textContent;
	if (val && val !== "—") {
		navigator.clipboard.writeText(val);
		const orig = copyInstanceBtn.textContent;
		copyInstanceBtn.textContent = "Copied!";
		setTimeout(() => (copyInstanceBtn.textContent = orig), 1500);
	}
});

// ─── Save Settings ────────────────────────────────────────────────────────
saveBtn.addEventListener("click", async () => {
	const label = profileLabelInput.value.trim().slice(0, 32);
	// Save to local storage
	await chrome.storage.local.set({
		label,
		custom_annotate_shortcut: currentShortcut,
	});

	// Notify background of profile label change
	await chrome.runtime.sendMessage({ method: "profile.set_label", label });

	saveMsg.hidden = false;
	setTimeout(() => {
		saveMsg.hidden = true;
	}, 2000);
});

init();

const sessionCountBadge = document.getElementById("sessionCountBadge");
const disconnectAllBtn = document.getElementById("disconnectAllBtn");

disconnectAllBtn?.addEventListener("click", async () => {
	await chrome.runtime.sendMessage({ method: "session.unbind", all: true });
	await refreshBindings();
});

async function refreshBindings() {
	const list = document.getElementById("sessionBindings");
	try {
		const res = await chrome.runtime.sendMessage({ method: "session.bindings" });
		if (!res?.ok) throw new Error(res?.error || "Bindings unavailable");
		const bindings = Array.isArray(res.data?.bindings) ? res.data.bindings : [];
		list.replaceChildren();
		const ready = bindings.filter(
			(b) => b.health?.state === "ready" && b.health.valid_until > Date.now(),
		);
		if (sessionCountBadge) {
			sessionCountBadge.textContent = `${ready.length} Ready / ${bindings.length} Saved`;
			sessionCountBadge.className = ready.length > 0 ? "badge detected" : "badge";
		}
		if (disconnectAllBtn) {
			disconnectAllBtn.hidden = bindings.length < 2;
		}
		if (!bindings.length) {
			const empty = document.createElement("div");
			empty.className = "session-empty";
			const titleRow = document.createElement("div");
			titleRow.className = "session-empty-title";
			const dot = document.createElement("span");
			dot.className = "status-dot";
			const titleText = document.createElement("span");
			titleText.textContent = "No active session bindings — Pin-Only mode";
			titleRow.append(dot, titleText);
			const hint = document.createElement("p");
			hint.className = "help-text";
			hint.textContent =
				'Bind a live agent session from your terminal using ap-browser bind --inbox <dir> --label "<session title>".';
			empty.append(titleRow, hint);
			list.appendChild(empty);
			return;
		}
		for (const b of bindings) {
			const row = document.createElement("div");
			row.className = "session-item";

			const info = document.createElement("div");
			info.className = "session-info";

			const primary = document.createElement("div");
			primary.className = "session-primary";

			const dot = document.createElement("span");
			dot.className = `status-dot ${ready.includes(b) ? "connected" : "disconnected"}`;
			dot.title = b.health?.reason || "Receiver readiness unverified";

			const title = document.createElement("span");
			title.className = "session-title";
			title.textContent = `${b.label || b.session_id} · ${ready.includes(b) ? "ready" : b.health?.state === "offline" ? "offline" : "unverified"}`;

			const scopeBadge = document.createElement("span");
			scopeBadge.className = "badge detected";
			scopeBadge.textContent = b.scope === "tab" ? `Tab ${b.tab_id}` : `Window ${b.window_id}`;

			const pidBadge = document.createElement("span");
			pidBadge.className = "badge";
			pidBadge.textContent = `PID ${b.pid}`;

			primary.append(dot, title, scopeBadge, pidBadge);

			const meta = document.createElement("div");
			meta.className = "session-meta";
			const metaLabel = document.createElement("span");
			metaLabel.textContent = "Session ID:";
			const sessionCode = document.createElement("code");
			sessionCode.className = "session-code";
			sessionCode.textContent = b.session_id;
			sessionCode.title = b.inbox ? `Inbox: ${b.inbox}` : b.session_id;
			meta.append(metaLabel, sessionCode);

			info.append(primary, meta);

			const button = document.createElement("button");
			button.type = "button";
			button.className = "btn btn-secondary btn-sm";
			button.textContent = "Disconnect";
			button.addEventListener("click", async () => {
				await chrome.runtime.sendMessage({
					method: "session.unbind",
					session_id: b.session_id,
					window_id: b.window_id,
					tab_id: b.scope === "tab" ? b.tab_id : null,
				});
				await refreshBindings();
			});

			row.append(info, button);
			list.appendChild(row);
		}
	} catch (_) {
		list.replaceChildren();
		const empty = document.createElement("div");
		empty.className = "session-empty";
		const titleRow = document.createElement("div");
		titleRow.className = "session-empty-title";
		const dot = document.createElement("span");
		dot.className = "status-dot disconnected";
		const titleText = document.createElement("span");
		titleText.textContent = "Bindings unavailable (native host offline)";
		titleRow.append(dot, titleText);
		empty.appendChild(titleRow);
		list.appendChild(empty);
	}
}
chrome.storage.onChanged.addListener((changes, area) => {
	if (area === "session" && changes.session_bindings) refreshBindings();
});
refreshBindings();
