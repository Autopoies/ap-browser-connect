import {test} from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile,mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {marker,stateBits,decodeState,assertFinalState,inspectRenderedTail} from './recording-state-oracle.mjs';
const expected={score:4,mode:'HOLD'},crop={x:80,y:100,width:640,height:360};
function synthetic(state=expected,{width=640,height=360,crop:rect=crop,dark=0,light=255}={}){
  const b=Buffer.alloc(width*height*3,40),scale=width/rect.width,bits=stateBits(state);
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    const cx=(x+.5)/scale+rect.x-marker.canvasX-marker.x,cy=(y+.5)/scale+rect.y-marker.canvasY-marker.y;
    if(cx>=0&&cx<24*24&&cy>=0&&cy<48){const v=(bits[Math.floor(cx/24)]^Math.floor(cy/24))?light:dark;b.fill(v,(y*width+x)*3,(y*width+x)*3+3);}
  }return b;
}
const geometry={width:640,height:360,crop};
test('reject absent/black/white/gray/truncated/wrong-state/wrong-crop and checksum corruption',()=>{
  assert.deepEqual(assertFinalState(synthetic(),geometry,expected),expected);
  for(const v of [0,40,128,255])assert.throws(()=>decodeState(Buffer.alloc(640*360*3,v),geometry));
  assert.throws(()=>decodeState(Buffer.alloc(0),geometry));
  assert.throws(()=>assertFinalState(synthetic({score:3,mode:'HOLD'}),geometry,expected));
  assert.throws(()=>assertFinalState(synthetic({score:4,mode:'RUN'}),geometry,expected));
  assert.throws(()=>decodeState(synthetic(),{...geometry,crop:{...crop,x:0,y:0}}));
  const corrupt=synthetic(); // Flip both complementary cells of a score bit: checksum must still reject.
  for(let row=0;row<2;row++)for(let y=78+row*24;y<102+row*24;y++)for(let x=20+8*24;x<44+8*24;x++)for(let c=0;c<3;c++){const i=(y*640+x)*3+c;corrupt[i]=255-corrupt[i];}
  assert.throws(()=>decodeState(corrupt,geometry),/checksum/);
  assert.deepEqual(decodeState(synthetic(expected,{dark:70,light:180}),geometry),expected);
  assert.throws(()=>decodeState(synthetic(expected,{dark:100,light:160}),geometry),/ambiguous/);
});
test('fixture draws matching visible text/marker synchronously without extra RAF/timer after static actions',async()=>{
  const html=await readFile(new URL('./recording-live-fixture.html',import.meta.url),'utf8');
  const rgb=Buffer.alloc(624*344*3),buttons={},order=[];let pending,rafCalls=0;
  const ctx={fillStyle:'',strokeStyle:'',beginPath(){},moveTo(){},lineTo(){},stroke(){},fillText(text){order.push(text);},fillRect(x,y,w,h){
    const color=this.fillStyle==='#ffffff'?[255,255,255]:this.fillStyle==='#000000'?[0,0,0]:[16,32,48];
    for(let yy=y;yy<Math.min(344,y+h);yy++)for(let xx=x;xx<Math.min(624,x+w);xx++){const i=(yy*624+xx)*3;rgb.set(color,i);}
  }};
  const canvas={getContext:()=>ctx},sandbox={innerWidth:1000,innerHeight:600,scrollX:0,scrollY:0,performance:{now:()=>0},addEventListener(){},cancelAnimationFrame(){pending=null;},requestAnimationFrame(fn){rafCalls++;pending=fn;return rafCalls;},document:{querySelector:s=>s==='canvas'?canvas:(buttons[s]??={})}};sandbox.window=sandbox;
  vm.runInNewContext(html.match(/<script>([\s\S]*)<\/script>/)[1],sandbox);
  const g={width:624,height:344,crop:{x:88,y:108,width:624,height:344}};
  assert.deepEqual(decodeState(rgb,g),{score:0,mode:'READY'});
  buttons['#start'].onclick();let fn=pending;pending=null;fn(0);fn=pending;pending=null;fn(2000);
  assert.equal(pending,null);const before=rafCalls;
  for(let i=0;i<4;i++)buttons['#step'].onclick();
  assert.deepEqual(decodeState(rgb,g),expected);assert.equal(order.filter(s=>s.startsWith('STATE')).at(-1),'STATE HOLD  SCORE 4');
  assert.equal(rafCalls,before,'late actions must not schedule an artificial rescuing repaint');
  assert.equal(pending,null);
});
test('diagnostic observer is read-only, tab-filtered and keeps at most two bounded genuine events',async()=>{
  const source=await readFile(new URL('./recording-live-e2e.mjs',import.meta.url),'utf8');
  const fn=source.match(/function observerInstall\(tabId\)\{[\s\S]*?\n\}(?=\nasync function collectProducer)/)[0];
  let listener;const sandbox={chrome:{debugger:{onEvent:{addListener(fn){listener=fn;}}}},performance:{now:()=>17}};
  const install=vm.runInNewContext('('+fn+')',sandbox);install(7);
  // No sendCommand/ACK/controller is available in this sandbox.
  for(let i=0;i<5;i++)listener({tabId:7},'Page.screencastFrame',{data:Buffer.from('jpeg'+i).toString('base64'),metadata:{timestamp:i,deviceWidth:1000,irrelevant:'redact'}});
  const slot=sandbox.__recordingFidelityObserver.slot;assert.equal(slot.received,5);assert.equal(slot.latest.length,2);
  assert.equal(slot.latest[0].event_ordinal,4);assert.equal(slot.latest[1].event_ordinal,5);assert.equal(slot.latest[1].metadata.irrelevant,undefined);
  listener({tabId:8},'Page.screencastFrame',{data:'AAAA'});assert.equal(slot.received,5);
  listener({tabId:7},'Page.screencastFrame',{data:'A'.repeat(5592412)});
  listener({tabId:7},'Page.screencastFrame',{data:'A'.repeat(5592408)}); // decoded >4MiB, even though encoded ceiling fits
  assert.equal(slot.rejected,2);assert.equal(slot.latest.length,2);assert.equal(slot.latest[1].event_ordinal,5);
});
test('exact final presentation gate is red for a wrong final state even after correct earlier frames',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'recording-state-tail-')),path=join(dir,'tail.mp4');
  try{const wrong={score:3,mode:'RUN'};
    const encode=states=>ffmpeg(['-f','rawvideo','-pix_fmt','rgb24','-s','640x360','-r','2','-i','pipe:0','-frames:v',String(states.length),'-c:v','libx264','-crf','25','-pix_fmt','yuv420p','-y',path],Buffer.concat(states.map(s=>synthetic(s))));
    encode([wrong,expected,wrong]);let r=await inspectRenderedTail(path,{...geometry,duration_ms:1500},expected);assert.equal(r.pass,false);assert.deepEqual(r.observations.at(-1).decoded,wrong);
    encode([expected,wrong,expected]);r=await inspectRenderedTail(path,{...geometry,duration_ms:1500},expected);assert.equal(r.pass,true);assert.equal(r.tail_all_match_expected,false);assert.deepEqual(r.observations.at(-1).decoded,expected);
  }finally{await rm(dir,{recursive:true,force:true});}
});
test('live JPEG diagnostic decoder does not seek a still image at zero and yields genuine marker pixels',async()=>{
  const source=await readFile(new URL('./recording-live-e2e.mjs',import.meta.url),'utf8');
  const fn=source.match(/async function frameRGB\(path,t=0\)\{[^\n]+\}/)[0],calls=[];
  const read=vm.runInNewContext('('+fn+')',{assert,command:async(file,args)=>{calls.push(args);const r=spawnSync(file,args,{maxBuffer:8*1024*1024});return {exit_code:r.status,stdout:r.stdout};}});
  const dir=await mkdtemp(join(tmpdir(),'recording-live-jpeg-')),path=join(dir,'source.jpg');
  try{ffmpeg(['-f','rawvideo','-pix_fmt','rgb24','-s','640x360','-i','pipe:0','-frames:v','1','-q:v','2',path],synthetic());
    assert.deepEqual(decodeState(await read(path),geometry),expected);assert.ok(!calls[0].includes('-ss'));
  }finally{await rm(dir,{recursive:true,force:true});}
});
function ffmpeg(args,input){const r=spawnSync('ffmpeg',['-v','error',...args],{input,maxBuffer:8*1024*1024});assert.equal(r.status,0,r.stderr?.toString());return r.stdout;}
test('real lossy H264 and 32-color GIF decode at viewport/crop/scaled coordinates; wrong exported state is red',async()=>{
  const dir=await mkdtemp(join(tmpdir(),'recording-state-oracle-'));
  try{for(const spec of [{name:'viewport',width:1000,height:600,crop:{x:0,y:0,width:1000,height:600}},{name:'region',width:640,height:424,crop},{name:'element',width:640,height:360,crop},{name:'scaled-gif',width:480,height:334,crop}]){
    const gif=spec.name==='scaled-gif',path=join(dir,spec.name+(gif?'.gif':'.mp4'));
    // GIF is genuinely palette quantized to 32 colors, not raw RGB mislabeled GIF.
    const codec=gif?['-filter_complex','[0:v]split[a][b];[a]palettegen=max_colors=32[p];[b][p]paletteuse']:['-c:v','libx264','-crf','25','-pix_fmt','yuv420p'];
    const encodeRGB=rgb=>ffmpeg(['-f','rawvideo','-pix_fmt','rgb24','-s',`${spec.width}x${spec.height}`,'-i','pipe:0','-frames:v','1',...codec,'-y',path],rgb);
    const encode=state=>encodeRGB(synthetic(state,spec));
    const decode=()=>ffmpeg(['-i',path,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1']);
    encode(expected);assert.deepEqual(assertFinalState(decode(),spec,expected),expected);
    assert.equal((await inspectRenderedTail(path,{...spec,duration_ms:100},expected)).pass,true,'exact-ordinal exported-frame extraction must work on installed FFmpeg');
    for(const wrong of [{score:3,mode:'HOLD'},{score:4,mode:'RUN'}]){encode(wrong);assert.throws(()=>assertFinalState(decode(),spec,expected),/RENDERED/);assert.equal((await inspectRenderedTail(path,{...spec,duration_ms:100},expected)).pass,false);}
    for(const fill of [0,40,128,255]){encodeRGB(Buffer.alloc(spec.width*spec.height*3,fill));assert.throws(()=>decodeState(decode(),spec),'encoded absent/black/white must not pass');}
  }}finally{await rm(dir,{recursive:true,force:true});}
});
