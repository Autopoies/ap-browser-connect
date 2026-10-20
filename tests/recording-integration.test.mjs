// Synthetic screenshot callbacks, actual production controller/host/bridge/CLI/FFmpeg.
// No browser; see recording-v2-migration.md for retired v1 producer assertions.
import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture, data, identityFor, startArgs, snapshot, artifact, edgePixels, until, sha, repo } from "./recording-integration-harness.mjs";

test("v2 capabilities, correlated final and all-format fresh-CLI exports/offline provenance",{timeout:60000},async()=>{
	const f=await fixture("formats");
	try {
		await f.run(["record"],1);assert.equal(f.trace.length,0,"--out checked before host work");
		const caps=data(await f.rpc("record.capabilities",{}));assert.equal(caps.host.protocol_version,2);assert.equal(caps.extension.backend,"cdp_capture_screenshot");assert.equal(f.cdp.length,0,"capabilities has no target side effect");
		const started=await f.run(startArgs("all_formats")),handle=started.data.handle,identity=identityFor(handle);
		await until(()=>f.trace.some(v=>v.result?.accepted_seq===1));
		await assert.rejects(f.guard.send({tabId:7},"Emulation.setDeviceMetricsOverride",{width:320,height:180}),e=>e.code==="RECORD_GEOMETRY_CHANGED");
		await f.at(100);await f.run(["record","phase",handle,"--text","air collision"]);
		await f.at(200);await f.run(["record","mark",handle,"--text","observed overlap","--duration","1s"]);
		await f.at(350);f.image=f.images.C;
		const stopped=await f.run(["record","stop",handle]);assert.equal(stopped.data.status.state,"sealed");
		await until(()=>!f.controller.isActive());
		const sealed=await snapshot(f,identity),m=sealed.manifest;
		assert.equal(started.data.out,undefined);assert.equal(stopped.data.out,undefined);
		assert.deepEqual(f.sources.filter(v=>v.method==="record.frame").map(v=>v.params.observation),m.frames.map(v=>v.observation));
		assert.equal(new Set(m.frames.map(v=>v.observation.request_id)).size,m.frames.length);
		assert.equal(m.protocol_version,2);assert.equal(m.backend,"cdp_capture_screenshot");
		assert.deepEqual(m.frames.map(v=>[v.seq,v.t_ms,v.observation.purpose]),[[1,0,"sample"],[2,350,"final"]]);
		assert.equal(m.end.stop_requested_ms,350);assert.equal(m.end.final_observation.request_id,m.frames[1].observation.request_id);
		assert.equal(m.end.cutoff.provenance,"final_geometry_validation");assert.equal(m.end.duration_ms,350);
		assert.equal(m.frames[1].sha256,sha(Buffer.from(f.images.C,"base64")));assert.equal(f.peakWrites,1);
		assert.equal(f.shots,4,"two genuine preparation requests plus sample and final");
		for(const call of f.cdp.filter(v=>v.method==="Page.captureScreenshot"))assert.deepEqual(call.params,{format:"jpeg",quality:75,fromSurface:true,captureBeyondViewport:false});
		assert.ok(!f.cdp.some(v=>/Screencast|Emulation\./.test(v.method)),"no stream ownership stealing or emulation reset");
		const chunk=data(await f.rpc("record.read",{identity,offset:0,length:31}));assert.deepEqual(data(await f.rpc("record.read",{identity,offset:0,length:31})),chunk);assert.equal(chunk.sha256,sha(Buffer.from(chunk.data_base64,"base64")));
		const outputs=[];
		for(const format of ["mp4","mov","gif"]){
			const path=join(f.out,`caller 空 格 ${format}.${format}`);
			await f.run(["record","export",handle,"--metadata","--fps","2","--out",format==="mp4"?path:`caller 空 格 ${format}.${format}`]);
			const checked=await artifact(path);assert.deepEqual(checked.source,m);assert.equal(checked.metadata.schema_version,2);assert.equal(checked.metadata.partial,false);
			assert.equal(checked.timeline.at(-1).source.observation.purpose,"final");assert.equal(checked.timeline.at(-1).source.t_ms,350);
			assert.equal(checked.timeline.at(-1).final_observation_visibility,true);
			const quantum=format==="gif"?10:1;assert.equal(checked.metadata.duration_ms,350+quantum);assert.ok(checked.metadata.final_visibility_extension_ms<2*quantum);
			outputs.push({format,checked,pixels:await edgePixels(path,checked)});
		}
		assert.equal(new Set(outputs.map(v=>v.checked.metadata.export_id)).size,3,"fresh CLI exports have distinct identities");
		await f.run(["record","export",handle,"--watermark","task","--fps","8","--out","task.mp4"]);
		const task=await artifact(join(f.out,"task.mp4"));assert.ok(task.timeline.some(r=>r.phase==="air collision"));assert.ok(task.timeline.some(r=>r.marks.includes("observed overlap")));
		const doc=await readFile(join(repo,"skill/references/recording.md"),"utf8"),example=doc.match(/```json\n([\s\S]*?)\n```/);assert.ok(example);
		await writeFile(join(f.out,"documented-template.json"),JSON.stringify(JSON.parse(example[1])));
		const cleanHash=sha(await readFile(join(f.out,"caller 空 格 mp4.mp4")));
		await f.run(["record","watermark","caller 空 格 mp4.mp4","--sidecar","caller 空 格 mp4.metadata.json","--watermark-config","documented-template.json","--out","documented-template.mov"]);
		assert.equal(sha(await readFile(join(f.out,"caller 空 格 mp4.mp4"))),cleanHash);
		const offline=await artifact(join(f.out,"documented-template.mov"));assert.equal(offline.metadata.provenance,"offline_verified_sidecar");assert.deepEqual(offline.source,m);
		assert.ok(!(await f.run(["record","export",handle,"--out","caller 空 格 mp4.mp4"],1)).ok);
		await f.run(["record","release",handle]);await f.run(["record","release",handle]);assert.equal((await f.run(["record","status",handle],1)).error.code,"RECORD_NOT_FOUND");
		assert.ok(!f.trace.some(v=>["record.read","record.manifest","record.status"].includes(v.method)),"local source reads never traverse Chrome");
		await f.save({sealed,outputs,task,offline});
	} finally {await f.close();}
});

test("mixed v1 capability fails before target/allocation, no capture fallback",{timeout:15000},async()=>{
	const f=await fixture("capability");try{
		f.capability={protocol_version:1,backend:"cdp_capture_screenshot"};
		const failed=await f.run(startArgs("mixed_versions"),1);assert.equal(failed.error.code,"RECORD_UNSUPPORTED_VERSION");
		assert.equal(f.cdp.length,0);assert.equal(f.trace.filter(v=>v.method==="record.start").length,0);
		f.capability=null;const started=await f.run(startArgs("after_negotiation"));await f.at(100);await f.run(["record","stop",started.data.handle]);await f.save({failed});
	}finally{await f.close();}
});
