import {test} from 'node:test';
import assert from 'node:assert/strict';
import {waitNativeReady} from './recording-live-readiness.mjs';
test('delayed hello/socket and one ping consume the same monotonic readiness budget',async()=>{
  let clock=0,calls=0;const result=await waitNativeReady({timeoutMs:300,now:()=>clock,sleep:async ms=>{clock+=ms;},observe:async()=>clock>=200?{instance:'owned',socket:'private'}:null,ping:async(native,remaining)=>{calls++;assert.equal(native.instance,'owned');assert.equal(remaining,100);clock+=35;return {instance:'owned',pong:true};}});
  assert.equal(calls,1);assert.equal(result.elapsed_ms,235);assert.equal(result.observed_after_ms,200);assert.equal(result.ping_elapsed_ms,35);
});
test('never-ready socket expires without ping or a renewed wait',async()=>{
  let clock=0,calls=0;await assert.rejects(waitNativeReady({timeoutMs:200,now:()=>clock,sleep:async ms=>{clock+=ms;},observe:async()=>null,ping:async()=>{calls++;}}),/shared deadline/);assert.equal(clock,200);assert.equal(calls,0);
});
test('a ping cannot silently renew an exhausted observation budget',async()=>{
  let clock=0;await assert.rejects(waitNativeReady({timeoutMs:100,now:()=>clock,sleep:async ms=>{clock+=ms;},observe:async()=>clock>=75?{instance:'owned'}:null,ping:async(_,remaining)=>{assert.equal(remaining,25);clock+=26;}}),/during ping/);
});
