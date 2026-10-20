import assert from "node:assert/strict";
import test from "node:test";
import { harness, identity, deferred, flush, jpeg } from "./recording-v2-harness.mjs";
import { validateObservation } from "./recording-validation.mjs";
import { readFile } from "node:fs/promises";
function largeJPEG(size){
 const source=Buffer.from(jpeg,"base64"),parts=[source.subarray(0,2)];let remaining=size-source.length;
 while(remaining){const length=Math.min(65537,remaining),segment=Buffer.alloc(length);segment[0]=255;segment[1]=254;segment.writeUInt16BE(length-2,2);parts.push(segment);remaining-=length;}
 parts.push(source.subarray(2));return Buffer.concat(parts).toString("base64");
}
test("actual 4MiB JPEGs respect 256MiB source cap; required final cannot increase it",async()=>{
 const h=harness(),p=h.params();p.config.max_duration_ms=60000;p.config.capture_fps=30;const data=largeJPEG(4194304);h.omitJPEG=true;h.shot=()=>({data});await h.start(p);await h.advance(2101);assert.equal(h.frames().length,64);await h.stop();await h.controller.idle();assert.equal(h.end().reason,"storage_limit");assert.equal(h.end().final_observation.reason,"storage_limit");assert.equal(h.end().counters.frames_sent,64);assert.equal(h.end().final_seq,64);assert.equal(h.shotCount,66);
});
test("a valid observation exceeding remaining byte credit is rejected truthfully, not sent",async()=>{
 const h=harness(),p=h.params();p.config.max_duration_ms=60000;p.config.capture_fps=30;const data=largeJPEG(4194304);h.omitJPEG=true;await h.start(p);h.shot=()=>({data});await h.advance(2101);assert.equal(h.frames().length,64);await h.stop();await h.controller.idle();assert.equal(h.end().reason,"storage_limit");assert.equal(h.end().counters.observations_rejected,1);assert.equal(h.end().counters.frames_sent,64);
});
test("1024 bounded event admissions; pending events cannot renew stop budget",async()=>{
 const h=harness();await h.start();h.eventGate=deferred();const pending=[];for(let i=0;i<1024;i++){const p=h.controller.dispatch("record.phase",{identity,operation_id:`phase${i}`,text:"bounded"});p.catch(()=>{});pending.push(p);}await assert.rejects(h.controller.dispatch("record.phase",{identity,operation_id:"overflow",text:"x"}),{code:"RECORD_LIMIT"});await h.stop();h.eventGate.resolve();await Promise.all(pending);await h.controller.idle();assert.equal(h.native.filter(n=>n.method === "record.event").length,1024);assert.equal(h.end().reason,"stopped");
});
test("pre-stop phase and queued mark drain before final under host admission order",async()=>{
 const h=harness();await h.start();h.eventGate=deferred();
 const phase=h.controller.dispatch("record.phase",{identity,operation_id:"phase_A",text:"A"});phase.catch(()=>{});
 const mark=h.controller.dispatch("record.mark",{identity,operation_id:"mark_B",text:"B",duration_ms:100});mark.catch(()=>{});
 await flush();assert.deepEqual(h.native.map(n=>n.method),["record.frame","record.event"]);
 assert.equal((await h.stop()).state,"stopping");await h.advance(250);
 assert.equal(h.frames().length,1,"no final while an admitted event ACK is pending");
 h.eventGate.resolve();await Promise.all([phase,mark]);await h.controller.idle();
 assert.deepEqual(h.native.map(n=>n.method === "record.frame" ? n.params.observation.purpose : n.method === "record.event" ? `event ${n.params.event.text}` : n.method),["sample","event A","event B","final","record.ended"]);
 assert.equal(h.end().reason,"stopped");assert.equal(h.end().final_observation.disposition,"accepted");assert.equal((await h.stop()).state,"sealed");
});
test("pre-final event drain rejection fails storage without issuing a final screenshot",async()=>{
 const h=harness();await h.start();h.eventGate=deferred();
 const phase=h.controller.dispatch("record.phase",{identity,operation_id:"phase_A",text:"A"});phase.catch(()=>{});
 await flush();await h.stop();await flush();h.eventGate.reject(Error("event storage failed"));
 await assert.rejects(phase,/event storage failed/);await h.controller.idle();
 assert.equal(h.end().reason,"storage_error");assert.equal(h.end().final_observation.disposition,"failed");assert.equal(h.end().final_observation.reason,"request_failed");
 assert.equal(h.frames().length,1);assert.equal(h.shotCount,3);assert.equal((await h.stop()).state,"failed");
});
test("failure cutoff freezes at actual closure, not delayed event-disk completion",async()=>{
 const h=harness();await h.start();h.eventGate=deferred();const e=h.controller.dispatch("record.phase",{identity,operation_id:"phase",text:"before"});await flush();h.shotError=Error("capture failure");await h.advance(100);assert.equal(h.end(),undefined);await h.advance(1000);h.eventGate.resolve();await e;await h.controller.idle();assert.equal(h.end().duration_ms,100);assert.equal(h.end().reason,"control_error");
});
test("final observed end freezes before durable credit/end wait",async()=>{
 const h=harness();await h.start();h.frameGate=deferred();h.jump(0.25);await h.stop();await flush();const frame=h.frames().at(-1);assert.equal(frame.observation.purpose,"final");await h.advance(1000);h.frameGate.resolve();await h.controller.idle();assert.equal(h.end().duration_ms,frame.observation.geometry_validated_ms);assert.equal(h.end().duration_ms,0.25);
});
test("response at cap may validate at cap; eligibility/stop at cap cannot initiate final",async()=>{
 const h=harness(),p=h.params();p.config.max_duration_ms=150;await h.start(p);h.shotGate=deferred();await h.advance(100);h.jump(50);h.shotGate.resolve();h.shotGate=null;await flush();await h.stop();await h.controller.idle();assert.equal(h.end().reason,"deadline");assert.equal(h.frames().at(-1).t_ms,150);assert.equal(h.frames().at(-1).observation.geometry_validated_ms,150);assert.ok(h.frames().every(f=>f.observation.purpose === "sample"));
});
test("end ACK timeout is bounded; late acceptance cannot resume or mutate terminal source",async()=>{
 const h=harness();await h.start();h.endGate=deferred();await h.stop();await flush();const end=structuredClone(h.end());await h.advance(10000);await h.controller.idle();assert.equal(h.controller.isActive(),false);h.endGate.resolve();await flush();assert.deepEqual(h.end(),end);assert.equal(h.frames().length,2);assert.equal(h.native.filter(n=>n.method === "record.ended").length,1);
});
test("actual JPEG header dimensions are frozen across stored operations",async()=>{
 const h=harness();await h.start();const changed=Buffer.from(jpeg,"base64"),sof=changed.indexOf(Buffer.from([255,192]));changed.writeUInt16BE(17,sof+7);h.shot=()=>({data:changed.toString("base64")});await h.advance(100);await h.controller.idle();assert.equal(h.end().reason,"geometry_changed");assert.equal(h.end().counters.observations_rejected,1);assert.equal(h.frames().length,1);
});
test("synchronous native post failure consumes no source sequence or invented send count",async()=>{
 const h=harness();await h.start();h.postFrameError=Error("port post failed");await h.stop();await h.controller.idle();assert.equal(h.frames().length,1);assert.equal(h.end().final_seq,1);assert.equal(h.end().counters.frames_sent,1);assert.equal(h.end().counters.observations_rejected,1);assert.equal(h.end().reason,"final_observation_failed");
});
test("shared invalid interval fixtures and regressing owned response are rejected without clamping",async()=>{
 const boundaries=JSON.parse(await readFile(new URL("../tests/fixtures/recording-v2/boundaries.json",import.meta.url)));
 for(const o of boundaries.invalid_intervals)assert.throws(()=>validateObservation(o,1500,o.response_received_ms));
 for(const n of [NaN,Infinity,-Infinity])assert.throws(()=>validateObservation({request_started_ms:0,response_received_ms:n,geometry_validated_ms:1},1500,n));
 const h=harness();await h.start();h.shot=()=>{h.jump(-1);return {data:jpeg};};await h.advance(100);await h.controller.idle();assert.equal(h.frames().length,1);assert.equal(h.end().reason,"invalid_frame");assert.equal(h.end().counters.observations_rejected,1);
});
test("stale epoch, operation reuse and credit cannot contaminate a replacement source",async()=>{
 const h=harness();await h.start();await h.stop();await h.controller.idle();await flush();const p=h.params({identity:{host_epoch:"new_epoch",record_id:"new"},operation_id:"new"});p.initial_credit.identity=p.identity;await assert.rejects(h.begin(p),{code:"RECORD_STALE_HOST"});await assert.rejects(h.controller.dispatch("record.stop",{identity:p.identity,operation_id:"stop"}),{code:"RECORD_STALE_HOST"});p.identity.host_epoch=identity.host_epoch;await assert.rejects(h.begin({...p,operation_id:"start_1"}),{code:"RECORD_OPERATION_CONFLICT"});
});
