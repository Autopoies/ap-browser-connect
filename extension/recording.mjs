// V2 only: correlated ordinary Page.captureScreenshot callbacks, never screencast events.
// One serial coherence operation OR durable native frame write; all effects injected.
import { fault, invalid, id, identity, credit, equal, canonical, startParams, validateEvent, validateObservation, jpegDimensions, resolveRegion } from "./recording-validation.mjs";
import { snapshotExpression, viewportObservation, mappingKey, imageMapping } from "./recording-geometry.mjs";
export { jpegDimensions } from "./recording-validation.mjs";
const TIMEOUT=10000, MAX_FRAMES=1800, MAX_BYTES=256*1024*1024;
export function recordingCapabilities(p={}) {
	if (!p || typeof p!=="object" || Array.isArray(p) || Object.keys(p).length) throw invalid("Capabilities params must be empty");
	return { protocol_version:2, backend:"cdp_capture_screenshot" };
}
const capability = recordingCapabilities;
const key = (i) => `${i.host_epoch}:${i.record_id}`;
function deferred() { let resolve,reject; const promise=new Promise((a,b)=>{resolve=a;reject=b;}); promise.catch(()=>{}); return {promise,resolve,reject}; }
export function createRecordingController({chrome,sendNative,acquireLease,now=()=>performance.now(),setTimer=setTimeout,clearTimer=clearTimeout}) {
	let active=null, hostEpoch=null, serial=0;
	const starts=new Map(), sessions=new Map();
	function bounded(pending,deadline,cancel) {
		let timer;
		const list=[Promise.resolve(pending),new Promise((_,reject)=>{timer=setTimer(()=>reject(fault("TIMEOUT","Recording operation timed out")),Math.max(0,deadline-now()));})];
		if (cancel) list.push(cancel);
		return Promise.race(list).finally(()=>clearTimer(timer));
	}
	function elapsed(s) { return s.origin == null ? 0 : now()-s.origin; }
	function budget(s) {
		if (s.origin == null) return s.startDeadline;
		return Math.min(s.operationDeadline ?? Infinity,s.origin+s.config.max_duration_ms+TIMEOUT,s.stopDeadline ?? Infinity,s.drainDeadline ?? Infinity);
	}
	function assertPreparing(s) {
		if (s.closed) throw fault("RECORD_INTERRUPTED","Recording preparation interrupted");
		if (now()>=s.startDeadline) throw fault("TIMEOUT","Recording preparation exceeded original 10s budget");
	}
	function trackRaw(s,pending,set) {
		const raw=Promise.resolve(pending); set.add(raw);
		raw.finally(()=>{set.delete(raw); cleanup(s);}).catch(()=>{});
		return raw;
	}
	function command(s,method,params={}) {
		if (s.origin == null) assertPreparing(s);
		const raw=trackRaw(s,Promise.resolve().then(()=>s.access.sendCommand(method,params)),s.chromePending);
		return bounded(raw,budget(s),s.origin == null ? s.cancel.promise : s.abort.promise);
	}
	async function observe(s,selector) {
		const r=await command(s,"Runtime.evaluate",{expression:snapshotExpression(selector),returnByValue:true});
		if (r?.exceptionDetails) throw invalid("Cannot read recording viewport or selector");
		const metrics=await command(s,"Page.getLayoutMetrics");
		return { observation:viewportObservation(r?.result?.value,metrics,s.access.emulation()), element:r?.result?.value?.element };
	}
	function cleanToken(s,purpose) {
		return Object.freeze({identity:Object.freeze({...s.identity}),request_id:`shot_${++serial}`,purpose});
	}
	function counted(s,field) { if (!s.frozen) s.counts[field]++; }
	async function capture(s,purpose) {
		const token=cleanToken(s,purpose), prep=purpose === "preparation";
		s.operationDeadline=now()+TIMEOUT;
		let received=false, rejected=false, cancelled=false;
		const rejectObservation=(late=false)=>{
			if (!prep && received && !rejected) { counted(s,"observations_rejected"); if (late) counted(s,"late_responses"); rejected=true; }
		};
		try {
			const before=(await observe(s)).observation;
			if (prep) assertPreparing(s);
			else {
				if (s.origin == null) {
					assertPreparing(s); s.origin=now(); s.state="recording";
					s.deadlineTimer=setTimer(()=>close(s,"deadline"),s.config.max_duration_ms);
				}
				// Stop/deadline can arrive during before-read. No sample admission after closure.
				if (purpose === "sample" && s.closed) return null;
				if (purpose === "final" && (s.mode !== "stopped" || s.finalAttempt)) throw fault("RECORD_INTERRUPTED","Final admission closed");
				if (elapsed(s)>=s.config.max_duration_ms || now()>=budget(s)) throw fault("RECORD_DEADLINE","No remaining screenshot budget");
			}
			// No async gap between admission, immutable token, clock measurement and invocation.
			const request_started_ms=prep ? null : elapsed(s);
			if (purpose === "final") s.finalAttempt={request_id:token.request_id,request_started_ms};
			counted(s,prep ? "preparation_requests" : "requests_started");
			if (!prep) { s.lastRequestAt=now(); armDelayCounter(s); }
			let invocation;
			try { invocation=s.access.sendCommand("Page.captureScreenshot",{format:"jpeg",quality:s.config.jpeg_quality,fromSurface:true,captureBeyondViewport:false}); }
			catch(e) { invocation=Promise.reject(e); }
			const raw=trackRaw(s,Promise.resolve(invocation).then((r)=>{
				counted(s,prep ? "preparation_responses" : "responses_received");
				received=true;
				if (cancelled) rejectObservation(elapsed(s)>s.config.max_duration_ms || now()>=budget(s));
				return {r,response_received_ms:prep ? null : elapsed(s)};
			},(e)=>{if (!prep) counted(s,"request_failures"); throw e;}),s.chromePending);
			if (!prep && !s.startedResolved) {
				s.startedResolved=true; s.started.resolve({...capability(),identity:s.identity,tab_id:s.tabId,clock:{source:"extension_performance",origin:"before_first_recorded_screenshot_request"},resolved_region_css:s.region});
			}
			const {r,response_received_ms}=await bounded(raw,budget(s),prep ? s.cancel.promise : s.abort.promise);
			if (prep) assertPreparing(s);
			else {
				if (response_received_ms>s.config.max_duration_ms || now()>budget(s)) { rejectObservation(true); throw fault("RECORD_LATE","Screenshot response outside original budget"); }
				if (s.failed || active !== s) { rejectObservation(); throw fault("RECORD_INTERRUPTED","Screenshot cancelled"); }
			}
			const image=jpegDimensions(r?.data);
			const after=(await observe(s)).observation;
			const mapping=imageMapping(before,after,image);
			if (prep) { assertPreparing(s); return {mapping,image}; }
			if (mapping.key !== s.mapping.key) throw fault("RECORD_GEOMETRY_CHANGED","Frozen screenshot mapping changed");
			const geometry_validated_ms=elapsed(s); // after all JPEG and mapping validation
			if (geometry_validated_ms>s.config.max_duration_ms || now()>budget(s)) { rejectObservation(true); throw fault("RECORD_LATE","Screenshot validation outside original budget"); }
			if (s.failed || active !== s) { rejectObservation(); throw fault("RECORD_INTERRUPTED","Screenshot cancelled"); }
			const observation={request_id:token.request_id,purpose:token.purpose,request_started_ms,response_received_ms,geometry_validated_ms};
			validateObservation(observation,s.config.max_duration_ms,response_received_ms,s.lastValidation ?? 0);
			return {identity:token.identity,t_ms:response_received_ms,observation,...image,
				geometry:{viewport_css:mapping.viewport,crop_css:s.region,css_to_image:mapping.transform,before,after},jpeg_base64:r.data};
		} catch(e) { cancelled=true; rejectObservation(e.code === "TIMEOUT" || e.code === "RECORD_LATE"); throw e; }
	}
	function armDelayCounter(s) {
		clearTimer(s.delayTimer);
		s.delayTimer=setTimer(()=>{if (!s.closed && s.busy) counted(s,"scheduling_delays");},1000/s.config.capture_fps);
	}
	async function prepare(s) {
		let previous=null;
		while (true) {
			assertPreparing(s);
			let result;
			try { result=await capture(s,"preparation"); }
			catch(e) { if (e.code !== "RECORD_GEOMETRY_CHANGED") throw e; previous=null; }
			if (result && previous?.mapping.key === result.mapping.key) {
				s.mapping=result.mapping;
				// One final readonly geometry/element selection, no scroll/tracking.
				const final=await observe(s,s.config.region.kind === "element" ? s.config.region.selector : undefined);
				if (mappingKey(final.observation) !== mappingKey(result.mapping.observation)) throw fault("RECORD_GEOMETRY_CHANGED","Mapping changed at final region selection");
				s.region=resolveRegion(s.config.region,s.mapping.viewport,final.element); return;
			}
			previous=result || null;
			await bounded(new Promise((resolve)=>{s.waitTimer=setTimer(resolve,Math.min(40,s.startDeadline-now()));}),s.startDeadline,s.cancel.promise);
		}
	}
	async function persist(s,frame) {
		const length=frame.jpeg_base64.length/4*3-(frame.jpeg_base64.endsWith("==")?2:frame.jpeg_base64.endsWith("=")?1:0);
		if (s.seq>=MAX_FRAMES || s.sentBytes+length>MAX_BYTES) { counted(s,"observations_rejected"); throw fault("RECORD_LIMIT","Recording hard source cap reached"); }
		if (s.failed || active !== s) { counted(s,"observations_rejected"); throw fault("RECORD_INTERRUPTED","Frame admission closed"); }
		const seq=s.seq+1; frame={...frame,seq};
		let sent=false, invocation;
		// Transport confirms the actual post, not merely a function invocation or ACK.
		const onSent=()=>{if (!sent) { sent=true; s.seq=seq; s.sentBytes+=length; counted(s,"frames_sent"); }};
		try { invocation=sendNative("record.frame",frame,onSent); } catch(e) { invocation=Promise.reject(e); }
		const pending=trackRaw(s,invocation,s.writes);
		let r;
		try { r=await bounded(pending,budget(s),s.abort.promise); }
		catch(e) { if (!sent) counted(s,"observations_rejected"); throw e; }
		if (!sent) { counted(s,"observations_rejected"); throw fault("RECORD_SEQUENCE","Frame transport did not confirm a native send"); }
		if (r?.accepted_seq !== seq) throw fault("RECORD_SEQUENCE","Invalid frame acceptance");
		credit(r.credit,s.identity,seq+1);
		s.persisted=seq; s.lastValidation=frame.observation.geometry_validated_ms;
		if (frame.observation.purpose === "final") s.final={disposition:"accepted",request_id:frame.observation.request_id,seq};
	}
	function failureReason(e) {
		if (e.code === "RECORD_LIMIT") return "storage_limit";
		if (e.code === "RECORD_GEOMETRY_CHANGED") return "geometry_changed";
		if (e.code === "RECORD_INVALID_PARAMS") return "invalid_frame";
		if (e.code === "TIMEOUT") return "credit_timeout";
		return "control_error";
	}
	function finalFailure(e) {
		if (e.code === "RECORD_LIMIT") return "storage_limit";
		if (e.code === "RECORD_LATE" || e.code === "RECORD_DEADLINE") return "deadline";
		if (e.code === "TIMEOUT") return "stop_budget";
		if (e.code === "RECORD_GEOMETRY_CHANGED" || e.code === "RECORD_INVALID_PARAMS") return "invalid_observation";
		return "request_failed";
	}
	function close(s,mode) {
		if (s.closed) return;
		if (s.origin != null && elapsed(s)>=s.config.max_duration_ms) mode="deadline";
		s.closed=true; s.mode=mode; s.state="stopping";
		s.cutoff=mode === "deadline" ? s.config.max_duration_ms : elapsed(s);
		s.drainDeadline=now()+TIMEOUT;
		if (mode === "stopped" && s.origin != null) { s.stopRequested=s.cutoff; s.stopDeadline=now()+TIMEOUT; }
		clearTimer(s.deadlineTimer); clearTimer(s.delayTimer); clearTimer(s.waitTimer); s.wake?.resolve();
		if (s.origin == null) { s.failed="start_failed"; s.cancel.reject(fault("RECORD_INTERRUPTED","Recording preparation interrupted")); }
	}
	function markFailed(s,reason) {
		if (!s.failed) {
			s.failed=reason;
			s.failureCutoff=s.origin == null ? 0 : Math.min(elapsed(s),s.config.max_duration_ms);
		}
	}
	function fail(s,reason) {
		if (s.frozen) return;
		if (!s.closed) close(s,reason);
		markFailed(s,reason); s.abort.reject(fault("RECORD_INTERRUPTED","Recording interrupted"));
	}
	async function loop(s) {
		try {
			while (!s.closed) {
				s.busy=true;
				let writing=false;
				try { const frame=await capture(s,"sample"); if (frame) { writing=true; await persist(s,frame); } }
				catch(e) {
					if (e.code === "RECORD_LATE" && s.mode === "deadline") { /* genuine settled late response discarded */ }
					else { fail(s,e.code === "TIMEOUT" && !writing ? "control_error" : failureReason(e)); }
				} finally { s.busy=false; clearTimer(s.delayTimer); }
				if (s.closed) break;
				const due=s.lastRequestAt+1000/s.config.capture_fps;
				s.wake=deferred();
				if (now()<due) await Promise.race([s.wake.promise,new Promise((resolve)=>{s.waitTimer=setTimer(resolve,due-now());})]);
				clearTimer(s.waitTimer); s.wake=null;
				if (elapsed(s)>=s.config.max_duration_ms) close(s,"deadline");
			}
			s.operationDeadline=null;
			if (s.mode === "stopped" && !s.failed) {
				try {
					// Host closes event admission at final; drain pre-stop events first.
					await bounded(s.eventTail || Promise.resolve(),budget(s),s.abort.promise);
					if (s.seq>=MAX_FRAMES || s.sentBytes>=MAX_BYTES) throw fault("RECORD_LIMIT","Final observation cannot fit hard source cap");
					if (now()>=s.stopDeadline) throw fault("TIMEOUT","Original stop budget exhausted");
					const frame=await capture(s,"final"); await persist(s,frame);
				} catch(e) { s.finalFailure=finalFailure(e); markFailed(s,e.code === "RECORD_LIMIT" ? "storage_limit" : "final_observation_failed"); }
			}
		} finally { await finish(s); }
	}
	async function finish(s) {
		if (s.finishing) return s.finishing;
		s.finishing=(async()=>{
			clearTimer(s.deadlineTimer); clearTimer(s.delayTimer); clearTimer(s.waitTimer);
			if (!s.closed) close(s,"start_failed");
			// End/event drain shares the original closure budget, never a new operation budget.
			s.operationDeadline=null;
			try { await bounded(s.eventTail || Promise.resolve(),budget(s)); }
			catch(_) { markFailed(s,"storage_error"); }
			if (!s.seq) markFailed(s,"no_frames");
			if (s.mode === "stopped" && !s.final) markFailed(s,"final_observation_failed");
			const reason=s.failed || s.mode;
			const final=s.final || (s.stopRequested != null ? {disposition:"failed",attempt:s.finalAttempt || null,reason:s.finalFailure || "interrupted"} : {disposition:"not_requested"});
			const accepted=final.disposition === "accepted";
			// Failure closes the remaining admission at the measured failure tick (or the
			// hard deadline), never before an already admitted valid sample/event.
			const t=accepted ? s.lastValidation : s.failureCutoff ?? s.cutoff ?? 0;
			s.end={final_seq:s.seq,duration_ms:t,duration_observed:s.origin != null,reason,
				cutoff:{t_ms:t,provenance:accepted?"final_geometry_validation":reason === "deadline"?"deadline":"admission_closed"},
				stop_requested_ms:s.stopRequested ?? null,final_observation:final,counters:{...s.counts}};
			s.frozen=true; s.state="failed";
			// Unacknowledged frame writes may include a durable final: leave recovery to
			// the host's authenticated prefix, not a contradictory producer Ended.
			if (s.origin != null && s.persisted === s.seq && !s.disconnected && now()<budget(s)) {
				try {
					const r=await bounded(sendNative("record.ended",{identity:s.identity,end:s.end}),budget(s));
					if (!equal(r?.identity,s.identity) || r?.state !== (s.failed ? "failed" : "sealed")) throw fault("RECORD_SEQUENCE","Invalid end acceptance");
					s.state=r.state;
				} catch(_) { s.state="failed"; }
			}
			s.finished=true; cleanup(s);
			const terminal=[...sessions.values()].filter(v=>v!==active && v.finished);
			while(terminal.length>4) sessions.delete(key(terminal.shift().identity));
		})();
		return s.finishing;
	}
	function cleanup(s) {
		// Never release exclusion while any original Chrome RPC/readiness/write is unresolved.
		if (!s.finished || s.releasing || s.chromePending.size || s.leasePending.size || s.writes.size || !s.release) return;
		s.releasing=true;
		Promise.resolve().then(()=>s.release()).then(()=>{if(active===s)active=null;}).catch(()=>{s.releasing=false;});
	}
	async function start(p) {
		startParams(p); // Mandatory exact version/backend validation BEFORE any target work.
		if(hostEpoch != null && hostEpoch !== p.identity.host_epoch) throw fault("RECORD_STALE_HOST","Recording belongs to another host epoch");
		p=structuredClone(p);
		const signature=canonical(p), k=key(p.identity), old=starts.get(k);
		if(old) { if(old.signature!==signature)throw fault("RECORD_OPERATION_CONFLICT","Conflicting start"); return old.promise; }
		if([...starts.values()].some(v=>v.operation===p.operation_id))throw fault("RECORD_OPERATION_CONFLICT","Start operation reused");
		if(active)throw fault("RECORD_BUSY","Recording or unresolved screenshot quarantine is active");
		if(starts.size>=4096)throw fault("RECORD_LIMIT","Start cache full");
		const s={identity:Object.freeze(identity(p.identity)),config:p.config,state:"starting",seq:0,persisted:0,sentBytes:0,origin:null,startDeadline:now()+TIMEOUT,release:()=>{},
			started:deferred(),cancel:deferred(),abort:deferred(),chromePending:new Set(),leasePending:new Set(),writes:new Set(),events:new Map(),eventIndex:0,
			counts:{preparation_requests:0,preparation_responses:0,requests_started:0,responses_received:0,request_failures:0,observations_rejected:0,late_responses:0,frames_sent:0,scheduling_delays:0}};
		active=s;hostEpoch=p.identity.host_epoch;sessions.set(k,s);
		const work=Promise.resolve().then(async()=>{
			try {
				assertPreparing(s);
				const tab=await bounded(p.tab_id != null ? chrome.tabs.get(p.tab_id) : chrome.tabs.query({active:true,currentWindow:true}).then(v=>v[0]),s.startDeadline,s.cancel.promise);
				assertPreparing(s);
				if(!Number.isSafeInteger(tab?.id) || tab.id<0)throw invalid("No recording target tab");
				s.tabId=tab.id;
				const acquisition=acquireLease(tab.id);
				if(!acquisition || typeof acquisition.release!=="function")throw fault("RECORD_GEOMETRY_CHANGED","Lifecycle-backed capture access required");
				s.release=acquisition.release;
				s.access=await bounded(trackRaw(s,acquisition.ready,s.leasePending),s.startDeadline,s.cancel.promise);
				assertPreparing(s);
				if(typeof s.access?.emulation!=="function" || typeof s.access?.sendCommand!=="function")throw fault("RECORD_GEOMETRY_CHANGED","Clean attachment provenance unavailable");
				s.access.emulation();
				await prepare(s); assertPreparing(s);
				s.loop=loop(s); await s.started.promise;
			} catch(e) {
				s.started.reject(e); fail(s,"start_failed"); await finish(s);
			}
		}); work.catch(()=>{});
		const promise=bounded(s.started.promise,s.startDeadline,s.cancel.promise).catch(e=>{fail(s,"start_failed");throw e;}); promise.catch(()=>{});
		starts.set(k,{signature,operation:p.operation_id,promise});
		return promise;
	}
	function find(p) {
		const i=identity(p?.identity);
		if(hostEpoch != null && i.host_epoch!==hostEpoch)throw fault("RECORD_STALE_HOST","Stale host epoch");
		const s=sessions.get(key(i));if(!s)throw fault("RECORD_NOT_FOUND","Recording not found");return s;
	}
	async function event(method,p) {
		const s=find(p);validateEvent(method,p);
		const value={operation_id:p.operation_id,text:p.text,...(method === "record.mark"?{duration_ms:p.duration_ms}:{})}, signature=canonical({method,...value});
		const old=s.events.get(p.operation_id);
		if(old){if(old.signature!==signature)throw fault("RECORD_OPERATION_CONFLICT","Conflicting event");return old.promise;}
		if(s.closed || s.origin == null || s.frozen)throw fault("RECORD_INVALID_STATE","Recording event admission closed");
		if(elapsed(s)>=s.config.max_duration_ms){close(s,"deadline");throw fault("RECORD_INVALID_STATE","Deadline reached");}
		if(s.eventIndex>=1024)throw fault("RECORD_LIMIT","Event cap reached");
		const event={event_index:++s.eventIndex,...value,t_ms:elapsed(s),kind:method === "record.mark"?"mark":"phase"};
		const promise=(s.eventTail || Promise.resolve()).then(async()=>{
			if(s.frozen || s.disconnected)throw fault("RECORD_INTERRUPTED","Event drain closed");
			const r=await bounded(sendNative("record.event",{identity:s.identity,event}),budget(s));
			if(!equal(r,event))throw fault("RECORD_SEQUENCE","Invalid event acceptance");return r;
		}).catch(e=>{fail(s,"storage_error");throw e;});
		s.eventTail=promise;s.events.set(p.operation_id,{signature,promise});return promise;
	}
	async function dispatch(method,p={}) {
		if(method === "record.capabilities") return recordingCapabilities(p);
		if(method === "record.start")return start(p);
		if(method === "record.phase" || method === "record.mark")return event(method,p);
		if(method === "record.stop") {if(!id(p?.operation_id))throw invalid("Invalid stop operation");const s=find(p);close(s,"stopped");return {identity:s.identity,state:s.state};}
		throw invalid("Not an extension recording control method");
	}
	function interrupt(reason,tabId) {
		const s=active;if(!s || (tabId != null && tabId!==s.tabId))return;
		if(reason === "native_disconnected")s.disconnected=true;
		// An actual detach/tab-close confirms the underlying target resources gone.
		// Original callbacks remain owned and inert; no foreign detach is attempted.
		if(reason === "debugger_detached" || reason === "tab_closed") s.chromePending.clear();
		fail(s,reason); cleanup(s);
	}
	return {dispatch,interrupt,onFrame:()=>{},isActive:()=>active!=null,isLeased:tabId=>active?.tabId===tabId,
		idle:()=>active?.finishing || active?.loop || Promise.resolve()};
}
