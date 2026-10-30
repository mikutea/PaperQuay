import type {FeatureInspection} from './inspector.ts';
export type FeatureAction='library'|'notes'|'sync'|'conflicts'|'transfer'|'incoming'|'cloud'|'remote'|'zotero'|'research'|'review'|'graph'|'ai-settings'|'exports';
export type FeatureState='available'|'conditional'|'partial'|'unavailable'|'planned'|'managed';
export type FeatureMode='local'|'service'|'computer'|'external'|'mixed'|'operator';
export interface FeatureRow {id:string;title:string;group:'account'|'library'|'sync'|'reading'|'notes'|'ai'|'research'|'operations';mode:FeatureMode;state:FeatureState;reason:string;action?:FeatureAction}
export interface FeatureEnvironment {
 ready:boolean;online:boolean;needsLogin:boolean;native:boolean;nativeAuthentication:boolean;webRtc:boolean;
 secretPersistence:'memory'|'system'|null;incomingShare:boolean;localOrganization:boolean;localRichNotes:boolean;localAiConversations:boolean;
 modelRuntime:boolean;cloudClient:boolean;desktopClient:boolean;remoteClient:boolean;aiConfigured:boolean;inspection:FeatureInspection;now:number;
}
export const featureGroups={account:'账号与隐私',library:'文库与导入',sync:'同步与恢复',reading:'文件与阅读',notes:'笔记与批注',ai:'模型与问答',research:'研究工作',operations:'服务与版本'} as const;
export const featureStateLabels:Record<FeatureState,string>={available:'本机支持',conditional:'需要准备',partial:'部分接入',unavailable:'当前不可用',planned:'尚未接入',managed:'由部署方提供'};
export const featureModeLabels:Record<FeatureMode,string>={local:'在此设备',service:'同步服务',computer:'在线电脑',external:'外部服务',mixed:'本机与服务',operator:'管理端'};
export function presentProfiles(env:FeatureEnvironment):{parse:number;index:number;computers:number;stale:boolean}{
 const i=env.inspection,checked=Date.parse(i.providersCheckedAt??''),ttl=(i.service?.remoteTasks?.providerPresenceSeconds??0)*1000;
 const fresh=Number.isFinite(checked)&&env.now>=checked&&env.now<checked+ttl;
 const providers=fresh?i.providers.filter(p=>Date.parse(p.expiresAt)>env.now):[];
 return{parse:providers.flatMap(p=>p.profiles).filter(p=>p.kind==='parse').length,index:providers.flatMap(p=>p.profiles).filter(p=>p.kind==='index').length,computers:providers.length,stale:Boolean(i.providersCheckedAt)&&(!fresh||(i.providers.length>0&&!providers.length))};
}
export function capabilityCatalog(e:FeatureEnvironment):FeatureRow[]{
 const rows:FeatureRow[]=[],i=e.inspection,s=i.status==='ready'?i.service:null,present=presentProfiles(e);
 const add=(id:string,title:string,group:FeatureRow['group'],mode:FeatureMode,state:FeatureState,reason:string,action?:FeatureAction)=>rows.push({id,title,group,mode,state,reason,...(action?{action}:{})});
 const local=(id:string,title:string,group:FeatureRow['group'],reason:string,action?:FeatureAction)=>add(id,title,group,'local',e.ready?'available':'unavailable',e.ready?reason:'先登录并打开此账号在本机的文库副本。',e.ready?action:undefined);
 const gate=()=>!e.ready?'请先打开当前账号。':e.needsLogin?'登录已过期，请重新登录；已保存的本机内容仍可使用。':!e.online?'此设备当前离线，远程操作需恢复连接。':null;
 const remote=(id:string,title:string,group:FeatureRow['group'],mode:FeatureMode,support:boolean|null,reason:string,action?:FeatureAction)=>{
  const blocked=gate();add(id,title,group,mode,blocked||support===false?'unavailable':'conditional',blocked??(support===false?'最近一次检查中，服务尚未开放此能力。':support===null?'尚未成功核对此服务，请使用上方检查功能。':reason),!blocked&&support===true?action:undefined);
 };
 add('ACC-01','登录与身份验证','account',e.native?'mixed':'service',e.native&&!e.nativeAuthentication?'unavailable':'conditional',e.native&&!e.nativeAuthentication?'此原生容器缺少系统浏览器登录组件。':'登录、密码找回与多因素验证由你连接的身份服务提供；当前登录状态不保证服务始终在线。','sync');
 local('ACC-02','账号与文库隔离','account','此账号的本机文库、缓存和待同步改动独立保存。切换账号后需重新检查远程能力。','sync');
 remote('ACC-03','设备与会话管理','account','service',s?true:null,'可在账号页读取登录设备并明确撤销会话；已离线的设备不能被即时擦除。','sync');
 add('ACC-04','令牌与模型密钥存储','account','local',e.secretPersistence==='system'?'available':e.secretPersistence==='memory'?'partial':'unavailable',e.secretPersistence==='system'?'本次运行使用系统安全存储。密钥不会随笔记和会话同步。':e.secretPersistence==='memory'?'本次运行仅在内存保留密钥，刷新后需重新填写；浏览器不会将密钥保存到本地存储。':'本次运行尚未提供可用的密钥存储。');
 add('ACC-05','个人数据导出与注销','account','mixed','partial','可明确导出文库与笔记；账号注销和离线设备远程擦除尚未接入。',e.ready?'transfer':undefined);
 add('ACC-06','账号开通与服务规则','account','operator','managed','账号开通、注册规则、恢复渠道与隐私说明由自托管服务的管理员提供。');
 local('LIB-01','文库浏览、搜索与筛选','library','可离线浏览此账号已保存的题录并搜索、筛选；另一设备尚未同步的内容不会自动出现。','library');
 add('LIB-02','集合、标签、收藏与阅读队列','library','mixed',!e.ready?'unavailable':e.localOrganization?'available':'partial',!e.ready?'请先打开本机文库。':e.localOrganization?'可维护已支持的分类、阅读状态与队列；联网后按当前服务能力同步。':s?.paperOrganization?'服务已声明分类支持，当前连接尚未协商；退出后重新登录可核对更新。题录仍可浏览。':'题录可浏览；分类字段需要服务支持，尚未核对时不声称可跨端维护。',e.ready?'library':undefined);
 local('LIB-03','文件、DOI、链接与系统分享导入','library',e.incomingShare?'可预览本机系统分享、书目文件或DOI后明确导入；普通网页不会自动当作全文。':'可选择书目文件或明确查询DOI；此运行环境未提供原生系统分享接收，使用文件导入作为回退。',e.incomingShare?'incoming':'transfer');
 local('LIB-04','题录编辑与书目导出','library','可编辑本机题录并导出受支持的书目格式；系统分享是否被目标应用接收由系统确认。','transfer');
 add('LIB-05','Zotero与外部文库','library','mixed',e.ready?'conditional':'unavailable',e.ready?'可导入外部库快照；Zotero增量读取需联网、明确选择个人/群组库并配置凭据。映射保留在导入设备。':'请先打开本机文库。',e.ready?(e.modelRuntime&&e.online&&!e.needsLogin?'zotero':'transfer'):undefined);
 local('LIB-06','PDF附件与版本','library','可保存并区分文献附件版本；全文可用性、长度与摘要在打开具体版本时核验。','library');
 remote('SYN-01','增量同步与重开继续','sync','service',s?true:null,'此服务已声明协议支持；请在账号页同步以确认本次连接与实际数据。','sync');
 local('SYN-02','本机保存与待同步改动','sync','本机事务确认保存后才显示成功；离线改动保留，服务端是否接收以同步状态为准。','sync');
 local('SYN-03','同一改动的安全重试','sync','重试复用原改动标识；服务端回执仍需成功同步确认，不能把本机保存当作云端已接收。','sync');
 local('SYN-04','同步冲突保留与处理','sync','已收到的冲突可查看并明确选择；提交解决方案需要有效登录和网络。','conflicts');
 local('SYN-05','删除与明确恢复','sync','已删除记录保留恢复边界，旧离线编辑不会自动恢复它；跨端结果以同步回执为准。','library');
 local('SYN-06','按设备与版本接续阅读','sync','可使用已保存或已同步的位置；选择其他设备位置时不会让当前阅读器突然跳页。','library');
 add('SYN-07','桌面旧数据接入','sync','mixed','partial','支持白名单投影与无损文件交换；无法识别的映射、历史格式和笔记会保留并明确跳过。完整桌面业务对照仍未完成。',e.ready?'transfer':undefined);
 local('SYN-08','查看保存、同步和失败状态','sync','本机已保存、待同步、冲突和登录过期分别显示；重试需明确操作。','sync');
 local('PDF-01','按需公开全文','reading','可明确输入真正的PDF链接并核验内容；链接可能失效、需要登录或被跨域限制，失败后仍可使用题录和笔记。','library');
 remote('PDF-02','从同账号电脑取PDF','reading','computer',s?Boolean(s.desktopPdf):null,'服务已开放电脑文件传输；电脑须在线并明确公开该附件。打开具体版本时才核对文件是否可取。','library');
 remote('PDF-03','设备直连与临时中继','reading','computer',s?Boolean(s.desktopPdf):null,s?.desktopPdf?.direct?(e.webRtc?'此设备具备WebRTC接口，可尝试服务已声明的直连；失败后按同一请求回退中继，实际公网可达性未由本页测试。':'此运行环境没有WebRTC直连接口，使用服务已开放的临时中继。'):'服务未声明直连，使用已开放的临时中继；实际文件权限和预算在取文件时核对。','library');
 remote('PDF-04','可选私有云副本','reading','service',s?Boolean(s.cloudPdf):null,'可进入副本管理核对配额并主动上传或删除；本页检查不会上传PDF。','cloud');
 local('PDF-05','临时缓存与主动离线保留','reading','支持查看和清理本机缓存；某份PDF是否已完整保存需在该文献中核对，不会预取整库。','library');
 local('PDF-06','文件内容与版本核验','reading','打开全文时核验类型、长度和摘要；未知或不同版本不自动套用旧坐标。','library');
 local('READ-01','PDF阅读与定位','reading','已有可用PDF后可使用目录、页码、缩放、搜索和文字选择；本页没有读取任何全文。','library');
 local('READ-02','解析文本、公式、表格与图片','reading','需导入或下载当前版本已核验的解析包；没有解析包时仍可使用PDF，不会伪造解析内容。','library');
 local('READ-03','手机、平板与横竖屏布局','reading','界面按当前视口组织阅读与工具面板；系统输入法、动态字体及不同实机仍需各自验证。','library');
 add('READ-04','大文件与弱网处理','reading','mixed','partial','已有取消、重试和按需页面渲染；受限来源可能需要完整下载，持续内存与不同实机的性能尚未全部验证。');
 local('NOTE-01','划线、区域与文字批注','notes','需先打开核验过的PDF版本；批注绑定该版本的页码与坐标，引用可回跳。','library');
 add('NOTE-02','Markdown与富文本笔记','notes','mixed',!e.ready?'unavailable':e.localRichNotes?'available':'partial',e.localRichNotes?'当前本机可使用已支持的富文本、公式、图片与表格；服务同步仍按协商能力进行。':s?.richNotes?'服务已声明富文本支持，当前连接尚未协商。退出后重新登录再同步，才能补取此前隐藏的内容；Markdown仍可用。':'Markdown笔记可用；完整富文本需服务支持或此账号已有离线能力记录。',e.ready?'notes':undefined);
 local('NOTE-03','自动保存与重新打开','notes','编辑器区分尚未保存与已经确认落盘；离开时会保留未保存保护，系统异常前未确认的内容不承诺恢复。','notes');
 local('NOTE-04','文献笔记、引用与批注汇总','notes','可查看、筛选和明确导出本机已有的笔记与批注；未下载或未同步的内容不会凭空补齐。','exports');
 add('AI-01','独立模型API配置','ai','external',!e.ready?'unavailable':e.aiConfigured?'conditional':'unavailable',!e.ready?'请先打开本机账号。':e.aiConfigured?'本账号已填写模型配置；有效密钥、连通性、可用模型与费用仍需在设置中明确确认。':'尚未为此账号填写有效模型配置。可在设置中配置服务和模型。',e.ready?'ai-settings':undefined);
 for(const [id,title,reason]of [['AI-02','选段解释、翻译与提问','使用前核对选段与发送预览；缺少实际文本时不能发送。'],['AI-03','单篇文献问答与摘要','需当前版本已取得的选段或解析文本；题录摘要不等于全文。']])add(id,title,'ai','external',!e.ready||!e.aiConfigured?'unavailable':'conditional',e.aiConfigured?reason+' 连接与密钥尚未由本页测试。':'先配置本账号模型，再打开具体文献准备文本。',e.ready?(e.aiConfigured?'library':'ai-settings'):undefined);
 add('AI-04','会话、问题模板与跨端继续','ai','mixed',!e.ready?'unavailable':e.localAiConversations?'available':'partial',e.localAiConversations?'本机已有同步会话能力；继续使用会话保存的原文，密钥不随会话同步。':s?.aiConversations?'服务已声明会话支持，当前连接尚未协商。退出后重新登录再同步，才能补取此前隐藏的会话。':'本机问答记录可保留；跨端会话与模板需要服务支持，尚未核对时不声称已经同步。',e.ready?'ai-settings':undefined);
 local('AI-05','取消、失败与费用提示','ai','生成时可停止等待；外部处理可能仍有费用。实际用量和未知费用分别呈现，检查能力不会调用模型。','ai-settings');
 remote('AI-06','远程解析与向量索引','ai','computer',s?Boolean(s.remoteTasks):null,i.providersError?'电脑配置本次未确认：'+i.providersError:present.computers?'最近检查可见解析配置 '+present.parse+' 个、索引配置 '+present.index+' 个；每类任务仍需相应电脑在线、来源和配额有效。':present.stale?'上次电脑信息已过期，请重新检查；现有任务仍可在任务页查询。':'暂未发现有效的电脑执行配置。请在同账号电脑上明确开启后重新检查。','remote');
 add('AI-07','电脑模型与专用网关','ai','mixed','partial','自定义兼容API可自行填写服务地址；专用电脑模型能力、网关授权与故障回退尚未接入，不能由一个地址推断已经支持。',e.ready?'ai-settings':undefined);
 add('PAR-01','文献雷达与推荐证据','research','mixed','partial','收藏、阅读状态与队列已有入口；雷达主题、推荐来源与证据业务尚未接入。',e.ready?'library':undefined);
 add('PAR-02','多篇问答与Agent','research','mixed',!e.ready?'unavailable':'partial','已接入多来源片段选择、实际发送预览、引用核对和结果保存；Agent工具审批、远程检索与委托执行尚未接入。',e.ready?'research':undefined);
 add('PAR-03','综述章节与引文核对','research','mixed',e.ready&&e.modelRuntime?'partial':'unavailable',e.ready&&e.modelRuntime?'已接入文献与笔记材料、蓝图和章节编辑、分段断点、引文校验及Word导出；真实外部模型、实机与桌面对应业务验收仍待完成。':!e.ready?'先登录并打开此账号在本机的文库副本。':'当前运行环境未提供模型与综述工作区，本机文库和笔记仍可访问。',e.ready&&e.modelRuntime?'review':undefined);
 add('PAR-04','知识图谱','research','local',e.ready?'partial':'unavailable',e.ready?'可触控浏览当前账号的文献、笔记链接、标签、按名称重建的分类与共同作者，检索、查看关系来源并导出JSON。桌面私有参考文献/向量/自定义关系尚未同步，真实材料与设备验收仍待。':'先打开此账号在本机的文库副本。',e.ready?'graph':undefined);
 const batchSupport=s?Boolean(s.remoteTasks):null;
 remote('PAR-05','持久批次与长任务','research','computer',batchSupport,i.batch==='unsupported'?'服务尚不支持安全的批次查询与取消，请升级后再用批次；单份远程任务仍可查询。':i.batch!=='supported'?'本次尚未确认批次查询与取消能力，请重新检查；不会自动提交或恢复任务。':'批次查询与取消已确认。提交仍需在线电脑配置、已同步版本及配额；进度保存在此设备，关闭后不会自动继续。','remote');
 if(rows.at(-1)?.id==='PAR-05'&&batchSupport&&i.batch==='unsupported'&&!gate())rows[rows.length-1].state='partial';
 local('PAR-06','功能能力与回退说明','research','本页显示每项功能的执行位置、准备条件和未接入原因；服务与电脑状态可明确重新检查。');
 add('OPS-01','服务授权、限制与审计','operations','operator','managed','客户端按账号发起操作；服务的实际对象授权、限流和审计配置由部署方负责，本页不执行安全验收。');
 add('OPS-02','备份与灾难恢复','operations','operator','planned','完整数据库、身份配置和密钥的备份恢复演练尚未作为本产品交付完成；文件导出不能替代灾难恢复。');
 add('OPS-03','正式升级与回滚','operations','operator','planned','正式版本的迁移、升级和回滚流程尚未验收完成；此页不会安装更新。');
 add('OPS-04','健康、容量与持续监测','operations','operator','partial','可在相应管理页查看任务与副本额度；持续监测、告警和容量承诺需部署方配置并实测。');
 add('OPS-05','可访问性与系统适配','operations','local','partial','已有明暗主题、键盘焦点、触控目标和减少动画支持；屏幕阅读器、完整动态字体与各实机隐私行为仍需验证。');
 add('OPS-06','正式发布与设备验收','operations','operator','planned','此开发版本尚未完成正式签名、升级与全部目标设备验收。功能存在不等于正式发布已通过。');
 for(const [ids,enabled,reason] of [[
  ['AI-01','AI-02','AI-03','AI-04','AI-05','PAR-02'],e.modelRuntime,'此运行环境未提供独立模型功能，无法从本页打开。'],
  [['PDF-04'],e.cloudClient,'此连接未提供私有副本客户端。'],
  [['PDF-02','PDF-03'],e.desktopClient,'此连接未提供电脑文件传输客户端。'],
  [['AI-06','PAR-05'],e.remoteClient,'此连接未提供远程任务客户端。']] as [string[],boolean,string][]) {
  if(!enabled)for(const row of rows)if(ids.includes(row.id)){row.state='unavailable';row.reason=reason;delete row.action;}
 }
 return rows;
}
