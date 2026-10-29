# M3 系统分享续作检查点 · 2026-10-29

从本地 f6bb2dd7990bed4d81a7f93733857da179bc68aa 继续，新增 LIB-03 系统分享接收与账号内导入。分支 feat/mobile-reading-ai-m2；本轮仅本地开发与提交，没有推送、合并、安装、发布或生产部署。M3 仍未完成，M4 未进入。

| 范围 | 本轮实际结果 | 适用限制 |
| --- | --- | --- |
| 根项目 | 串行全量 928/928；TypeScript、Vite 生产构建通过 | 约 434 秒，零失败/跳过；保留既有构建体积警告 |
| 移动端 | 全量 935/935；TypeScript、Vite 生产构建通过 | 包含本轮 54 项新增自动化；不替代 Native 编译与 OS 提供方 |
| 完整账号界面 | 文件模式 Chromium + ConnectedApp，14 组通过 | 真实浏览器 IndexedDB；仅 Native/认证/DOI/API 使用本地契约替身，无实际 HTTP 或服务 |
| Native Android | 440 项纯 Java 断言；实际 Store 输出 4 项 + 非法名 64 项与生产 TS 交叉一致 | 使用已有 JDK25；未取得 Android SDK，未执行完整 Gradle/AGP 编译 |
| Native iOS | plist、PBX 两 target、扩展依赖/嵌入、共享 Store、App Group、OIDC 保留检查通过 | Windows 无 Xcode/Swift 编译，未签名、未装机 |
| 独立补审 | 3 个确定 P2 已修复；当前 32 个文件范围无剩余确定 P1/P2，46/46 定向回归独立通过 | 本地补审，不代表 GitHub 当前 head 的代码/安全审查 |
| 桌面包依赖 | 隔离 win-unpacked/ASAR 构建和真实抽取验证通过，Electron 42.11.9 | 包基于本轮起点 f6bb2dd；没有安装/启动包或进行升级验收，不代表新增 Native 分享已打包 |

14 组界面检查包含首次 Markdown 入库、同来源重开、明确 DOI 查询、普通网页只显示原文、手动 DOI 与明确另存副本、账号切换、完整结构/公式/图片、回执隔离、320px/200% 字号、深色/减少动画、移除确认及焦点恢复。实际 HTTP 请求、账号 API 调用、页面和 console 错误均为零。两次 DOI 查询由本地受控替身返回；不计为 Crossref 联网验收。

计划页同步新增系统分享流程：53 项需求、29 个文档目标、8 组尺寸/字号、22 张截图，6 组自动化检查通过；新流程与放大头部截图已实际复核。

复核修复了文件名契约造成整箱读取失败、缺省回执字段导致首次导入被阻止，以及 iOS 通知与文档提交锁序风险。初轮组件测试仅等待一个事件循环导致 WebCrypto 完成时序不稳定，改为有界等待实际完成条件；生产断言未放宽。界面脚本的 DOI envelope 缺字段和未展开结构预览已修正；原失败记录保留。

证据位于任务目录 qa/m3/20261029/continuation/。主要日志：root-tests-final.log、mobile-tests-final.log、root-types-final.log、root-vite-final.log、mobile-types-final.log、mobile-vite-final.log、incoming-ui-results.json、incoming-ui-expanded-run.log、android-incoming-status.md、ios-project-final-validation.json、incoming-review.md、incoming-review-fingerprints.json、package-build.json、package-verify.log。界面截图与只读构建/验收脚本保存在同目录。实现和使用边界见 [系统分享](incoming-share.md)。

尚未关闭的门槛：Android SDK/受支持 JDK 的完整原生构建；macOS Xcode/签名/App Group 配置；真实 OS 分享冷暖启动及文件提供方；最新实际 Electron/浏览器账号服务链；真实外部账号/计费与此前暂缓的四类实机。Android SDK 未下载，未接受 SDK 许可；用户可提供既有 SDK 路径后再检查环境。

自动审批此前拒绝准备 API4311/预览4317 启动脚本及桌面 API4312 启动，仅返回 blocked by policy，未给原因。没有重试、换端口/工具/代理/主机绕过；本轮文件模式 UI 和现有自动化不替代那 19 项未执行服务链场景。[前序集成证据](m3-integration-checkpoint.md) 保留原日期与适用范围。M3 门槛未完成，继续不进入 M4；可见剩余额度 <=50% 时按既有约定保存并停止。
