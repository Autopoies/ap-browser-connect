// V1 DOM-only quiet-window tests replaced by actual screenshot/coherence preparation.
import assert from "node:assert/strict";
import test from "node:test";
import vm from "node:vm";
import { harness, identity, deferred, flush, facts, jpeg } from "./recording-v2-harness.mjs";
import { snapshotExpression } from "./recording-geometry.mjs";

test("initial resize is retried with genuine screenshots and repeat mapping within original budget",async()=>{
 const h=harness();h.value=facts(20,20);h.shot=n=>{if(n===1)h.value=facts();return {data:jpeg};};
 // Use the real fixture; first pre/post mapping is intentionally incoherent.
 const pending=h.begin();await h.advance(80);const r=await pending;assert.equal(r.resolved_region_css.width,16);assert.equal(h.shotCount,4);assert.equal(h.frames().length,1);assert.equal(h.frames()[0].observation.request_started_ms,0);
 await h.stop();await h.controller.idle();assert.equal(h.end().counters.preparation_requests,3);
});
test("mapping uses actual JPEG bounds independently of device pixel ratio",async()=>{
 const h=harness();h.value=facts(8,8);h.value.dom.device_scale_factor=3;await h.start();const f=h.frames()[0];assert.equal(f.width,16);assert.equal(f.geometry.css_to_image.scale_x,2);assert.equal(f.geometry.before.dom.device_scale_factor,3);await h.stop();await h.controller.idle();
});
test("scroll, document and content changes are preserved without rejecting viewport-local mapping",async()=>{
 const h=harness();await h.start();h.shot=n=>{h.value.dom.scroll_y=n;h.value.dom.document_height=100+n;h.value.dom.visual.page_y=n;return {data:jpeg};};
 await h.advance(100);await h.stop();await h.controller.idle();assert.equal(h.end().reason,"stopped");const f=h.frames()[1];assert.notEqual(f.geometry.before.dom.scroll_y,f.geometry.after.dom.scroll_y);assert.equal(f.geometry.after.cdp.content_height,f.geometry.after.dom.document_height);
});
test("fixed rectangle and one final safely quoted visible-element read; no scroll/tracking",async()=>{
 for(const region of [{kind:"rect",rect:{x:1,y:2,width:7,height:8}},{kind:"element",selector:'[data-name="a\\b"]'}]){
 const h=harness();h.value.element={x:-3,y:2,width:10,height:20};const p=h.params();p.config.region=region;const r=await h.start(p);
 assert.deepEqual(r.resolved_region_css,region.kind === "rect"?region.rect:{x:0,y:2,width:7,height:14});await h.advance(100);await h.stop();await h.controller.idle();
 assert.equal(h.calls.filter(c=>c.params?.expression?.includes("document.querySelector(")).length,region.kind === "element"?1:0);assert.equal(h.calls.some(c=>c.params?.expression?.includes("scrollIntoView")),false);
 }
});
test("pure element expression safely quotes selector and only reads bounds",()=>{
 const selector='x");throw 1;//';let reads=0;const visual={width:16,height:16,offsetLeft:0,offsetTop:0,pageLeft:0,pageTop:0,scale:1};
 const value=vm.runInNewContext(snapshotExpression(selector),{window:{visualViewport:visual},document:{documentElement:{clientWidth:16,clientHeight:16,scrollWidth:16,scrollHeight:16},querySelector:s=>{assert.equal(s,selector);reads++;return {getBoundingClientRect:()=>({x:1,y:2,width:3,height:4})};}},innerWidth:16,innerHeight:16,devicePixelRatio:1,scrollX:0,scrollY:0});assert.equal(reads,1);assert.equal(value.element.x,1);
});
test("missing/invisible element, out-of-bounds rectangle and final selection resize fail without sample",async()=>{
 for(const region of [{kind:"element",selector:"#missing"},{kind:"rect",rect:{x:15,y:0,width:2,height:1}}]){const h=harness(),p=h.params();p.config.region=region;await assert.rejects(h.start(p));await h.controller.idle();await flush();assert.equal(h.frames().length,0);assert.equal(h.controller.isActive(),false);}
 const h=harness();let reads=0;h.onCommand=method=>{if(method === "Runtime.evaluate" && ++reads===5)h.value=facts(17,16);};await assert.rejects(h.start(),{code:"RECORD_GEOMETRY_CHANGED"});assert.equal(h.frames().length,0);
});
test("never coherent mapping and slow lease share original startup 10s budget",async()=>{
 const h=harness();let n=0;h.onCommand=method=>{if(method === "Runtime.evaluate")h.value=facts(++n%2?16:17,16);};const pending=h.begin();await h.advance(10000);await assert.rejects(pending);await h.controller.idle();await flush();assert.equal(h.frames().length,0);assert.equal(h.controller.isActive(),false);
 const slow=harness();slow.leaseGate=deferred();const p=slow.begin();await slow.advance(10000);await assert.rejects(p,{code:"TIMEOUT"});await slow.controller.idle();assert.equal(slow.controller.isActive(),true);slow.leaseGate.resolve();await flush();assert.equal(slow.shotCount,0);assert.equal(slow.controller.isActive(),false);
});
test("stop during preparation cancels zero-source without origin/final and late preparation cannot enter replacement",async()=>{
 const h=harness();h.shotGate=deferred();const pending=h.begin();await flush();await h.stop();await assert.rejects(pending,{code:"RECORD_INTERRUPTED"});await h.controller.idle();assert.equal(h.controller.isActive(),true);assert.equal(h.end(),undefined);assert.equal(h.frames().length,0);
 h.shotGate.resolve();await flush();assert.equal(h.controller.isActive(),false);h.shotGate=null;const p=h.params({identity:{...identity,record_id:"replacement"},operation_id:"replacement"});p.initial_credit.identity=p.identity;await h.start(p);assert.ok(h.frames().every(f=>f.identity.record_id === "replacement"));await h.controller.dispatch("record.stop",{identity:p.identity,operation_id:"stop_new"});await h.controller.idle();
});
test("preparation read cancellation and native loss remain quarantined until original read resolves",async()=>{
 for(const reason of ["native_disconnected","tab_closed","debugger_detached"]){const h=harness();h.readGate=deferred();const p=h.begin();await flush();h.controller.interrupt(reason,7);await assert.rejects(p);await h.controller.idle();await flush();assert.equal(h.controller.isActive(),reason === "native_disconnected");h.readGate.resolve();await flush();assert.equal(h.controller.isActive(),false);assert.equal(h.shotCount,0);}
});
test("unknown/pre-attached or previously emulated target refuses without reset/detach",async()=>{
 for(const clean of [false,true]){const h=harness();h.guard.attached(7,clean);if(clean)await h.chrome.debugger.sendCommand({tabId:7},"Emulation.setDeviceMetricsOverride",{});await assert.rejects(h.start(),{code:"RECORD_GEOMETRY_CHANGED"});await flush();assert.equal(h.shotCount,0);assert.equal(h.calls.some(c=>/detach|clearDevice/.test(c.method)),false);assert.equal(h.controller.isActive(),false);}
});
test("target resolution failure releases active slot and duplicate failed start remains tombstoned",async()=>{
 const h=harness();h.activeTab=-1;await assert.rejects(h.begin());await h.controller.idle();await flush();assert.equal(h.controller.isActive(),false);h.activeTab=7;await assert.rejects(h.begin());assert.equal(h.acquired.length,0);
});
