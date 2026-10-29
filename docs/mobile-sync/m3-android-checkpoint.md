# Android 原生构建与 MuMu 检查点 · 2026-10-29

从本地 52e55e551ad34654ee048ecd9a90ed7841db2393 继续。用户授权安装所需开发工具并尝试 MuMu。本轮补上 Android 原生编译、真实跨 UID 系统分享、Native SQLite 和系统安全存储证据；产品变更为两个正式 Android 测试入口及文档，没有修改已提交的运行时实现。M3 仍未完成，M4 未进入。

| 范围 | 实际结果 | 适用边界 |
| --- | --- | --- |
| 独立构建环境 | 发布方 SHA-256 核对后安装 JDK 21.0.12.1+1、SDK command-line tools 22、API 36 rev2、build-tools 35.0.0、platform-tools 37.0.1；Gradle 8.14.3 | 仅任务目录和进程环境；已接受本次 SDK 许可，没有改全局 PATH 或项目 wrapper |
| Android 原生包 | 完整 assembleDebug、assembleDebugAndroidTest、testDebugUnitTest 通过 | 中文路径触发 AGP 限制后，在独立 ASCII 副本构建；没有关闭路径检查 |
| JUnit | 2 个方法通过，其中新增 wrapper 实际执行既有 440 项 Store/Policy 断言 | 440 是断言数，不是 JUnit 方法数 |
| 正式 Native bridge | 真正首次安装（快照尚不存在）1 项设备测试通过，3.656 秒；生产配置页 DOM、Android 插件、WebCrypto、空载荷通知、去重、认领落盘、账号隔离、Activity 重建、非法 owner、明确清理 | 隔离空箱前置；本类首次文本为暖 Intent，冷文件由外部来源 APK 单独验证 |
| 跨应用 OS 分享 | Markdown、JSON、BibTeX、RIS 由独立 UID 的非导出提供方分享，Native 保存后通过生产 TS 解析；真实系统菜单选择 PaperQuay | 来源是可复现的合成提供方，没有真实云盘或外部账号 |
| 拒绝与容量 | 无授权 ClipData、非法文件名、PDF、超限、多项和满箱不覆盖现有数据；提供方计数证明无授权及非法输入没有读取文件 | Android 会为带 EXTRA_STREAM 的分享自动授予读取权限，该控制组不是无授权测试；另有接收侧伪造 flag 检查 |
| Native SQLite | 笔记、outbox、回执原子提交；旧签名重复导入不新增；第三次提交 guard 在 INSERT 后取消并真实 ROLLBACK；新 handle 读取相同状态 | 直接本地 FakeAPI 仅提供两个 register 返回，不启动 HTTP 服务、不使用真实登录凭据 |
| 进程恢复与安全存储 | 第二进程读回相同 Workspace 哈希、回执、原文、账号归属和系统安全存储 witness；全部检查后定向移除两个测试 scope、一个 key 和来源 | 两次 instrumentation PID 为 4501、4727；第一次进程在外部 force-stop 前已退出，之后确认无进程并启动第二阶段；不声称 force-stop 杀死了仍运行的旧 PID |

## 环境、产物与原始失败

新建空白 MuMu 5.30.1.3586 实例 2：PaperQuay-M3-QA-20261029，Android 12 / API 32 / x86_64，WebView 110.0.5481.154.1。只操作其 ADB 127.0.0.1:16448；原实例 0、1 保持停止且未改配置。没有使用 root、全局 ADB kill-server 或连接其他设备。测试完成后正常关闭本次实例并保留磁盘。首次安装复验前已归档本次合成 App 数据（249344 字节），确认 Native scope/key 清理及空箱后才卸载重装本次测试包。模拟器不能代替 Android 手机和平板实机。

原始失败均保留：AGP 中文路径检查；AndroidX ActivityScenario 与 SEND→MAIN 安全重置不匹配，改用无 LAUNCHER category 的显式 MAIN；只读 Java 探针的 Windows stdout 编码，修正为显式 UTF-8；测试源码 setClipData 返回 void 的链式编译错误已修正。一次 QA 文件清理适配器错误复用了文字专用断言，在删除前拒绝；前后快照逐字节相同后改用通用 Native.list，完整文件断言保留。正式测试补审修复了首次安装不存在快照时的误判，以及首个 changed 通知可能污染重复分享等待的窄竞态。没有移除生产安全校验，也没有把失败记录覆盖成通过。

首次 Native 启动记录到 4 条 Capacitor SystemBars 在 DOM 尚未建立时注入 CSS 的已捕获异常。生产配置页正常显示；没有修改 SDK 或全局系统栏策略，不能宣称 Native console 零错误，物理设备安全区、方向和键盘仍需验收。Gradle 现有 flatDir、SDK XML 版本和调试库 strip 警告保留。

基线调试 APK：PaperQuay-52e55e5-android-debug.apk，SHA-256 4920ab61933efa16f5c8ed96d6fef6fdc02d97f05d1c2db31f22a6f704ad1764。Native 数据 QA 使用另存的临时 sidecar APK；脚本、测试 wrapper 和 provider/sink 只在 QA 目录与独立构建副本，未进入正式源码或最终 APK。均为本地调试签名，不代表签名发布或升级验收。

## 证据与复现边界

任务目录 qa/m3/20261029/android-build-emulator 保存安装收据、来源/产物摘要、构建日志、正式 instrumentation、JUnit XML、系统分享菜单截图、原始 Native 快照、提供方计数、生产 TS 交叉校验和两阶段白名单 JSON。原始 debug logcat 可能含本次合成输入与调用参数，不是脱敏公开材料；native-data-run-result.json 与 native-data-verify-result.json 只含固定码、哈希、计数、布尔值和 PID。

正式源码新增 IncomingSharePolicyJUnitTest.java 和 IncomingShareBridgeInstrumentedTest.java。两个文件独立静态补审完成，当前指纹范围无剩余确定 P1/P2；这不是 GitHub 当前 head 的代码/安全审查。后者必须在专用空白实例运行，发现已有内容即拒绝，不提供跳过前置或恢复删除入口。跨应用与 SQLite/安全存储 sidecar 是单独 QA 工具；首次出现未知快照、账号或 key 时停止，不进行自动重试或全箱清理。

本轮最终根项目 928/928、移动端 935/935，均零失败/跳过；两端 TypeScript 与 Vite 生产构建通过。计划页 53 项需求、30 个本地文档目标、7 组文件模式检查、8 组尺寸/字号和 22 张截图；实际复核修改区域的桌面头部、320px/200% 头部及 390px 分享流程，其余布局由几何断言核验。构建体积警告保留。

## 尚未关闭的门槛

Xcode/Swift 编译、签名和 App Group；iPhone、iPad、Android 手机和平板；真实文件提供方和外部账号/计费；最新 Electron/浏览器实际账号服务链及 19 项场景仍待验收。Android 36 是编译目标，本轮运行系统为 API 32。没有推送、合并、发布、生产部署或更换用户正在运行的桌面应用。

自动审批此前拒绝 API4311/预览4317 准备及桌面 API4312 启动，只返回 blocked by policy。本轮未重试、换端口/工具/代理/主机绕过。直接本地 FakeAPI 与 Native 数据验证不替代实际 HTTP/OIDC 服务链。前序结果见 [系统分享检查点](m3-incoming-checkpoint.md)。可见剩余额度 <=50% 时按既有约定保存并停止。
