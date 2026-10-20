// Real controller/guard + synthetic screenshot RPCs; real native host/bridge/CLI.
// No Chrome, global manifests, installed binaries, or real HOME changes.
import assert from "node:assert/strict";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, readFile, writeFile, rm, access, realpath } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer, createConnection } from "node:net";
import { createHash } from "node:crypto";
import { createRecordingController } from "../extension/recording.mjs";
import { createRecordingGuard } from "../extension/recording-guard.mjs";
import { facts, metrics } from "../extension/recording-v2-harness.mjs";
import { createRecordingTestClock, flush } from "./recording-test-clock.mjs";
export const exec = promisify(execFile);
export const repo = fileURLToPath(new URL("../", import.meta.url));
const bin = resolve(repo, process.env.CARGO_TARGET_DIR || "target", "debug");
export const sha = bytes => createHash("sha256").update(bytes).digest("hex");
export const sleep = ms => new Promise(r => setTimeout(r, ms));
export function gate() { let release; const promise = new Promise(r => {release=r;}); return {promise, release}; }
export async function until(fn, ms=5000) { const end=Date.now()+ms; while (!(await fn())) {assert.ok(Date.now()<end,"bounded integration wait expired"); await sleep(10);} }
export async function exists(path) {try {await access(path); return true;} catch {return false;}}
const encode = value => {const b=Buffer.from(JSON.stringify(value)), h=Buffer.alloc(4); h.writeUInt32LE(b.length); return Buffer.concat([h,b]);};
async function stop(child) {if (!child || child.exitCode!==null || child.signalCode!==null) return; child.kill("SIGTERM"); await until(()=>child.exitCode!==null || child.signalCode!==null);}
export async function stateJpegs() {
	const images={};
	for (const [name,color] of [["A","red"],["B","lime"],["C","blue"],["D","white"]]) {
		images[name]=(await exec("ffmpeg",["-v","error","-f","lavfi","-i",`color=c=${color}:s=320x180`,"-frames:v","1","-c:v","mjpeg","-f","image2pipe","pipe:1"],{encoding:"buffer",timeout:5000})).stdout.toString("base64");
	}
	return images;
}
export async function fixture(name) {
	const root=await mkdtemp("/tmp/apv2-"); const home=join(root,"home"); await mkdir(home,{mode:0o700});
	const requested=process.env.AP_RECORDING_INTEGRATION_ARTIFACTS;
	let out=requested ? await mkdtemp(join(resolve(requested),`${name}-`)) : join(root,"caller 空 格");
	await mkdir(out,{recursive:true}); out=await realpath(out);
	const env={...process.env,HOME:home,TMPDIR:root,AP_BROWSER_INSTANCE:"snapshot_integration"}; delete env.AP_BROWSER_REMOTE;
	const clock=createRecordingTestClock(), pending=new Map(), trace=[], sources=[], cdp=[], commands=[], errors=[], releases=[];
	const images=await stateJpegs();
	let host,bridge,controller,seq=0,bytes=Buffer.alloc(0),shotGate,creditGate,eventCreditGate;
	const f={image:images.A,images,dropEnd:false,capability:null,peakWrites:0,inFlight:0,shots:0};
	const write=v=>{if (!host.stdin.destroyed && !host.stdin.writableEnded) host.stdin.write(encode(v));};
	const native=(method,params,onSent)=>new Promise((resolve,reject)=>{
		sources.push({method,params:structuredClone(params),sent_at:clock.now(),trace_length:trace.length});
		if (method==="record.ended" && f.dropEnd) {reject(new Error("synthetic lost End transport")); return;}
		if (method==="record.frame") {f.inFlight++; f.peakWrites=Math.max(f.peakWrites,f.inFlight);}
		const id=`sw-${++seq}`; pending.set(id,{resolve,reject,method}); write({id,method,params}); onSent?.();
	});
	async function route(m) {
		trace.push(m);
		if (typeof m.id==="string") {
			const waiter=pending.get(m.id); assert.ok(waiter,"opaque response association");
			if (creditGate && m.result?.accepted_seq===creditGate.seq) await creditGate.promise;
			// The real host has already appended/synced this event; delay only its ACK
			// to the actual controller so a second admitted event waits behind it.
			if (eventCreditGate && waiter.method==="record.event" && m.result?.operation_id===eventCreditGate.operation) await eventCreditGate.promise;
			pending.delete(m.id); if (waiter.method==="record.frame") f.inFlight--;
			if(m.ok)waiter.resolve(m.result);else waiter.reject(Object.assign(new Error(m.error.message),m.error));
		} else if (m.method?.startsWith("record.")) {
			try {
				const data=m.method==="record.start" ? await clock.start(controller,m.params) : m.method==="record.capabilities" && f.capability ? f.capability : await controller.dispatch(m.method,m.params);
				write({id:m.id,result:{ok:true,data}});
			} catch(e) {write({id:m.id,error:{code:e.code||"FIXTURE_FAILURE",message:e.message}});}
		} else if(m.method==="ping")write({id:m.id,result:{ok:true,data:{pong:true}}});
		else throw Error(`unexpected method ${m.method}`);
	}
	const raw=async(source,method,params)=>{
		cdp.push({source,method,params,at:clock.now()}); assert.equal(source.tabId,7);
		if(method==="Runtime.evaluate")return {result:{value:facts(320,180)}};
		if(method==="Page.getLayoutMetrics")return metrics(facts(320,180).dom);
		if(method==="Page.captureScreenshot") {
			clock.screenshotInvoked(); f.shots++; const data=f.image;
			if(shotGate){const g=shotGate; shotGate=null; await g.promise;}
			return {data};
		}
		throw Error(`unapproved fake CDP command ${method}`);
	};
	const guard=createRecordingGuard(raw); guard.attached(7,true); // modeled successful clean attach, not browser evidence
	controller=createRecordingController({now:clock.now,setTimer:clock.setTimer,clearTimer:clock.clearTimer,sendNative:native,
		chrome:{tabs:{get:async id=>({id})}},acquireLease(tabId){const access=guard.reserve(tabId);return {ready:Promise.resolve(access),async release(){releases.push(tabId);access.release();}};}});
	let hostStderr="",bridgeLog="",rpc;
	async function close() {
		shotGate?.release(); creditGate?.release(); eventCreditGate?.release(); controller.interrupt("native_disconnected");
		if(host && !host.stdin.destroyed)host.stdin.end();
		if(host){try{await until(()=>host.exitCode!==null,2000);}catch{await stop(host);}}
		await stop(bridge); for(const p of pending.values())p.reject(new Error("fixture cleanup"));
		await rm(root,{recursive:true,force:true});
	}
	try {
		host=spawn(join(bin,"ap-browser-host"),["chrome-extension://synthetic-snapshot/"],{env,stdio:["pipe","pipe","pipe"]});
		host.on("error",e=>errors.push(String(e)));host.stderr.on("data",b=>{hostStderr=(hostStderr+b).slice(-65536);});
		host.stdout.on("data",b=>{bytes=Buffer.concat([bytes,b]);while(bytes.length>=4 && bytes.length>=bytes.readUInt32LE(0)+4){const n=bytes.readUInt32LE(0);assert.ok(n<1024*1024);const m=JSON.parse(bytes.subarray(4,n+4));bytes=bytes.subarray(n+4);route(m).catch(e=>errors.push(String(e)));}});
		write({method:"hello",params:{instance_id:env.AP_BROWSER_INSTANCE,extension_version:"synthetic-v2",chrome_version:"fake-RPC",open_tabs:[]}});
		await until(()=>exists(join(root,"ap-browser-snapshot_integration.sock")));
		const reservation=createServer(); await new Promise(r=>reservation.listen(0,"127.0.0.1",r));const port=reservation.address().port; await new Promise(r=>reservation.close(r));
		const tokenFile=join(root,"bridge-token");bridge=spawn(join(bin,"ap-browser-bridge"),["--instance",env.AP_BROWSER_INSTANCE,"--listen",`127.0.0.1:${port}`,"--token-file",tokenFile],{env,stdio:["ignore","ignore","pipe"]});
		bridge.on("error",e=>errors.push(String(e)));bridge.stderr.on("data",b=>{bridgeLog=(bridgeLog+b).slice(-65536);});
		await until(()=>bridgeLog.includes("AP_BROWSER_REMOTE="));const token=await readFile(tokenFile,"utf8");env.AP_BROWSER_REMOTE=`tcp://127.0.0.1:${port}?token=${token}`;
		rpc=async(method,params)=>{
			const stream=createConnection({host:"127.0.0.1",port});
			try{return await new Promise((resolve,reject)=>{
				let b=Buffer.alloc(0),authed=false;stream.setTimeout(15000,()=>reject(Error("bridge timeout")));stream.on("error",reject);stream.on("end",()=>reject(Error("bridge EOF")));
				stream.on("connect",()=>stream.write(encode({token})));stream.on("data",incoming=>{b=Buffer.concat([b,incoming]);while(b.length>=4&&b.length>=b.readUInt32LE(0)+4){const n=b.readUInt32LE(0),v=JSON.parse(b.subarray(4,n+4));b=b.subarray(n+4);if(!authed){assert.equal(v.ok,true);authed=true;stream.write(encode({method,params}));}else resolve(v);}});
			});}finally{stream.destroy();}
		};
	}catch(e){await close();throw e;}
	return Object.assign(f,{out,clock,controller,guard,trace,sources,cdp,commands,errors,releases,rpc,close,
		async run(args,expected=0){
			let stdout,stderr,code=0;try{({stdout,stderr}=await exec(join(bin,"ap-browser"),args,{env,cwd:out,timeout:30000,maxBuffer:4*1024*1024}));}catch(e){({stdout,stderr}=e);code=e.code;}
			const value=JSON.parse(stdout);commands.push({args,exit_code:code,stdout:value,stderr});assert.equal(code,expected,JSON.stringify(commands.at(-1)));return value;
		},
		async at(t){await clock.atCapture(t);await flush();},
		gateShot(){shotGate=gate();return shotGate;},
		gateCredit(n){creditGate={...gate(),seq:n};return creditGate;},
		gateEventCredit(operation){eventCreditGate={...gate(),operation};return eventCreditGate;},
		async save(facts){assert.deepEqual(errors,[]);await writeFile(join(out,"verification.json"),JSON.stringify({scope:"synthetic screenshot RPCs; real controller/guard/native host/bridge/fresh CLI/FFmpeg; NOT live acceptance",commands,trace,sources,cdp,releases,clock:clock.facts(),hostStderr,facts},null,2));console.log(`Integration artifacts: ${out}`);},
	});
}
export const data=r=>{assert.equal(r.result?.ok,true,JSON.stringify(r));return r.result.data;};
export const identityFor=handle=>{const [,host_epoch,record_id]=handle.split(":");return {host_epoch,record_id};};
export const startArgs=(operation,duration="5s")=>["--tab","7","record","start","--max-duration",duration,"--capture-fps","2","--label","project=arena","--operation-id",operation];
export async function snapshot(f,identity){return {status:data(await f.rpc("record.status",{identity})),manifest:data(await f.rpc("record.manifest",{identity})),chunk:data(await f.rpc("record.read",{identity,offset:0,length:262144}))};}
export async function artifact(path) {
	const video=await readFile(path),raw=await readFile(path.replace(/\.(mp4|mov|gif)$/,".metadata.json")),timelineBytes=await readFile(path.replace(/\.(mp4|mov|gif)$/,".timeline.jsonl")),metadata=JSON.parse(raw);
	assert.equal(metadata.video.sha256,sha(video));assert.equal(metadata.timeline.sha256,sha(timelineBytes));assert.equal(metadata.source_manifest_sha256,sha(Buffer.from(metadata.source_manifest_json)));
	const source=JSON.parse(metadata.source_manifest_json),timeline=timelineBytes.toString().trim().split("\n").map(JSON.parse);
	const probe=JSON.parse((await exec("ffprobe",["-v","error","-show_streams","-show_format","-show_frames","-of","json",path],{timeout:5000})).stdout);
	assert.equal(probe.streams.length,1);assert.equal(probe.streams[0].codec_type,"video");assert.equal(probe.frames.length,timeline.length);
	assert.ok(Math.abs(Number(probe.format.duration)*1000-metadata.duration_ms)<0.02);
	for(const [i,row] of timeline.entries()) {
		assert.equal(row.export_id,metadata.export_id);assert.equal(row.output_frame,i+1);assert.ok(Math.abs(Number(probe.frames[i].pts_time)*1000-row.pts_ms)<0.02);
		if(metadata.schema_version===2 && row.source){const frame=source.frames[row.source.seq-1];assert.deepEqual(row.source,{seq:frame.seq,t_ms:frame.t_ms,observation:frame.observation});}
	}
	return {metadata,source,timeline,probe};
}
export async function edgePixels(path,checked) {
	const pixels=[];
	for(const n of [0,checked.timeline.length-1]) {
		const b=(await exec("ffmpeg",["-v","error","-i",path,"-vf",`select=eq(n\\,${n})`,"-fps_mode","passthrough","-frames:v","1","-pix_fmt","rgb24","-f","rawvideo","pipe:1"],{encoding:"buffer",timeout:5000,maxBuffer:4*1024*1024})).stdout;
		const offset=(8*checked.metadata.width+8)*3;pixels.push([...b.subarray(offset,offset+3)]);
	}
	assert.ok(pixels[0][0]>190&&pixels[0][1]<40&&pixels[0][2]<40,"first state red A");
	assert.ok(pixels[1][2]>190&&pixels[1][0]<40&&pixels[1][1]<40,"final state blue C");return pixels;
}
