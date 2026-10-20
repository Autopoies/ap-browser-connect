import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import * as filters from "./filter-enforcement.mjs";
import * as runtime from "./runtime-helpers.mjs";
import * as snapshot from "./state-snapshot.mjs";
import { createRecordingController, recordingCapabilities } from "./recording.mjs";
import { createRecordingGuard } from "./recording-guard.mjs";
import { facts, metrics, deferred, jpeg, wire } from "./recording-v2-harness.mjs";
const source=(await readFile(new URL("./background.js",import.meta.url),"utf8")).replace(/^import\s+\{[\s\S]*?\}\s+from\s+"[^"]+";\n/gm,"");
const event=()=>({listeners:[],addListener(f){this.listeners.push(f);},removeListener(){}});
const flush=async()=>{for(let i=0;i<150;i++)await Promise.resolve();};
async function harness(){
 const calls=[],responses=[],natives=[],timers=new Map(),ports=[],control={};
 let timerId=0,now=0,context,framePending=null,nextRpc=10,queries=0;
 const tabs=[{id:7,windowId:1,active:true,url:"https://example.test"},{id:8,windowId:1,active:false,url:"https://other.test"}];
 const setTimer=(fn,ms)=>{timers.set(++timerId,{fn,at:now+ms});return timerId;},clearTimer=id=>timers.delete(id);
 const data={instance_id:"browser_1",label:"Test"};const storage={async get(keys){return keys==null?{...data}:Object.fromEntries((Array.isArray(keys)?keys:[keys]).map(k=>[k,data[k]]));},async set(v){Object.assign(data,v);}};
 function port(){const p={onMessage:event(),onDisconnect:event(),postMessage(m){
  if(!m.id?.startsWith?.("sw-")){responses.push(m);return;}
  natives.push({...m,port:p});let result;
  if(m.method === "record.frame"){result={accepted_seq:m.params.seq,credit:{identity:m.params.identity,next_seq:m.params.seq+1,max_frame_bytes:4194304}};if(framePending){framePending.reply=()=>context.handleNativeMessage({id:m.id,ok:true,result},p);return;}}
  else if(m.method === "record.event")result=m.params.event;
  else if(m.method === "record.ended")result={identity:m.params.identity,state:["stopped","deadline"].includes(m.params.end.reason)?"sealed":"failed"};else throw Error(m.method);
  queueMicrotask(()=>context.handleNativeMessage({id:m.id,ok:true,result},p));
 }};ports.push(p);return p;}
 const chrome={
  storage:{local:storage,session:storage,onChanged:event()},runtime:{connectNative:port,getManifest:()=>({version:"test"}),onInstalled:event(),onStartup:event(),onMessage:event()},
  tabs:{onRemoved:event(),onUpdated:event(),onActivated:event(),async get(id){return tabs.find(t=>t.id===id);},async query(q){queries++;return tabs.filter(t=>!q.active||t.active);},async sendMessage(){}},windows:{onRemoved:event(),async getLastFocused(){return {id:1};}},
  debugger:{onEvent:event(),onDetach:event(),async attach(s){calls.push({method:"attach",source:s});if(control.attachError)throw Error(control.attachError);},async detach(s){calls.push({method:"detach",source:s});if(control.detachFail)throw Error("detach failed");for(const f of chrome.debugger.onDetach.listeners)f(s);},async sendCommand(source,method,params){
   calls.push({source,method,params});if(method === "Page.enable" && control.blockEnable)await control.blockEnable.promise;
   if(method === "Runtime.evaluate" && params.expression === "long" && control.blockNormal)await control.blockNormal.promise;
   if(method === "Runtime.evaluate")return {result:{value:facts()}};
   if(method === "Page.getLayoutMetrics")return metrics(facts().dom);
   if(method === "Page.captureScreenshot"){if(control.shotGate)await control.shotGate.promise;if(control.shotError)throw Error("capture failed");return {data:jpeg};}return {};
  }},action:{onClicked:event(),async setIcon(){}},alarms:{onAlarm:event(),async get(){return {};}},commands:{onCommand:event()}
 };
 context=vm.createContext({...filters,...runtime,...snapshot,chrome,console,TextEncoder,structuredClone,navigator:{userAgent:"test"},btoa,atob,setTimeout:setTimer,clearTimeout:clearTimer,createRecordingGuard,recordingCapabilities,createRecordingController:o=>createRecordingController({...o,now:()=>now,setTimer,clearTimer})});
 vm.runInContext(source,context,{filename:"background.js"});await flush();
 const advance=async ms=>{const end=now+ms;await flush();for(let i=0;i<20000;i++){const next=[...timers].filter(([,t])=>t.at<=end).sort((a,b)=>a[1].at-b[1].at||a[0]-b[0])[0];if(!next){now=end;await flush();return;}now=next[1].at;timers.delete(next[0]);next[1].fn();await flush();}throw Error("timer loop");};
 const rpc=async(method,params={},selected=ports.at(-1))=>{const id=nextRpc++;const pending=context.handleNativeMessage({jsonrpc:"2.0",id,method,params},selected);if(method === "record.start")await advance(40);await pending;return responses.find(m=>m.id===id);};
 return {context,chrome,calls,responses,natives,timers,ports,rpc,control,queryCount:()=>queries,
  start:()=>{const p=structuredClone(wire.extension_start.params);p.config.max_duration_ms=10000;return rpc("record.start",p);},stop:()=>rpc("record.stop",wire.stop.params),
  stream(){for(const f of chrome.debugger.onEvent.listeners)f({tabId:7},"Page.screencastFrame",{sessionId:91,data:jpeg});},
  blockFrame(){framePending={};return framePending;},unblockFrame(){framePending=null;},runTimers:advance,async idle(){await vm.runInContext("recordingController?.idle()",context);await flush();}
 };
}
test("background early capability/version/wrong-direction routes have zero target/favicon/annotation effects",async()=>{
 const h=await harness(),count=h.queryCount();const cap=await h.rpc("record.capabilities");assert.equal(cap.result.data.protocol_version,2);
 assert.equal((await h.rpc("record.capabilities",{tab_id:7})).error.code,"RECORD_INVALID_PARAMS");assert.equal((await h.rpc("record.capabilities",null)).error.code,"RECORD_INVALID_PARAMS");
 for(const method of ["record.status","record.manifest","record.read","record.release","record.frame","record.event","record.ended"])assert.equal((await h.rpc(method,{})).error.code,"RECORD_INVALID_PARAMS");
 const p=structuredClone(wire.extension_start.params);delete p.protocol_version;assert.equal((await h.rpc("record.start",p)).error.code,"RECORD_UNSUPPORTED_VERSION");p.protocol_version=2;p.backend="old";assert.equal((await h.rpc("record.start",p)).error.code,"RECORD_UNSUPPORTED_BACKEND");assert.equal(h.queryCount(),count);assert.equal(h.calls.length,0);
});
test("background starts real screenshot producer with Page only and no favicon/annotation; old stream untouched",async()=>{
 const h=await harness();const r=await h.start();assert.equal(r.result.data.tab_id,7);assert.equal(h.calls[0].method,"attach");assert.equal(h.calls[1].method,"Page.enable");assert.equal(h.calls.filter(c=>c.method === "Page.captureScreenshot").length,3);
 const before=h.natives.length;h.stream();await flush();assert.equal(h.natives.length,before);await h.stop();await h.idle();assert.equal(h.calls.some(c=>/Screencast/.test(c.method)),false);assert.equal(h.calls.some(c=>c.params?.expression?.includes("__apSwapped")),false);assert.equal(h.calls.filter(c=>c.method === "detach").length,1);
});
test("clean normal-command attachment coexists; recording does not detach/reset or blanket block focus",async()=>{
 const h=await harness();await h.rpc("eval",{tab_id:7,expression:"1"});const count=h.calls.length;await h.start();assert.equal(h.calls.slice(count).some(c=>c.method === "attach"),false);
 assert.equal((await h.rpc("cdp",{tab_id:7,method:"Emulation.setFocusEmulationEnabled",params:{enabled:true}})).result.ok,true);
 const unsafe=await h.rpc("cdp",{tab_id:7,method:"Emulation.setDeviceMetricsOverride",params:{width:4}});assert.equal(unsafe.result?.ok??false,false);
 await h.stop();await h.idle();assert.equal(h.calls.some(c=>c.method === "detach"),false);assert.equal(vm.runInContext("lockedTabs.has(7)",h.context),true);
});
test("ordinary owner's screencast is never started/stopped/ACKed by recording and cannot become source",async()=>{
 const h=await harness();await h.rpc("cdp",{tab_id:7,method:"Page.startScreencast",params:{format:"jpeg"}});const boundary=h.calls.length;await h.start();h.stream();await flush();await h.stop();await h.idle();assert.equal(h.calls.slice(boundary).some(c=>/Screencast/.test(c.method)),false);assert.equal(h.calls.some(c=>c.method === "detach"),false);assert.equal(h.natives.filter(n=>n.method === "record.frame").length,2);
});
test("unknown pre-attachment and prior emulation refuse without detach/reset",async()=>{
 for(const mode of ["unknown","emulated"]){const h=await harness();if(mode === "unknown")h.control.attachError="Already attached";else await h.rpc("cdp",{tab_id:7,method:"Emulation.setDeviceMetricsOverride",params:{}});const r=await h.start();assert.equal(r.error.code,"RECORD_GEOMETRY_CHANGED");await h.idle();assert.equal(h.calls.some(c=>c.method === "detach" || c.method === "Page.captureScreenshot"),false);assert.equal(h.calls.some(c=>c.method === "Emulation.clearDeviceMetricsOverride"),false);}
});
test("lease survives releaseTab/unlock/3s restore, normal same-tab and unrelated-tab commands",async()=>{
 const h=await harness();await h.start();await h.rpc("eval",{tab_id:7,expression:"1"});await h.context.releaseTab(7);await h.context.unlockAllTabs();await h.context.unlockOtherTabs(8);await h.runTimers(3000);await h.rpc("eval",{tab_id:8,expression:"2"});assert.equal(h.calls.some(c=>c.method === "detach" && c.source.tabId===7),false);assert.equal(h.calls.some(c=>c.method === "Network.enable" && c.source.tabId===7),true);assert.equal(h.calls.filter(c=>c.source?.tabId===7 && c.params?.expression?.includes("__apSwapped")).length,0);
 await h.stop();await h.idle();assert.equal(h.calls.some(c=>c.method === "detach" && c.source.tabId===7),false);await h.runTimers(3000);assert.equal(h.calls.filter(c=>c.method === "detach" && c.source.tabId===7).length,1);
});
test("recording cleanup cannot detach below an in-flight normal command",async()=>{
 for(const explicitTab of [true,false]){const h=await harness();await h.start();h.control.blockNormal=deferred();const normal=h.rpc("eval",{expression:"long",...(explicitTab?{tab_id:7}:{})});await flush();assert.equal(vm.runInContext("normalTabUsers.get(7)",h.context),1);await h.stop();await h.idle();await h.runTimers(3000);assert.equal(h.calls.some(c=>c.method === "detach" && c.source.tabId===7),false);h.control.blockNormal.resolve();await normal;await h.runTimers(3000);assert.equal(h.calls.filter(c=>c.method === "detach" && c.source.tabId===7).length,1);}
});
test("stop ACK is prompt under disk wait; credit accepts only original native port",async()=>{
 const h=await harness();await h.start();const block=h.blockFrame();await h.runTimers(500);const frames=h.natives.filter(m=>m.method === "record.frame"),f=frames.at(-1);assert.equal(frames.length,2);
 await h.context.handleNativeMessage({id:f.id,ok:true,result:{accepted_seq:f.params.seq,credit:{identity:f.params.identity,next_seq:f.params.seq+1,max_frame_bytes:4194304}}},{postMessage(){}});const ack=await h.stop();assert.equal(ack.result.data.state,"stopping");await flush();assert.equal(h.natives.some(m=>m.method === "record.ended"),false);h.unblockFrame();await block.reply();await h.idle();assert.equal(h.natives.filter(m=>m.method === "record.ended").length,1);
});
test("native loss cancels admitted writes, no resume on replacement; capabilities still no-target",async()=>{
 const h=await harness();await h.start();h.blockFrame();await h.runTimers(500);const old=h.ports[0];for(const f of old.onDisconnect.listeners)f();await h.idle();assert.equal(h.natives.some(m=>m.method === "record.ended"),false);assert.equal(h.calls.filter(c=>c.method === "detach").length,1);await h.context.connectNativePort();await flush();h.stream();await flush();assert.equal(h.natives.filter(m=>m.method === "record.frame").length,2);assert.equal((await h.rpc("record.stop",wire.stop.params)).error.code,"RECORD_NOT_FOUND");assert.equal((await h.rpc("record.start",wire.extension_start.params,old)).error.code,"RECORD_INTERRUPTED");assert.equal((await h.rpc("record.capabilities")).result.data.protocol_version,2);
});
test("disconnect during hung initialization keeps lease quarantined, late readiness only cleans up",async()=>{
 const h=await harness();h.control.blockEnable=deferred();const starting=h.start();await flush();for(const f of h.ports[0].onDisconnect.listeners)f();await h.idle();assert.equal(vm.runInContext("recordingLeases.has(7)",h.context),true);await h.context.connectNativePort();await flush();assert.equal((await h.rpc("record.capabilities")).result.data.protocol_version,2);assert.equal((await h.start()).error.code,"RECORD_BUSY");h.control.blockEnable.resolve();await flush();assert.equal((await starting).error.code,"RECORD_INTERRUPTED");assert.equal(h.calls.some(c=>c.method === "Page.captureScreenshot"),false);assert.equal(h.calls.filter(c=>c.method === "detach").length,1);assert.equal(vm.runInContext("recordingController.isActive()",h.context),false);
});
test("confirmed detach cannot clear still-pending attachment initialization or permit late capture",async()=>{
 const h=await harness();h.control.blockEnable=deferred();const starting=h.start();await flush();for(const f of h.chrome.debugger.onDetach.listeners)f({tabId:7});await h.idle();assert.equal(vm.runInContext("recordingController.isActive()",h.context),true);h.control.blockEnable.resolve();await flush();assert.equal((await starting).error.code,"RECORD_INTERRUPTED");assert.equal(vm.runInContext("recordingController.isActive()",h.context),false);assert.equal(h.calls.some(c=>c.method === "Page.captureScreenshot"),false);
});
test("shared-owner unresolved screenshot quarantines across native replacement without foreign detach",async()=>{
 const h=await harness();await h.start();await h.rpc("eval",{tab_id:7,expression:"1"});h.control.shotGate=deferred();await h.runTimers(500);await h.stop();await h.runTimers(10000);await h.idle();assert.equal(vm.runInContext("recordingController.isActive()",h.context),true);assert.equal(h.calls.some(c=>c.method === "detach" && c.source.tabId===7),false);
 for(const f of h.ports[0].onDisconnect.listeners)f();await h.context.connectNativePort();await flush();assert.equal((await h.start()).error.code,"RECORD_BUSY");const before=h.natives.filter(m=>m.method === "record.frame").length;h.control.shotGate.resolve();await flush();assert.equal(h.natives.filter(m=>m.method === "record.frame").length,before);assert.equal(vm.runInContext("recordingController.isActive()",h.context),false);
});
test("external detach/tab close ends pinned recording and clears unresolved target quarantine only",async()=>{
 for(const reason of ["debugger_detached","tab_closed"]){const h=await harness();await h.start();h.control.shotGate=deferred();await h.runTimers(500);if(reason === "debugger_detached")for(const f of h.chrome.debugger.onDetach.listeners)f({tabId:7});else for(const f of h.chrome.tabs.onRemoved.listeners)f(7);await h.idle();assert.equal(h.natives.find(m=>m.method === "record.ended").params.end.reason,reason);assert.equal(h.calls.some(c=>c.method === "detach" && c.source.tabId!==7),false);assert.equal(vm.runInContext("recordingController.isActive()",h.context),false);h.control.shotGate.resolve();await flush();}
});
