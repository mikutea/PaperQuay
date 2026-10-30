# Android 原生构建与 MuMu 检查点 · 2026-10-29

## 2026-10-30：列表搜索与筛选连续性

文库与笔记的查询/筛选/已删除视图分别保留在当前会话内，经过账号页或编辑/阅读界面返回后保持；身份、账号、服务、设备或本地数据代次改变即清空，旧回调不能改写新会话。登录过期但本地文库可读时仍可搜索。筛选无结果提供一键清除，不再提示创建首篇文献。搜索词不持久化或同步；行为说明见[UI续作](ui-refresh.md)。

本轮新增12项回归，定向19/19；根928/928、移动947/947、两端TypeScript/Vite通过。根项目首次917/928，含10项共享盘watch错误和1项window未定义；仅检查子进程改用文件监听库支持的polling后全过，原日志保留，未改测试或产品配置。无INTERNET权限的独立Native夹具在390/320px各验证7个状态，包括页面间查询、编辑/账号返回、筛选清除、已删除视图、A→B→A与登录过期后本地搜索；全部无脚本错误/横向溢出，合成查询未写入本地偏好或Workspace。

不含夹具的产品APK 18590126B，SHA256 e03971d9ceecda30de5de95403f098ee10f6bd4dcdc290c0213b0ac66ca696f6。111个dist资源逐字节匹配，Manifest/DEX/Native库18项与d46844f包一致，SystemBars native及关闭远程调试保持。专用MuMu2安装后正式Native分享/认证VIEW桥接1项通过（4.152秒）；回执见qa/m3/20261030/list-state。本轮未push或发布；真实OIDC服务链19场景、实机、现代WebView与Xcode等原验收缺口保持，M3未完成、M4未进入。


## 2026-10-30：移动端统一视觉与原生交互验收

已按Apple当前HIG、WWDC26及4个可核实小红书样本重做实际应用配色、布局和反馈。覆盖连接、文库、笔记、账号、AI/导入及阅读工具；使用语义tokens、带名称的图标导航、浮层滚动避让和短横屏侧栏。PDF与批注颜色独立，原Native安全区、权限和认证/分享逻辑未改。设计来源与范围见[UI改版说明](ui-refresh.md)。

本轮根928/928、移动串行935/935通过；最终定向39/39、两端TypeScript/Vite及Android构建通过。独立无INTERNET权限测试包在实际MuMu WebView以320/390/768px视口验证51个新版状态，另保留3个旧版基线；包含真实深色、200%根字号、横屏、减少动画、快速反向导航和触摸取消。全状态无脚本错误/横向溢出，测得的可见按钮与summary均不小于44px。合成认证/API/分享接口不代表真实服务验收。

不含夹具的最终产品APK另通过正式Native分享/认证VIEW回归1项（4.571秒）。APK 18589768B，SHA256 b988264361829f1a5f56ffacea2d7ff74541a155095af840056fed44c61b82ca；与上一轮相比Manifest/DEX/Native库18项字节不变，SystemBars native和关闭WebView远程调试保留。111个dist资源逐字节匹配Native资源，额外仅Cordova生成文件。QA在qa/m3/20261030/ui-refresh，含实拍、失败记录和回执。

本轮未push或发布，未接管桌面用户profile。真实服务链、桌面Electron Reader、真实IME/现代WebView、四类实机及Xcode仍待验收，M3未完成、M4未进入。此前服务链自动审批阻塞未重试或绕过。本地file浏览器通道也因协议权限被拒，改以无联网权限的独立原生包验证本地组件。

## 2026-10-30：认证 VIEW 路由与分享隔离

从19dc492继续，仅扩展正式Android instrumentation，没有修改运行时逻辑。在生产MainActivity上通过真实暖ACTION_VIEW分别打开合成callback和logout URL；App插件各回传一个完全相同的appUrlOpen事件，Activity实例保持相同，分享列表/错误通知与私有空快照不变，HTTP调用0。完整Bridge测试1项/3.894秒通过，包括原有认领/隔离/去重/重建/权限和清理回归。本轮根项目928/928、TypeScript与Vite生产构建通过。

测试使用合成code/state，不是实际OIDC登录、token交换、外部浏览器回跳或服务链验收。证据位于qa/m3/20261030/android-auth-routing。真实身份服务仍受此前blocked by policy限制，本轮未启动或绕过；M3未完成，M4未进入。初始可见剩余额度51%，依约不扩大本轮范围。


## 续作：系统栏注入与真实键盘遮挡

从 30391f985aa39ded690f85ddb539b2eeb24c1b6a 继续，运行时只将 Capacitor 8.5.3 支持的 Android 专用 SystemBars.insetsHandling 设为 native。应用只使用标准 env(safe-area-inset-*)，没有依赖 SDK 注入的 --safe-area-inset-*。原生安全区与 IME padding 保留，跳过 document.documentElement 尚未建立时的 CSS 注入；没有改 SDK、关闭 insets 或降低 WebView 安全配置。

| 检查 | 本轮结果 |
| --- | --- |
| 修复前日志 | 首轮 css 模式复现 3 条注入异常；第二次未出现，属于时序性错误，不声称每次必现 |
| 实际 Native 布局 | 修复前后各 6 个状态全部通过，所有原生窗口几何完全相同；生产配置页、实际 Native bridge、安全上下文、无框架覆盖层、无横向溢出 |
| 真实遮挡键盘 | MuMu 默认输入法仅报告 visible=true、imeBottom=0，该轮不能计作避让验收。另用离线受控 Android InputMethodService，产生 420px / 280dp 实际遮挡；横竖屏聚焦字段可见，输入在旋转后保留 |
| 窗口恢复 | 竖屏 WebView 高度 1564→1144→1564px；横屏 864→444→864px，关闭键盘后恢复；修改前后的值逐项一致 |
| 修复后日志 | native 模式完整布局回归与随后实际 OS 冷启动分享均为 0 条注入错误；未覆盖现代 WebView 或真机全部启动情形 |
| 实际冷分享 | 接收方进程不存在时，独立 UID 来源分享 50B Markdown；提供方 open-md 从4到5，原文完整入箱，配置页正常启动 |
| 完整回归 | 根项目928/928、移动935/935，两端TypeScript/Vite通过；正式Native分享Bridge 1项/3.661秒通过；Gradle明确重跑2个JUnit方法，实际440项断言通过 |
| APK 差异 | 对18,398,799B候选包逐条 ZIP 比对，唯一改变条目 assets/capacitor.config.json；Manifest、DEX、Native库、Web资源字节均不变。SHA-256 1e0e2e708f8c5c9deb2156a6f31b73cadf8dd048bb0000d8122c1c4dfd419223 |

QA 键盘没有读取输入、记录、持久化或联网代码；只用于本轮专用 MuMu2。启用前备份 default/enabled input methods 和硬键盘显示设置，完成后已精确恢复原值并卸载该 QA 包。原实例0/1未改动。临时 instrumentation 探针不进入产品源码或最终测试包。

本轮仍在 Windows / MuMu Android12(API32) / WebView110 验证。输入法是受控夹具，不代表真实输入法产品或实机验收；现代 WebView140+、刘海/手势导航、真实系统生命周期、四类实机和 Xcode 仍待补。实际 HTTP/OIDC 服务链仍受既有自动审批阻塞，未尝试重启或绕过。M3未完成、M4未进入。

证据在任务目录 qa/m3/20261029/android-insets/：geometry-comparison.json、baseline/result.json、baseline-occluding/result.json、native-occluding/result.json、cold-share-result.json、candidate-package.json、ime-state-before.json、ime-restored.json，以及实际截图和本轮回归日志。截图路径/ABI/默认模式均来自真实 Native 和生产 DOM，没有注入虚假 viewport。

## 前一轮：原生构建与数据持久化

以下保留 30391f9 之前那一轮的原始范围、产物和限制。该轮运行时代码未变；上方续作已修改系统栏配置。


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
