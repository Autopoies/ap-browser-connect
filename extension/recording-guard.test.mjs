import assert from "node:assert/strict";
import test from "node:test";
import { createRecordingGuard } from "./recording-guard.mjs";
import { deferred } from "./recording-v2-harness.mjs";

test("only an actual known clean attach lifecycle authorizes provenance; DPR never does",()=>{
 const g=createRecordingGuard(async()=>({}));assert.throws(()=>g.reserve(7));g.attached(7,false);assert.throws(()=>g.reserve(7));g.detached(7);g.attached(7,true);const a=g.reserve(7);assert.equal(a.emulation(),"fresh_known_unemulated");assert.throws(()=>g.reserve(7));g.detached(7);assert.throws(()=>a.emulation());g.attached(7,true);assert.throws(()=>a.emulation());const b=g.reserve(7);a.release();assert.equal(b.emulation(),"fresh_known_unemulated");
});
test("mutator history remains unsafe even when setter fails or tries to clear override",async()=>{
 for(const method of ["Emulation.setDeviceMetricsOverride","Emulation.clearDeviceMetricsOverride","Emulation.setVisibleSize","Emulation.setPageScaleFactor","Page.setDeviceMetricsOverride","Emulation.setDisplayFeaturesOverride","Target.sendMessageToTarget"]){const g=createRecordingGuard(async()=>{throw Error("RPC failed");});g.attached(7,true);await assert.rejects(g.send({tabId:7},method,{}));assert.throws(()=>g.reserve(7));}
});
test("unsafe clip/beyond-viewport screenshot taints clean history, safe full viewport tracks in flight",async()=>{
 for(const params of [{},{clip:{x:0,y:0,width:1,height:1,scale:1},captureBeyondViewport:false},{fromSurface:false,captureBeyondViewport:false},{captureBeyondViewport:true}]){const g=createRecordingGuard(async()=>({}));g.attached(7,true);await g.send({tabId:7},"Page.captureScreenshot",params);assert.throws(()=>g.reserve(7));}
 const gate=deferred(),g=createRecordingGuard(()=>gate.promise);g.attached(7,true);const call=g.send({tabId:7},"Page.captureScreenshot",{fromSurface:true,captureBeyondViewport:false});assert.throws(()=>g.reserve(7));gate.resolve({});await call;const a=g.reserve(7);assert.equal(a.emulation(),"fresh_known_unemulated");
});
test("target-specific exclusion permits ordinary click focus, eval and unrelated-tab mutators",async()=>{
 const calls=[],g=createRecordingGuard(async(s,m)=>{calls.push([s.tabId,m]);return {};});g.attached(7,true);g.attached(8,true);const a=g.reserve(7);
 for(const method of ["Emulation.setDeviceMetricsOverride","Emulation.clearDeviceMetricsOverride","Emulation.setVisibleSize","Page.captureScreenshot","Target.sendMessageToTarget"])await assert.rejects(g.send({tabId:7},method,{}));
 await assert.rejects(g.send({tabId:8},"Target.sendMessageToTarget",{message:"opaque"}));
 await g.send({tabId:7},"Emulation.setFocusEmulationEnabled",{enabled:true});await g.send({tabId:7},"Runtime.evaluate",{});await g.send({tabId:8},"Emulation.setDeviceMetricsOverride",{});
 await a.sendCommand("Page.captureScreenshot",{format:"jpeg",fromSurface:true,captureBeyondViewport:false});assert.equal(a.emulation(),"fresh_known_unemulated");assert.equal(calls.length,4);a.release();await g.send({tabId:7},"Emulation.setVisibleSize",{});assert.throws(()=>g.reserve(7));
});
