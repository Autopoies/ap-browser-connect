// popup.js — bound to chrome.storage.local.

const labelInput = document.getElementById("label");
const instanceIdEl = document.getElementById("instanceId");
const copyBtn = document.getElementById("copyBtn");
const hostDot = document.getElementById("hostDot");
const hostState = document.getElementById("hostState");
const opsDot = document.getElementById("opsDot");
const opsCount = document.getElementById("opsCount");

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

async function refreshStatus() {
  try {
    const s = await chrome.runtime.sendMessage({ method: "status" });
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
const statusInterval = setInterval(refreshStatus, 1000);
