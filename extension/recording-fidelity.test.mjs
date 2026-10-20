// V2 scheduling/final provenance replaces v1 unsolicited candidate/ACK/drop tests.
import assert from "node:assert/strict";
import test from "node:test";
import { harness, identity, deferred, flush, jpeg } from "./recording-v2-harness.mjs";
const stop=async h=>{await h.stop();await h.controller.idle();await flush();};

test("one operation OR durable write; FPS opportunity delayed once, no backlog",async()=>{
 const h=harness();h.frameGate=deferred();await h.start();assert.equal(h.shotCount,3);await h.advance(350);assert.equal(h.shotCount,3);assert.equal(h.frames().length,1);
 h.frameGate.resolve();h.frameGate=null;await flush();assert.equal(h.shotCount,4);await stop(h);assert.equal(h.end().counters.scheduling_delays,1);assert.equal(h.frames().length,3);
});
test("slow screenshot postpones one eligibility, never overlaps another capture",async()=>{
 const h=harness();await h.start();h.shotGate=deferred();await h.advance(100);assert.equal(h.shotCount,4);await h.advance(500);assert.equal(h.shotCount,4);h.shotGate.resolve();h.shotGate=null;await flush();await stop(h);assert.equal(h.end().counters.scheduling_delays,1);
});
test("stop during before-read prevents new sample admission and issues one actual final",async()=>{
 const h=harness();await h.start();h.readGate=deferred();await h.advance(100);const before=h.shotCount;const ack=await h.stop();assert.equal(ack.state,"stopping");h.readGate.resolve();h.readGate=null;await h.controller.idle();assert.equal(h.shotCount,before+1);assert.deepEqual(h.frames().map(f=>f.observation.purpose),["sample","final"]);
});
test("stop settles admitted sample/write then genuine final with exact intervals and immutable identity/purpose",async()=>{
 const h=harness();await h.start();h.shotGate=deferred();await h.advance(100);h.jump(10);await h.stop();await h.stop();assert.equal(h.end(),undefined);h.jump(5.125);h.shotGate.resolve();h.shotGate=null;await h.controller.idle();
 const [a,b,c]=h.frames();assert.equal(b.observation.purpose,"sample");assert.equal(c.observation.purpose,"final");assert.ok(b.observation.request_started_ms<=h.end().stop_requested_ms);assert.ok(c.observation.request_started_ms>=h.end().stop_requested_ms);assert.ok(c.observation.request_started_ms>=b.observation.geometry_validated_ms);assert.equal(h.end().duration_ms,c.observation.geometry_validated_ms);assert.ok(h.end().duration_ms>h.end().stop_requested_ms);assert.deepEqual(a.identity,identity);
});
test("equal precision clock ticks enforce causal stop/event/sample closure, final may tie",async()=>{
 const h=harness();await h.start();await h.controller.dispatch("record.phase",{identity,operation_id:"phase",text:"before"});await h.stop();await assert.rejects(h.controller.dispatch("record.mark",{identity,operation_id:"late",text:"after",duration_ms:1}),{code:"RECORD_INVALID_STATE"});await h.controller.idle();assert.equal(h.frames().at(-1).observation.request_started_ms,h.end().stop_requested_ms);assert.equal(h.frames().filter(f=>f.observation.purpose === "sample").length,1);
});
test("final error/invalid data becomes explicit failure with unique attempt and truthful counts",async()=>{
 for(const mode of ["rpc","data","mapping"]){const h=harness();await h.start();if(mode === "rpc")h.shotError=Error("Chrome rejected");if(mode === "data")h.shot=()=>({data:"bad"});if(mode === "mapping")h.shot=()=>{h.value.dom.device_scale_factor=2;return {data:jpeg};};await stop(h);const end=h.end();assert.equal(end.reason,"final_observation_failed");assert.equal(end.final_observation.disposition,"failed");assert.ok(end.final_observation.attempt.request_id);assert.equal(end.final_observation.attempt.request_started_ms, end.stop_requested_ms);assert.equal(h.frames().length,1);assert.equal(end.counters.request_failures,mode === "rpc"?1:0);assert.equal(end.counters.observations_rejected,mode === "rpc"?0:1);}
});
test("late final response is discarded, never backdated; hard deadline wins",async()=>{
 const h=harness();const p=h.params();p.config.max_duration_ms=150;await h.start(p);h.shotGate=deferred();await h.stop();await h.advance(151);h.shotGate.resolve();h.shotGate=null;await h.controller.idle();assert.equal(h.end().reason,"final_observation_failed");assert.equal(h.end().final_observation.reason,"deadline");assert.equal(h.end().counters.late_responses,1);assert.equal(h.frames().length,1);assert.ok(h.end().duration_ms<=150);
});
test("final cannot start at original deadline after earlier write drains",async()=>{
 const h=harness();h.frameGate=deferred();const p=h.params();p.config.max_duration_ms=100;await h.start(p);await h.stop();await h.advance(100);h.frameGate.resolve();h.frameGate=null;await h.controller.idle();assert.equal(h.end().reason,"final_observation_failed");assert.equal(h.end().final_observation.attempt,null);assert.equal(h.shotCount,3);
});
test("deadline discards settled late sample response with honest counters but no fresh final",async()=>{
 const h=harness();const p=h.params();p.config.max_duration_ms=150;await h.start(p);h.shotGate=deferred();await h.advance(100);await h.advance(51);h.shotGate.resolve();h.shotGate=null;await h.controller.idle();assert.equal(h.end().reason,"deadline");assert.equal(h.end().counters.late_responses,1);assert.equal(h.end().counters.observations_rejected,1);assert.equal(h.frames().length,1);
});
test("unresolved final timeout quarantines across replacement; late callback cannot mutate end",async()=>{
 const h=harness();await h.start();h.shotGate=deferred();await h.stop();await h.advance(10000);await h.controller.idle();const end=structuredClone(h.end());assert.equal(end,undefined);assert.equal(h.controller.isActive(),true);
 const p=h.params({identity:{...identity,record_id:"new"},operation_id:"new"});p.initial_credit.identity=p.identity;await assert.rejects(h.begin(p),{code:"RECORD_BUSY"});await assert.rejects(h.chrome.debugger.sendCommand({tabId:7},"Emulation.setVisibleSize",{}),{code:"RECORD_GEOMETRY_CHANGED"});h.shotGate.resolve();h.shotGate=null;await flush();assert.deepEqual(h.end(),end);assert.equal(h.frames().length,1);assert.equal(h.controller.isActive(),false);await h.start(p);await h.controller.dispatch("record.stop",{identity:p.identity,operation_id:"stop_new"});await h.controller.idle();
});
test("confirmed target detach clears unresolved Chrome quarantine; late result remains inert",async()=>{
 const h=harness();await h.start();h.shotGate=deferred();await h.advance(100);h.controller.interrupt("debugger_detached",7);await h.controller.idle();await flush();assert.equal(h.controller.isActive(),false);const end=structuredClone(h.end());h.shotGate.resolve();await flush();assert.deepEqual(h.end(),end);assert.equal(h.frames().length,1);
});
test("lost native credit sends no contradictory Ended and never duplicates/retries a frame",async()=>{
 for(const mode of ["timeout","identity","seq","bytes","reject"]){const h=harness();await h.start();if(mode === "timeout")h.frameGate=deferred();else if(mode === "reject")h.frameError=Error("disk");else h.frameReply={accepted_seq:mode === "seq"?8:2,credit:{identity:mode === "identity"?{...identity,record_id:"wrong"}:identity,next_seq:3,max_frame_bytes:mode === "bytes"?1:4194304}};
 await h.stop();if(mode === "timeout")await h.advance(10000);await h.controller.idle();assert.equal(h.end(),undefined);assert.equal(h.frames().length,2);if(h.frameGate){assert.equal(h.controller.isActive(),true);h.frameGate.resolve();await flush();assert.equal(h.controller.isActive(),false);}assert.equal(h.frames().length,2);}
});
test("original stop budget bounds event drain plus final write/end, never renewed",async()=>{
 const h=harness();await h.start();h.eventGate=deferred();const e=h.controller.dispatch("record.phase",{identity,operation_id:"phase",text:"pending"});e.catch(()=>{});h.frameGate=deferred();await h.stop();await h.advance(9000);h.frameGate.resolve();h.frameGate=null;await flush();assert.equal(h.end(),undefined);await h.advance(1000);await h.controller.idle();assert.equal(h.now(),10040);assert.equal(h.controller.isActive(),false);h.eventGate.resolve();await flush();
});
test("operation timeout covers all geometry steps without renewing 10s",async()=>{
 const h=harness();const p=h.params();p.config.max_duration_ms=60000;await h.start(p);h.shotGate=deferred();await h.advance(100);await h.advance(9000);h.readGate=deferred();h.shotGate.resolve();h.shotGate=null;await flush();await h.advance(1000);await h.controller.idle();assert.equal(h.frames().length,1);assert.equal(h.controller.isActive(),true);h.readGate.resolve();await flush();assert.equal(h.controller.isActive(),false);
});
test("unrelated screencast events are ignored without ACK, mutation, source or fallback",async()=>{
 const h=harness();await h.start();for(let i=0;i<100;i++)h.controller.onFrame({tabId:7},"Page.screencastFrame",{sessionId:i,data:jpeg});await flush();assert.equal(h.frames().length,1);assert.equal(h.calls.some(c=>/Screencast/.test(c.method)),false);await stop(h);
});
test("1800-source cap remains hard; required final cannot be silently omitted",async()=>{
 const h=harness();const p=h.params();p.config.max_duration_ms=60000;p.config.capture_fps=30;await h.start(p);await h.advance(59967);assert.equal(h.frames().length,1800);await stop(h);assert.equal(h.end().reason,"storage_limit");assert.equal(h.end().final_observation.reason,"storage_limit");assert.equal(h.end().final_seq,1800);
});
