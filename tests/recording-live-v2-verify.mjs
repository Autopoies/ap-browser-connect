#!/usr/bin/env node
// READ-ONLY replay of originals. Never launches Chrome/native/CLI or rewrites receipt.
import assert from 'node:assert/strict';
import {readFile,stat} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {PRODUCT_HEAD,verifySource,observations} from './recording-live-v2-helpers.mjs';
import {inspectRenderedTail,decodeState} from './recording-state-oracle.mjs';
const exec=promisify(execFile),hash=b=>createHash('sha256').update(b).digest('hex'),repo=fileURLToPath(new URL('../',import.meta.url));
assert.equal(process.argv.length,3,'usage: node tests/recording-live-v2-verify.mjs /absolute/live-v2.json');
const receipt=JSON.parse(await readFile(process.argv[2]));assert.equal(receipt.tested_product_head,PRODUCT_HEAD);
for(const [path,digest] of Object.entries(receipt.harness_files)){assert.equal(hash(await readFile(join(repo,path))),digest,'exact executed harness bytes');}
assert.equal(receipt.functional_source_delta.exit_code,0);assert.equal(receipt.functional_source_after.exit_code,0);
assert.equal(receipt.source_native_immutable_after_run,true);assert.equal(receipt.native_staging.status,'pass');assert.equal(receipt.host_exited,true);assert.equal(receipt.browser_exited,true);assert.equal(receipt.owned_profile_removed,true);assert.deepEqual(receipt.owned_processes_after_cleanup,[]);
const observer=JSON.parse(await readFile(join(receipt.artifacts_dir,'observer.json')));assert.deepEqual(observer.pauses,[]);assert.deepEqual(observer.observations,receipt.actual_observations);
const reconstructed=(await exec('git',['show',`${PRODUCT_HEAD}:extension/background.js`],{cwd:repo,maxBuffer:1024*1024})).stdout.replace('const NATIVE_HOST_NAME = "com.apbrowser.connect";',`const NATIVE_HOST_NAME = "${receipt.extension.alias}";`);assert.equal(hash(reconstructed),receipt.extension.staged.find(f=>f.path==='background.js').sha256);
const sourceChecks=[];
for(const source of receipt.sources??[]){const m=JSON.parse(await readFile(source.manifest_path)),spool=await readFile(source.spool_path);assert.deepEqual(m,source.manifest);assert.equal(hash(spool),m.spool_sha256);assert.equal(spool.length,m.spool_bytes);
  for(const f of m.frames){const file=source.files.find(x=>x.seq===f.seq),b=await readFile(file.path);assert.equal(hash(b),f.sha256);assert.deepEqual(b,spool.subarray(f.offset,f.offset+f.length));const p=JSON.parse((await exec('ffprobe',['-v','error','-show_streams','-of','json',file.path])).stdout);assert.equal(p.streams[0].width,f.width);assert.equal(p.streams[0].height,f.height);}
  if(m.state==='sealed'){verifySource(m,receipt.actual_observations);if(m.end.reason==='stopped'){const last=source.files.at(-1),f=m.frames.at(-1),rgb=(await exec('ffmpeg',['-v','error','-i',last.path,'-frames:v','1','-f','rawvideo','-pix_fmt','rgb24','pipe:1'],{encoding:'buffer',maxBuffer:12*1024*1024})).stdout;assert.deepEqual(decodeState(rgb,{width:f.width,height:f.height,crop:{x:0,y:0,width:f.width,height:f.height}}),{score:4,mode:'HOLD'});}}
  sourceChecks.push({path:source.manifest_path,state:m.state,reason:m.end.reason,frames:m.frames.length,spool_sha256:hash(spool)});
}
const videos=[];
for(const a of receipt.artifacts){assert.equal(hash(await readFile(a.path)),a.sha256);assert.equal((await stat(a.path)).size,a.bytes);const independent=await exec('python3',['-c','import importlib.util,json,sys; s=importlib.util.spec_from_file_location("check",sys.argv[1]); m=importlib.util.module_from_spec(s); s.loader.exec_module(m); from pathlib import Path; print(json.dumps(m.check(Path(sys.argv[2]))))',join(repo,'tests/recording-artifacts-check.py'),a.metadata_path],{env:{...process.env,PYTHONDONTWRITEBYTECODE:'1'}});const m=JSON.parse(await readFile(a.metadata_path));if(a.final_rendered_state){const source=JSON.parse(m.source_manifest_json),tail=await inspectRenderedTail(a.path,{width:m.width,height:m.height,crop:source.frames[0].geometry.crop_css,duration_ms:m.duration_ms},{score:4,mode:'HOLD'});assert.equal(tail.pass,true);assert.deepEqual(tail,a.final_rendered_state);}videos.push(JSON.parse(independent.stdout));}
if(receipt.status==='pass'){assert.equal(receipt.real_native_chain,true);assert.equal(receipt.scenarios.length,7);assert.ok(receipt.scenarios.every(s=>s.status==='pass'));assert.ok(receipt.artifacts.length>=10);assert.ok(receipt.logpoints_removed);}
console.log(JSON.stringify({status:receipt.status==='pass'?'pass':'blocked',scope:'readonly original evidence replay; never upgrades a failed/incomplete live run',head:receipt.head,sources:sourceChecks,videos},null,2));
