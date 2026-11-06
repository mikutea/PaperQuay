# M3/M4 必要开发检查点 · 2026-11-04

本轮已补齐已定义的必要代码：旧桌面笔记和题录交换、受控远程检索、图谱来源包，以及实际 Reader 的每设备/每版本阅读位置记录与明确接续。根项目1510/1510、移动端1427/1427、服务单元100/100和三端TypeScript、桌面/移动生产构建已通过。**当前开发候选已核验；真实服务、实机与正式发布验收仍待完成。**

本检查点对应 `a2f762fbe9ac45ddbcc5e925e4641e47846cb811` 之上的本轮工作树；该HEAD和旧APK/ASAR均不能代表全部新功能。原53项[需求](requirements.md)与[验收条件](acceptance.md)保持不变。较早检查点中的日期、失败、计数和当时未完成事项保留，当前状态以本页及其具名证据解释。

## 本轮补充的实际行为

| 范围 | 当前操作与保存结果 | 适用边界 |
| --- | --- | --- |
| 桌面笔记 | 设置中明确发送、关联已有笔记、接收固定版本为新本机副本，处理未知原请求、删除/恢复和冲突；已确认映射可供图谱使用。 | 保留原本机笔记；同名/同UUID不自动绑定。无损富文本、图片和未解析引用按实际内容核验，检查/登录不自动发送。见[笔记检查点](m3-desktop-notes-checkpoint.md)。 |
| 桌面题录与组织字段 | 已确认唯一文献绑定可检查/发布题录，按白名单事务接收并撤销本机采用。收藏、标签、阅读安排、队列和集合有明确账号选择。 | 不从PDF阅读进度推断已读，不按同名重建旧分类编号/层级；附件、原笔记和原页位置保留。见[题录验证](../../../qa/m3/20261104/desktop-paper-exchange/verification.md)。 |
| 多篇问答与Agent远程检索 | 明确选择成功index产物后，由声明支持的账号服务执行有界 `lexical-v1`；保存原请求、结果与来源回执，用户逐片段采用到实际问答或Agent上下文，再单独批准模型发送。 | 检索本身不调用embedding/chat，不重新解析或执行任意命令。命中词项数不代表语义相似度、质量或论证正确；空结果保留为空。见[服务实现](../../../qa/m4/20261104/remote-retrieval/core-server-checkpoint.md)与[移动工作区交付](../../../qa/m4/20261104/remote-retrieval/mobile-ui/README.md)。 |
| 图谱明确交换和来源包 | 自定义/已采纳AI关系可明确发布与接收；已确认笔记端点可参与。桌面参考文献缓存和向量缓存可导出来源包，在移动端核对账号、题录、版本后逐项采用、浏览和导出。 | 缓存来源保持 `pdfVersionVerified:false`。缓存时间、未知时间和包生成时间分开显示；来源失配时隐藏当前边，完整原包仍保留。文件采用不自动上传账号，不生成新AI关系。见[来源捕获](../../../qa/m4/20261104/graph-evidence/core-verification.md)与[移动图谱验收](../../../qa/m4/20261104/graph-evidence/mobile-ui/README.md)。 |
| 实际桌面阅读接续 | 当前native-library PDF完整字节与main进程当前导入附件、账号版本核验一致后，可明确开启本次会话的本机位置记录；发送和来源设备接续分别检查、选择并确认。 | 最近位置可回退，最远位置不回退；无历史坐标猜测或跨版本套用。打开、登录、联网和pull均不自动启用、发送或跳页。实际行为与证据如下。 |

本轮没有发现另一个由原始必需条目、缺失入口和具体最小结果共同证实的新增功能项。[范围复核](../../../qa/m4/20261104/final-scope-closure-review.md)保留各项判断及当时尚在执行的验证，不能据此免除真实材料与桌面业务结果对照。

## 桌面位置：本机保存与账号发送分开确认

Reader工具中的账号位置面板初次打开仅读本机状态。用户明确检查时，实际PDFJS `getData()`计算完整SHA-256、长度和页数，main再核对当前已导入附件及有效账号版本；64MiB以上的证明请求明确不可用。文件名、标题、同路径和历史 `sourceKey` 都不作为内容身份证明。多个合法绑定版本或多个设备位置均默认不选。

明确开启记录后，面板外的实际tracking hook持续接收当前文档的位置事件，先保存账号/文库私有draft，再确认本机保存。最近点按实际事件次序更新；最远点合并已确认本机历史、同版本draft和本次前进/回退事件。每个位置事件不发API、不重复读取/哈希完整PDF。关闭面板保留用户已开启的会话；明确停止、文档/账号/设备/库/能力变化或重启会结束该会话，私有draft保留。

发送仍需新检查与明确确认。发送前固定完整source、capture、opId、entityId、sessionId、deviceSequence和outbox；后续滚动不会替换已暂存或未知操作的载荷。保存未确认时只重试本机保存，不重复发送。旧设备未知请求保留原身份并阻止跨设备改写，当前设备的其他合法操作仍可使用。自己的墓碑需要明确恢复；记录本机位置不会恢复账号记录。

继续阅读先选择设备与确切最近点，main重新核对来源和远端revision，Reader再次核对当前文档后才应用。当前窗口/缩放无法精确到达该规范化位置时，明确报告不可达并恢复此前位置，不把近似位置显示为成功。账号或文档A→B→A、退役访问器和迟到回调不能把旧操作应用到新文档。旧 `paperHistory` 不作猜测迁移，原文件和既有阅读行为保留。

## 当前验证收据

| 层 | 已观察结果 | 证据与限制 |
| --- | --- | --- |
| 根项目完整回归 | **1510/1510**，0失败/跳过 | [run-03根日志](../../../qa/m4/20261104/development-final/run-03/root-tests.log)。run-01中止、run-02的1507/1507及新增隔离回归均保留。 |
| 移动端完整回归 | **1427/1427**，0失败/跳过 | [run-02移动日志](../../../qa/m4/20261104/development-final/run-02/mobile-tests.log)。旧失败和后续复核不覆盖。 |
| 服务端单元 | **100/100** | [run-01服务日志](../../../qa/m4/20261104/development-final/run-01/server-unit-tests.log)。不等于真实OIDC服务链。 |
| 三端TypeScript与两端生产构建 | 根/移动/服务类型检查、根/移动Vite均通过 | [根类型](../../../qa/m4/20261104/development-final/run-03/root-typecheck.log)、[移动类型](../../../qa/m4/20261104/development-final/run-03/mobile-typecheck.log)、[服务类型](../../../qa/m4/20261104/development-final/run-01/server-typecheck.log)、[根构建](../../../qa/m4/20261104/development-final/run-03/root-build.log)、[移动构建](../../../qa/m4/20261104/development-final/run-03/mobile-build.log)。构建保留大chunk提示，未据此验证实机性能。 |
| 阅读core/runtime | **33/33**（9 core、24 runtime） | [冻结报告](../../../qa/m3/20261104/desktop-reading-position/core-runtime-freeze.md)。真实临时native私有文件；API与附件证明适配器为进程内合成数据。 |
| 阅读Reader/controller与父命令 | **23/23**及**7/7** | [Reader/controller](../../../qa/m3/20261104/desktop-reading-position/reader-tracking-run-03.log)、[父命令run-04](../../../qa/m3/20261104/desktop-reading-position/parent-commands-run-04.log)。包含停止后显示归属与迟到停止错误；不替代外部账号/两设备。 |
| 阅读面板hooks与布局 | **37/37**；run-04三显示**60图** | [UI报告](../../../qa/m3/20261104/desktop-reading-position/ui/README.md)。实际组件/样式与合成IPC/Reader；包括不可达提示、停止失败重试和只保存恢复。 |
| 实际PDF/native联合功能与视觉 | 最终run-09 **passed**，13源码哈希匹配、9对PNG/DOM | [run-09报告](../../../qa/m3/20261104/desktop-reading-position/native-runtime/run-09/report.json)：实际PDFJS worker/canvas/getData、当前DOM几何、已导入native附件/SQLite、产品trusted preload/main IPC、实际hook/controller与Panel；身份和fixed-route API为进程内合成响应，0网络。 |
| 图谱移动组件与IndexedDB | run-06四显示**44图**；99项实际源码/CSS输入哈希固定 | [图谱移动报告](../../../qa/m4/20261104/graph-evidence/mobile-ui/README.md)。包括缓存未知时间、epoch-zero、包时间区分、来源失配隐藏及完整原包保留。 |
| Android Native局部持久层 | 检索三显示**54图/12次物理重开**；图谱单轮390px | [检索Native](../../../qa/m4/20261104/remote-retrieval/native/README.md)、[图谱Native](../../../qa/m4/20261104/graph-evidence/native/README.md)。实际Capacitor SQLite，合成账号/来源，无真实网络；保持各自原范围。 |

最终run-09在run-06/07功能验证之后，补齐真正不同账号B的停止后显示隔离、近页尾回滚精确比例和关闭面板后的Reader截图。旧run-06的7张PNG仍保留合成帧滞后限制；当前图像/DOM和代码以run-09为准。实际行为、失败轮次与独立R1–R9关闭收据见[阅读检查点](m3-desktop-reading-checkpoint.md)和[原生验证说明](../../../qa/m3/20261104/desktop-reading-position/native-runtime/README.md)。

## 当前开发候选

| 候选 | 验证结果与收据 |
| --- | --- |
| [Android调试APK](../../../qa/m4/20261104/development-final/run-03/artifacts/PaperQuay-mobile-m3-m4-development-debug.apk) | 21,403,504字节，SHA-256 `218ec57717185f8cd8a17acfc05b4bcbf34eea1396e48f50d6f3b549813f0641`；141个当前dist文件与APK、Android/iOS public逐字节一致，18个DEX/原生库/manifest条目与此前产品一致。[APK收据](../../../qa/m4/20261104/development-final/run-03/android-artifact.json)。未安装到模拟器或实机。 |
| [Windows开发ASAR](../../../qa/m4/20261104/development-final/run-03/artifacts/PaperQuay-m3-m4-development-app.asar)及同名unpacked目录 | 102,775,699字节，SHA-256 `578a8008a911d63b87b4a09e26ddaece3a1050eecde2d84adcacd374c857643a`；85个runtime源码、77个renderer文件及原生模块与当前源逐字节一致；包内笔记/题录/图谱/阅读、Word、Agent、模型、NativeFS与OIDC依赖实际smoke通过。[ASAR收据](../../../qa/m4/20261104/development-final/run-03/desktop-artifact.json)。未签名、未安装。 |
| 源码包与完整变更补丁 | 与本地提交一并保存；最终路径、提交及文件哈希见[交付说明](../../../qa/m4/20261104/development-final/README.md)和外部manifest，避免在源码包内部记录自身哈希。 |

旧生成资源和APK在替换构建镜像的生成目录前已备份。首次Windows包依赖检查已通过，但验证程序在持有临时NativeFS DLL时清理失败；已改为子进程加载，保留前一候选和失败日志，新候选完整验证与临时目录清理通过。没有更换用户运行中的应用或读取其profile，没有push、发布或生产部署。

旧检查点的调试APK、ASAR与Native收据仍属于各自源码/范围，不自动成为本轮新候选的证据。iOS资源copy不代表Xcode或签名通过。

## 必需范围与后续扩展

PAR-05已有至多16份解析/索引目标的本机持久批次、原requestId查询/恢复和取消预留；后台单任务在账号服务中持久化，同账号另一设备可查看/取消。原批次编组只存在当前账号/设备，不进入同步outbox。

跨设备批次编组、整批接管，以及未列明任务种类的「桌面其他长任务适配」继续记录为后续扩展。它们不追加为本轮新硬门槛，也不能被描述为已经实现。query embedding检索、移动新生成AI关系和未知历史坐标迁移未被本轮最小必需范围新增承诺。

## 仍未通过的外部验收

- **当前真实OIDC/浏览器/Electron服务链19场景：0 / blocked。** API/preview启动拒绝没有通过其他端口、工具或包装器绕过；用户已说明没有可用真实环境，不重复索要。进程内fixed routes、Fastify.inject、真实非OIDC PostgreSQL或旧head结果不能改写此项。
- iPhone、iPad、Android手机、Android平板四类实机，以及现代WebView、实际OS分享/系统浏览器、锁屏/后台终止、弱网/NAT继续分别待验。模拟器真实SQLite重开只证明所测局部。
- 真实Zotero/MinerU、外部模型/embedding、网关/电脑提供者、计费/限流、真实材料和桌面业务结果对照仍待验；合成响应和实际payload结构不能替代这些结果。
- Xcode编译、iOS签名与目标机运行未由资源copy证明。精确提交CI、代码/安全审查、无未处置P1/P2、签名、安装升级/回滚、备份恢复、容量及外网客户端仍按[正式验收条件](acceptance.md)执行。

本轮记录必要代码和所列验证结果。M3/M4阶段验收与正式发布继续保留上述条件；本机构建或新增截图不会把真实服务场景从0改为通过。
