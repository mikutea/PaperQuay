# 系统分享接收与账号导入

2026-10-29：新增 Android SEND 接收、iOS 文档打开和 Share Extension，以及账号页的「处理系统分享」。本轮补上 LIB-03 的原生入口与本机导入流程；Android 编译、MuMu 真实跨应用分享和 Native 持久化已通过，见 [Android 检查点](m3-android-checkpoint.md)；iOS 编译、真实文件提供方与四类实机仍待验收。

## 从系统分享走到文库

1. 在原应用选择 PaperQuay。Android 暂存一项内容；iOS 分享扩展先显示本机预览，由用户点击「保存到待处理」。随后回到 PaperQuay。
2. 登录并打开账号页的「处理系统分享」。列表仅返回文件名、类型、大小、时间；首次点击「预览此分享」才读取原文并持久认领到当前账号。
3. JSON、Markdown、BibTeX、RIS 在本地解析，使用现有文库预览。单一 DOI／doi.org 链接需点击「查询 DOI」，才会向固定 Crossref API 请求题录。普通网页只显示原文，可手工核对并填写 DOI；不自动抓取网页。
4. 核对选择后保存。文献、笔记、outbox 和导入回执在同一账号存储事务提交。已保存的同一项分享重开时显示原结果。原文保留在待处理箱，用户可另行确认移除。

Web 保留既有选文件导入；只有原生插件可用才展示系统分享入口。分享不触发模型、PDF 下载或整库同步上传。

## 原文、账号与重复操作

Native 客户端契约为 PaperQuayIncomingShare 的 list/read/remove/clear 与空载荷 changed 通知。owner 是规范 API 地址和账号 ID 的 SHA-256，原始账号标识、路径和凭据不经过分享桥。首次 read 在返回内容前持久保存认领；正常列表和清理只处理未分配及当前账号副本。切换账号或会话后，旧预览及迟到回调失效。

准备对象保留完整元数据、UTF-8 原文和来源摘要；只能由生产校验器创建。导入再生成冻结的 archive/selection 与请求摘要。Workspace 在事务内先查回执：同来源和同请求返回原 summary；同 sourceId 改内容或选择被拒绝。新请求复核当前预览、能力、容量和账号，随后一次提交所有数据。真实 IndexedDB 中断及提交后丢失返回值均有回归。

回执只含来源 UUID、两个 SHA-256 和九个数值统计，保留在本机账号 Workspace，不进入同步 wire。每账号最多 1024 条，满额拒绝新分享导入并保留原文，不自动淘汰旧回执。此时仍可使用普通文件导入并人工核对重复项。

回执保证同一保留来源的重试幂等；从原应用再次分享、明确移除后重新分享、清理账号本机数据后重导入，均不能据此宣称 OS 级永久 exactly-once。OS 接受的 unassigned 同内容重放仅在待处理箱内去重；不同账号已经认领的内容分别保留。

## Native 边界

| 项目 | 当前限制 |
| --- | --- |
| 待处理容量 | 4 项；文字 64 KiB，单文件 4 MiB，原始内容合计 8 MiB |
| 输入 | 一项 DOI／链接文字，或 UTF-8 JSON、Markdown、BibTeX、RIS；拒绝 PDF、多项分享和非法文件名 |
| Android | 仅授权的 content URI；私有 noBackup AtomicFile；读取槽、超时和取消限制迟到提供方提交 |
| iOS | App 与扩展共用 group.dev.paperquay.mobile.incoming；POSIX 锁、有限读取与原子写；扩展不调用宿主启动私有 API |
| 文档打开 | 只读取 OS 安全范围 URL 或 App 实际 Documents/Inbox，原 URL 不进入 JS；单读取槽与 30 秒提交期限 |
| 损坏存储 | 明确确认清空后先保留损坏快照，再重建；已有损坏备份不覆盖；不删除原文件 |
| 无损内容 | 保留 TAB／CR／LF、BOM 和原始内容摘要；拒绝其他非法控制字符。v2 结构和图片继续走生产校验与浏览器解码 |

原生读取上限约束实际消费和提交；不能据此承诺 OS 提供方内部的分配量或系统调度时间。iOS App Group 的 Developer Portal、签名和 provisioning 尚未配置或验收。

## 实现与核验

客户端在 apps/mobile/src/platform/incomingShare.ts；本地解析和回执在 library/incomingShare.ts、library/incomingReceipt.ts；账号事务在 sync/workspace.ts。App 以稳定账号 owner 取得客户端，以账号/设备/generation/认证主体限制预览生命周期。两个 UI 面板沿用 ReaderSheet 焦点、滚动和字号行为。

结果与环境限制见 [本轮检查点](m3-incoming-checkpoint.md)。原生接入依据 [Capacitor Android](https://capacitorjs.com/docs/plugins/android)、[Capacitor iOS](https://capacitorjs.com/docs/plugins/ios) 和 [Apple 共享容器文档](https://developer.apple.com/library/archive/documentation/General/Conceptual/ExtensibilityPG/ExtensionScenarios.html)。
