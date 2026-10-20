// Offline tests ONLY: no Chrome/native host launch, no live PASS from these fixtures.
import assert from 'node:assert/strict';
import test from 'node:test';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createServer} from 'node:net';
import {PRODUCT_HEAD,BACKEND,pinnedTab,capabilities,cdpArgs,locateLogpoints,logpoints,verifySource,readonlyRPC} from './recording-live-v2-helpers.mjs';
const exec=promisify(execFile),repo=fileURLToPath(new URL('../',import.meta.url));
test('direct explicit-profile tabs and exact response identity; legacy aggregate/ambiguous shapes fail',()=>{
  const body={ok:true,meta:{profile:{instance_id:'test_instance'}},data:{tabs:[{id:7,url:'http://fixture/'}]}};
  assert.equal(pinnedTab(body,'test_instance','http://fixture/'),7);
  for(const r of [{...body,meta:{}},{...body,data:{profiles:[{tabs:body.data.tabs}]}},{...body,data:{tabs:[...body.data.tabs,...body.data.tabs]}},{...body,data:{tabs:[]}}])assert.throws(()=>pinnedTab(r,'test_instance','http://fixture/'));
});
test('capabilities exact both implementations, no schema/version/backend fallback',()=>{
  const c={host:{protocol_version:2,backend:BACKEND},extension:{protocol_version:2,backend:BACKEND},legacy_v1_read_only:true};capabilities(c);
  for(const bad of [{...c,extension:{...c.extension,protocol_version:1}},{...c,host:{...c.host,backend:'screencast'}},{...c,host:undefined},{...c,legacy_v1_read_only:false},{...c,extra:true}])assert.throws(()=>capabilities(bad));
});
test('all bounded read-only logpoints resolve unique actual source anchors and parse as false conditions',async()=>{
  const sources={};for(const p of logpoints)sources[p.file]=await readFile(join(repo,'extension',p.file),'utf8');const located=locateLogpoints(sources);assert.equal(located.length,5);
  const mutation=/sendCommand\(|postMessage\(|\.(?:data|jpeg_base64)\s*(?:[+*/%-]=|=(?!=))/;
  for(const bad of ['r.data = x','r.data += x','r.jpeg_base64=x','port.postMessage(x)','access.sendCommand(x)'])assert.ok(mutation.test(bad));assert.ok(!mutation.test('typeof r?.data==="string"'));
  for(const p of located){assert.ok(p.condition.endsWith(',false)'));new Function(`return ${p.condition}`);assert.ok(!mutation.test(p.condition),'conditions never drive/replace transport');}
  const response=located.find(p=>p.needle.includes('const {r,response_received_ms}'));assert.equal(response.offset,1);assert.equal(sources['recording.mjs'].split('\n')[response.lineNumber].trim(),'if (prep) assertPreparing(s);');assert.ok(!response.needle.includes('received=true'));
  const messages=[],condition=new Function('token','s','r','response_received_ms','performance','console',`return ${response.condition}`);assert.equal(condition({identity:{record_id:'rec',host_epoch:'host'},request_id:'shot',purpose:'final'},{origin:10},{data:'jpeg'},42,{now:()=>53},{info:v=>messages.push(v)}),false);assert.equal(JSON.parse(messages[0].slice(8)).response_received_ms,42);
  assert.throws(()=>locateLogpoints({...sources,'recording.mjs':''}));assert.throws(()=>locateLogpoints({...sources,'recording.mjs':sources['recording.mjs'].replace('const {r,response_received_ms}=await bounded(raw,budget(s),prep ? s.cancel.promise : s.abort.promise);\n\t\t\tif (prep) assertPreparing(s);','const {r,response_received_ms}=await bounded(raw,budget(s),prep ? s.cancel.promise : s.abort.promise);\nthrow 0;')}));
  assert.ok(sources['recording.mjs'].includes('s.access.sendCommand("Page.captureScreenshot",{format:"jpeg",quality:s.config.jpeg_quality,fromSurface:true,captureBeyondViewport:false})'));
});
function syntheticLogs(m){const identity=m.identity,origin=5000,logs=[];
  for(const n of [1,2,3]){logs.push({kind:'request',identity,request_id:'prep'+n,purpose:'preparation',origin:null,request_started_ms:null},{kind:'response',identity,request_id:'prep'+n,purpose:'preparation'});}
  logs.push({kind:'native_control',identity,method:'record.stop',id:99,sw_ms:origin+m.end.stop_requested_ms-1});
  for(const f of m.frames){const o=f.observation;logs.push({kind:'request',identity,request_id:o.request_id,purpose:o.purpose,origin,request_started_ms:o.request_started_ms,sw_ms:origin+o.request_started_ms,options:{format:'jpeg',quality:m.config.jpeg_quality,fromSurface:true,captureBeyondViewport:false}},{kind:'response',identity,request_id:o.request_id,purpose:o.purpose,response_received_ms:o.response_received_ms,data_length:296},{kind:'native_send',identity,method:'record.frame',id:'sw-'+f.seq,seq:f.seq,observation:o,data_length:296});}
  return logs;
}
test('source proof checks actual ownership associations, stop FINAL, exact clock and deadline; synthetic only',async()=>{
  const m=JSON.parse(await readFile(join(repo,'tests/fixtures/recording-v2/manifest.json'))),logs=syntheticLogs(m);assert.equal(verifySource(m,logs).pass,true);
  const copy=()=>structuredClone(logs);
  let bad=copy();bad.find(l=>l.kind==='request'&&l.purpose==='final').request_started_ms--;assert.throws(()=>verifySource(m,bad));
  bad=copy();bad.find(l=>l.kind==='request'&&l.purpose==='final').sw_ms=0;assert.throws(()=>verifySource(m,bad));
  bad=copy();bad.find(l=>l.kind==='native_send').observation.request_id='forged';assert.throws(()=>verifySource(m,bad));
  bad=copy();bad.find(l=>l.kind==='response'&&l.purpose==='final').data_length++;assert.throws(()=>verifySource(m,bad));
  bad=copy();bad.push(bad.find(l=>l.kind==='request'));assert.throws(()=>verifySource(m,bad));
  const deadline=structuredClone(m);deadline.frames.pop();deadline.end={...deadline.end,reason:'deadline',final_seq:1,duration_ms:1500,stop_requested_ms:null,final_observation:{disposition:'not_requested'},counters:{...deadline.end.counters,requests_started:1,responses_received:1,frames_sent:1}};
  const dl=syntheticLogs(deadline);assert.equal(verifySource(deadline,dl).pass,true);deadline.frames[0].observation.request_started_ms=1500;assert.throws(()=>verifySource(deadline,dl));
});
test('readonly RPC rejects protocol/JSON/length/EOF errors cleanly; caller finally always runs',async()=>{
  const root=await mkdtemp('/tmp/apv2rpc-');
  try{for(const [name,response] of [['ok',{result:{ok:true,data:{ready:2}}}],['no-frames',{error:{code:'RECORD_NO_FRAMES'}}],['json','not-json'],['cap',Buffer.from([1,0,64,0])],['eof',null]]){
    const path=join(root,name+'.sock'),server=createServer(socket=>socket.once('data',()=>{if(response===null){socket.end();return;}const body=typeof response==='string'?Buffer.from(response):Buffer.from(JSON.stringify(response)),h=Buffer.alloc(4);h.writeUInt32LE(body.length);socket.end(Buffer.isBuffer(response)?response:Buffer.concat([h,body]));}));await new Promise(r=>server.listen(path,r));let finalized=false;
    try{const call=(async()=>{try{return await readonlyRPC(path,'record.manifest',{identity:{host_epoch:'host',record_id:'rec'}},1000);}finally{finalized=true;}})();if(name==='ok')assert.deepEqual(await call,{ready:2});else await assert.rejects(call,name==='no-frames'?/RECORD_NO_FRAMES/:undefined);assert.equal(finalized,true);}finally{await new Promise(r=>server.close(r));}
  }}finally{await rm(root,{recursive:true,force:true});}
});
test('unmodified audited fixture and no scroll claim; failure checkpoint precedes EVERY recovery RPC',async()=>{
  const harness=await readFile(join(repo,'tests/recording-live-v2.mjs'),'utf8');assert.ok(harness.includes("const html=await readFile(join(repo,'tests/recording-live-fixture.html'),'utf8');"));assert.ok(harness.includes('67b6c24963b0703b25b5d77cf6ac50dbbe03d59617659d0cbd8fd8c6c64f03df'));assert.ok(!harness.includes('min-height:1400px'));assert.ok(!harness.includes("type:'mouseWheel'"));assert.ok(harness.includes('live_scroll_exercised:false'));
  const failure=harness.slice(harness.indexOf('}catch(e){report.status='));assert.ok(failure.indexOf("await checkpoint('failure-before-recovery')")<failure.indexOf('if(!activeHandle'));assert.ok(harness.includes("await checkpoint('scenario-'+scenario.name)"));assert.ok(harness.includes("'--timeout','15'"));assert.ok(harness.includes('assert.equal(dom.innerWidth,metrics.cssLayoutViewport.clientWidth)'));
});
test('actual binary CLI syntax for EVERY live form, private empty IPC only; named --params, no browser',async()=>{
  const root=await mkdtemp('/tmp/apv2syntax-'),instance='00000000-0000-4000-8000-000000000000',h=instance+':host_test:record_test',font='/System/Library/Fonts/STHeiti Medium.ttc',out=join(root,'caller 空 格.mp4');
  const env={...process.env,HOME:root,TMPDIR:root};delete env.AP_BROWSER_REMOTE;delete env.AP_BROWSER_INSTANCE;
  const cases=[['ping'],['tabs','list'],['--tab','7','eval','fixtureState()'],...['Page.getLayoutMetrics','Input.dispatchMouseEvent'].map(method=>cdpArgs(7,method,method==='Page.getLayoutMetrics'?{}:{type:'mousePressed',x:100,y:100,button:'left',clickCount:1})),
    ...[[],['--region','80,100,640,360'],['--element','#arena']].map(select=>['--tab','7','record','start','--max-duration','15s','--capture-fps','1','--jpeg-quality','80','--label','project=竞技','--label','build='+PRODUCT_HEAD.slice(0,8),'--label','run=LIVEV2','--label','attempt=element-repeat','--run-id','live-v2',...select]),
    ['record','start','--max-duration','3500ms','--capture-fps','2'],['record','status',h],['record','stop',h],['record','release',h],['record','phase',h,'--text','运动阶段'],['record','mark',h,'--text','STEP +1','--duration','1s'],
    ['record','export',h,'--fps','8','--size','1280','--crf','20','--metadata','--out',out],['record','export',h,'--preset','tiny','--fps','2','--watermark','task','--font',font,'--metadata','--out',out.replace('.mp4','.gif')],['record','export',h,'--preset','compact','--fps','2','--watermark','task','--font',font,'--metadata','--out',out.replace('.mp4','.mov')],['record','export',h,'--out',out],
    ['record','watermark',join(root,'absent.mp4'),'--sidecar',join(root,'absent.metadata.json'),'--watermark-config',join(root,'absent-template.json'),'--font',font,'--label','project=竞技','--fps','4','--metadata','--out',out]];
  try{for(const args of cases){let r;try{await exec(join(repo,'target/debug/ap-browser'),['--profile',instance,'--timeout','1','--wait-online','0',...args],{env,cwd:root,timeout:7000});assert.fail('private empty profile/file unexpectedly worked');}catch(e){r=e;}
    assert.notEqual(r.code,2,`clap syntax rejected ${JSON.stringify(args)}: ${r.stderr}`);assert.ok([1,7].includes(r.code),JSON.stringify({args,code:r.code,stdout:r.stdout,stderr:r.stderr}));assert.equal(JSON.parse(r.stdout).ok,false);}
    assert.deepEqual(cdpArgs(7,'Page.getLayoutMetrics',{}),['--tab','7','cdp','Page.getLayoutMetrics','--params','{}']);
  }finally{await rm(root,{recursive:true,force:true});}
});
