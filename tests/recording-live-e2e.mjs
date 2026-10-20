#!/usr/bin/env node
// Explicit opt-in only. No download/install/user-profile/native-manifest writes.
// Build: cargo build --locked --offline -p ap-browser -p ap-browser-host
// Run: AP_RECORDING_LIVE_OPT_IN=1 node tests/recording-live-e2e.mjs --chrome /absolute/installed/test/Chrome
// Chrome inherits HOME. Only native host + CLI receive private HOME/TMPDIR.
// --fidelity-diagnostic: ONE explicitly authorized sparse-source capture with a
// read-only bounded producer observer. Writes only its run receipt, never the
// historical canonical PASS. An exit/status here is not full live acceptance.
import assert from 'node:assert/strict';
import { spawn, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, readFile, writeFile, readdir, cp, chmod, rm, realpath, access, stat, open } from 'node:fs/promises';
import { join, resolve, basename } from 'node:path';
import { userInfo } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:http';
import { createConnection } from 'node:net';
import { decodeState, inspectRenderedTail } from './recording-state-oracle.mjs';
import { waitNativeReady } from './recording-live-readiness.mjs';
const exec = promisify(execFile), sleep = ms => new Promise(r => setTimeout(r, ms));
const repo = fileURLToPath(new URL('../', import.meta.url));
const evidenceRoot = resolve(repo, '../live-evidence'), hash = b => createHash('sha256').update(b).digest('hex');
const chromePath = process.argv[process.argv.indexOf('--chrome') + 1];
function cyan([r,g,b]){return g>180&&b>180&&Math.min(g,b)-r>70&&Math.abs(g-b)<45;}
function magenta([r,g,b]){return r>100&&b>70&&Math.min(r,b)-g>55;}
function arenaDark([r,g,b]){return Math.max(r,g,b)<130&&b-r>15&&b-g>10&&g>=r-5;}
if(process.argv.includes('--self-test')){
  for(const c of [[0,255,255],[119,249,253],[102,255,249]])assert.ok(cyan(c));
  for(const c of [[168,0,118],[152,30,116]])assert.ok(magenta(c));
  for(const c of [[16,32,48],[45,69,93],[24,27,47],[8,35,60]])assert.ok(arenaDark(c));
  for(const c of [[0,0,0],[255,255,255],[128,128,128],[255,255,0]]){assert.ok(!cyan(c));assert.ok(!magenta(c));assert.ok(!arenaDark(c));}
  assert.ok(!cyan([152,30,116]));assert.ok(!magenta([119,249,253]));assert.ok(!arenaDark([119,249,253]));
  console.log('PASS crop marker classifier: retained gamut-shifted positives; black/white/gray/yellow/wrong-region negatives');process.exit(0);
}
if (process.env.AP_RECORDING_LIVE_OPT_IN !== '1' || !process.argv.includes('--chrome') || !chromePath.startsWith('/') || !/Chrome for Testing|Chromium/.test(chromePath)) {
  console.error('Refusing live execution: require AP_RECORDING_LIVE_OPT_IN=1 and --chrome /absolute/installed/Chrome-for-Testing-or-Chromium (no branded user Chrome).'); process.exit(2);
}
assert.equal(process.env.HOME,userInfo().homedir,'browser HOME must equal the OS account home; never a disposable host HOME');
const expectedHead = process.env.AP_RECORDING_LIVE_EXPECTED_HEAD || '0e2cf1206b53ff6ed8c2ae00e1b0f708fb71a728';
const report = { schema_version: 1, status: 'blocked', real_mv3_native_chain: false, fake_transport: false, artifacts: [], scenarios: [], commands: [], started_at: new Date().toISOString() };
const diagnostic = process.argv.includes('--diagnostic'), reproTwo = process.argv.includes('--repro-two');
// Exactly one capture, not a substitute for complete repaired-HEAD acceptance.
const fidelityDiagnostic=process.argv.includes('--fidelity-diagnostic'),markDiagnostic=process.argv.includes('--mark-diagnostic');
if(fidelityDiagnostic||markDiagnostic)report.diagnostic_only=true;
let activeHandle, interrupted, workerSession, currentScenarioName;
let root, out, chrome, cdp, server, privateEnv, credentialError, hostPid, fixtureTab, hardTimer, browserLog='';
const children = new Set();
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{interrupted='received '+signal;for(const child of children)child.kill('SIGTERM');});
async function command(file, args, options = {}) {
  let stdout = '', stderr = '', code = 0;
  try { ({stdout, stderr} = await exec(file, args, {cwd: out || repo, timeout: 45000, maxBuffer: 24 * 1024 * 1024, ...options})); }
  catch(e) { stdout = e.stdout || ''; stderr = e.stderr || ''; code = e.code || e.signal || 1; }
  return {file, args, exit_code: code, stdout, stderr};
}
async function cli(args, expected = 0) {
  assert.ok(!credentialError&&!interrupted, credentialError||interrupted);
  const start=performance.now();const result = await command(join(repo, 'target/debug/ap-browser'), args, {env: privateEnv});result.started_mono_ms=start;result.elapsed_ms=performance.now()-start; report.commands.push(result);
  if(result.exit_code!==expected&&activeHandle){
    // Preserve latest bounded genuine producer images before waiting/decoding/export.
    const slot=workerSession?await cdp.call('Runtime.evaluate',{expression:'(()=>{const o=globalThis.__recordingFidelityObserver;return o?.slot})()',returnByValue:true},workerSession).catch(()=>null):null;
    if(slot?.result?.value){const dir=join(out,'failure-producer-raw');await mkdir(dir);report.failure_producer_raw=[];for(const [i,f] of slot.result.value.latest.entries()){const b=Buffer.from(f.data,'base64');assert.ok(b.length<=4194304);const path=join(dir,'producer-'+i+'.jpg');await writeFile(path,b);report.failure_producer_raw.push({path,sha256:hash(b),event_ordinal:f.event_ordinal,received_sw_mono_ms:f.received_sw_mono_ms,metadata:f.metadata});}}
    const deadline=Date.now()+12000;report.failure_settlement=[];
    while(Date.now()<deadline&&report.failure_settlement.length<40){const s=await command(join(repo,'target/debug/ap-browser'),['--timeout','1','record','status',activeHandle],{env:privateEnv,timeout:1500});report.failure_settlement.push(s);report.failure_status=s;let state;try{state=JSON.parse(s.stdout).data.status.state;}catch{}if(state==='sealed'||state==='failed')break;await sleep(250);}
    report.failure_manifest=await hostRead('record.manifest',activeHandle).catch(e=>({error:e.message}));
    if(workerSession)try{await collectProducer(workerSession,report.failure_manifest.result?.data,null,'failure-'+currentScenarioName);}catch(e){report.failure_producer_collection_error=e.message;}
    report.failure_page_state=await command(join(repo,'target/debug/ap-browser'),['--tab',String(fixtureTab),'eval','fixtureState()'],{env:privateEnv});
    report.failure_targets=await cdp.call('Target.getTargets').catch(e=>({error:e.message}));
    const partial=join(out,'RED explicit partial.mp4');report.failure_partial_export=await command(join(repo,'target/debug/ap-browser'),['record','export',activeHandle,'--partial','--metadata','--out',partial],{env:privateEnv});
    if(report.failure_partial_export.exit_code===0)report.red_partial_artifact={path:partial,sha256:hash(await readFile(partial))};
  }
  assert.equal(result.exit_code, expected, JSON.stringify(result)); return JSON.parse(result.stdout);
}
async function waitFor(fn, ms = 10000) { const end=Date.now()+ms; while(Date.now()<end){assert.ok(!interrupted&&!credentialError,interrupted||credentialError);const v=await fn();if(v)return v;await sleep(100);} throw Error('bounded live wait timed out'); }
async function stop(child) { if (!child || child.exitCode !== null || child.signalCode !== null) return; child.kill('SIGTERM'); for(let i=0;i<30 && child.exitCode===null && child.signalCode===null;i++)await sleep(100);if(child.exitCode===null && child.signalCode===null)child.kill('SIGKILL'); }
class CDP {
  constructor(url) { this.ws = new WebSocket(url); this.seq=0;this.pending=new Map();this.events=[];this.ws.onmessage=({data})=>{const v=JSON.parse(data);if(v.id){const p=this.pending.get(v.id);if(p){clearTimeout(p.timer);this.pending.delete(v.id);v.error?p.reject(Error(JSON.stringify(v.error))):p.resolve(v.result);}}else this.events.push(v);}; }
  async open(){await new Promise((r,j)=>{this.ws.onopen=r;this.ws.onerror=j;});}
  call(method, params={}, sessionId){return new Promise((resolve,reject)=>{const id=++this.seq;const timer=setTimeout(()=>{this.pending.delete(id);reject(Error('CDP timeout '+method));},7000);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});}
  close(){this.ws.close();}
}
async function inventory(dir, prefix='') {let result=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=join(prefix,e.name);if(e.isDirectory())result.push(...await inventory(join(dir,e.name),p));else result.push({path:p,sha256:hash(await readFile(join(dir,e.name)))});}return result.sort((a,b)=>a.path.localeCompare(b.path));}
async function hostRead(method,handle){
  assert.equal(method,'record.manifest');const [instance,host_epoch,record_id]=handle.split(':');const socket=createConnection(join(privateEnv.TMPDIR,`ap-browser-${instance}.sock`));
  try{return await new Promise((resolve,reject)=>{let bytes=Buffer.alloc(0);socket.setTimeout(5000,()=>reject(Error('read-only manifest timeout')));socket.on('error',reject);socket.on('connect',()=>{const p=Buffer.from(JSON.stringify({method,params:{identity:{host_epoch,record_id}}})),h=Buffer.alloc(4);h.writeUInt32LE(p.length);socket.write(Buffer.concat([h,p]));});socket.on('data',b=>{bytes=Buffer.concat([bytes,b]);if(bytes.length>=4){const n=bytes.readUInt32LE(0);if(n>4*1024*1024)return reject(Error('diagnostic response bound'));if(bytes.length>=n+4)resolve(JSON.parse(bytes.subarray(4,n+4)));}});});}finally{socket.destroy();}
}
async function processFacts(){const r=await command('ps',['-axo','pid=,ppid=,command=']);return r.stdout.split('\n').filter(l=>l.includes(root)||l.includes(join(repo,'target/debug/ap-browser-host'))).join('\n');}
async function sourceState(){return (await cli(['--tab',String(fixtureTab),'eval','fixtureState()'])).data.result;}
async function action(target){return cli(['--tab',String(fixtureTab),'click',target]);}
async function probeVideo(path) {
  const r = await command('ffprobe',['-v','error','-show_streams','-show_format','-show_frames','-of','json',path]);assert.equal(r.exit_code,0,r.stderr);return JSON.parse(r.stdout);
}
async function validate(path, opts={}) {
  const p=await probeVideo(path), streams=p.streams, frames=p.frames.filter(f=>f.media_type==='video');
  assert.equal(streams.length,1);assert.equal(streams[0].codec_type,'video');
  const gif=path.endsWith('.gif');assert.equal(streams[0].codec_name,gif?'gif':'h264');if(!gif){assert.equal(streams[0].pix_fmt,'yuv420p');assert.equal(streams[0].width%2,0);assert.equal(streams[0].height%2,0);}
  const stem=path.replace(/\.[^.]+$/,''), metaPath=stem+'.metadata.json', timelinePath=stem+'.timeline.jsonl';
  const m=JSON.parse(await readFile(metaPath)), timelineBytes=await readFile(timelinePath), rows=timelineBytes.toString().trim().split('\n').map(JSON.parse);
  assert.equal(m.video.sha256,hash(await readFile(path)));assert.equal(m.timeline.sha256,hash(timelineBytes));
  assert.equal(m.width,streams[0].width);assert.equal(m.height,streams[0].height);assert.equal(frames.length,rows.length);
  const quantum=gif?10:1000*Number(streams[0].time_base.split('/')[0])/Number(streams[0].time_base.split('/')[1]);
  const duration=Number(p.format.duration)*1000;assert.ok(Math.abs(duration-m.duration_ms)<=quantum+2,`duration ${duration} != ${m.duration_ms}`);
  const pts=frames.map(f=>Number(f.best_effort_timestamp_time)*1000);assert.equal(pts[0],0);for(let i=1;i<pts.length;i++)assert.ok(pts[i]>pts[i-1]);
  for(let i=0;i<pts.length;i++)assert.ok(Math.abs(pts[i]-rows[i].pts_ms)<=quantum+2);
  if(opts.dimensions)assert.deepEqual([m.width,m.height],opts.dimensions);
  const manifest=m.source_manifest_json?JSON.parse(m.source_manifest_json):null;
  if(manifest){assert.equal(m.partial,false);assert.ok(manifest.frames.length>3,'real observed motion frames required');assert.ok(manifest.end.duration_ms>5000);if(opts.events){assert.ok(manifest.events.length>=2);assert.ok(rows.some(r=>r.phase==='运动阶段'));assert.ok(rows.some(r=>r.marks.includes('STEP +1')));}}
  if(opts.fps)assert.ok(frames.length<=Math.ceil(m.duration_ms/1000*opts.fps)+1);
  const checks={path,sha256:hash(await readFile(path)),bytes:(await readFile(path)).length,codec:streams[0].codec_name,width:m.width,height:m.height,duration_ms:duration,presentation_frames:frames.length,pts_monotonic:true,no_audio:true,metadata_path:metaPath,timeline_path:timelinePath,source_observations:manifest?.frames.length,source_identity:m.identity};
  report.artifacts.push(checks);
  await writeFile(stem+'.ffprobe.json',JSON.stringify(p,null,2));
  return {m,manifest,rows,checks};
}
async function frameRGB(path,t=0){const r=await command('ffmpeg',['-v','error',...(t===0?[]:['-ss',String(t)]),'-i',path,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{encoding:'buffer'});assert.equal(r.exit_code,0);return r.stdout;}
function pixel(b,w,x,y){return [...b.subarray((y*w+x)*3,(y*w+x)*3+3)];}
async function finalRendered(path,v,expected){
  const result=await inspectRenderedTail(path,{width:v.m.width,height:v.m.height,crop:v.manifest.frames[0].geometry.crop_css,duration_ms:v.m.duration_ms},expected);
  v.checks.final_rendered_state=result;await writeFile(path.replace(/\.[^.]+$/,'')+'.rendered-state.json',JSON.stringify(result,null,2));return result;
}
// Optional read-only genuine chrome.debugger event observer. No ACK, sendCommand,
// controller calls, rendering or transport injection. At most two <=4MiB JPEGs.
function observerInstall(tabId){
  const slot={received:0,rejected:0,latest:[]};
  const listener=(source,method,p)=>{if(source.tabId!==tabId||method!=='Page.screencastFrame')return;slot.received++;
    const data=p?.data;if(typeof data!=='string'||data.length>5592408||data.length%4!==0){slot.rejected++;return;}
    const bytes=data.length/4*3-(data.endsWith('==')?2:data.endsWith('=')?1:0);if(bytes>4194304){slot.rejected++;return;}
    const metadata={};for(const k of ['timestamp','deviceWidth','deviceHeight','offsetTop','pageScaleFactor','scrollOffsetX','scrollOffsetY'])if(Number.isFinite(p.metadata?.[k]))metadata[k]=p.metadata[k];
    // Evict before retaining the next genuine image; no accumulating frame log.
    if(slot.latest.length===2)slot.latest.shift();slot.latest.push({event_ordinal:slot.received,received_sw_mono_ms:performance.now(),metadata,data});};
  globalThis.__recordingFidelityObserver={slot,listener};chrome.debugger.onEvent.addListener(listener);return {installed:true,max_images:2,max_jpeg_bytes:4194304};
}
async function collectProducer(swSession,manifest,expected,name='diagnostic'){
  const expression='(()=>{const o=globalThis.__recordingFidelityObserver;chrome.debugger.onEvent.removeListener(o.listener);delete globalThis.__recordingFidelityObserver;return o.slot})()';
  const r=await cdp.call('Runtime.evaluate',{expression,returnByValue:true},swSession);assert.ok(!r.exceptionDetails);const slot=r.result.value;
  const evidence=join(out,'source-'+name);await mkdir(evidence,{mode:0o700});
  const result={diagnostic_only:true,provenance:'read-only chrome.debugger.onEvent Page.screencastFrame in actual SW; observer never ACKs',received:slot.received,rejected:slot.rejected,expected,producer:[],stored:[],manifest_drops:manifest?.end.drops,manifest_end:manifest?.end};
  async function image(bytes,label,facts){
    assert.ok(bytes.length<=4194304);const path=join(evidence,label+'.jpg');await writeFile(path,bytes);
    const probe=await probeVideo(path),width=probe.streams[0].width,height=probe.streams[0].height;
    let decoded,error;try{decoded=decodeState(await frameRGB(path,0),{width,height,crop:{x:0,y:0,width,height}});}catch(e){error=e.message;}
    return {...facts,path,sha256:hash(bytes),bytes:bytes.length,width,height,decoded,error};
  }
  for(const [i,f] of slot.latest.entries()){const bytes=Buffer.from(f.data,'base64');result.producer.push(await image(bytes,'producer-'+(i+1),{event_ordinal:f.event_ordinal,received_sw_mono_ms:f.received_sw_mono_ms,metadata:f.metadata,stored_seq:manifest?.frames.find(s=>s.sha256===hash(bytes))?.seq??null}));}
  if(manifest?.frames.length){const spool=join(privateEnv.TMPDIR,'ap-browser-recordings-'+process.getuid(),manifest.identity.host_epoch,manifest.identity.record_id,'frames');
  const file=await open(spool,'r');try{for(const f of manifest.frames.slice(-2)){assert.ok(f.length>0&&f.length<=4194304);const bytes=Buffer.alloc(f.length);const read=await file.read(bytes,0,f.length,f.offset);assert.equal(read.bytesRead,f.length);assert.equal(hash(bytes),f.sha256);result.stored.push(await image(bytes,'stored-'+f.seq,{seq:f.seq,t_ms:f.t_ms,cdp_timestamp_s:f.cdp_timestamp_s}));}}finally{await file.close();}
  result.first_source=manifest.frames[0];result.last_source=manifest.frames.at(-1);}
  await writeFile(join(evidence,'producer-vs-stored.json'),JSON.stringify(result,null,2));(report.producer_vs_stored??=[]).push({name,...result});return result;
}
// Read only genuine latest JPEGs. Never ACK, request a screenshot or repaint.
async function waitProducerState(swSession,expected){
  const deadline=Date.now()+2500;let seen=0;
  while(Date.now()<deadline){
    const r=await cdp.call('Runtime.evaluate',{expression:'globalThis.__recordingFidelityObserver.slot.latest.at(-1)',returnByValue:true},swSession);assert.ok(!r.exceptionDetails);const f=r.result.value;
    if(f&&f.event_ordinal!==seen){seen=f.event_ordinal;const bytes=Buffer.from(f.data,'base64');assert.ok(bytes.length<=4194304);const path=join(out,'.pending-observation.jpg');await writeFile(path,bytes);
      try{const state=decodeState(await frameRGB(path),{width:f.metadata.deviceWidth,height:f.metadata.deviceHeight,crop:{x:0,y:0,width:f.metadata.deviceWidth,height:f.metadata.deviceHeight}});
        if(state.score===expected.score&&state.mode===expected.mode)return {event_ordinal:f.event_ordinal,received_sw_mono_ms:f.received_sw_mono_ms,metadata:f.metadata,sha256:hash(bytes),jpeg_bytes:bytes.length,decoded:state};
      }finally{await rm(path,{force:true});}
    }await sleep(10);
  }throw Error('bounded wait for genuine producer state timed out');
}
function spoolPath(handle){const [,epoch,id]=handle.split(':');return join(privateEnv.TMPDIR,'ap-browser-recordings-'+process.getuid(),epoch,id,'frames');}
async function waitDurableProducer(handle,producer){
  const deadline=Date.now()+2000;
  while(Date.now()<deadline){const status=(await cli(['record','status',handle])).data.status;
    if(status.spool_bytes>=producer.jpeg_bytes){const file=await open(spoolPath(handle),'r');try{const b=Buffer.alloc(producer.jpeg_bytes),r=await file.read(b,0,b.length,status.spool_bytes-b.length);if(r.bytesRead===b.length&&hash(b)===producer.sha256){
      const path=join(out,'pending-baseline-stored.jpg');await writeFile(path,b);
      const probe=await probeVideo(path),width=probe.streams[0].width,height=probe.streams[0].height;
      const decoded=decodeState(await frameRGB(path),{width,height,crop:{x:0,y:0,width,height}});assert.deepEqual(decoded,{score:2,mode:'HOLD'},'actual durable baseline pixels must show SCORE2, not merely a new seq');
      return {...status,baseline_image:{path,sha256:hash(b),bytes:b.length,width,height,decoded}};
    }}finally{await file.close();}}
    await sleep(20);
  }throw Error('actual durable source never matched the observed SCORE2 JPEG');
}
async function verifyMotion(path,w,h){const a=await frameRGB(path,.45),b=await frameRGB(path,1.4),c=await frameRGB(path,4.9),d=await frameRGB(path,5.5);let motion=0,hold=0;for(let i=0;i<a.length;i++){motion+=Math.abs(a[i]-b[i]);hold+=Math.abs(c[i]-d[i]);}motion/=w*h*3;hold/=w*h*3;assert.ok(motion>1,'meaningful motion absent');assert.ok(hold<.25,'static hold changed');return {motion_mean_abs_rgb:motion,static_hold_mean_abs_rgb:hold};}
try {
  await access(chromePath);await mkdir(evidenceRoot,{recursive:true});out=await mkdtemp(join(evidenceRoot,'live-'));out=await realpath(out);
  root=await realpath(await mkdtemp('/tmp/aplive-'));await chmod(root,0o700);
  report.evidence_dir=out;report.owned_root=root;report.code_head=(await command('git',['rev-parse','HEAD'],{cwd:repo})).stdout.trim();assert.equal(report.code_head,expectedHead);
  report.browser_version=(await command(chromePath,['--version'])).stdout.trim();report.browser_executable=chromePath;report.browser_executable_sha256=hash(await readFile(chromePath));
  const sourceClean=await command('git',['diff','--exit-code','HEAD','--','extension','core','host','cli','bridge','Cargo.toml','Cargo.lock'],{cwd:repo});report.functional_source_diff=sourceClean;assert.equal(sourceClean.exit_code,0,'refusing dirty functional source');
  const build=await command('cargo',['build','--locked','--offline','-p','ap-browser','-p','ap-browser-host','-p','ap-browser-bridge'],{cwd:repo});report.build=build;assert.equal(build.exit_code,0);
  for(const name of ['ap-browser','ap-browser-host','ap-browser-bridge'])report[name+'_sha256']=hash(await readFile(join(repo,'target/debug',name)));
  report.harness_sha256=hash(await readFile(fileURLToPath(import.meta.url)));
  const nativeSource=join(repo,'target/debug/ap-browser-host'),nativeStaged=join(root,'ap-browser-host');
  report.staging_helper_sha256=hash(await readFile(join(repo,'tests/recording-live-stage-host.py')));
  report.native_staging_command=await command('python3',[join(repo,'tests/recording-live-stage-host.py'),'--source',nativeSource,'--destination',nativeStaged,'--owned-root',root,'--expected-sha256','241de34687d035da9af3c9ace5426409955b9b78c5f04cbc04c6e430e622ded2'],{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
  try{report.native_staging=JSON.parse(report.native_staging_command.stdout);}catch{}
  assert.equal(report.native_staging_command.exit_code,0,'metadata-preserving staging failed; no bypass/launch');assert.equal(report.native_staging?.status,'pass');
  // Copy functional bytes exactly, then make only authorized identity substitutions.
  const ext=join(root,'extension'),profile=join(root,'profile'),home=join(root,'host-home'),tmp=join(root,'host-tmp');
  await cp(join(repo,'extension'),ext,{recursive:true});for(const p of [profile,home,tmp,join(profile,'NativeMessagingHosts')])await mkdir(p,{recursive:true,mode:0o700});
  const unique=('com.apbrowser.live_'+basename(root).replaceAll('-','_')).toLowerCase();assert.match(unique,/^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/);
  const background=await readFile(join(ext,'background.js'),'utf8');assert.equal(background.split('const NATIVE_HOST_NAME = "com.apbrowser.connect";').length,2);
  await writeFile(join(ext,'background.js'),background.replace('const NATIVE_HOST_NAME = "com.apbrowser.connect";',`const NATIVE_HOST_NAME = "${unique}";`));
  const publicKey=generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({type:'spki',format:'der'});const key=publicKey.toString('base64');
  const manifestSource=await readFile(join(ext,'manifest.json'),'utf8');await writeFile(join(ext,'manifest.json'),manifestSource.replace('{','{\n\t"key": '+JSON.stringify(key)+','));
  const extensionId=hash(publicKey).slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
  report.extension={id:extensionId,native_host_name:unique,source:await inventory(join(repo,'extension')),staged:await inventory(ext),delta:['background.js: unique NATIVE_HOST_NAME literal only','manifest.json: generated public test key insertion only'],test_public_key:key};
  assert.equal((await readFile(join(ext,'background.js'),'utf8')).replace(unique,'com.apbrowser.connect'),background);
  const normalized=JSON.parse(await readFile(join(ext,'manifest.json')));delete normalized.key;assert.deepEqual(normalized,JSON.parse(manifestSource));
  const changed=report.extension.staged.filter(e=>report.extension.source.find(s=>s.path===e.path)?.sha256!==e.sha256).map(e=>e.path);assert.deepEqual(changed.sort(),['background.js','manifest.json']);
  const wrapper=join(root,'native-wrapper.sh');
  const q=s=>"'"+s.replaceAll("'","'\\''")+"'";
  await writeFile(wrapper,`#!/bin/sh\n# Chrome alone spawns this; do not change the browser HOME.\nexport HOME=${q(home)} TMPDIR=${q(tmp)} RUST_LOG=info\nunset AP_BROWSER_REMOTE AP_BROWSER_INSTANCE\nprintf '%s\\n' "$$ $PPID" > ${q(join(root,'host-pid'))}\nexec ${q(nativeStaged)} "$@" 2>>${q(join(out,'native.log'))}\n`,{mode:0o700});
  const nativeManifest={name:unique,description:'Disposable recording acceptance only',path:wrapper,type:'stdio',allowed_origins:[`chrome-extension://${extensionId}/`]};
  const nativePath=join(profile,'NativeMessagingHosts',unique+'.json');await writeFile(nativePath,JSON.stringify(nativeManifest));
  report.native={manifest_path:nativePath,manifest:nativeManifest,manifest_sha256:hash(await readFile(nativePath)),wrapper:await readFile(wrapper,'utf8'),wrapper_sha256:hash(await readFile(wrapper)),binary:nativeStaged,original_binary:nativeSource};
  assert.equal(await realpath(wrapper),wrapper);assert.ok(report.native.wrapper.startsWith('#!/bin/sh\n'));assert.ok((await stat(wrapper)).mode&0o100);assert.ok((await stat(report.native.binary)).mode&0o100);assert.ok(nativePath.startsWith(profile+'/NativeMessagingHosts/'));
  report.native.prelaunch_stat={wrapper_mode:(await stat(wrapper)).mode,manifest_mode:(await stat(nativePath)).mode,binary_mode:(await stat(report.native.binary)).mode};
  privateEnv={...process.env,HOME:home,TMPDIR:tmp};delete privateEnv.AP_BROWSER_REMOTE;delete privateEnv.AP_BROWSER_INSTANCE;
  const html=await readFile(join(repo,'tests/recording-live-fixture.html'));report.fixture_sha256=hash(html);
  server=createServer((req,res)=>{if(req.url!=='/fixture'){res.writeHead(404);res.end();return;}res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'"});res.end(html);});await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const url=`http://127.0.0.1:${server.address().port}/fixture`;
  const args=[`--user-data-dir=${profile}`,'--use-mock-keychain','--password-store=basic','--disable-sync','--disable-background-networking','--disable-component-update','--disable-domain-reliability','--no-first-run','--no-default-browser-check','--disable-default-apps','--disable-features=MediaRouter,OptimizationHints','--metrics-recording-only','--no-pings','--force-device-scale-factor=1','--window-size=1000,800','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',`--disable-extensions-except=${ext}`,`--load-extension=${ext}`,url];
  report.browser_launch={args,HOME:process.env.HOME,host_HOME:home,host_TMPDIR:tmp,headed:true,started_mono_ms:performance.now()};
  chrome=spawn(chromePath,args,{env:{...process.env},stdio:['ignore','ignore','pipe']});children.add(chrome);report.browser_pid=chrome.pid;
  chrome.stderr.on('data',b=>{const s=b.toString();browserLog+=s;if(/keychain.*(?:not found|error|failed)|(?:password|credential).*dialog/i.test(s)){credentialError='credential/keychain problem in owned browser stderr';chrome.kill('SIGTERM');}});
  hardTimer=setTimeout(()=>{interrupted='live hard deadline';for(const ch of children)ch.kill('SIGTERM');},diagnostic?30000:fidelityDiagnostic?60000:240000);
  const devtools=await waitFor(async()=>{try{return (await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n');}catch{return null;}});
  cdp=new CDP(`ws://127.0.0.1:${devtools[0]}${devtools[1]}`);await cdp.open();report.cdp_version=await cdp.call('Browser.getVersion');
  const sw=await waitFor(async()=>{const {targetInfos}=await cdp.call('Target.getTargets');return targetInfos.find(t=>t.type==='service_worker'&&t.url===`chrome-extension://${extensionId}/background.js`);});
  report.service_worker={target_id:sw.targetId,url:sw.url};
  const swSession=(await cdp.call('Target.attachToTarget',{targetId:sw.targetId,flatten:true})).sessionId;workerSession=swSession;
  await cdp.call('Runtime.enable',{},swSession);
  if(diagnostic){
    // Read existing console/error events only; do not inject any transport or call the controller.
    await sleep(6000);report.diagnostic_only=true;report.sw_diagnostics=cdp.events.filter(e=>e.method.startsWith('Runtime.')||e.method.startsWith('Log.')).slice(-100);
    report.diagnostic_processes=await processFacts();report.diagnostic_host_spawned=await readFile(join(root,'host-pid'),'utf8').catch(()=>null);if(report.diagnostic_host_spawned)hostPid=Number(report.diagnostic_host_spawned.split(' ')[0]);
    throw Error('diagnostic-only stop; native lookup outcome retained for supervisor decision');
  }
  await cdp.call('Tracing.start',{categories:'blink.user_timing,devtools.timeline,blink.console',transferMode:'ReportEvents'});
  const traceMark='owned-live-sw-identity-'+basename(root);await cdp.call('Runtime.evaluate',{expression:`performance.mark(${JSON.stringify(traceMark)})`},swSession);await sleep(100);await cdp.call('Tracing.end');
  await waitFor(()=>cdp.events.some(e=>e.method==='Tracing.tracingComplete'));
  const marks=cdp.events.filter(e=>e.method==='Tracing.dataCollected').flatMap(e=>e.params.value).filter(e=>e.name===traceMark);assert.ok(marks.length);report.service_worker.trace_identity=marks;report.service_worker.pid=marks[0].pid;
  // Keep this owned SW session only for bounded read-only producer diagnostics.
  const hostPidLine=await waitFor(async()=>{try{return await readFile(join(root,'host-pid'),'utf8');}catch{return null;}});[hostPid]=hostPidLine.trim().split(' ').map(Number);report.native.pid_observed_elapsed_ms=performance.now()-report.browser_launch.started_mono_ms;report.native.pid=hostPid;report.native.launch_parent_pid=Number(hostPidLine.trim().split(' ')[1]);
  report.processes=await processFacts();report.browser_processes=await cdp.call('SystemInfo.getProcessInfo');assert.ok(report.processes.includes(String(hostPid))&&report.processes.includes('ap-browser-host'));
  report.native.process_identity=(await command('ps',['-p',String(hostPid),'-o','pid=,ppid=,comm=,args='])).stdout;
  assert.ok(report.native.process_identity.includes(`chrome-extension://${extensionId}/`));assert.ok(report.native.process_identity.includes(nativeStaged),'Chrome must exec exact staged binary');
  report.native.exec_observed_elapsed_ms=performance.now()-report.browser_launch.started_mono_ms;
  report.native_readiness=await waitNativeReady({observe:async()=>{
    assert.ok(!interrupted&&!credentialError,interrupted||credentialError);
    const sockets=(await readdir(tmp)).filter(n=>/^ap-browser-[A-Za-z0-9_-]+\.sock$/.test(n));assert.ok(sockets.length<=1,'ambiguous owned native instances');if(!sockets.length)return null;
    const socket=join(tmp,sockets[0]),instance=sockets[0].slice(11,-5);if(!(await stat(socket)).isSocket())return null;
    const log=await readFile(join(home,'.ap-browser','host.log'),'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e;});
    const hellos=[...log.matchAll(/hello: instance_id=([A-Za-z0-9_-]+)/g)].map(m=>m[1]);if(!hellos.length||!log.includes('listening on '+socket))return null;
    assert.equal(hellos.at(-1),instance);assert.ok(log.includes('spawned by chrome-extension://'+extensionId+'/'));
    return {instance,socket,hello_instance:hellos.at(-1),staged_origin:`chrome-extension://${extensionId}/`,observed_elapsed_since_browser_ms:performance.now()-report.browser_launch.started_mono_ms};
  },ping:async(native,remaining)=>{
    const args=['--profile',native.instance,'--timeout',String(Math.max(1,Math.floor(remaining/1000))),'--wait-online','0','ping'],start=performance.now();
    const call=await command(join(repo,'target/debug/ap-browser'),args,{env:privateEnv,timeout:Math.max(1,Math.floor(remaining))});call.started_mono_ms=start;call.elapsed_ms=performance.now()-start;report.commands.push(call);report.readiness_ping=call;
    assert.equal(call.exit_code,0,JSON.stringify(call));const response=JSON.parse(call.stdout);assert.equal(response.ok,true);assert.equal(response.data.pong,true);assert.equal(response.meta.profile.instance_id,native.instance);return response;
  }});
  report.native.instance_id=report.native_readiness.native.instance;
  const profiles=await cli(['profiles']);report.profiles=profiles;
  const tabs=await cli(['tabs','list']);report.tabs=tabs;
  // Isolated socket discovery contains exactly this test instance, not user IPC.
  const sockets=(await readdir(tmp)).filter(n=>n.startsWith('ap-browser-')&&n.endsWith('.sock'));assert.equal(sockets.length,1);report.native.instance_id=sockets[0].slice(11,-5);
  assert.equal(tabs.data.profiles.length,1);const tabList=tabs.data.profiles[0].tabs;assert.ok(Array.isArray(tabList));fixtureTab=tabList.find(t=>t.url===url)?.id;assert.ok(fixtureTab);
  report.fixture_initial=await sourceState();assert.equal(report.fixture_initial.scrollY,0);
  report.real_mv3_native_chain=true;
  const expression=`(${observerInstall.toString()})(${fixtureTab})`;report.observer={install_expression_sha256:hash(expression),install_expression:expression,max_images:2};
  // Recording controls remain public CLI only; observer copies real events without effects.
  const font='/System/Library/Fonts/STHeiti Medium.ttc';await access(font);report.font={path:font,sha256:hash(await readFile(font))};
  const paths={clean:join(out,'full clean.mp4'),region:join(out,'区域 task.mp4'),element:join(out,'element clean.mp4'),gif:join(out,'元素 low fps.gif'),mov:join(out,'元素 task.mov'),offline:join(out,'offline 自定义.mov')};
  const scenarios=[{name:'viewport',select:[],path:paths.clean},{name:'region',select:['--region','80,100,640,360'],path:paths.region},{name:'element',select:['--element','#arena'],path:paths.element},{name:'sparse-source',captureFps:2,select:['--region','80,100,640,360'],path:join(out,'sparse source task.mp4')},{name:'sparse-stop',captureFps:1,pendingStop:true,select:['--region','80,100,640,360'],path:join(out,'pending stop source task.mp4')}];
  for(const scenario of (markDiagnostic?[scenarios[0]]:fidelityDiagnostic?[scenarios[3]]:scenarios.slice(0,reproTwo?2:5))){
    const intendedFinal={score:4,mode:'HOLD'};currentScenarioName=scenario.name;
    if(markDiagnostic){
      await cdp.call('Debugger.enable',{},swSession);
      const lines=(await readFile(join(repo,'extension/recording.mjs'),'utf8')).split('\n'),lineNumber=lines.findIndex(l=>l.includes('if (!equal(r, value)) throw'));
      assert.ok(lineNumber>0);const condition='console.info("LIVE_EVENT_ECHO",JSON.stringify({identity:s.identity,request:value,response:r,request_t_ms_lexeme:JSON.stringify(value.t_ms),response_t_ms_lexeme:JSON.stringify(r?.t_ms)})),false';
      const point=await cdp.call('Debugger.setBreakpointByUrl',{url:`chrome-extension://${extensionId}/recording.mjs`,lineNumber,condition},swSession);
      report.event_echo_logpoint={lineNumber,condition,condition_sha256:hash(condition),result:point,lexeme_limit:'JSON.stringify of original JS request and JS-parsed native reply; not raw Rust-wire numeric lexemes'};
    }
    const installed=await cdp.call('Runtime.evaluate',{expression,returnByValue:true},swSession);assert.ok(!installed.exceptionDetails);assert.equal(installed.result.value.installed,true);
    const started=await cli(['--tab',String(fixtureTab),'record','start','--max-duration','15s','--capture-fps',String(scenario.captureFps??12),'--label','project=竞技','--label','build='+report.code_head.slice(0,8),'--label','run=LIVE','--label','attempt='+scenario.name,'--run-id','live-01',...scenario.select]);const handle=started.data.handle;activeHandle=handle;assert.ok(handle);
    const startCall=report.commands.at(-1);assert.ok(startCall.elapsed_ms>=200,'start must include actual measured preparation');
    const epoch=handle.split(':')[1];report.native.host_epoch??=epoch;assert.equal(epoch,report.native.host_epoch);
    await cli(['record','phase',handle,'--text','运动阶段']);await action('#start');await sleep(1000);await cli(['record','mark',handle,'--text','STEP +1','--duration','1s']);await action('#step');await sleep(2700);
    const status=await cli(['record','status',handle]);assert.equal(status.data.status.state,'recording');
    // Late actual state-change burst, then silence. Never repaint after the burst
    // to rescue a missing source event; CLI state is corroboration, NOT the oracle.
    let pendingProof,during;
    if(scenario.pendingStop){
      await sleep(1800);await action('#step');
      const prior=await waitProducerState(swSession,{score:2,mode:'HOLD'}),durable=await waitDurableProducer(handle,prior);
      await action('#step');await action('#step');const final=await waitProducerState(swSession,intendedFinal);
      const beforeStop=(await cli(['record','status',handle])).data.status;
      pendingProof={prior_producer:prior,prior_durable:durable,final_producer:final,before_stop:beforeStop};
    }else{for(let i=0;i<3;i++)await action('#step');during=await sourceState();assert.equal(during.score,intendedFinal.score);assert.equal(during.mode,intendedFinal.mode);await sleep(2100);}
    const stopped=await cli(['record','stop',handle]);assert.equal(stopped.data.status.state,'sealed');
    if(!during)during=await sourceState();assert.equal(during.score,4);assert.equal(during.mode,'HOLD');
    const terminal=(await hostRead('record.manifest',handle)).result.data;
    await collectProducer(swSession,terminal,intendedFinal,scenario.name);
    if(pendingProof){
      const prior=terminal.frames.find(f=>f.seq===pendingProof.prior_durable.persisted_seq),last=terminal.frames.at(-1);
      pendingProof.prior_source=prior;pendingProof.final_source=last;pendingProof.end=terminal.end;
      pendingProof.margin_ms=prior.t_ms+1000-terminal.end.duration_ms;
      pendingProof.proven=prior.sha256===pendingProof.prior_durable.baseline_image.sha256&&pendingProof.prior_durable.baseline_image.decoded.score===2&&pendingProof.prior_durable.baseline_image.decoded.mode==='HOLD'&&prior.sha256===pendingProof.prior_producer.sha256&&last.sha256===pendingProof.final_producer.sha256&&pendingProof.before_stop.persisted_seq===prior.seq&&last.seq===prior.seq+1&&last.t_ms<=terminal.end.duration_ms&&pendingProof.margin_ms>=100;
      pendingProof.clock_note='Only actual manifest t_ms/end.duration_ms used for fps margin; observer SW clock/raw CDP/Node timestamps not subtracted.';
      report.pending_stop_proof=pendingProof;
    }
    const task=['region','sparse-source','sparse-stop'].includes(scenario.name)?['--watermark','task','--font',font]:[];
    await cli(['record','export',handle,'--fps','8','--size','1280','--metadata',...task,'--out',scenario.path]);
    const v=await validate(scenario.path,{events:true});assert.equal(v.manifest.config.capture_fps,scenario.captureFps??12,'verify sparse SOURCE fps, not just low export fps');
    const expected=scenario.name==='viewport'?[Math.ceil(during.viewport.width/2)*2,Math.ceil(during.viewport.height/2)*2]:[640,360+(['region','sparse-source','sparse-stop'].includes(scenario.name)?64:0)];assert.deepEqual([v.m.width,v.m.height],expected);
    const rgb=await frameRGB(scenario.path,.5);const w=v.m.width;
    const markerPixels=scenario.name==='viewport'?{outside:pixel(rgb,w,10,200),cyan:pixel(rgb,w,82,110)}:{left:pixel(rgb,w,2,10),right:pixel(rgb,w,635,10),right_inner:pixel(rgb,w,630,10),inside:pixel(rgb,w,12,100)};
    if(scenario.name==='viewport'){assert.ok(magenta(markerPixels.outside));assert.ok(cyan(markerPixels.cyan));}
    else {assert.ok(cyan(markerPixels.left));assert.ok(cyan(markerPixels.right));assert.ok(arenaDark(markerPixels.right_inner));assert.ok(arenaDark(markerPixels.inside));}
    // Genuine producer/spool evidence was already saved before export/decoder gates.
    const rendered=await finalRendered(scenario.path,v,intendedFinal);
    const facts={name:scenario.name,status:rendered.pass?'pass':'fail',final_rendered_state:rendered,capture_fps:scenario.captureFps??12,handle,started:started.data,stopped:stopped.data,during,output:scenario.path,crop_pixels_verified:true,marker_pixels:markerPixels,start_elapsed_ms:startCall.elapsed_ms,stable_capture_geometry:v.manifest.frames[0].geometry};
    if(scenario.name==='viewport')facts.motion=await verifyMotion(scenario.path,w,v.m.height);
    if(scenario.name==='element'){
      const cleanHash=hash(await readFile(paths.element));
      await cli(['record','export',handle,'--preset','tiny','--fps','2','--watermark','task','--font',font,'--out',paths.gif]);const gif=await validate(paths.gif,{events:true,fps:2,dimensions:[480,334]});assert.ok((await finalRendered(paths.gif,gif,intendedFinal)).pass,'GIF final rendered state mismatch');
      await cli(['record','export',handle,'--preset','compact','--fps','4','--watermark','task','--font',font,'--out',paths.mov]);const mov=await validate(paths.mov,{events:true,fps:4,dimensions:[640,424]});assert.ok((await finalRendered(paths.mov,mov,intendedFinal)).pass,'MOV final rendered state mismatch');
      const before=hash(await readFile(paths.mov));await cli(['record','export',handle,'--out',paths.mov],1);assert.equal(hash(await readFile(paths.mov)),before);
      // Keep the custom overlay below the fixed marker rows; it must remain an
      // independent exported-text check, not cover the rendered-state oracle.
      const custom={version:1,layout:'overlay',items:[{text:{kind:'template',value:'离线 {label.project} / {pts_ms}'},anchor:'top_left',x:12,y:224,font_size:20,color:'#ffffff',background:'#000000',opacity:1,update_interval_ms:250}]};
      const config=join(out,'offline-template.json');await writeFile(config,JSON.stringify(custom));
      await cli(['record','watermark',paths.element,'--sidecar',paths.element.replace('.mp4','.metadata.json'),'--watermark-config',config,'--font',font,'--label','project=竞技','--fps','4','--out',paths.offline]);const off=await validate(paths.offline,{dimensions:[640,360],fps:4});assert.ok((await finalRendered(paths.offline,off,intendedFinal)).pass,'offline final rendered state mismatch');assert.equal(off.m.provenance,'offline_verified_sidecar');assert.equal(hash(await readFile(paths.element)),cleanHash);facts.clean_source_preserved=true;
    }
    await cli(['record','release',handle]);await cli(['record','status',handle],1);activeHandle=null;report.scenarios.push(facts);assert.ok(rendered.pass,'final RENDERED state mismatch (receipt retained; page JS state alone is insufficient)');
    if(pendingProof&&!pendingProof.proven)throw Object.assign(Error('pending-stop timing inconclusive: no early-drain claim without actual same-clock source/end proof'),{code:'INCONCLUSIVE_PENDING_STOP'});
  }
  report.final_fixture=await sourceState();assert.equal(report.final_fixture.scrollX,0);assert.equal(report.final_fixture.scrollY,0);assert.deepEqual(report.final_fixture.rect,report.fixture_initial.rect);
  report.source_layout_unchanged=true;report.processes_before_cleanup=await processFacts();report.status=(reproTwo||fidelityDiagnostic||markDiagnostic)?'blocked':'pass';if(fidelityDiagnostic)report.diagnostic_only=true;if(reproTwo)report.diagnostic_two_capture_only=true;
} catch(e) { report.status=e.code==='INCONCLUSIVE_PENDING_STOP'?'blocked':report.real_mv3_native_chain?'fail':'blocked';report.error={code:e.code,message:e.message,stack:e.stack};console.error(e.stack);
  // Preserve an owned source even when a pixel/pending-proof helper, not a CLI call, fails.
  if(activeHandle&&workerSession&&!report.failure_manifest){
    report.failure_cleanup_stop=await command(join(repo,'target/debug/ap-browser'),['--timeout','2','record','stop',activeHandle],{env:privateEnv,timeout:12000});
    report.failure_manifest=await hostRead('record.manifest',activeHandle).catch(error=>({error:error.message}));
    try{await collectProducer(workerSession,report.failure_manifest.result?.data,null,'failure-'+currentScenarioName);}catch(error){report.failure_producer_collection_error=error.message;}
  }
  if(hostPid){report.blocked_owned_pid=await command('ps',['-p',String(hostPid),'-o','pid=,ppid=,stat=,wchan=,etime=,comm=,args='],{timeout:1000});report.blocked_owned_fds=await command('/usr/sbin/lsof',['-n','-a','-p',String(hostPid),'-d','0,1,2,cwd,txt'],{timeout:1000});}
}
finally {
  clearTimeout(hardTimer);if(cdp){report.sw_console=cdp.events.filter(e=>e.method==='Runtime.consoleAPICalled'||e.method==='Runtime.exceptionThrown').slice(-100);cdp.close();}await stop(chrome);if(server)await new Promise(r=>server.close(r));
  if(hostPid){await sleep(300);try{process.kill(hostPid,0);report.cleanup_host_required_signal=true;process.kill(hostPid,'SIGTERM');await sleep(300);}catch{};try{process.kill(hostPid,0);report.host_exited=false;}catch{report.host_exited=true;}}
  report.browser_exited=!chrome||chrome.exitCode!==null||chrome.signalCode!==null;
  if(root)report.owned_processes_after_cleanup=(await command('ps',['-axo','pid=,ppid=,command='])).stdout.split('\n').filter(l=>l.includes(root));
  if(root){try{const log=await readFile(join(root,'host-home','.ap-browser','host.log')).catch(()=>null);if(log&&out){await writeFile(join(out,'host-runtime.log'),log);report.native_runtime_log=join(out,'host-runtime.log');}await rm(root,{recursive:true,force:true});report.owned_profile_removed=true;}catch(e){report.cleanup_error=e.message;}}
  if(credentialError){report.status='blocked';report.credential_problem=credentialError;}
  if(interrupted){report.status='blocked';report.interrupted=interrupted;}
  if(report.status==='pass'&&(!report.host_exited||!report.browser_exited||report.owned_processes_after_cleanup?.length))report.status='fail';
  if(report.native_staging){
    const helper=join(repo,'tests/recording-live-stage-host.py');
    report.original_native_after=await command('python3',[helper,'--snapshot',join(repo,'target/debug/ap-browser-host')],{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});
    if(report.original_native_after.exit_code===0){try{const before=report.native_staging.source_before??report.native_staging.evidence?.source_before;assert.ok(before,'initial metadata snapshot unavailable');assert.deepEqual(JSON.parse(report.original_native_after.stdout).snapshot,before);report.source_native_immutable_after_run=true;}catch(e){report.status='blocked';report.source_native_verification_error=e.message;}}
    else {report.status='blocked';report.source_native_verification_error='source metadata snapshot denied/failed';}
  }
  report.finished_at=new Date().toISOString();
  if(out){await writeFile(join(out,'browser.log'),browserLog);report.browser_log=join(out,'browser.log');await writeFile(join(out,'e2e-results.json'),JSON.stringify(report,null,2));if(!fidelityDiagnostic&&!markDiagnostic)await writeFile(join(evidenceRoot,'e2e-results.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,receipt:(fidelityDiagnostic||markDiagnostic)?join(out,'e2e-results.json'):join(evidenceRoot,'e2e-results.json'),run_receipt:join(out,'e2e-results.json'),artifacts:report.artifacts.length,error:report.error?.message}));}
}
process.exitCode=report.status==='pass'?0:1;
