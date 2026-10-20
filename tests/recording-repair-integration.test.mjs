// Snapshot v2 lifecycle cross-seam tests. Synthetic RPCs are NOT live acceptance.
import assert from "node:assert/strict";
import test from "node:test";
import { join } from "node:path";
import { fixture, data, identityFor, startArgs, snapshot, artifact, edgePixels, until, exists, sha } from "./recording-integration-harness.mjs";

test("stop closes same-tick admission, drains actual durable credit, then one correlated final",{timeout:30000},async()=>{
	const f=await fixture("stop-credit");let stopping;try{
		const credit=f.gateCredit(1),started=await f.run(startArgs("stop_credit")),handle=started.data.handle,identity=identityFor(handle);
		await until(()=>f.trace.some(v=>v.result?.accepted_seq===1));assert.equal(data(await f.rpc("record.status",{identity})).persisted_seq,1);
		await f.at(100);await f.run(["record","phase",handle,"--text","same tick"]);
		stopping=f.run(["record","stop",handle]);await until(()=>f.trace.some(v=>v.method==="record.stop"));
		assert.equal(data(await f.rpc("record.status",{identity})).state,"stopping");
		const event=data(await f.rpc("ping",{}));assert.deepEqual(event,{pong:true});
		const refused=await f.rpc("record.phase",{identity,operation_id:"after_close",text:"late"});assert.equal(refused.error.code,"RECORD_INVALID_STATE");
		assert.equal(f.shots,3,"no screenshot while actual native credit held");assert.equal(f.sources.filter(v=>v.method==="record.ended").length,0);
		f.image=f.images.C;credit.release();assert.equal((await stopping).data.status.state,"sealed");
		const sealed=await snapshot(f,identity),m=sealed.manifest;assert.equal(m.frames.length,2);assert.equal(m.events[0].t_ms,100);assert.equal(m.end.stop_requested_ms,100);
		assert.equal(m.frames[1].observation.request_started_ms,100,"equal precision tick admitted only as genuine final");assert.equal(f.peakWrites,1);
		assert.ok(f.trace.findIndex(v=>v.result?.accepted_seq===2)<f.trace.findIndex(v=>v.result?.state==="sealed"));
		await f.run(["record","export",handle,"--metadata","--fps","2","--out","drained.mp4"]);const checked=await artifact(join(f.out,"drained.mp4"));const pixels=await edgePixels(join(f.out,"drained.mp4"),checked);
		await f.at(1000);assert.deepEqual(await snapshot(f,identity),sealed);assert.equal(f.shots,4);await f.save({sealed,checked,pixels});
	}finally{await f.close();await stopping?.catch(()=>{});}
});

test("pre-stop phase and queued mark durably drain through real host before FINAL despite delayed event ACK",{timeout:30000},async()=>{
	const f=await fixture("queued-events-final"),controls=[];
	const control=(method,params)=>{const p=f.rpc(method,params);p.catch(()=>{});controls.push(p);return p;};try{
		const started=await f.run(startArgs("queued_events_final")),identity=identityFor(started.data.handle);
		await until(()=>f.trace.some(v=>v.result?.accepted_seq===1));await f.at(100);
		const phase={identity,operation_id:"queued_phase_A",text:"phase A"},mark={identity,operation_id:"queued_mark_B",text:"mark B",duration_ms:1000};
		const credit=f.gateEventCredit(phase.operation_id);
		const phaseReply=control("record.phase",phase);
		await until(()=>f.trace.some(v=>v.ok===true && v.result?.operation_id===phase.operation_id));
		const markReply=control("record.mark",mark);
		await until(()=>f.trace.some(v=>v.method==="record.mark" && v.params.operation_id===mark.operation_id));
		assert.equal(f.sources.filter(v=>v.method==="record.event").length,1,"B admitted by controller but queued behind A's delayed durable ACK");
		const stopReply=control("record.stop",{identity,operation_id:"queued_events_stop"});
		assert.equal(data(await stopReply).state,"stopping");
		const refused=await f.rpc("record.mark",{identity,operation_id:"post_stop_mark",text:"late",duration_ms:1000});assert.equal(refused.error.code,"RECORD_INVALID_STATE");
		await f.at(350);
		assert.equal(f.shots,3,"no final screenshot while admitted events await original credit");
		assert.equal(f.sources.filter(v=>v.method==="record.ended").length,0);
		f.image=f.images.C;credit.release();
		const accepted=[data(await phaseReply),data(await markReply)];
		await until(async()=>data(await f.rpc("record.status",{identity})).state==="sealed");
		const sealed=await snapshot(f,identity),m=sealed.manifest;
		assert.equal(sealed.status.state,"sealed");assert.equal(m.end.reason,"stopped");assert.equal(m.end.stop_requested_ms,100);
		assert.deepEqual(m.events,accepted);assert.deepEqual(m.events.map(v=>[v.event_index,v.kind,v.text,v.t_ms]),[[1,"phase","phase A",100],[2,"mark","mark B",100]]);
		assert.deepEqual(m.frames.map(v=>v.observation.purpose),["sample","final"]);assert.equal(m.frames[1].t_ms,350);
		assert.deepEqual(m.end.final_observation,{disposition:"accepted",request_id:m.frames[1].observation.request_id,seq:2});
		const sourceOrder=f.sources.filter(v=>["record.frame","record.event","record.ended"].includes(v.method)).map(v=>v.method==="record.frame"?v.params.observation.purpose:v.method==="record.event"?v.params.event.text:"ended");
		assert.deepEqual(sourceOrder,["sample","phase A","mark B","final","ended"]);
		const durableA=f.trace.findIndex(v=>v.ok===true && v.result?.operation_id===phase.operation_id),durableB=f.trace.findIndex(v=>v.ok===true && v.result?.operation_id===mark.operation_id),durableFinal=f.trace.findIndex(v=>v.result?.accepted_seq===2);
		assert.ok(durableA>=0 && durableA<durableB && durableB<durableFinal,"real Rust writer ACKs both durable events before accepting final");
		const finalSend=f.sources.find(v=>v.method==="record.frame" && v.params.observation.purpose==="final");
		assert.ok(durableB<finalSend.trace_length,"both real host durable event ACKs observed BEFORE final frame is even sent");
		assert.deepEqual(f.sources.filter(v=>v.method==="record.event").map(v=>v.params.event),m.events);
		await f.save({sealed,sourceOrder,durableAckOrder:{phase:durableA,mark:durableB,final:durableFinal}});
	}finally{await f.close();await Promise.allSettled(controls);}
});

test("deadline starts no final and discards late callback without backdating or cross-session mutation",{timeout:30000},async()=>{
	const f=await fixture("deadline-late");try{
		const started=await f.run(startArgs("deadline_late","1s")),handle=started.data.handle,identity=identityFor(handle);
		await until(()=>f.trace.some(v=>v.result?.accepted_seq===1));const gate=f.gateShot();
		await f.at(500);assert.equal(f.shots,4);await f.at(1001);f.image=f.images.D;gate.release();
		await until(async()=>data(await f.rpc("record.status",{identity})).state==="sealed");
		const sealed=await snapshot(f,identity),m=sealed.manifest;assert.equal(m.end.reason,"deadline");assert.equal(m.end.duration_ms,1000);assert.equal(m.end.final_observation.disposition,"not_requested");
		assert.equal(m.frames.length,1);assert.equal(m.end.counters.requests_started,2);assert.equal(m.end.counters.late_responses,1);assert.equal(m.end.counters.observations_rejected,1);assert.equal(f.shots,4);
		await f.run(["record","export",handle,"--metadata","--fps","2","--out","deadline.mp4"]);const checked=await artifact(join(f.out,"deadline.mp4"));assert.equal(checked.metadata.duration_ms,1000);assert.ok(checked.timeline.every(r=>!r.final_observation_visibility));
		await until(()=>!f.controller.isActive());f.image=f.images.A;
		const next=await f.run(startArgs("replacement"));assert.notEqual(next.data.handle,handle);await f.at(100);f.image=f.images.C;await f.run(["record","stop",next.data.handle]);
		assert.deepEqual(await snapshot(f,identity),sealed);assert.equal(f.sources.filter(v=>v.method==="record.frame" && v.params.identity.record_id===identity.record_id).length,1);
		await f.save({sealed,checked,next});
	}finally{await f.close();}
});

test("lost End retains actual durable final as immutable failed unknown-end partial through offline export",{timeout:45000},async()=>{
	const f=await fixture("lost-end");try{
		const started=await f.run(startArgs("lost_end")),handle=started.data.handle,identity=identityFor(handle);
		await until(()=>f.trace.some(v=>v.result?.accepted_seq===1));await f.at(350);f.image=f.images.C;f.dropEnd=true;
		const stopped=await f.run(["record","stop",handle]);assert.equal(stopped.data.status.state,"failed");
		const sealed=await snapshot(f,identity),m=sealed.manifest;assert.equal(m.frames.length,2);assert.equal(m.frames[1].observation.purpose,"final");
		assert.equal(m.frames[1].sha256,sha(Buffer.from(f.images.C,"base64")));assert.equal(m.end.final_observation.disposition,"persisted_without_end");
		assert.equal(m.end.stop_requested_ms,null);assert.equal(m.end.counters,null);assert.equal(m.end.duration_observed,false);assert.equal(m.end.cutoff.provenance,"durable_lower_bound");assert.equal(m.end.duration_ms,350);
		await f.run(["record","export",handle,"--metadata","--out","refused.mp4"],1);assert.equal(await exists(join(f.out,"refused.mp4")),false);
		const outputs=[];for(const format of ["mp4","mov","gif"]){
			const file=`partial-${format}.${format}`;await f.run(["record","export",handle,"--partial","--metadata","--fps","2","--out",file]);
			const checked=await artifact(join(f.out,file));assert.equal(checked.metadata.partial,true);assert.equal(checked.metadata.observed_source_end_ms,undefined);assert.deepEqual(checked.source,m);outputs.push({checked,pixels:await edgePixels(join(f.out,file),checked)});
		}
		await f.run(["record","watermark","partial-mp4.mp4","--sidecar","partial-mp4.metadata.json","--watermark","task","--out","offline-partial.mov"]);
		const offline=await artifact(join(f.out,"offline-partial.mov"));assert.equal(offline.metadata.partial,true);assert.equal(offline.metadata.observed_source_end_ms,undefined);assert.deepEqual(offline.source,m);
		assert.deepEqual(await snapshot(f,identity),sealed);await f.save({sealed,outputs,offline});
	}finally{await f.close();}
});
