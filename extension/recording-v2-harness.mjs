import { readFile } from "node:fs/promises";
import { createRecordingController } from "./recording.mjs";
import { createRecordingGuard } from "./recording-guard.mjs";
export const wire=JSON.parse(await readFile(new URL("../tests/fixtures/recording-v2/wire.json",import.meta.url)));
export const jpeg=JSON.parse(await readFile(new URL("../tests/fixtures/recording/wire.json",import.meta.url))).frame.params.jpeg_base64;
export const identity={host_epoch:"epoch_1",record_id:"record_1"};
export function deferred(){let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};}
export async function flush(){for(let i=0;i<150;i++)await Promise.resolve();}
export function facts(width=16,height=16){
	const visual={width,height,offset_x:0,offset_y:0,page_x:0,page_y:0,scale:1};
	return {dom:{inner_width:width,inner_height:height,client_width:width,client_height:height,device_scale_factor:1,scroll_x:0,scroll_y:0,document_width:width,document_height:height,visual}};
}
export function metrics(dom){const v=dom.visual;return {cssLayoutViewport:{clientWidth:dom.inner_width,clientHeight:dom.inner_height,pageX:dom.scroll_x,pageY:dom.scroll_y},cssVisualViewport:{clientWidth:v.width,clientHeight:v.height,offsetX:v.offset_x,offsetY:v.offset_y,pageX:v.page_x,pageY:v.page_y,scale:v.scale,zoom:1},cssContentSize:{width:dom.document_width,height:dom.document_height}};}
export function harness(){
	let clock=0,timerId=0;
	const timers=new Map(),calls=[],native=[],releases=[],acquired=[],finalRecords=new Set();
	const h={value:facts(),activeTab:7,queryCount:0,shotCount:0};
	const setTimer=(fn,ms)=>{timers.set(++timerId,{fn,at:clock+Math.max(0,ms)});return timerId;};
	const clearTimer=id=>timers.delete(id);
	const raw=async(source,method,params)=>{
		calls.push({source,method,params});
		if(h.onCommand)await h.onCommand(method,params);
		if(method === "Runtime.evaluate") {if(h.readGate)await h.readGate.promise;return {result:{value:structuredClone(h.value)}};}
		if(method === "Page.getLayoutMetrics")return h.layout || metrics(h.value.dom);
		if(method === "Page.captureScreenshot"){
			h.shotCount++;
			if(h.shot) return h.shot(h.shotCount);
			if(h.shotGate)await h.shotGate.promise;
			if(h.shotError)throw h.shotError;
			return {data:jpeg};
		}
		return {};
	};
	const guard=createRecordingGuard(raw);guard.attached(7,true);
	const chrome={tabs:{async get(id){h.queryCount++;return {id};},async query(){h.queryCount++;return [{id:h.activeTab}];}},debugger:{sendCommand:guard.send}};
	const controller=createRecordingController({chrome,now:()=>clock,setTimer,clearTimer,
		acquireLease(tabId){
			acquired.push(tabId);let access;
			const ready=Promise.resolve(h.leaseGate?.promise).then(()=>{access=guard.reserve(tabId);return access;});
			return {ready,async release(){releases.push(tabId);access?.release();if(h.releaseGate)await h.releaseGate.promise;}};
		},
		async sendNative(method,params,onSent){
			if(h.postError || (method === "record.frame" && h.postFrameError))throw h.postError || h.postFrameError;
			native.push({method,params:structuredClone(h.omitJPEG && method === "record.frame" ? {...params,jpeg_base64:"<bounded fixture omitted from test log>"} : params)});
			onSent?.();
			if(method === "record.frame"){
				if(params.observation.purpose === "final")finalRecords.add(JSON.stringify(params.identity));
				if(h.frameGate)await h.frameGate.promise;
				if(h.frameError)throw h.frameError;
				return h.frameReply || {accepted_seq:params.seq,credit:{identity:params.identity,next_seq:params.seq+1,max_frame_bytes:4194304}};
			}
			if(method === "record.event"){
				// Match host admission: even a pre-stop event cannot follow a final frame.
				if(finalRecords.has(JSON.stringify(params.identity)))throw Object.assign(Error("Event after final observation"),{code:"RECORD_INVALID_PARAMS"});
				if(h.eventGate)await h.eventGate.promise;return h.eventReply || params.event;
			}
			if(method === "record.ended"){if(h.endGate)await h.endGate.promise;return {identity:params.identity,state:["stopped","deadline"].includes(params.end.reason)?"sealed":"failed"};}
			throw Error(method);
		}
	});
	return Object.assign(h,{controller,calls,native,timers,releases,acquired,guard,chrome,
		params:(overrides={})=>({protocol_version:2,backend:"cdp_capture_screenshot",identity:structuredClone(identity),operation_id:"start_1",initial_credit:{identity:structuredClone(identity),next_seq:1,max_frame_bytes:4194304},config:{max_duration_ms:5000,capture_fps:10,jpeg_quality:80,region:{kind:"viewport"},labels:{}},...overrides}),
		begin(p){const pending=controller.dispatch("record.start",p||h.params());pending.catch(()=>{});return pending;},
		async start(p){const pending=h.begin(p);await flush();await h.advance(40);await flush();return pending;},
		async stop(){return controller.dispatch("record.stop",{identity,operation_id:"stop_1"});},
		async advance(ms){const end=clock+ms;await flush();for(let n=0;n<10000;n++){
			const next=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at || a[0]-b[0])[0];
			if(!next){clock=end;await flush();return;}
			clock=next[1].at;timers.delete(next[0]);next[1].fn();await flush();
		}throw Error("Timer loop");},
		jump(ms){clock+=ms;},now:()=>clock,
		frames:()=>native.filter(v=>v.method === "record.frame").map(v=>v.params),
		end:()=>native.find(v=>v.method === "record.ended")?.params.end,
	});
}
