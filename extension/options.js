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
const agentSelect = document.getElementById("agentSelect");
const detectedAgentsList = document.getElementById("detectedAgentsList");
const customAgentGroup = document.getElementById("customAgentGroup");
const customAgentCmd = document.getElementById("customAgentCmd");
const terminalSelect = document.getElementById("terminalSelect");
const detectedTerminalsList = document.getElementById("detectedTerminalsList");
const workspaceCwdInput = document.getElementById("workspaceCwd");
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
		"default_agent",
		"custom_agent_cmd",
		"default_terminal",
		"workspace_cwd",
	]);

	instanceIdCode.textContent = stored.instance_id || "—";
	instanceIdCode.title = stored.instance_id || "";
	profileLabelInput.value = stored.label || "";

	if (stored.custom_annotate_shortcut) {
		currentShortcut = stored.custom_annotate_shortcut;
	}
	shortcutDisplay.textContent = formatShortcutDisplay(currentShortcut);

	if (stored.default_agent) {
		agentSelect.value = stored.default_agent;
	}
	customAgentGroup.hidden = agentSelect.value !== "custom";
	if (stored.custom_agent_cmd) {
		customAgentCmd.value = stored.custom_agent_cmd;
	}

	// 2. Query Host capabilities
	fetchHostCapabilities(stored.default_terminal, stored.workspace_cwd);
}

async function fetchHostCapabilities(savedTerminal, savedCwd) {
	try {
		const res = await chrome.runtime.sendMessage({ method: "host.capabilities" });
		if (res?.ok && res.data) {
			hostStatusDot.className = "status-dot connected";
			hostStatusText.textContent = "Native Host Connected";
			renderCapabilities(res.data, savedTerminal, savedCwd);
		} else {
			hostStatusDot.className = "status-dot disconnected";
			hostStatusText.textContent = res?.error || "Host not responding";
		}
	} catch (e) {
		hostStatusDot.className = "status-dot disconnected";
		hostStatusText.textContent = "Native Host Disconnected";
	}
}

function renderCapabilities(caps, savedTerminal, savedCwd) {
	// Agents badges
	detectedAgentsList.replaceChildren();
	if (Array.isArray(caps.agents)) {
		for (const agent of caps.agents) {
			const badge = document.createElement("span");
			badge.className = `badge ${agent.installed ? "detected" : ""}`;
			badge.textContent = `${agent.name}: ${agent.installed ? "✓ Installed" : "Not Found"}`;
			detectedAgentsList.appendChild(badge);
		}
	}

	// Terminals
	const defaultOpt = document.createElement("option");
	defaultOpt.value = "auto";
	defaultOpt.textContent = "Auto (Default / Ghostty / iTerm / WT)";
	terminalSelect.replaceChildren(defaultOpt);
	detectedTerminalsList.replaceChildren();
	if (Array.isArray(caps.terminals)) {
		for (const term of caps.terminals) {
			if (term.installed) {
				const opt = document.createElement("option");
				opt.value = term.id;
				opt.textContent = term.name;
				terminalSelect.appendChild(opt);
			}
			const badge = document.createElement("span");
			badge.className = `badge ${term.installed ? "detected" : ""}`;
			badge.textContent = `${term.name}: ${term.installed ? "✓ Installed" : "Not Found"}`;
			detectedTerminalsList.appendChild(badge);
		}
	}

	if (savedTerminal && Array.from(terminalSelect.options).some((o) => o.value === savedTerminal)) {
		terminalSelect.value = savedTerminal;
	}

	// CWD
	if (savedCwd) {
		workspaceCwdInput.value = savedCwd;
	} else if (caps.default_cwd) {
		workspaceCwdInput.value = caps.default_cwd;
	}
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

// ─── Agent Select Toggle ──────────────────────────────────────────────────
agentSelect.addEventListener("change", () => {
	customAgentGroup.hidden = agentSelect.value !== "custom";
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
	const default_agent = agentSelect.value;
	const custom_agent_cmd = customAgentCmd.value.trim();
	const default_terminal = terminalSelect.value;
	const workspace_cwd = workspaceCwdInput.value.trim();

	// Save to local storage
	await chrome.storage.local.set({
		label,
		custom_annotate_shortcut: currentShortcut,
		default_agent,
		custom_agent_cmd,
		default_terminal,
		workspace_cwd,
	});

	// Notify background of profile label change
	await chrome.runtime.sendMessage({ method: "profile.set_label", label });

	saveMsg.hidden = false;
	setTimeout(() => {
		saveMsg.hidden = true;
	}, 2000);
});

init();
