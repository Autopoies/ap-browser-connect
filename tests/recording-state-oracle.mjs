// Test-only rendered-state oracle. Coordinates are CSS, relative to the canvas.
// Fixture draws these cells synchronously with its visible STATE/SCORE text.
import assert from 'node:assert/strict';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
const exec=promisify(execFile);
export const marker = Object.freeze({x:12,y:70,cell:24,columns:24,rows:2,canvasX:88,canvasY:108});
const modes=['READY','RUN','HOLD'];
const bits=(v,n)=>Array.from({length:n},(_,i)=>(v>>(n-1-i))&1);
export function stateBits({score,mode}) {
  assert.ok(Number.isInteger(score)&&score>=0&&score<=255,'score outside marker range');
  const m=modes.indexOf(mode);assert.ok(m>=0,'unknown mode');
  return [1,0,1,1,0,1,...bits(m,2),...bits(score,8),...bits(score^((m+1)*0x39)^0xa7,8)];
}
// Output image includes an optional appended task strip; scale is content width/crop
// width, NOT total height/crop height. No search/OCR/fixtureState fallback is allowed.
export function decodeState(rgb,{width,height,crop,contentWidth=width}) {
  assert.equal(rgb.length,width*height*3,'missing/truncated RGB frame');
  assert.ok(crop&&crop.width>0&&contentWidth>0);
  const scale=contentWidth/crop.width, cells=[];
  for(let row=0;row<2;row++)for(let col=0;col<24;col++){
    const x=(marker.canvasX+marker.x+col*marker.cell-crop.x)*scale;
    const y=(marker.canvasY+marker.y+row*marker.cell-crop.y)*scale;
    // Ignore outer cell quarters: JPEG/H264 ringing, 4:2:0 edges and GIF scaling.
    const x0=Math.ceil(x+marker.cell*scale*.25),x1=Math.floor(x+marker.cell*scale*.75);
    const y0=Math.ceil(y+marker.cell*scale*.25),y1=Math.floor(y+marker.cell*scale*.75);
    assert.ok(x0>=0&&y0>=0&&x1<width&&y1<height&&x1>=x0&&y1>=y0,'marker outside image');
    let dark=0,light=0,n=0;
    for(let yy=y0;yy<=y1;yy++)for(let xx=x0;xx<=x1;xx++){
      const i=(yy*width+xx)*3,r=rgb[i],g=rgb[i+1],b=rgb[i+2];n++;
      if(Math.max(r,g,b)<=85)dark++;
      if(Math.min(r,g,b)>=170&&Math.max(r,g,b)-Math.min(r,g,b)<=65)light++;
    }
    // Require 90% high-contrast agreement per interior, not a permissive average.
    assert.ok(Math.max(dark,light)/n>=.9,'ambiguous/absent marker cell');
    cells.push(light>dark?1:0);
  }
  const top=cells.slice(0,24),bottom=cells.slice(24);
  assert.ok(top.every((b,i)=>b!==bottom[i]),'marker complement mismatch');
  assert.deepEqual(top.slice(0,6),[1,0,1,1,0,1],'marker guard missing');
  const val=(a)=>a.reduce((n,b)=>n*2+b,0),m=val(top.slice(6,8)),score=val(top.slice(8,16));
  assert.ok(m<3,'invalid marker mode');assert.equal(val(top.slice(16)),score^((m+1)*0x39)^0xa7,'marker checksum mismatch');
  return {score,mode:modes[m]};
}
export function assertFinalState(rgb,geometry,expected){const decoded=decodeState(rgb,geometry);assert.deepEqual(decoded,expected,'final RENDERED state differs from intended final state');return decoded;}
// Decode exact presentation ordinals (including the last), never a screenshot or
// a seek beyond EOF. Called by live harness AND offline verification of originals.
export async function inspectRenderedTail(path,{width,height,crop,duration_ms},expected){
  const {stdout}=await exec('ffprobe',['-v','error','-show_frames','-of','json',path],{timeout:15000,maxBuffer:8*1024*1024});
  const frames=JSON.parse(stdout).frames.filter(f=>f.media_type==='video');
  const tail=frames.map((f,i)=>({i,pts_ms:Number(f.best_effort_timestamp_time)*1000})).filter(f=>f.pts_ms>=duration_ms-1100);
  assert.ok(tail.length,'no final presentation frames');
  const geometry={width,height,crop},observations=[];
  for(const f of tail){
    const {stdout:rgb}=await exec('ffmpeg',['-v','error','-i',path,'-vf',`select='eq(n,${f.i})'`,'-fps_mode','passthrough','-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{encoding:'buffer',timeout:15000,maxBuffer:8*1024*1024});
    try{const decoded=decodeState(rgb,geometry);observations.push({...f,decoded,matches_expected:decoded.score===expected.score&&decoded.mode===expected.mode});}catch(e){observations.push({...f,matches_expected:false,error:e.message});}
  }
  // Final-state fidelity is the gate. Earlier tail samples remain diagnostic;
  // this contract does not invent a stricter maximum update-latency requirement.
  const pass=observations.at(-1).matches_expected;
  return {pass,gate:'last actual presentation frame',tail_all_match_expected:observations.every(f=>f.matches_expected),expected,geometry,tolerances:{dark_max:85,light_min:170,light_channel_spread_max:65,cell_interior_fraction:.5,cell_agreement_min:.9},observations};
}
