// Test-only offline invariants and read-only logpoint definitions for genuine v2 LIVE.
import assert from 'node:assert/strict';
import {createConnection} from 'node:net';
export async function readonlyRPC(socketPath,method,params,timeout=5000){
  assert.ok(['record.capabilities','record.manifest'].includes(method));const socket=createConnection(socketPath);
  try{return await new Promise((resolve,reject)=>{
    let bytes=Buffer.alloc(0);socket.setTimeout(timeout,()=>reject(Error('readonly RPC deadline')));socket.on('error',reject);socket.on('end',()=>reject(Error('readonly RPC EOF')));
    socket.on('connect',()=>{const b=Buffer.from(JSON.stringify({jsonrpc:'2.0',method,params})),h=Buffer.alloc(4);h.writeUInt32LE(b.length);socket.write(Buffer.concat([h,b]));});
    socket.on('data',b=>{try{
      bytes=Buffer.concat([bytes,b]);if(bytes.length<4)return;const n=bytes.readUInt32LE(0);if(n>4194304)return reject(Error('readonly response cap'));if(bytes.length<n+4)return;
      const r=JSON.parse(bytes.subarray(4,n+4));if(r.result?.ok!==true)return reject(Error(JSON.stringify(r)));resolve(r.result.data);
    }catch(e){reject(e);}});
  });}finally{socket.destroy();}
}
export const PRODUCT_HEAD='1d9726ff3a6ed14b2ed0280039e57af198f9a3fe';
export const BACKEND='cdp_capture_screenshot';
export const crop=Object.freeze({x:80,y:100,width:640,height:360});
export const cdpArgs=(tab,method,params)=>['--tab',String(tab),'cdp',method,'--params',JSON.stringify(params)];
export function pinnedTab(r,instance,url){
  assert.equal(r?.ok,true);assert.equal(r.meta?.profile?.instance_id,instance);
  assert.ok(Array.isArray(r.data?.tabs)&&!('profiles' in r.data),'explicit-profile DIRECT tabs body');
  assert.ok(r.data.tabs.every(t=>Number.isSafeInteger(t.id)&&typeof t.url==='string'));
  const matches=r.data.tabs.filter(t=>t.url===url);assert.equal(matches.length,1);return matches[0].id;
}
export function capabilities(c){assert.deepEqual(c,{host:{protocol_version:2,backend:BACKEND},extension:{protocol_version:2,backend:BACKEND},legacy_v1_read_only:true});}
// Conditions only read source locals and console.info bounded metadata; never patch
// sendCommand/transport, retain image strings, pause, mutate page or invoke producer.
const log=(kind,fields)=>`(console.info("LIVE_V2 "+JSON.stringify({kind:${JSON.stringify(kind)},${fields}})),false)`;
export const logpoints=[
  {file:'recording-guard.mjs',needle:'const screenshot = method === "Page.captureScreenshot";',condition:'((method==="Page.captureScreenshot"||/Emulation\\.|[Ss]creencast/.test(method))&&console.info("LIVE_V2 "+JSON.stringify({kind:"actual_cdp",method,options:params,tab_id:source.tabId,owned_token:typeof token==="symbol",sw_ms:performance.now()})),false)'},
  {file:'recording.mjs',needle:'try { invocation=s.access.sendCommand("Page.captureScreenshot"',condition:log('request','identity:token.identity,request_id:token.request_id,purpose:token.purpose,request_started_ms,origin:s.origin,sw_ms:performance.now(),options:{format:"jpeg",quality:s.config.jpeg_quality,fromSurface:true,captureBeyondViewport:false}')},
  {file:'recording.mjs',needle:'const {r,response_received_ms}=await bounded(',offset:1,next:'if (prep) assertPreparing(s);',condition:log('response','identity:token.identity,request_id:token.request_id,purpose:token.purpose,response_received_ms,origin:s.origin,sw_ms:performance.now(),data_length:typeof r?.data==="string"?r.data.length:null')},
  {file:'background.js',needle:'try { port.postMessage({ id, method, params }); onSent?.(); }',condition:log('native_send','id,method,identity:params?.identity,seq:params?.seq,observation:params?.observation,end:params?.end,data_length:typeof params?.jpeg_base64==="string"?params.jpeg_base64.length:null')},
  {file:'background.js',needle:'if (!msg || typeof msg !== "object") return;',condition:'(["record.start","record.stop","record.capabilities"].includes(msg?.method)&&console.info("LIVE_V2 "+JSON.stringify({kind:"native_control",id:msg.id,method:msg.method,identity:msg.params?.identity,params:msg.method==="record.capabilities"?msg.params:undefined,sw_ms:performance.now()})),false)'},
];
export function locateLogpoints(sources){return logpoints.map(p=>{const lines=sources[p.file].split('\n'),matches=lines.flatMap((l,i)=>l.includes(p.needle)?[i]:[]);assert.equal(matches.length,1,`unique audited anchor ${p.needle}`);const lineNumber=matches[0]+(p.offset??0);if(p.next)assert.ok(lines[lineNumber].includes(p.next),'response logpoint must be in outer capture frame AFTER await, not callback closure');return {...p,lineNumber};});}
export function observations(events){return events.filter(e=>e.method==='Runtime.consoleAPICalled').flatMap(e=>e.params.args).filter(a=>typeof a.value==='string'&&a.value.startsWith('LIVE_V2 ')).map(a=>JSON.parse(a.value.slice(8)));}
export function verifySource(m,logs){
  assert.equal(m.protocol_version,2);assert.equal(m.backend,BACKEND);assert.equal(m.state,'sealed');assert.equal(m.clock.source,'extension_performance');assert.equal(m.clock.origin,'before_first_recorded_screenshot_request');
  const same=i=>i?.host_epoch===m.identity.host_epoch&&i?.record_id===m.identity.record_id;
  const own=logs.filter(l=>same(l.identity)),requests=own.filter(l=>l.kind==='request'),responses=own.filter(l=>l.kind==='response');
  const prep=requests.filter(l=>l.purpose==='preparation'),recorded=requests.filter(l=>l.purpose!=='preparation');
  assert.ok(prep.length>=2,'real repeated screenshot preparation');assert.equal(new Set(requests.map(l=>l.request_id)).size,requests.length);
  assert.equal(recorded.length,m.end.counters.requests_started);assert.equal(responses.filter(l=>l.purpose!=='preparation').length,m.end.counters.responses_received);assert.equal(prep.length,m.end.counters.preparation_requests);
  assert.equal(m.end.counters.preparation_responses,responses.filter(l=>l.purpose==='preparation').length);
  let previous=0;
  for(const f of m.frames){const o=f.observation,r=recorded.filter(r=>r.request_id===o.request_id),cb=responses.filter(r=>r.request_id===o.request_id),send=own.filter(r=>r.kind==='native_send'&&r.method==='record.frame'&&r.seq===f.seq);
    assert.equal(r.length,1);assert.equal(cb.length,1);assert.equal(send.length,1);assert.equal(cb[0].response_received_ms,o.response_received_ms);assert.equal(r[0].purpose,o.purpose);assert.equal(r[0].request_started_ms,o.request_started_ms);assert.deepEqual(send[0].observation,o);assert.equal(send[0].data_length,cb[0].data_length);assert.ok(Number.isSafeInteger(send[0].id)||typeof send[0].id==='string');
    assert.deepEqual(r[0].options,{format:'jpeg',quality:m.config.jpeg_quality,fromSurface:true,captureBeyondViewport:false});
    assert.ok(previous<=o.request_started_ms&&o.request_started_ms<=o.response_received_ms&&o.response_received_ms===f.t_ms&&f.t_ms<=o.geometry_validated_ms&&o.geometry_validated_ms<=m.config.max_duration_ms);previous=o.geometry_validated_ms;
    assert.equal(f.geometry.before.emulation,'fresh_known_unemulated');assert.equal(f.geometry.after.emulation,'fresh_known_unemulated');
  }
  const final=m.frames.filter(f=>f.observation.purpose==='final');
  if(m.end.reason==='stopped'){
    assert.equal(final.length,1);assert.equal(final[0],m.frames.at(-1));assert.ok(final[0].observation.request_started_ms>=m.end.stop_requested_ms);assert.equal(m.end.duration_ms,final[0].observation.geometry_validated_ms);assert.deepEqual(m.end.final_observation,{disposition:'accepted',request_id:final[0].observation.request_id,seq:final[0].seq});
    const stop=own.filter(l=>l.kind==='native_control'&&l.method==='record.stop');assert.equal(stop.length,1,'genuine explicit stop control');const request=requests.find(r=>r.request_id===final[0].observation.request_id);assert.ok(request.sw_ms>=stop[0].sw_ms&&request.origin+request.request_started_ms>=stop[0].sw_ms,'real FINAL invocation after actual stop control on SAME SW clock');
  }else{assert.equal(m.end.reason,'deadline');assert.equal(final.length,0);assert.deepEqual(m.end.final_observation,{disposition:'not_requested'});assert.equal(m.end.stop_requested_ms,null);assert.equal(m.end.duration_ms,m.config.max_duration_ms);}
  assert.ok(recorded.every(r=>r.request_started_ms<m.config.max_duration_ms),'no post-cap request');
  const span=m.frames.at(-1).t_ms-m.frames[0].t_ms;
  return {pass:true,preparation_requests:prep.length,requested_source_fps:m.config.capture_fps,observations:m.frames.length,actual_observation_fps:span>0?(m.frames.length-1)*1000/span:null,requests:recorded.length,responses:responses.length-prep.length,counters:m.end.counters,final:m.end.final_observation,clock:m.clock,correlation:'immutable screenshot request token/owned callback -> genuine native frame RPC -> durable source; native RPC id is NOT Chrome-internal CDP id; logpoint sw_ms diagnostic only'};
}
