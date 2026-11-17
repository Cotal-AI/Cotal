import assert from 'node:assert/strict';

/** Diagnostic only: issue stock read-only requests and retain every outcome without retrying it. */
export async function measureDaemonRequests({stage,request,count=50,deadlineMs=180000,now=Date.now}){
 assert(['after-ready','after-update'].includes(stage));
 assert(Number.isInteger(count)&&count>0&&count<=50);
 assert(Number.isInteger(deadlineMs)&&deadlineMs>0&&deadlineMs<=180000);
 const startedAt=now(),rows=[];
 for(let index=0;index<count;index++){
  const remaining=deadlineMs-(now()-startedAt);
  if(remaining<=0)break;
  const before=now();
  let result;
  try { result=await request(`${stage} read-only daemon request ${index+1}`,Math.min(5000,remaining)); }
  catch(error){rows.push({index:index+1,startedAt:new Date(before).toISOString(),finishedAt:new Date(now()).toISOString(),elapsedMs:now()-before,exit:null,error:error.message,enotconn:false,uncertain:true});break;}
  const text=result.stdout+result.stderr;
  rows.push({index:index+1,startedAt:new Date(before).toISOString(),finishedAt:new Date(now()).toISOString(),elapsedMs:now()-before,...result,enotconn:text.includes("could not read the daemon's peer credentials: Socket is not connected")});
 }
 return {stage,requested:count,completed:rows.length,startedAt:new Date(startedAt).toISOString(),finishedAt:new Date(now()).toISOString(),deadlineMs,enotconn:rows.filter(row=>row.enotconn).length,failures:rows.filter(row=>row.exit!==0).length,rows};
}
