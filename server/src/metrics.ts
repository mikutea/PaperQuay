import {performance} from 'node:perf_hooks';
import type {FastifyInstance} from 'fastify';

export const LATENCY_BUCKETS_MS=Object.freeze([10,25,50,100,250,500,1000,2500,5000,15000]);
const increment=(value:number)=>Math.min(Number.MAX_SAFE_INTEGER,value+1);

/** Constant-size aggregates only. There are no route, URL, account, device,
 * request-ID, header, query, body or exception labels to retain or disclose. */
export class PrivateMetrics {
  private readonly started=new WeakMap<object,number>();
  private attempted=0;
  private active=0;
  private completed=0;
  private aborted=0;
  private readonly statuses=[0,0,0,0,0];
  private readonly latency=Array<number>(LATENCY_BUCKETS_MS.length+1).fill(0);
  private durationSum=0;
  private durationMax=0;
  private readonly now:()=>number;
  constructor(now=()=>performance.now()){this.now=now;}
  begin(request:object){if(this.started.has(request))return;this.started.set(request,this.now());this.attempted=increment(this.attempted);this.active=increment(this.active);}
  finish(request:object,status:number){
    const start=this.started.get(request);if(start===undefined)return;
    this.started.delete(request);this.active=Math.max(0,this.active-1);this.completed=increment(this.completed);
    const group=Math.max(1,Math.min(5,Math.floor(status/100)))-1;this.statuses[group]=increment(this.statuses[group]);
    const elapsed=Math.max(0,this.now()-start),duration=Number.isFinite(elapsed)?elapsed:0;
    const index=LATENCY_BUCKETS_MS.findIndex(limit=>duration<=limit),bucket=index<0?LATENCY_BUCKETS_MS.length:index;
    this.latency[bucket]=increment(this.latency[bucket]);this.durationSum=Math.min(Number.MAX_SAFE_INTEGER,this.durationSum+duration);this.durationMax=Math.max(this.durationMax,duration);
  }
  abort(request:object){if(!this.started.has(request))return;this.started.delete(request);this.active=Math.max(0,this.active-1);this.aborted=increment(this.aborted);}
  snapshot(){const memory=process.memoryUsage(),cpu=process.cpuUsage();return {
    format:'paperquay-private-metrics',version:1,at:new Date().toISOString(),uptimeSeconds:process.uptime(),
    requests:{attempted:this.attempted,active:this.active,completed:this.completed,aborted:this.aborted,
      statusClasses:[...this.statuses]},
    latency:{boundsMs:[...LATENCY_BUCKETS_MS],counts:[...this.latency],sumMs:this.durationSum,maxMs:this.durationMax},
    process:{rssBytes:memory.rss,heapUsedBytes:memory.heapUsed,externalBytes:memory.external,
      cpuUserMicroseconds:cpu.user,cpuSystemMicroseconds:cpu.system},
  } as const;}
}

/** Opt-in operator logs, never an HTTP metrics route or client capability. */
export function installPrivateMetrics(app:FastifyInstance,seconds:number) {
  const metrics=new PrivateMetrics();
  app.addHook('onRequest',async request=>{metrics.begin(request);});
  app.addHook('onResponse',async(request,reply)=>{metrics.finish(request,reply.statusCode);});
  app.addHook('onTimeout',async request=>{metrics.abort(request);});
  app.addHook('onRequestAbort',async request=>{metrics.abort(request);});
  let timer:ReturnType<typeof setInterval>|undefined;
  app.addHook('onReady',async()=>{
    const emit=()=>app.log.info({paperquayPrivateMetrics:metrics.snapshot()},'private aggregate metrics');
    emit();timer=setInterval(emit,seconds*1000);timer.unref();
  });
  app.addHook('onClose',async()=>{if(timer)clearInterval(timer);});
  return metrics;
}
