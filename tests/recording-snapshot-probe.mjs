#!/usr/bin/env node
// Primitive API feasibility ONLY. No record/screencast commands or product edits.
// Self-test: node tests/recording-snapshot-probe.mjs --self-test
// Live: AP_RECORDING_SNAPSHOT_OPT_IN=1 AP_RECORDING_SNAPSHOT_EXPECTED_HEAD=<HEAD>
// node tests/recording-snapshot-probe.mjs --chrome /absolute/approved/CfT156
// Exactly one fresh browser session; no launch/capture fallback after failure.
import assert from 'node:assert/strict';
import {spawn, execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {createHash, generateKeyPairSync} from 'node:crypto';
import {mkdtemp, mkdir, readFile, writeFile, readdir, cp, chmod, rm, realpath, stat, access} from 'node:fs/promises';
import {join, resolve, basename} from 'node:path';
import {userInfo} from 'node:os';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:http';
import {waitNativeReady} from './recording-live-readiness.mjs';
import {decodeState} from './recording-state-oracle.mjs';
const exec=promisify(execFile), sleep=ms=>new Promise(r=>setTimeout(r,ms));
const repo=fileURLToPath(new URL('../',import.meta.url)), evidenceRoot=resolve(repo,'../v2-receipts');
const baseline='2ec3b6d41f928d8667c1962b237aee14153fb288';
const hash=b=>createHash('sha256').update(b).digest('hex');
const options=Object.freeze({format:'jpeg',quality:80,fromSurface:true,captureBeyondViewport:false});
const crop=Object.freeze({x:80,y:100,width:640,height:360});
const binaryHashes={'ap-browser':'13cc0303af69314f71bb4a88d3c581867525ea00083c68cb8125de5ff301b33f','ap-browser-host':'241de34687d035da9af3c9ace5426409955b9b78c5f04cbc04c6e430e622ded2','ap-browser-bridge':'b6db675bdfd7708575ab83663a857d8ebd0752da6baf484bd40373bf7fd31e32'};
function assertOptions(o){assert.deepEqual(o,{format:'jpeg',quality:80,fromSurface:true,captureBeyondViewport:false});}
const cdpArgs=(tab,method,params)=>['--tab',String(tab),'cdp',method,'--params',JSON.stringify(params)];
function pinnedTab(response,instance,url){
  assert.equal(response?.ok,true);assert.equal(response.meta?.profile?.instance_id,instance,'exact response instance');
  assert.ok(response.data&&!('profiles' in response.data)&&Array.isArray(response.data.tabs),'explicit-profile direct tabs envelope only');
  const tabs=response.data.tabs;assert.ok(tabs.every(t=>Number.isSafeInteger(t.id)&&typeof t.url==='string'),'well-formed tabs');
  const matches=tabs.filter(t=>t.url===url);assert.equal(matches.length,1,'unique exact fixture URL');return matches[0].id;
}
function cliResult(response){assert.equal(response?.ok,true);assert.ok(response.data&&Object.hasOwn(response.data,'result'),'public cdp/eval data.result');return response.data.result;}
function jpegDimensions(b){
  assert.ok(b.length>4&&b.length<=4194304&&b[0]===255&&b[1]===216,'bounded JPEG SOI');
  for(let i=2;i+3<b.length;){assert.equal(b[i++],255);while(b[i]===255)i++;const marker=b[i++];
    if(marker===217||marker===218)break;if(marker===1||(marker>=208&&marker<=215))continue;
    const n=b.readUInt16BE(i);assert.ok(n>=2&&i+n<=b.length,'segment bound');
    if([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)){assert.ok(n>=8);return {width:b.readUInt16BE(i+5),height:b.readUInt16BE(i+3)};}i+=n;
  }throw Error('JPEG SOF absent');
}
// Mapping-critical values only. Content/scroll observations remain in full facts.
function mapping(f){const v=f.visual,l=f.layout.cssLayoutViewport,c=f.layout.cssVisualViewport;return {inner:f.inner,client:f.client,dpr:f.dpr,
  visual:{width:v.width,height:v.height,scale:v.scale,offsetLeft:v.offsetLeft,offsetTop:v.offsetTop},
  cssLayout:{clientWidth:l.clientWidth,clientHeight:l.clientHeight},
  cssVisual:{clientWidth:c.clientWidth,clientHeight:c.clientHeight,scale:c.scale,offsetX:c.offsetX,offsetY:c.offsetY,zoom:c.zoom}};}
function coherent(before,after,d){
  if(JSON.stringify(mapping(before))!==JSON.stringify(mapping(after)))return false;
  const v=after.visual,l=after.layout.cssLayoutViewport,c=after.layout.cssVisualViewport;
  return after.dpr===1&&v.scale===1&&v.offsetLeft===0&&v.offsetTop===0&&c.scale===1&&
    c.offsetX===0&&c.offsetY===0&&after.inner.width===d.width&&after.inner.height===d.height&&
    l.clientWidth===d.width&&l.clientHeight===d.height&&c.clientWidth===d.width&&c.clientHeight===d.height;
}
function cropRGB(rgb,width,height,r){
  assert.equal(rgb.length,width*height*3);assert.ok(r.x>=0&&r.y>=0&&r.x+r.width<=width&&r.y+r.height<=height);
  const b=Buffer.alloc(r.width*r.height*3);for(let y=0;y<r.height;y++)rgb.copy(b,y*r.width*3,((r.y+y)*width+r.x)*3,((r.y+y)*width+r.x+r.width)*3);return b;
}
if(process.argv.includes('--self-test')){
  assertOptions(options);for(const extra of [{clip:crop},{optimizeForSpeed:true},{fromSurface:false},{captureBeyondViewport:true}])assert.throws(()=>assertOptions({...options,...extra}));
  const b=Buffer.from([255,216,255,192,0,8,8,2,88,3,232,1,255,217]);assert.deepEqual(jpegDimensions(b),{width:1000,height:600});assert.throws(()=>jpegDimensions(b.subarray(0,9)));
  const f={inner:{width:1000,height:600},client:{width:1000,height:600},dpr:1,visual:{scale:1,offsetLeft:0,offsetTop:0},fixture:{rect:crop},layout:{cssLayoutViewport:{clientWidth:1000,clientHeight:600},cssVisualViewport:{clientWidth:1000,clientHeight:600,scale:1,offsetX:0,offsetY:0}}};
  assert.ok(coherent(f,f,{width:1000,height:600}));assert.ok(!coherent(f,f,{width:913,height:600}));assert.ok(!coherent(f,{...f,dpr:2},{width:1000,height:600}));
  const scroll={...f,scroll:{x:0,y:20},visual:{...f.visual,pageLeft:0,pageTop:20},fixture:{rect:{...crop,y:80}},layout:{cssLayoutViewport:{...f.layout.cssLayoutViewport,pageX:0,pageY:20},cssVisualViewport:{...f.layout.cssVisualViewport,pageX:0,pageY:20}}};assert.ok(coherent(f,scroll,{width:1000,height:600}));
  assert.ok(!coherent(f,{...scroll,visual:{...scroll.visual,offsetTop:1}},{width:1000,height:600}));
  const pixels=Buffer.from(Array.from({length:4*3*3},(_,i)=>i));assert.deepEqual(cropRGB(pixels,4,3,{x:1,y:1,width:2,height:1}),pixels.subarray(15,21));
  assert.throws(()=>cropRGB(pixels,4,3,{x:3,y:0,width:2,height:1}));
  // Direct shape is authenticated by current background.js tabs.list and the
  // first real redacted receipt (data_keys:[tabs]); bodies here are reconstruction.
  const instance='67701dd8-a4de-4780-92b5-dd8db7424846',url='redacted:fixture',direct={ok:true,meta:{profile:{instance_id:instance}},data:{tabs:[{id:481393549,url}]}};
  assert.equal(pinnedTab(direct,instance,url),481393549);
  for(const bad of [{...direct,data:{profiles:[{instance_id:instance,tabs:direct.data.tabs}]}},{...direct,meta:{}},{...direct,meta:{profile:{instance_id:'other'}}},{...direct,data:{}},{...direct,data:{tabs:[...direct.data.tabs,...direct.data.tabs]}},{...direct,data:{tabs:[{id:1}]}},{...direct,data:{tabs:[]}}])assert.throws(()=>pinnedTab(bad,instance,url));
  assert.equal(cliResult({ok:true,data:{result:{data:'jpeg'}}}).data,'jpeg');assert.deepEqual(cliResult({ok:true,data:{result:{score:4}}}),{score:4});assert.throws(()=>cliResult({ok:true,data:{tabs:[]}}));
  if(process.argv.includes('--receipt')){
    const r=JSON.parse(await readFile(process.argv[process.argv.indexOf('--receipt')+1]));
    if(r.tabs_response_redacted)assert.equal(pinnedTab(r.tabs_response_redacted,r.native.instance_id,'redacted:fixture'),r.fixture_tab);
    else {const c=r.commands.find(c=>c.args.slice(-2).join(' ')==='tabs list');assert.deepEqual(c.response.data_keys,['tabs']);assert.equal(c.response.meta.instance_id,r.native.instance_id);assert.equal(c.exit_code,0);}
  }
  assert.deepEqual(cdpArgs(1,'Page.getLayoutMetrics',{}),['--tab','1','cdp','Page.getLayoutMetrics','--params','{}']);
  if(process.argv.includes('--cli-syntax')){
    // Actual binary parser, private empty socket/HOME only; no browser or native
    // connection can occur. OFFLINE is expected, clap exit2 must fail the test.
    const empty=await realpath(await mkdtemp('/tmp/apsnapshot-syntax-'));
    try{
      const env={...process.env,HOME:empty,TMPDIR:empty};delete env.AP_BROWSER_REMOTE;delete env.AP_BROWSER_INSTANCE;
      for(const [method,params] of [['Page.getLayoutMetrics',{}],['Page.captureScreenshot',options],['Input.dispatchMouseEvent',{type:'mousePressed',x:1,y:1,button:'left',clickCount:1}]]){
        let result;try{await exec(join(repo,'target/debug/ap-browser'),['--profile','00000000-0000-4000-8000-000000000000','--timeout','1','--wait-online','0',...cdpArgs(1,method,params)],{env,timeout:5000});assert.fail('empty profile unexpectedly connected');}catch(e){result=e;}
        assert.equal(result.code,7,'valid CLI syntax must reach OFFLINE transport exit7, not clap exit2');assert.equal(JSON.parse(result.stdout).error.code,'OFFLINE');
      }
    }finally{await rm(empty,{recursive:true,force:true});}
  }
  console.log('PASS snapshot primitive self-tests: exact options, JPEG SOF bounds, strict mapping/refusal, scroll distinction, fixed RGB crop, pinned direct-envelope identity and ambiguity negatives, cdp/eval result shapes and named --params syntax');process.exit(0);
}
const chromePath=process.argv[process.argv.indexOf('--chrome')+1];
assert.equal(process.env.AP_RECORDING_SNAPSHOT_OPT_IN,'1','explicit opt-in required');
assert.ok(process.argv.includes('--chrome')&&chromePath?.startsWith('/')&&chromePath.includes('Google Chrome for Testing'),'approved absolute CfT required');
assert.equal(process.env.HOME,userInfo().homedir,'browser inherits actual account HOME');
assert.ok(process.env.AP_RECORDING_SNAPSHOT_EXPECTED_HEAD,'explicit HEAD required');
const report={schema_version:1,status:'blocked',prior_startup_parser_block:process.env.AP_RECORDING_SNAPSHOT_PRIOR_RECEIPT||null,scope:'primitive API feasibility; NOT recording-v2 implementation or recording acceptance',capture_method:'Page.captureScreenshot',real_native_chain:false,correlated_responses:false,options:{fromSurface:true,captureBeyondViewport:false,clip:null},jpeg_options:options,screenshot_requests:0,screenshot_responses:0,screenshot_count:0,observations:[],commands:[],started_at:new Date().toISOString(),functional_baseline:baseline,
  timing_semantics:'Node performance.now diagnostic intervals around public CLI subprocess operations and readonly checks only; NOT extension/SW clock, exact native send, compositor paint time, or v2 protocol intervals',
  emulation_policy:'fresh private profile, sole ordinary extension page debugger owner, no metrics/clip/resize/focus emulation calls. Known or unknown existing emulation and concurrent emulation mutators unsupported: geometry alone cannot detect every override; no public generic enabled-state getter. Do not reset foreign emulation.',
  ordinary_hooks:'unchanged public CLI generic path attaches debugger, swaps head favicon, sends agent_activity to any binding, schedules3s restore; probe authors no DOM/repaint changes. Fresh profile has no user binding.',
  correlation_semantics:'native RPC numeric ID observed on inbound/outbound SW false-condition logpoints, serial public CLI process response with same base64 length; NOT Chrome internal CDP IDs'};
let root,out,chrome,cdp,server,privateEnv,fixtureTab,hostPid,hardTimer,interrupted,credentialError,browserLog='',swSession;
for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>{interrupted=signal;chrome?.kill('SIGTERM');});
async function command(file,args,opts={}){try{const {stdout,stderr}=await exec(file,args,{cwd:repo,timeout:7000,maxBuffer:9*1024*1024,...opts});return {file,args,exit_code:0,stdout,stderr};}catch(e){return {file,args,exit_code:e.code||e.signal||1,stdout:e.stdout||'',stderr:e.stderr||''};}}
function healthy(){assert.ok(!interrupted&&!credentialError,interrupted||credentialError);}
async function waitFor(fn,ms=10000){const end=performance.now()+ms;while(performance.now()<end){healthy();const v=await fn();if(v)return v;await sleep(25);}throw Error('bounded wait expired');}
async function cli(args,{timeout=6500}={}){
  healthy();const started=performance.now();const r=await command(join(repo,'target/debug/ap-browser'),['--profile',report.native.instance_id,'--timeout','5','--wait-online','0',...args],{env:privateEnv,timeout});
  let value;try{value=JSON.parse(r.stdout);}catch{}
  // Never persist a giant image/base64 log, including failure output.
  const safe={...r,started_node_ms:started,completed_node_ms:performance.now(),stdout:undefined,response:value?{ok:value.ok,error:value.error,meta:{instance_id:value.meta?.profile?.instance_id,tab_id:value.meta?.tab_id},data_keys:Object.keys(value.data||{}),result_keys:typeof value.data?.result==='object'?Object.keys(value.data.result||{}):undefined}:undefined,stdout_bytes:Buffer.byteLength(r.stdout)};
  report.commands.push(safe);assert.equal(r.exit_code,0,JSON.stringify(safe));assert.equal(value?.ok,true,JSON.stringify(safe));return value;
}
async function publicCDP(method,params={},opts){return cliResult(await cli(cdpArgs(fixtureTab,method,params),opts));}
const factExpression=`(()=>{const vv=visualViewport;return {inner:{width:innerWidth,height:innerHeight},outer:{width:outerWidth,height:outerHeight},client:{width:document.documentElement.clientWidth,height:document.documentElement.clientHeight},dpr:devicePixelRatio,visual:{width:vv.width,height:vv.height,offsetLeft:vv.offsetLeft,offsetTop:vv.offsetTop,pageLeft:vv.pageLeft,pageTop:vv.pageTop,scale:vv.scale},scroll:{x:scrollX,y:scrollY},document:{width:document.documentElement.scrollWidth,height:document.documentElement.scrollHeight},screen:{width:screen.width,height:screen.height,availWidth:screen.availWidth,availHeight:screen.availHeight},visibility:document.visibilityState,focus:document.hasFocus(),favicon_links:document.querySelectorAll('link[rel*=icon]').length,fixture:fixtureState()}})()`;
async function facts(deadline){const opts=deadline?{timeout:Math.max(1,Math.floor(deadline-performance.now()))}:undefined;const f=(await cli(['--tab',String(fixtureTab),'eval',factExpression],opts)).data.result;f.layout=await publicCDP('Page.getLayoutMetrics',{},deadline?{timeout:Math.max(1,Math.floor(deadline-performance.now()))}:undefined);return f;}
class CDP{
  constructor(url){this.ws=new WebSocket(url);this.seq=0;this.pending=new Map();this.events=[];this.ws.onmessage=({data})=>{const v=JSON.parse(data);if(v.id){const p=this.pending.get(v.id);if(p){clearTimeout(p.timer);this.pending.delete(v.id);v.error?p.reject(Error(JSON.stringify(v.error))):p.resolve(v.result);}}else{assert.ok(this.events.length<20000,'bounded observer');this.events.push(v);}};}
  async open(){await new Promise((r,j)=>{this.ws.onopen=r;this.ws.onerror=j;});}
  call(method,params={},sessionId){return new Promise((resolve,reject)=>{const id=++this.seq,timer=setTimeout(()=>{this.pending.delete(id);reject(Error('observer timeout '+method));},7000);this.pending.set(id,{resolve,reject,timer});this.ws.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});}
  close(){this.ws.close();}
}
function nativeLogs(start=0){return cdp.events.slice(start).filter(e=>e.method==='Runtime.consoleAPICalled').flatMap(e=>e.params.args.filter(a=>typeof a.value==='string').map(a=>a.value)).filter(s=>s.startsWith('SNAPSHOT_NATIVE ')).map(s=>JSON.parse(s.slice(16)));}
async function inventory(dir,prefix=''){let result=[];for(const e of await readdir(dir,{withFileTypes:true})){const p=join(prefix,e.name);if(e.isDirectory())result.push(...await inventory(join(dir,e.name),p));else result.push({path:p,sha256:hash(await readFile(join(dir,e.name)))});}return result.sort((a,b)=>a.path.localeCompare(b.path));}
async function stop(child){if(!child||child.exitCode!==null||child.signalCode!==null)return;child.kill('SIGTERM');for(let i=0;i<30&&child.exitCode===null&&child.signalCode===null;i++)await sleep(100);if(child.exitCode===null&&child.signalCode===null)child.kill('SIGKILL');}
async function processes(){return (await command('ps',['-axo','pid=,ppid=,command='])).stdout.split('\n').filter(l=>l.includes(root));}
async function capture(label,deadline){
  assertOptions(options);if(deadline)assert.ok(performance.now()<deadline,'original preparation deadline');
  const before=await facts(deadline),eventStart=cdp.events.length,requestStarted=performance.now();
  report.screenshot_requests++;
  const response=await publicCDP('Page.captureScreenshot',options,deadline?{timeout:Math.max(1,Math.floor(deadline-performance.now()))}:undefined),responseReceived=performance.now();
  report.screenshot_responses++;
  assert.equal(typeof response.data,'string');assert.ok(response.data.length<=5592408&&response.data.length%4===0,'bounded base64 response');
  const bytes=Buffer.from(response.data,'base64');assert.equal(bytes.toString('base64'),response.data,'canonical screenshot base64');const d=jpegDimensions(bytes),path=join(out,`${String(report.screenshot_count+1).padStart(2,'0')}-${label}.jpg`);await writeFile(path,bytes);
  const o={label,path,sha256:hash(bytes),bytes:bytes.length,base64_length:response.data.length,...d,request_started_node_ms:requestStarted,response_received_node_ms:responseReceived,before};report.observations.push(o);report.screenshot_count++;
  o.after=await facts(deadline);o.geometry_validated_node_ms=performance.now();o.coherent=coherent(before,o.after,d);
  // The independent observer socket may deliver console events after CLI completion.
  // Wait only for evidence, never retry or change the screenshot request.
  const observerStart=performance.now(),observerBudget=deadline?Math.min(1000,Math.max(1,deadline-observerStart)):1000;
  const {input,output}=await waitFor(()=>{const logs=nativeLogs(eventStart),input=logs.filter(x=>x.direction==='request'&&x.method==='Page.captureScreenshot');assert.ok(input.length<=1,'one actual screenshot native request');if(!input.length)return null;const output=logs.filter(x=>x.direction==='response'&&x.id===input[0].id);assert.ok(output.length<=1,'one same-ID native callback response');return output.length?{input,output}:null;},observerBudget);
  o.observer_wait_ms=performance.now()-observerStart;assert.deepEqual(input[0].options,options);assert.equal(output[0].ok,true);assert.equal(output[0].data_length,response.data.length);
  assert.ok(!report.observations.slice(0,-1).some(x=>x.native_request_id===input[0].id),'unique actual native request ID');o.native_request_id=input[0].id;o.native_request=input[0];o.native_response=output[0];
  if(o.coherent){
    const r=await command('ffmpeg',['-v','error','-i',path,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{encoding:'buffer'});assert.equal(r.exit_code,0);const rgb=r.stdout;
    o.decoded=decodeState(rgb,{width:d.width,height:d.height,crop:{x:0,y:0,width:d.width,height:d.height}});
    o.motion_patch_sha256=hash(cropRGB(rgb,d.width,d.height,{x:88,y:248,width:624,height:40}));
    const cropped=cropRGB(rgb,d.width,d.height,crop),ppm=Buffer.concat([Buffer.from(`P6\n${crop.width} ${crop.height}\n255\n`),cropped]);o.fixed_crop={method:'offline integer CSS-to-image1:1 RGB crop; NO CDP clip',css:crop,path:path.replace('.jpg','-crop.ppm'),sha256:hash(ppm),decoded:decodeState(cropped,{width:crop.width,height:crop.height,crop})};await writeFile(o.fixed_crop.path,ppm);assert.deepEqual(o.fixed_crop.decoded,o.decoded);
    const pixel=(x,y)=>[...rgb.subarray((y*d.width+x)*3,(y*d.width+x)*3+3)];o.marker_pixels={outside:pixel(10,200),cyan:pixel(82,110),inside:pixel(92,200)};
    const [rr,g,b]=o.marker_pixels.cyan;assert.ok(g>180&&b>180&&Math.min(g,b)-rr>70,'cyan border mapped');const [r1,g1,b1]=o.marker_pixels.outside;assert.ok(Math.min(r1,b1)-g1>55,'outside magenta mapped');
  }
  if(deadline)assert.ok(performance.now()<=deadline,'single original10s prep budget includes checks/decoding');return o;
}
async function button(selector){const r=(await cli(['--tab',String(fixtureTab),'eval',`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`])).data.result;for(const type of ['mousePressed','mouseReleased'])await publicCDP('Input.dispatchMouseEvent',{type,x:r.x,y:r.y,button:'left',clickCount:1});}
try{
  await mkdir(evidenceRoot,{recursive:true});out=await realpath(await mkdtemp(join(evidenceRoot,'snapshot-')));report.artifacts_dir=out;
  report.code_head=(await command('git',['rev-parse','HEAD'])).stdout.trim();assert.equal(report.code_head,process.env.AP_RECORDING_SNAPSHOT_EXPECTED_HEAD);
  report.functional_source_diff=await command('git',['diff','--exit-code',baseline,'--','extension','core','host','cli','bridge','Cargo.toml','Cargo.lock']);assert.equal(report.functional_source_diff.exit_code,0);
  report.functional_trees={};for(const p of ['extension','core','host','cli','bridge'])report.functional_trees[p]=(await command('git',['rev-parse',`${baseline}:${p}`])).stdout.trim();
  report.probe_sha256=hash(await readFile(fileURLToPath(import.meta.url)));
  report.source_audit={revision:'f842f52ef39fd97b449eb27cff414bf05a98ddce',files:[],normal_path:'Page1420–1633: default params/no clip/no beyond; emulation1096–1111 returns still-disabled without update; no SetSize or async restore on normal path.',limitations:'fromSurface:false trusted-only1492; emulation/clip path modifies size/params, async restore1996–2000 can overwrite concurrent owner; no generic enabled-state getter; fresh sole-owner only, unknown targets unsupported.'};
  for(const [path,sha256] of [[ '/tmp/recording-compositor-source-f842f52/page_handler.cc','008a11651f5048ea8630f4a2d0f710904d1595c890287b55aa1a0517d8fd4dab'],['/tmp/recording-compositor-source-f842f52/Page.pdl','9eb79e1b6747b462e908d54758474854064d42b8362097542708d11e8c407a11'],[join(evidenceRoot,'source-f842f52/emulation_handler.cc'),'3056fc08d3d36cea635a602254040cdefa7d38a91f0fcfa8a1e64ec17839d9ee'],[join(evidenceRoot,'source-f842f52/emulation_handler.h'),'4e088d40f5d1035f04884a00db2d722f0d4f5a0bd1cb218caca4443ee4204664']]){const bytes=await readFile(path);assert.equal(hash(bytes),sha256);const retained=join(out,basename(path));await writeFile(retained,bytes);report.source_audit.files.push({path:retained,sha256});}
  await access(chromePath);report.browser_version=(await command(chromePath,['--version'])).stdout.trim();assert.match(report.browser_version,/156\.0\.8078\.4/);report.browser_executable=chromePath;report.browser_executable_sha256=hash(await readFile(chromePath));
  report.binary_hashes={};for(const [name,sha] of Object.entries(binaryHashes)){const actual=hash(await readFile(join(repo,'target/debug',name)));assert.equal(actual,sha);report.binary_hashes[name]=actual;}
  root=await realpath(await mkdtemp('/tmp/apsnapshot-'));await chmod(root,0o700);report.owned_root=root;
  const helper=join(repo,'tests/recording-live-stage-host.py'),nativeSource=join(repo,'target/debug/ap-browser-host'),nativeStaged=join(root,'ap-browser-host');report.staging_helper_sha256=hash(await readFile(helper));
  const stage=await command('python3',[helper,'--source',nativeSource,'--destination',nativeStaged,'--owned-root',root,'--expected-sha256',binaryHashes['ap-browser-host']],{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});report.native_staging_command=stage;assert.equal(stage.exit_code,0,'safe staging failed; no launch');report.native_staging=JSON.parse(stage.stdout);assert.equal(report.native_staging.status,'pass');
  const ext=join(root,'extension'),profile=join(root,'profile'),home=join(root,'host-home'),tmp=join(root,'host-tmp');await cp(join(repo,'extension'),ext,{recursive:true});for(const p of [profile,home,tmp,join(profile,'NativeMessagingHosts')])await mkdir(p,{recursive:true,mode:0o700});
  const alias=('com.apbrowser.live_'+basename(root).replaceAll('-','_')).toLowerCase();assert.match(alias,/^[a-z0-9_]+(?:\.[a-z0-9_]+)*$/);
  const background=await readFile(join(ext,'background.js'),'utf8'),literal='const NATIVE_HOST_NAME = "com.apbrowser.connect";';assert.equal(background.split(literal).length,2);await writeFile(join(ext,'background.js'),background.replace(literal,`const NATIVE_HOST_NAME = "${alias}";`));
  const publicKey=generateKeyPairSync('rsa',{modulusLength:2048}).publicKey.export({type:'spki',format:'der'}),key=publicKey.toString('base64'),manifestSource=await readFile(join(ext,'manifest.json'),'utf8');await writeFile(join(ext,'manifest.json'),manifestSource.replace('{','{\n\t"key": '+JSON.stringify(key)+','));
  const extensionId=hash(publicKey).slice(0,32).replace(/[0-9a-f]/g,c=>String.fromCharCode(97+parseInt(c,16)));
  report.extension={id:extensionId,alias,public_test_key:key,source:await inventory(join(repo,'extension')),staged:await inventory(ext),delta:['background.js unique lowercase alias literal only','manifest.json generated public key only']};
  assert.equal((await readFile(join(ext,'background.js'),'utf8')).replace(alias,'com.apbrowser.connect'),background);const normalized=JSON.parse(await readFile(join(ext,'manifest.json')));delete normalized.key;assert.deepEqual(normalized,JSON.parse(manifestSource));assert.deepEqual(report.extension.staged.filter(e=>report.extension.source.find(s=>s.path===e.path)?.sha256!==e.sha256).map(e=>e.path).sort(),['background.js','manifest.json']);
  const q=s=>"'"+s.replaceAll("'","'\\''")+"'",wrapper=join(root,'native-wrapper.sh');await writeFile(wrapper,`#!/bin/sh\nexport HOME=${q(home)} TMPDIR=${q(tmp)} RUST_LOG=info\nunset AP_BROWSER_REMOTE AP_BROWSER_INSTANCE\nprintf '%s\\n' "$$ $PPID" > ${q(join(root,'host-pid'))}\nexec ${q(nativeStaged)} "$@" 2>>${q(join(out,'native.log'))}\n`,{mode:0o700});
  const nativeManifest={name:alias,description:'Disposable screenshot primitive probe',path:wrapper,type:'stdio',allowed_origins:[`chrome-extension://${extensionId}/`]},manifestPath=join(profile,'NativeMessagingHosts',alias+'.json');await writeFile(manifestPath,JSON.stringify(nativeManifest));report.native={manifest_path:manifestPath,manifest:nativeManifest,wrapper:await readFile(wrapper,'utf8'),binary:nativeStaged,original_binary:nativeSource};
  privateEnv={...process.env,HOME:home,TMPDIR:tmp};delete privateEnv.AP_BROWSER_REMOTE;delete privateEnv.AP_BROWSER_INSTANCE;
  const html=await readFile(join(repo,'tests/recording-live-fixture.html'));report.fixture_sha256=hash(html);server=createServer((req,res)=>{if(req.url!=='/fixture'){res.writeHead(404);res.end();return;}res.writeHead(200,{'Content-Type':'text/html; charset=utf-8','Content-Security-Policy':"default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'none'"});res.end(html);});await new Promise(r=>server.listen(0,'127.0.0.1',r));const url=`http://127.0.0.1:${server.address().port}/fixture`;
  const args=[`--user-data-dir=${profile}`,'--use-mock-keychain','--password-store=basic','--disable-sync','--disable-background-networking','--disable-component-update','--disable-domain-reliability','--no-first-run','--no-default-browser-check','--disable-default-apps','--disable-features=MediaRouter,OptimizationHints','--metrics-recording-only','--no-pings','--force-device-scale-factor=1','--window-size=1000,800','--remote-debugging-address=127.0.0.1','--remote-debugging-port=0',`--disable-extensions-except=${ext}`,`--load-extension=${ext}`,url];
  report.browser_launch={args,HOME:process.env.HOME,host_HOME:home,host_TMPDIR:tmp,headed:true,started_node_ms:performance.now(),launch_count:1};chrome=spawn(chromePath,args,{env:{...process.env},stdio:['ignore','ignore','pipe']});report.browser_pid=chrome.pid;chrome.stderr.on('data',b=>{browserLog+=b.toString();if(/keychain.*(?:not found|error|failed)|(?:password|credential).*dialog/i.test(b.toString())){credentialError='credential problem';chrome.kill('SIGTERM');}});
  hardTimer=setTimeout(()=>{interrupted='90s total probe deadline';chrome.kill('SIGTERM');},90000);
  const devtools=await waitFor(async()=>{try{return (await readFile(join(profile,'DevToolsActivePort'),'utf8')).split('\n');}catch{return null;}});cdp=new CDP(`ws://127.0.0.1:${devtools[0]}${devtools[1]}`);await cdp.open();report.browser_identity=await cdp.call('Browser.getVersion');assert.equal(report.browser_identity.revision,'@f842f52ef39fd97b449eb27cff414bf05a98ddce','identity-pinned Chromium revision');
  const sw=await waitFor(async()=>{const {targetInfos}=await cdp.call('Target.getTargets');return targetInfos.find(t=>t.type==='service_worker'&&t.url===`chrome-extension://${extensionId}/background.js`);});swSession=(await cdp.call('Target.attachToTarget',{targetId:sw.targetId,flatten:true})).sessionId;await cdp.call('Runtime.enable',{},swSession);report.service_worker={target_id:sw.targetId,url:sw.url};
  await cdp.call('Tracing.start',{categories:'blink.user_timing,devtools.timeline,blink.console',transferMode:'ReportEvents'});const traceMark='snapshot-sw-identity-'+basename(root);await cdp.call('Runtime.evaluate',{expression:`performance.mark(${JSON.stringify(traceMark)})`},swSession);await cdp.call('Tracing.end');await waitFor(()=>cdp.events.some(e=>e.method==='Tracing.tracingComplete'));const marks=cdp.events.filter(e=>e.method==='Tracing.dataCollected').flatMap(e=>e.params.value).filter(e=>e.name===traceMark);assert.ok(marks.length);report.service_worker.trace_identity=marks;report.service_worker.pid=marks[0].pid;
  const pidLine=await waitFor(async()=>{try{return await readFile(join(root,'host-pid'),'utf8');}catch{return null;}});[hostPid]=pidLine.trim().split(' ').map(Number);report.native.pid=hostPid;report.native.parent_pid=Number(pidLine.trim().split(' ')[1]);assert.equal(report.native.parent_pid,chrome.pid);report.native.process_identity=(await command('ps',['-p',String(hostPid),'-o','pid=,ppid=,comm=,args='])).stdout;assert.ok(report.native.process_identity.includes(nativeStaged)&&report.native.process_identity.includes(`chrome-extension://${extensionId}/`));report.processes=await processes();
  report.native_readiness=await waitNativeReady({observe:async()=>{healthy();const sockets=(await readdir(tmp)).filter(n=>/^ap-browser-[A-Za-z0-9_-]+\.sock$/.test(n));assert.ok(sockets.length<=1);if(!sockets.length)return null;const socket=join(tmp,sockets[0]),instance=sockets[0].slice(11,-5);if(!(await stat(socket)).isSocket())return null;const log=await readFile(join(home,'.ap-browser/host.log'),'utf8').catch(e=>{if(e.code==='ENOENT')return '';throw e;});const hellos=[...log.matchAll(/hello: instance_id=([A-Za-z0-9_-]+)/g)].map(m=>m[1]);if(!hellos.length||!log.includes('listening on '+socket))return null;assert.equal(hellos.at(-1),instance);assert.ok(log.includes('spawned by chrome-extension://'+extensionId+'/'));return {instance,socket,hello_instance:hellos.at(-1)};},ping:async(native,remaining)=>{report.native.instance_id=native.instance;const r=await command(join(repo,'target/debug/ap-browser'),['--profile',native.instance,'--timeout',String(Math.max(1,Math.floor(remaining/1000))),'--wait-online','0','ping'],{env:privateEnv,timeout:Math.max(1,Math.floor(remaining))});report.readiness_ping=r;assert.equal(r.exit_code,0);const p=JSON.parse(r.stdout);assert.equal(p.ok,true);assert.equal(p.data.pong,true);assert.equal(p.meta.profile.instance_id,native.instance);return p;}});
  report.real_native_chain=true;
  await cdp.call('Debugger.enable',{},swSession);
  const lines=background.split('\n'),logpoints=[{needle:'if (!msg || typeof msg !== "object") return;',condition:'(msg?.method === "cdp" && console.info("SNAPSHOT_NATIVE "+JSON.stringify({direction:"request",id:msg.id,method:msg.params?.method,options:msg.params?.method==="Page.captureScreenshot"?msg.params.params:undefined})),false)'},{needle:'port.postMessage(payload);',condition:'(typeof payload?.id === "number" && console.info("SNAPSHOT_NATIVE "+JSON.stringify({direction:"response",id:payload.id,ok:payload.result?.ok===true,error:!!payload.error,data_length:typeof payload.result?.data?.result?.data==="string"?payload.result.data.result.data.length:null})),false)'}];
  report.logpoints=[];for(const p of logpoints){const lineNumber=lines.findIndex(l=>l.includes(p.needle));assert.ok(lineNumber>0);const r=await cdp.call('Debugger.setBreakpointByUrl',{url:`chrome-extension://${extensionId}/background.js`,lineNumber,condition:p.condition},swSession);assert.ok(r.locations.length);report.logpoints.push({...p,lineNumber,result:r,condition_sha256:hash(p.condition)});}
  const tabs=await cli(['tabs','list']);fixtureTab=pinnedTab(tabs,report.native.instance_id,url);report.fixture_tab=fixtureTab;
  report.tabs_response_redacted={...tabs,data:{tabs:tabs.data.tabs.map(t=>({id:t.id,url:t.url===url?'redacted:fixture':'redacted:other',active:t.active}))}};
  report.tabs_response_note='Actual direct response, title removed and URLs replaced with typed fixture/other tokens; reusable parser replay uses exact redacted body.';
  // One original10s window; preserve even incoherent initial infobar observations.
  const prepStart=performance.now(),prepDeadline=prepStart+10000;let prior,prepared;
  for(let attempt=1;attempt<=4;attempt++){const o=await capture('prepare-'+attempt,prepDeadline);if(o.coherent&&prior?.coherent&&JSON.stringify(mapping(o.after))===JSON.stringify(mapping(prior.after))){prepared=o;break;}prior=o;}
  assert.ok(prepared,'no repeat coherent preparation within original10s/four requests');report.preparation={started_node_ms:prepStart,completed_node_ms:performance.now(),budget_ms:10000,max_requests:4,accepted_request_id:prepared.native_request_id,repeat_coherent:true};
  report.debugger_infobar_transition={initial_history:report.observations[0].before.fixture.viewportHistory,final_history:prepared.after.fixture.viewportHistory,first_before:report.observations[0].before.inner,prepared:prepared.after.inner,policy:'ordinary debugger attachment only; no suppression/resize/discarded evidence'};
  const repeated=await capture('repeated-ready');assert.ok(repeated.coherent);assert.deepEqual(repeated.decoded,{score:0,mode:'READY'});
  await button('#start');const motionA=await capture('motion-a');await sleep(450);const motionB=await capture('motion-b');for(const o of [motionA,motionB]){assert.ok(o.coherent);assert.deepEqual(o.decoded,{score:0,mode:'RUN'});}assert.notEqual(motionA.sha256,motionB.sha256,'actual motion pixels differ');assert.notEqual(motionA.motion_patch_sha256,motionB.motion_patch_sha256,'yellow sprite motion patch differs');
  await waitFor(async()=>{const s=(await cli(['--tab',String(fixtureTab),'eval','fixtureState()'])).data.result;return s.mode==='HOLD';},3000);
  for(let i=0;i<4;i++)await button('#step');const finalA=await capture('final-score4-a'),finalB=await capture('final-score4-b');for(const o of [finalA,finalB]){assert.ok(o.coherent);assert.deepEqual(o.decoded,{score:4,mode:'HOLD'});assert.deepEqual(o.fixed_crop.decoded,{score:4,mode:'HOLD'});}
  // Semantics and crop geometry are the gate, not undocumented byte-identical JPEG encoding.
  assert.deepEqual(finalB.after.fixture.rect,prepared.after.fixture.rect);assert.equal(finalB.after.scroll.x,0);assert.equal(finalB.after.scroll.y,0);
  report.final_pixel_evidence={pass:true,request_ids:[finalA.native_request_id,finalB.native_request_id],decoded:{score:4,mode:'HOLD'},jpeg_sha256:[finalA.sha256,finalB.sha256],jpeg_bytes_identical:finalA.sha256===finalB.sha256,fixed_crop_verified:true};report.motion_evidence={pass:true,request_ids:[motionA.native_request_id,motionB.native_request_id],distinct_jpegs:true,patch_css:{x:88,y:248,width:624,height:40},distinct_motion_patch:true};
  report.correlated_responses=report.observations.every(o=>Number.isSafeInteger(o.native_request_id)&&o.native_response.id===o.native_request_id);assert.ok(report.correlated_responses&&report.screenshot_count>=6);
  report.native_rpc_observations=nativeLogs();assert.ok(!report.native_rpc_observations.some(o=>o.direction==='request'&&(/Emulation\.|Screencast|screencast/.test(o.method))));assert.ok(!cdp.events.some(e=>e.method==='Debugger.paused'),'false logpoints never pause');
  for(const p of report.logpoints)await cdp.call('Debugger.removeBreakpoint',{breakpointId:p.result.breakpointId},swSession);report.logpoints_removed=true;report.status='pass';
}catch(e){report.status='blocked';report.error={message:e.message,stack:e.stack};console.error(e.stack);}
finally{
  clearTimeout(hardTimer);if(cdp){report.native_rpc_observations??=nativeLogs();cdp.close();}await stop(chrome);if(server)await new Promise(r=>server.close(r));
  if(hostPid){await sleep(300);try{process.kill(hostPid,0);report.cleanup_host_signal=true;process.kill(hostPid,'SIGTERM');await sleep(300);}catch{}try{process.kill(hostPid,0);report.host_exited=false;}catch{report.host_exited=true;}}
  report.browser_exited=!chrome||chrome.exitCode!==null||chrome.signalCode!==null;
  if(root){report.owned_processes_after_cleanup=await processes();const log=await readFile(join(root,'host-home/.ap-browser/host.log')).catch(()=>null);if(log&&out){report.native_runtime_log=join(out,'host-runtime.log');await writeFile(report.native_runtime_log,log);const epochs=[...log.toString().matchAll(/host_[0-9]+_[0-9]+_[0-9]+/g)];if(epochs.length)report.native.host_epoch=epochs[0][0];}await rm(root,{recursive:true,force:true});report.owned_profile_removed=true;}
  if(report.native_staging){const r=await command('python3',[join(repo,'tests/recording-live-stage-host.py'),'--snapshot',join(repo,'target/debug/ap-browser-host')],{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});report.original_native_after=r;try{assert.equal(r.exit_code,0);assert.deepEqual(JSON.parse(r.stdout).snapshot,report.native_staging.source_before??report.native_staging.evidence?.source_before);report.source_native_immutable_after_run=true;}catch(e){report.status='blocked';report.source_immutability_error=e.message;}}
  report.functional_source_after=await command('git',['diff','--exit-code',baseline,'--','extension','core','host','cli','bridge','Cargo.toml','Cargo.lock']);if(report.functional_source_after.exit_code!==0)report.status='fail';
  if(interrupted||credentialError){report.status='blocked';report.interrupted=interrupted;report.credential_error=credentialError;}
  if(report.status==='pass'&&(!report.host_exited||!report.browser_exited||report.owned_processes_after_cleanup?.length))report.status='fail';report.finished_at=new Date().toISOString();
  if(out){report.browser_log=join(out,'browser.log');await writeFile(report.browser_log,browserLog);report.receipt=join(out,'probe.json');await writeFile(report.receipt,JSON.stringify(report,null,2));await writeFile(join(evidenceRoot,'probe.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({status:report.status,screenshot_count:report.screenshot_count,receipt:join(evidenceRoot,'probe.json'),run_receipt:report.receipt,error:report.error?.message}));}
}
process.exitCode=report.status==='pass'?0:1;
