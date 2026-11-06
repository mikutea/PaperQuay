import assert from 'node:assert/strict';
import test from 'node:test';
import Fastify from 'fastify';
import {PrivateMetrics,installPrivateMetrics} from '../../src/metrics.ts';
import {testConfig} from '../fixtures.ts';

test('private metrics retain fixed aggregate histograms and retire each completed or aborted request once',()=>{
  let time=0;const metrics=new PrivateMetrics(()=>time),ok={},failed={},aborted={};
  metrics.begin(ok);metrics.begin(ok);metrics.begin(failed);metrics.begin(aborted);time=40;
  metrics.finish(ok,200);metrics.finish(ok,200);metrics.abort(aborted);metrics.abort(aborted);time=1200;metrics.finish(failed,503);
  const value=metrics.snapshot();assert.deepEqual(value.requests,{attempted:3,active:0,completed:2,aborted:1,statusClasses:[0,1,0,0,1]});
  assert.equal(value.latency.counts.reduce((a,b)=>a+b,0),2);assert.equal(value.latency.counts[2],1);assert.equal(value.latency.counts[7],1);
  assert.equal(value.latency.sumMs,1240);assert.equal(value.latency.maxMs,1200);
  assert(value.process.rssBytes>0);assert(value.process.cpuUserMicroseconds>=0);
});

test('real HTTP completion accounts for failures and never stores URL, header, body or request identity sentinels',async()=>{
  const app=Fastify(),metrics=installPrivateMetrics(app,15);
  app.get('/read/:id',async()=>({ok:true}));app.post('/private-note',async()=>({ok:true}));
  app.get('/failure',async(_request,reply)=>reply.code(503).send({error:{code:'SYNTHETIC_FAILURE'}}));
  try {
    await app.inject({url:'/read/private-id-sentinel?token=private-url-sentinel',headers:{authorization:'Bearer private-auth-sentinel'}});
    await app.inject({method:'POST',url:'/private-note',payload:{text:'private-body-sentinel'}});
    await app.inject({url:'/failure'});
    assert.equal((await app.inject({url:'/internal/metrics'})).statusCode,404);
    const snapshot=metrics.snapshot(),wire=JSON.stringify(snapshot);
    assert.deepEqual(snapshot.requests.statusClasses,[0,2,0,1,1]);assert.equal(snapshot.requests.active,0);
    assert(!wire.includes('sentinel'));assert(!wire.includes('authorization'));assert(!wire.includes('private-note'));
  }finally{await app.close();}
});

test('aggregate logging is explicit and its interval cannot become an unbounded or busy loop',()=>{
  assert.equal(testConfig().privateMetricsIntervalSeconds,0);
  for(const value of['15','60','3600'])assert.equal(testConfig({PAPERQUAY_PRIVATE_METRICS_INTERVAL_SECONDS:value}).privateMetricsIntervalSeconds,Number(value));
  for(const value of['-1','1','14','3601','NaN','Infinity','15.5'])assert.throws(()=>testConfig({PAPERQUAY_PRIVATE_METRICS_INTERVAL_SECONDS:value}),{code:'CONFIGURATION_INVALID'});
});
