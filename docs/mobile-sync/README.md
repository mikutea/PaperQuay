# PaperQuay 手机、平板与账号同步

本方案面向可长期使用、可维护、可恢复的产品质量。完整目标是让 iPhone、Android 手机、iPad 和 Android 平板拥有与桌面端相同的业务能力，并按触控、屏幕和系统限制重新组织界面。阅读、笔记、划线和独立调用大模型 API 是核心能力。

**当前阶段：M1–M4 主体实现已合入；M5 按正常使用主流程收尾。** Windows 桌面、Web 与 Android 均纳入本轮交付。账号连接、阅读位置、笔记与富文本、文件交换、外部文库、受控电脑任务，以及雷达、Agent、问答、综述与图谱已集成；各轮实现与验证记录保留在下方文档。

2026-11-10 的 [PR #55](https://github.com/mikutea/PaperQuay/pull/55) 修复 Zotero 无版本头 304 的确认读取；[PR #57](https://github.com/mikutea/PaperQuay/pull/57) 修复桌面 Agent 结束时覆盖最终结果和主题可读性；[PR #58](https://github.com/mikutea/PaperQuay/pull/58) 修复阅读布局变化后 PDF 缩放过小。浅色与深色模式均已实际查看，细节见 [补充记录](m5-automated-checkpoint-20261110.md)。

本轮以登录回到应用、跨端同步、阅读标记、保存重开、常用模型／解析和基本备份恢复为结项标准。一台可用 Android 手机完成日常主流程即可；四类设备全覆盖、正式 T24、完整恢复预算与所有提供方矩阵不再是本轮硬门槛。iOS 原生安装仍需签名／分发入口和可用设备，保持未交付记录。完整范围见 [当前验收标准](acceptance.md)。

| 文档 | 用途 |
| --- | --- |
| [M4 模型Agent检查点](m4-agent-model-checkpoint.md) | 明确模型请求、上下文/分支、送审、恢复与原生证据 |
| [M4 本机Agent检查点](m4-agent-checkpoint.md) | 四规则、真实差异、原子审批和本机回执 |
| [M4 雷达检查点](m4-radar-checkpoint.md) | 当前雷达实现、原生矩阵、产物和未完成门槛 |
| [M4 桌面业务对齐](m4-business.md) | 实际雷达、问答、综述、图谱与批次入口，以及尚未完成的验收 |
| [完整文库、会话与远程任务](m3-full-library.md) | 本轮实际入口、数据保真、预算与恢复边界 |
| [M3 集成检查点](m3-integration-checkpoint.md) | 本轮自动化、审查、工具阻塞及剩余阶段门槛 |
| [完整功能清单](requirements.md) | 功能边界、目标阶段及可观察结果 |
| [开发计划](plan.md) | 实施顺序、依赖、交付物和退出条件 |
| [验收标准](acceptance.md) | 正常、异常、数据恢复、安全与实机门槛 |
| [协议与架构](architecture.md) | 跨端实体、同步规则、身份及平台边界 |
| [可视化计划](index.html) | 在浏览器中查看阶段与需求矩阵 |
| [M1 验收记录](qa/README.md) | 真实服务、离线冲突、账号隔离与视觉证据 |
| [M2 验证记录](qa/m2.md) | 阅读、AI、原生适配与自动化边界 |
| [M2 检查点](m2-checkpoint.md) | 当前实现、回归结果与剩余门槛 |
| [M3 文件交换](library-transfer.md) | JSON / Markdown、BibTeX / RIS 和 DOI 查询的范围、格式和平台行为 |
| [M3 首批检查点](m3-checkpoint.md) | 原子导入、真实下载、双客户端同步与扫描 PDF 回归 |
| [M3 书目检查点](m3-bibliography-checkpoint.md) | 字段转换、无 DOI 去重、查询取消和本轮 339 项移动端回归 |
| [M3 私有云检查点](m3-cloud-checkpoint.md) | 显式 PDF 上传、跨客户端读取、独立配额、删除与撤销、375 项移动端回归 |
| [私有云 PDF 使用与协议](private-cloud-pdf.md) | 开关、操作入口、保存/删除边界与部署限制 |
| [按版本打开全文](pdf-sources.md) | 四种来源的顺序、等待上限、回退原因与取消边界 |
| [M3 全文来源检查点](m3-sources-checkpoint.md) | 同版本读取、异步与事务保护、跨客户端和 Electron 验证 |
| [同账号在线电脑取文件](desktop-pdf.md) | 桌面登录、选定附件发布、临时转发与停止提供 |
| [M3 桌面文件检查点](m3-desktop-checkpoint.md) | 真实 Electron/OIDC/文件传输、连接边界与剩余验收 |
| [设备直连协议](direct-transfer-contract.md) | 同租约信令、短期授权、DataChannel 与中继回退 |
| [M3 直连检查点](m3-direct-checkpoint.md) | 本轮真实传输、故障回退与剩余验收状态 |
| [外部文库快照映射](external-library.md) | 来源身份、字段更新、显式关联与本机持久化边界 |
| [M3 外部库检查点](m3-external-checkpoint.md) | 原子保存、重复导入、跨客户端同步与故障恢复证据 |
| [版本绑定的解析包](parsed-documents.md) | 格式、来源证据、导出/导入与独立缓存边界 |
| [M3 解析阅读检查点](m3-parsed-checkpoint.md) | 自动化与移动合成包证据、桌面真实闭环待验收原因 |
| [用解析文本询问 AI](parsed-ai.md) | 明确发送范围、内容限制、引用与版本变更 |
| [M3 解析 AI 检查点](m3-parsed-ai-checkpoint.md) | 实际 HTTP、取消、包替换/清理、笔记同步与焦点证据 |

代码入口为 [`apps/mobile`](../../apps/mobile/README.md)、[`server`](../../server/README.md)、[`packages/sync-core`](../../packages/sync-core/README.md) 与 [`electron/backend`](../../electron/backend)。手机文库和平板笔记已连接真实 OIDC 与 PostgreSQL；已验证独立客户端同步、离线保存、冲突后继续编辑及完整人工合并。桌面已使用白名单投影发布选定文献和附件版本，尚未接入旧 Reader 的双向同步。

## 已确定的产品决策

- 服务器默认保存账号、文库元数据、个人记录和必要的文本衍生数据，不自动保存整个 PDF 文库。
- 阅读时按版本寻找可用全文：已验证的临时缓存、同账号在线电脑、用户主动上传的私有云副本、用户填写的公开链接。各来源与整次获取均有上限；不会无限等待电脑。
- 手机和平板默认不保留整库 PDF。临时文件和内存缓存不可完全避免，但可查看和清理；离线保存须用户主动选择。
- 电脑开着不等于一定可连接，必须登录并明确开启选定 PDF 的提供。支持时先尝试设备直连；失败后在同一次请求内转临时中继，中继占用服务器带宽、不留存 PDF。默认没有 STUN，仅尝试本地对端；公网连通性需另行验收。
- 移动 AI 可使用用户在该设备配置的外部模型 API，电脑离线不影响这条路线。API 密钥不进入普通账号同步。
- 同步以记录和版本为单位；不同版本的 PDF 不自动继承页码、划线和坐标。并发正文保留双方，删除与恢复明确分开。
- 既有 WebDAV 备份、可信局域网共享和本地库继续独立工作。新功能不自动接管旧库或上传旧数据。

## 已知基线与边界

方案初始基线为 `6e137a3d81e3f1198766c9d199c9c68440dff7f3`；M2 从 M1 合并后的 `main` 提交 `98eb84e36d8e5746d5a1433398de8572f0163de6` 开始。现有桌面端存在 SQLite 文库、localStorage 阅读历史、独立笔记与 radar 状态；这些内容不能原样打包成同步协议。

旧阅读坐标没有历史文件 hash 证据时只能保留为未验证记录；不能用当前文件 hash 猜测旧坐标属于哪个版本。富文本笔记的真值是 `contentJson`，M1 不将其压平为 Markdown 后回写。

2026-11-06：原启动 SQLite 路径交换 P2 已由 [PR #42](https://github.com/mikutea/PaperQuay/pull/42) 的目录句柄／VFS 边界修复，并通过准确提交的八项 CI 与两类审查，详见 [SQLite 路径边界](../sqlite-open-boundary.md)。原生 HTTPS 回调与域名关联配置见 [原生链接](native-links.md)。签名、实机、外部提供方和生产服务链仍按各自验收项记录。

本轮开发在隔离工作树和合成数据上进行。生产部署、域名、证书和运维记录在仓库外管理；容量和真实设备验收按实际结果记录。未验证的原生包、外网链路、性能和恢复能力均不得标为通过。

2026-10-29 最新续作：[系统分享设计与使用](incoming-share.md) · [验证及未完成门槛](m3-incoming-checkpoint.md)。
