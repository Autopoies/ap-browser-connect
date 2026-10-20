// Test-only readiness: one monotonic budget covers observation AND one public ping.
export async function waitNativeReady({observe,ping,now=()=>performance.now(),sleep=ms=>new Promise(r=>setTimeout(r,ms)),timeoutMs=10000}){
  if(!(timeoutMs>0&&timeoutMs<=10000))throw Error('readiness budget must be <=10000ms');
  const start=now(),deadline=start+timeoutMs;let observations=0;
  while(now()<deadline){
    const native=await observe();observations++;
    if(native){
      const observed=now(),remaining=deadline-observed;if(remaining<=0)break;
      const response=await ping(native,remaining);
      if(now()>deadline)throw Error('native readiness deadline expired during ping');
      return {native,response,observations,timeout_ms:timeoutMs,observed_after_ms:observed-start,ping_elapsed_ms:now()-observed,elapsed_ms:now()-start};
    }
    await sleep(Math.min(25,Math.max(0,deadline-now())));
  }
  throw Error('native hello/socket readiness exceeded shared deadline');
}
