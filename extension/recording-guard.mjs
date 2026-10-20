// Attachment history, not viewport/DPR inference, authorizes the audited screenshot path.
const error = (message) => Object.assign(new Error(message), { code: "RECORD_GEOMETRY_CHANGED" });
const mutators = new Set([
	"Emulation.setDeviceMetricsOverride", "Emulation.clearDeviceMetricsOverride",
	"Emulation.setVisibleSize", "Emulation.forceViewport", "Emulation.resetViewport",
	"Emulation.setPageScaleFactor", "Emulation.resetPageScaleFactor",
	"Emulation.setScrollbarsHidden", "Emulation.setAutoDarkModeOverride",
	"Page.setDeviceMetricsOverride", "Page.clearDeviceMetricsOverride",
	"Emulation.setDisplayFeaturesOverride", "Emulation.clearDisplayFeaturesOverride",
	"Emulation.setDevicePostureOverride", "Emulation.clearDevicePostureOverride",
	"Emulation.setSafeAreaInsetsOverride",
	// Opaque nested CDP transport cannot be certified as nonmutating.
	"Target.sendMessageToTarget",
]);
const unsafeScreenshot = (p) => p?.clip != null || p?.captureBeyondViewport !== false || p?.fromSurface === false;
export function createRecordingGuard(sendCommand) {
	const targets = new Map();
	function attached(tabId, clean) {
		// Called ONLY following a real attach result; Already attached is unknown.
		targets.set(tabId, { clean, owned: clean, pending: 0, owner: null });
	}
	function detached(tabId) { targets.delete(tabId); }
	function send(source, method, params = {}, token) {
		const state = targets.get(source.tabId);
		const screenshot = method === "Page.captureScreenshot";
		const mutator = mutators.has(method) || (screenshot && unsafeScreenshot(params));
		// Legacy nested transport can address another target/session, not source.tabId.
		if (method === "Target.sendMessageToTarget") {
			if ([...targets.values()].some(s => s.owner)) return Promise.reject(error("Cannot certify the target of nested CDP during recording"));
			for (const s of targets.values()) s.clean = false;
		}
		if (state?.owner && (mutator || screenshot) && state.owner !== token) return Promise.reject(error("Recording owns target screenshot/emulation operations"));
		if (token && (!state || state.owner !== token || !state.clean)) return Promise.reject(error("Recording attachment provenance was lost"));
		if (mutator && state) state.clean = false; // Even rejected/failed setters may have side effects.
		if (state && (mutator || screenshot)) state.pending++;
		let pending;
		try { pending = sendCommand(source, method, params); }
		catch (e) { pending = Promise.reject(e); }
		return Promise.resolve(pending).finally(() => { if (state && (mutator || screenshot)) state.pending--; });
	}
	function reserve(tabId) {
		const state = targets.get(tabId);
		if (!state?.clean || state.pending || state.owner) throw error("Target is unknown, emulated or has an in-flight screenshot/emulation operation; use a known clean attachment");
		const token = Symbol("capture owner");
		state.owner = token;
		const emulation = () => {
			if (targets.get(tabId) !== state || state.owner !== token || !state.clean) throw error("Recording attachment provenance was lost");
			return "fresh_known_unemulated";
		};
		return Object.freeze({
			emulation,
			sendCommand: (method, params) => { emulation(); return send({ tabId }, method, params, token); },
			release: () => { if (state.owner === token) state.owner = null; },
		});
	}
	return { attached, detached, send, reserve, ownsAttachment: (tabId) => targets.get(tabId)?.owned === true };
}
