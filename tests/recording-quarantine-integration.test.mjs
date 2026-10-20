// Unresolved original screenshot ownership across actual native/CLI sessions.
import assert from "node:assert/strict";
import test from "node:test";
import { fixture, data, identityFor, startArgs, snapshot, until } from "./recording-integration-harness.mjs";

test("timed-out screenshot keeps exclusion until original completion; frozen failed prefix survives replacement",{timeout:30000},async()=>{
	const f=await fixture("quarantine");let held;
	try {
		const first=await f.run(startArgs("unresolved","1s")),handle=first.data.handle,identity=identityFor(handle);
		await until(()=>f.trace.some(v=>v.result?.accepted_seq===1));held=f.gateShot();await f.at(500);await f.at(10500);
		await until(async()=>data(await f.rpc("record.status",{identity})).state==="failed");
		const frozen=await snapshot(f,identity);assert.equal(frozen.manifest.frames.length,1);assert.equal(f.controller.isActive(),true);
		await assert.rejects(f.guard.send({tabId:7},"Emulation.clearDeviceMetricsOverride",{}),e=>e.code==="RECORD_GEOMETRY_CHANGED");
		const refused=await f.run(startArgs("while_quarantined"),1);assert.equal(refused.error.code,"RECORD_BUSY");assert.equal(f.shots,4);
		held.release();await until(()=>!f.controller.isActive());assert.deepEqual(await snapshot(f,identity),frozen);
		const next=await f.run(startArgs("after_original_completion"));assert.notEqual(next.data.handle,handle);
		await f.at(100);f.image=f.images.C;await f.run(["record","stop",next.data.handle]);
		assert.deepEqual(await snapshot(f,identity),frozen);assert.equal(f.sources.filter(v=>v.method==="record.frame"&&v.params.identity.record_id===identity.record_id).length,1);
		await f.save({frozen,refused,next});
	}finally{held?.release();await f.close();}
});
