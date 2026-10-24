import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import type { TestContext } from 'node:test';
import { HandoffConsent, HANDOFF_QUESTION_MS } from '../src/handoff-consent.js';
import { ToolStore } from '../src/tool-store.js';
import { assessQuota, observeQuota } from '../src/quota.js';
import { baseTime, fixture, errorCode } from './helpers.js';

function setup(t: TestContext) {
  const f=fixture(t), store=new ToolStore(path.join(f.root,'consent.sqlite')); f.onCleanup(()=>store.close());
  let now=baseTime, used=72;
  const quota=()=>assessQuota(observeQuota({ordinaryUsageAllowed:true,rateLimits:{spendControlReached:false,
    primary:{usedPercent:used,windowDurationMins:300,resetsAt:Math.floor(now/1000)+3600},
    secondary:{usedPercent:10,windowDurationMins:10080,resetsAt:Math.floor(now/1000)+604800}}},now,now),undefined,now);
  const gate=new HandoffConsent(store,quota,()=>now), task={taskId:'task-a',conversationId:'original-chat',title:'Known authorized task'};
  return {store,gate,task,advance:(ms:number)=>{now+=ms;},recover:()=>{used=1;store.noteConsentRecovery(++now);},low:()=>{used=72;}};
}
test('explicit acceptance allows only the bound task and conversation without waiting',async t=>{
  const f=setup(t); let calls=0;
  assert.throws(()=>f.gate.assertAllowed(f.task.taskId,f.task.conversationId),errorCode('HANDOFF_CONFIRMATION_REQUIRED'));
  assert((await f.gate.confirm(f.task,async()=>{calls++;return 'handoff';})).allowed);
  await f.gate.confirm(f.task,async()=>{calls++;return 'decline';});assert.equal(calls,1);
  assert.throws(()=>f.gate.assertAllowed('task-b',f.task.conversationId),errorCode('HANDOFF_CONFIRMATION_REQUIRED'));
  assert.throws(()=>f.gate.assertAllowed(f.task.taskId,'other-chat'),errorCode('HANDOFF_CONFIRMATION_REQUIRED'));
});
test('unanswered question defaults to handoff only after the full 30 seconds',async t=>{
  const f=setup(t); const result=await f.gate.confirm(f.task,async offer=>{
    assert.equal(offer.deadlineAt-offer.createdAt,HANDOFF_QUESTION_MS);f.advance(30_000);return 'timeout';});
  assert(result.allowed);assert.equal(result.record?.reason,'unanswered-30s-default-handoff');
});
test('early timeout, missing UI and transport failure never imply user silence',async t=>{
  for(const mode of ['early','missing','error'] as const){const f=setup(t);const result=await f.gate.confirm({...f.task,taskId:mode},
    mode==='missing'?undefined:async()=>{if(mode==='error')throw Error('disconnected');return 'timeout';});
    assert.equal(result.allowed,false);assert.equal(result.record?.phase,'unavailable');}
});
test('decline and cancel persist across duplicates and database connections; explicit reconsider asks again',async t=>{
  const f=setup(t);let calls=0;await f.gate.confirm(f.task,async()=>{calls++;return 'decline';});
  await f.gate.confirm(f.task,async()=>{calls++;return 'handoff';});assert.equal(calls,1);
  assert.equal(f.gate.status(f.task.taskId,f.task.conversationId).nextAction,'handoff-declined');
  const same=new HandoffConsent(f.store,()=>({state:'ready',allowWork:false,allowHandoff:true} as any));
  assert.equal(same.current(f.task.taskId,f.task.conversationId)?.phase,'declined');
  const cancelled=await f.gate.confirm({...f.task,reconsider:true},async()=>{calls++;return 'cancelled';});assert.equal(cancelled.allowed,false);
  const accepted=await f.gate.confirm({...f.task,reconsider:true},async()=>{calls++;return 'handoff';});assert(accepted.allowed);assert.equal(calls,3);
});
test('concurrent calls show one question and an interrupted origin cannot auto approve',async t=>{
  const f=setup(t), controller=new AbortController();let finish!:(value:'timeout')=>void,calls=0;
  const a=f.gate.confirm(f.task,async()=>{calls++;return new Promise(resolve=>{finish=resolve;});},controller.signal);
  const b=await f.gate.confirm(f.task,async()=>{calls++;return 'handoff';});assert.equal(b.record?.phase,'waiting');assert.equal(calls,1);
  f.advance(30_000);controller.abort();finish('timeout');const result=await a;assert.equal(result.allowed,false);assert.equal(result.record?.phase,'interrupted');
});
test('actual healthy observation rearms the next threshold episode, without a timer reasking a refusal',async t=>{
  const f=setup(t);await f.gate.confirm(f.task,async()=> 'decline');f.advance(600_000);
  assert.equal(f.gate.status(f.task.taskId,f.task.conversationId).record?.phase,'declined');
  f.recover();assert.equal(f.gate.current(f.task.taskId,f.task.conversationId),null);f.low();
  assert((await f.gate.confirm(f.task,async()=> 'handoff')).allowed);
});
