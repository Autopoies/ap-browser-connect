// V2 migration of controller/lifecycle/security coverage; no legacy stream producer.
import assert from "node:assert/strict";
import test from "node:test";
import { harness, identity, flush, jpeg, wire } from "./recording-v2-harness.mjs";
import { jpegDimensions, startParams, validateEvent } from "./recording-validation.mjs";

const stop = async h => { await h.stop(); await h.controller.idle(); await flush(); };
test("real shared JPEG fixture and strict bounded/canonical base64", () => {
 assert.deepEqual(jpegDimensions(jpeg),{width:16,height:16});
 for(const bad of [null,"", "a===",jpeg.slice(0,-1),"A".repeat(5592412),btoa("not jpeg")]) assert.throws(()=>jpegDimensions(bad));
 const raw=Buffer.from(jpeg,"base64"), sof=raw.indexOf(Buffer.from([255,192]));
 for(const size of [0,16385]) {const changed=Buffer.from(raw);changed.writeUInt16BE(size,sof+7);assert.throws(()=>jpegDimensions(changed.toString("base64")));}
});
test("capability and exact version/backend failures perform no target work",async()=>{
 const h=harness(); assert.deepEqual(await h.controller.dispatch("record.capabilities",{}),{protocol_version:2,backend:"cdp_capture_screenshot"});
 for(const p of [{x:1},null,[]]) await assert.rejects(h.controller.dispatch("record.capabilities",p));
 for(const [p,code] of [[h.params({protocol_version:1}),"RECORD_UNSUPPORTED_VERSION"],[h.params({backend:"legacy"}),"RECORD_UNSUPPORTED_BACKEND"]]) await assert.rejects(h.begin(p),{code});
 for(const method of ["record.status","record.manifest","record.read","record.release","record.frame","record.event","record.ended"]) await assert.rejects(h.controller.dispatch(method,{}));
 assert.equal(h.queryCount,0);assert.equal(h.calls.length,0);assert.equal(h.acquired.length,0);
});
test("start bounds and initial credit are mandatory before target resolution",async()=>{
 const h=harness();
 const changes=[p=>delete p.protocol_version,p=>p.identity.record_id="../bad",p=>p.operation_id="",p=>p.tab_id=-1,p=>p.config.capture_fps=31,p=>p.config.max_duration_ms=60001,p=>p.config.jpeg_quality=0,p=>p.config.labels={bad:"\u0000"},p=>p.config.region={kind:"element",selector:""},p=>p.initial_credit.next_seq=2,p=>p.initial_credit.identity.record_id="other",p=>p.initial_credit.max_frame_bytes=1];
 for(const change of changes){const p=h.params();change(p);await assert.rejects(h.begin(p));} assert.equal(h.queryCount,0);
});
test("actual correlated screenshot options, origin, serial source, idempotency and final seal",async()=>{
 const h=harness();const p=h.params();const pending=h.begin(p);const duplicate=h.begin(structuredClone(p));await h.advance(40);const started=await pending;assert.deepEqual(await duplicate,started);
 assert.equal(started.clock.origin,"before_first_recorded_screenshot_request");assert.equal(started.protocol_version,2);assert.equal(h.queryCount,1);
 await assert.rejects(h.begin(h.params({config:{...p.config,jpeg_quality:1}})),{code:"RECORD_OPERATION_CONFLICT"});
 h.jump(12.125);await stop(h);
 const frames=h.frames();assert.equal(frames.length,2);assert.deepEqual(frames.map(f=>f.observation.purpose),["sample","final"]);
 assert.notEqual(frames[0].observation.request_id,frames[1].observation.request_id);
 for(const [i,f] of frames.entries()){assert.equal(f.seq,i+1);assert.equal(f.t_ms,f.observation.response_received_ms);assert.ok(f.observation.request_started_ms<=f.t_ms && f.t_ms<=f.observation.geometry_validated_ms);}
 assert.equal(h.end().duration_ms,frames.at(-1).observation.geometry_validated_ms);assert.equal(h.end().final_observation.seq,2);assert.equal(h.end().reason,"stopped");assert.equal(h.controller.isActive(),false);
 for(const c of h.calls.filter(c=>c.method === "Page.captureScreenshot"))assert.deepEqual(c.params,{format:"jpeg",quality:80,fromSurface:true,captureBeyondViewport:false});
 assert.equal(h.calls.some(c=>/Screencast|Emulation\./.test(c.method)),false);
 assert.deepEqual(h.end().counters,{preparation_requests:2,preparation_responses:2,requests_started:2,responses_received:2,request_failures:0,observations_rejected:0,late_responses:0,frames_sent:2,scheduling_delays:0});
});
test("shared v2 wire start uses real fixture through actual controller",async()=>{
 const h=harness();const p=structuredClone(wire.extension_start.params);const started=await h.start(p);assert.equal(started.identity.record_id,p.identity.record_id);
 await h.controller.dispatch("record.stop",{identity:p.identity,operation_id:"stop_fixture"});await h.controller.idle();assert.equal(h.end().reason,"stopped");
});
test("start pins a copied config/target and refuses another identity while active",async()=>{
 const h=harness();const p=h.params();const pending=h.begin(p);p.identity.record_id="mutated";p.config.jpeg_quality=1;await flush();h.activeTab=8;await h.advance(40);await pending;
 assert.equal(h.acquired[0],7);assert.equal(h.frames()[0].identity.record_id,"record_1");
 const other=h.params({identity:{...identity,record_id:"other"},operation_id:"other"});other.initial_credit.identity=other.identity;
 await assert.rejects(h.begin(other),{code:"RECORD_BUSY"});await stop(h);
});
test("phase/mark literal validation, deduplication and ordered stop-boundary drain",async()=>{
 const h=harness();await h.start();const phase={identity,operation_id:"phase",text:"任务\nliteral %{x}"};const a=await h.controller.dispatch("record.phase",phase);assert.deepEqual(await h.controller.dispatch("record.phase",phase),a);
 await assert.rejects(h.controller.dispatch("record.phase",{...phase,text:"other"}),{code:"RECORD_OPERATION_CONFLICT"});
 h.jump(3.25);await h.controller.dispatch("record.mark",{identity,operation_id:"mark",text:"done",duration_ms:100});
 await stop(h);assert.equal(h.native.filter(n=>n.method === "record.event").length,2);assert.ok(a.t_ms<=h.end().stop_requested_ms);
 await assert.rejects(h.controller.dispatch("record.phase",{...phase,operation_id:"late"}),{code:"RECORD_INVALID_STATE"});
 for(const p of [{operation_id:"a",text:"x",duration_ms:0},{operation_id:"a",text:"\tbad",duration_ms:1},{operation_id:"a",text:"x".repeat(513),duration_ms:1}])assert.throws(()=>validateEvent("record.mark",p));
});
test("automatic deadline is original cap without final request; stop after closure is idempotent",async()=>{
 const h=harness();const p=h.params();p.config.max_duration_ms=250;await h.start(p);await h.advance(250);await h.controller.idle();const before=h.shotCount;await h.stop();await flush();
 assert.equal(h.end().reason,"deadline");assert.equal(h.end().duration_ms,250);assert.equal(h.end().stop_requested_ms,null);assert.equal(h.end().final_observation.disposition,"not_requested");assert.equal(h.shotCount,before);assert.ok(h.frames().every(f=>f.observation.purpose === "sample"));
});
test("nonfinite and malformed geometry/JPEG cause explicit source failure, never hidden retry",async()=>{
 for(const mode of ["jpeg","dom","layout","image"]){const h=harness();await h.start();if(mode === "jpeg")h.shot=()=>({data:"bad"});if(mode === "dom")h.value.dom.device_scale_factor=NaN;if(mode === "layout")h.layout={};if(mode === "image")h.value.dom.inner_width=32;
 await h.advance(100);await h.controller.idle();assert.ok(!["deadline","stopped"].includes(h.end().reason));assert.equal(h.frames().length,1);}
});
test("terminal start tombstones prevent attachment after session detail eviction",async()=>{
 const h=harness();for(let n=0;n<7;n++){const p=h.params({identity:{...identity,record_id:`r${n}`},operation_id:`s${n}`});p.initial_credit.identity=p.identity;const started=await h.start(p);await h.controller.dispatch("record.stop",{identity:p.identity,operation_id:`end${n}`});await h.controller.idle();await flush();if(n === 0)h.first={p,started};}
 const count=h.acquired.length;assert.deepEqual(await h.begin(h.first.p),h.first.started);assert.equal(h.acquired.length,count);
});
