import assert from 'node:assert/strict';import {test} from 'node:test';import {readFile} from 'node:fs/promises';
import {capabilityCatalog,presentProfiles,type FeatureEnvironment} from '../src/capabilities/catalog.ts';
import {environment,enabled,now} from './fixtures/featureCapabilities.ts';
const row=(e:FeatureEnvironment,id:string)=>capabilityCatalog(e).find(r=>r.id===id)!;
test('user catalog covers every numbered requirement exactly once and every row has location and reason',async()=>{
 const doc=await readFile(new URL('../../../docs/mobile-sync/requirements.md',import.meta.url),'utf8');const ids=doc.split(String.fromCharCode(10)).filter(line=>line.startsWith('| ')).map(line=>line.split('|')[1].trim()).filter(id=>/^[A-Z]+-[0-9]{2}$/.test(id));const e=enabled(),before=structuredClone(e),rows=capabilityCatalog(e);
 assert.equal(ids.length,53);assert.equal(new Set(rows.map(r=>r.id)).size,53);assert.deepEqual(rows.map(r=>r.id).sort(),ids.sort());assert.ok(rows.every(r=>r.title&&r.reason&&r.mode&&r.state));assert.deepEqual(e,before);
});
test('unread declarations do not become disabled services, live PCs or a verified model',()=>{
 const e=environment();for(const id of ['PDF-02','PDF-03','PDF-04','AI-06','PAR-05']){assert.equal(row(e,id).state,'conditional');assert.match(row(e,id).reason,/尚未成功核对/);assert.equal(row(e,id).action,undefined);}
 assert.equal(row(e,'AI-01').state,'unavailable');assert.match(row(e,'AI-01').reason,/尚未.*模型配置/);assert.equal(row(e,'ACC-04').state,'partial');assert.match(row(e,'ACC-04').reason,/仅在内存/);
 e.aiConfigured=true;assert.equal(row(e,'AI-01').state,'conditional');assert.match(row(e,'AI-01').reason,/连通性.*费用.*明确确认/);
});
test('declaration support never proves every remote profile, file, capacity or unimplemented M4 function',()=>{
 const e=enabled();assert.match(row(e,'AI-06').reason,/解析配置 1 个、索引配置 0 个/);assert.equal(row(e,'AI-06').state,'conditional');
 assert.equal(row(e,'PAR-03').state,'partial');assert.equal(row(e,'PAR-03').action,'review');assert.match(row(e,'PAR-03').reason,/真实外部模型.*待完成/);assert.equal(row(e,'PAR-02').state,'partial');assert.equal(row(e,'PAR-02').action,'agent');assert.match(row(e,'PAR-02').reason,/规则计划.*逐项核对/);assert.match(row(e,'PAR-02').reason,/模型可提出计划.*需预览/);for(const id of ['OPS-02','OPS-03','OPS-06']){assert.equal(row(e,id).state,'planned');assert.equal(row(e,id).action,undefined);}
 assert.equal(row(e,'AI-07').state,'partial');assert.match(row(e,'AI-07').reason,/不能由一个地址推断/);
});
test('presence expires at the observed TTL even with far-future server timestamps, and a backwards clock is never online proof',()=>{
 const e=enabled();assert.deepEqual(presentProfiles(e),{parse:1,index:0,computers:1,stale:false});e.inspection.providers[0].expiresAt='2099-01-01T00:00:00.000Z';e.now+=45000;
 assert.equal(presentProfiles(e).computers,0);assert.match(row(e,'AI-06').reason,/信息已过期/);e.now=now-1;assert.equal(presentProfiles(e).computers,0);
});
test('offline, expired login, unsupported service and absent runtime each give distinct actionable reasons',()=>{
 const e=enabled();e.online=false;assert.match(row(e,'PAR-05').reason,/离线/);assert.equal(row(e,'PAR-05').action,undefined);assert.equal(row(e,'LIB-01').state,'available');
 e.online=true;e.needsLogin=true;assert.match(row(e,'PDF-04').reason,/登录已过期/);assert.equal(row(e,'PDF-04').action,undefined);e.needsLogin=false;e.inspection.service!.cloudPdf=null;assert.match(row(e,'PDF-04').reason,/服务尚未开放/);
 e.remoteClient=false;e.modelRuntime=false;assert.match(row(e,'AI-06').reason,/未提供远程任务客户端/);for(const id of ['AI-01','AI-02','AI-03','AI-04','AI-05','PAR-03'])assert.equal(row(e,id).action,undefined);assert.equal(row(e,'PAR-02').action,'agent');assert.equal(row(e,'PAR-02').state,'partial');assert.match(row(e,'PAR-02').reason,/当前环境未提供模型运行时/);
});
test('old batch endpoints preserve single task recovery and missing WebRTC preserves declared relay fallback',()=>{
 const e=enabled();e.inspection.batch='unsupported';assert.equal(row(e,'PAR-05').state,'partial');assert.match(row(e,'PAR-05').reason,/单份.*仍可查询/);assert.equal(row(e,'PAR-05').action,'remote');assert.match(row(e,'PDF-03').reason,/未声明直连/);
 e.inspection.service!.desktopPdf!.direct={transport:'webrtc-data-v1',attemptMs:6000,maxSdpBytes:32768,stunUrls:[]};assert.match(row(e,'PDF-03').reason,/没有WebRTC.*中继/);e.webRtc=true;assert.match(row(e,'PDF-03').reason,/具备WebRTC接口/);
});

test('a newly declared content schema stays conditional until the workspace connection has negotiated its cursor transition',()=>{
 const e=enabled();e.localOrganization=false;e.localRichNotes=false;e.localAiConversations=false;
 for(const id of ['LIB-02','NOTE-02','AI-04']){assert.equal(row(e,id).state,'partial');assert.match(row(e,id).reason,/当前连接尚未协商/);}
});

test('a freshly checked empty provider list is not misreported as expired evidence',()=>{
 const e=enabled();e.inspection.providers=[];assert.equal(presentProfiles(e).stale,false);assert.match(row(e,'AI-06').reason,/暂未发现有效/);
 e.now+=45000;assert.equal(presentProfiles(e).stale,true);assert.match(row(e,'AI-06').reason,/信息已过期/);
});

test('graph has a local route without model runtime and describes explicit historical desktop source adoption',()=>{const e=enabled();e.modelRuntime=false;e.online=false;assert.equal(row(e,'PAR-04').action,'graph');assert.equal(row(e,'PAR-04').state,'partial');assert.match(row(e,'PAR-04').reason,/桌面可明确交换.*参考文献和缓存向量相似关系通过桌面来源包.*同一账号、题录与版本.*逐项采用/);assert.match(row(e,'PAR-04').reason,/历史缓存仍需回原文核验.*不会自动上传或调用模型.*真实材料和设备验收仍待/);e.ready=false;assert.equal(row(e,'PAR-04').action,undefined);assert.equal(row(e,'PAR-04').state,'unavailable');});

test('gateway capability and private history are explained without inferring provider presence or enabling a missing runtime',()=>{
 const e=enabled();assert.match(row(e,'AI-07').reason,/原请求账本.*当前服务未声明模型调用/);assert.equal(row(e,'AI-07').action,'ai-settings');
 e.modelRuntime=false;assert.equal(row(e,'AI-07').state,'unavailable');assert.equal(row(e,'AI-07').action,undefined);assert.match(row(e,'AI-07').reason,/未提供独立模型功能/);
});

test('graph editing follows negotiated local capability and desktop exchange still requires explicit decisions and real-device acceptance',()=>{const e=enabled();e.localGraphRelations=false;assert.match(row(e,'PAR-04').reason,/关系同步尚未确认/);e.inspection.service!.graphRelations=true;assert.match(row(e,'PAR-04').reason,/服务已声明关系同步/);e.localGraphRelations=true;assert.match(row(e,'PAR-04').reason,/明确创建、编辑、删除及同步/);assert.match(row(e,'PAR-04').reason,/桌面可明确交换自定义与已采纳AI关系/);assert.match(row(e,'PAR-04').reason,/不会自动上传或调用模型.*真实材料和设备验收仍待/);assert.equal(row(e,'PAR-04').state,'partial');});
