# PaperQuay 原生容器与登录存储

`android/` 和 `ios/` 是 Capacitor 8.5.3 CLI 生成并同步过的真实工程。当前实现提供系统浏览器 OIDC、系统凭据存储、SQLite 账号快照与应用私有目录 PDF 缓存。自动化结果不代表 iPhone、iPad、Android 手机或平板已完成实机验收。

## 服务配置

在 IdP 中注册 **public client**，启用 Authorization Code、PKCE S256 与刷新令牌。客户端不包含 client secret。注册精确回调：

- 登录：`dev.paperquay.mobile://auth/callback`
- 退出：`dev.paperquay.mobile://auth/logout`

应用只接受精确 scheme、host、path，拒绝重复参数、片段令牌和错误 issuer。PKCE verifier、state、nonce 放入系统安全存储；待处理 state 最长保留 10 分钟。正常返回、冷启动 `App.getLaunchUrl()` 和运行中的 `appUrlOpen` 由同一处理器消费。IdP 应返回与配置 authority 一致的 issuer，并在 ID token 中包含当前 client audience。

应用保持标准 WebView `fetch`，未启用全局 `CapacitorHttp` 替换。IdP 的 discovery/token 端点、同步服务以及用户选择的模型端点必须允许相应来源与请求头：

| 容器 | Origin |
| --- | --- |
| iOS / iPadOS | `capacitor://localhost` |
| Android | `https://localhost` |

模型流式请求依赖真实 `ReadableStream`、`AbortSignal` 和重定向拒绝；原生容器不会自动消除 CORS 限制。Android release 工程禁止 cleartext 和 mixed content。本文不修改任何实际 IdP 或生产服务配置。

## 接入接口

- `parseAppConfig(input, pageOrigin, native)`：原生模式使用上面的固定回调。
- `createAuthSession(config)`：返回统一 `AuthSession`；挂载后 `initialize()`，销毁时 `dispose()`。
- `AuthSession.getSubject()`：只提供已验证的 issuer/subject，不包含令牌。过期安全会话仍可提供主体，快照设置 `needsLogin`；`getAccessToken()` 只返回尚未过期或成功刷新后的令牌。
- `createSecretStore()`：浏览器仅内存；原生为 iOS Keychain 或 Android Keystore 加密存储。原生插件缺失时失败，不回退到 Web Storage。
- `createAccountStorage({ decode })`：浏览器 IndexedDB；原生 SQLite，二者实现 `AccountStorage<T>`。原生多句柄共享串行连接，`close()` 只结束当前句柄。
- `assertPlatformReady()`：检查原生插件齐备；`assertM1WebRuntime` 保留为兼容别名。

系统凭据按 namespace/key 哈希寻址，不进入账号快照、响应式状态或日志。iOS 禁用 iCloud 同步，使用 `whenUnlockedThisDeviceOnly`；Android 禁用应用备份和设备迁移。安全存储调用串行化，退出和账号切换会使旧网络响应与旧安全写入失效。

SQLite 使用 WAL、`synchronous=FULL`，并在启动时核验设置。一次账号保存包含内容、outbox、冲突和游标，只有 COMMIT 返回后才确认保存成功。账号内容保存在应用私有数据库，未启用额外数据库加密；令牌和 API key 始终使用系统安全存储。

离线身份映射只来自成功的设备注册，并按服务、issuer、client、subject 隔离。离线打开还要求该账号在本机已有工作区；联网后先重新准备能力和注册设备，再发送待同步操作。明确撤销不走缓存回退。

## 构建和验证

在 `apps/mobile` 安装锁定依赖后执行：

```sh
npm ci
npm test
npm run build
npx cap sync
```

Android 工程使用 JDK 21、Android SDK 36 和 Gradle wrapper 8.14.3；从 `android/` 执行 `./gradlew assembleDebug`。iOS 工程采用 Swift Package Manager，在 macOS/Xcode 上打开 `ios/App/App.xcodeproj`，或用 `xcodebuild -project ios/App/App.xcodeproj -scheme App -destination 'generic/platform=iOS Simulator' -derivedDataPath build/ios CODE_SIGNING_ALLOWED=NO build` 验证模拟器构建。发布签名与商店提交流程不属于本阶段。

在 Windows UNC 共享路径下，如果 npm script 找不到 `.bin` 命令，可从映射盘目录显式运行 Node CLI：

```powershell
& 'C:/Program Files/nodejs/node.exe' node_modules/typescript/bin/tsc --noEmit
& 'C:/Program Files/nodejs/node.exe' --import tsx --test tests/*.test.ts
& 'C:/Program Files/nodejs/node.exe' node_modules/vite/bin/vite.js build
& 'C:/Program Files/nodejs/node.exe' node_modules/@capacitor/cli/bin/capacitor sync
```

`native-auth.test.ts` 使用真实 oidc-client-ts 协议处理和注入的系统桥；`native-storage.test.ts` 使用真实 Node SQLite 文件验证提交、回滚和重新打开。`verifiedBinding.test.ts` 与 `offlineBinding.test.ts` 覆盖身份隔离、离线恢复和迟到响应。它们不执行 iOS Keychain、Android Keystore、操作系统终止或真实设备浏览器跳转。

本地 Windows 环境缺少 Android/iOS 完整构建工具链（Android SDK、JDK 21 与 Xcode）；已完成工程生成、插件同步、XML/Xcode 项目解析和上述自动化验证。原生编译由对应 CI 环境验证；四类真实设备的安装、登录往返、进程终止后恢复、低空间写入与 PDF/模型网络行为仍待验收。

## 依赖依据

- [Capacitor App 与冷启动 URL](https://capacitorjs.com/docs/apis/app)
- [Capacitor 系统浏览器](https://capacitorjs.com/docs/apis/browser)
- [Secure Storage 的 Cap 8 支持与系统存储](https://github.com/aparajita/capacitor-secure-storage)
- [Capacitor Community SQLite](https://github.com/capacitor-community/sqlite)
- [Filesystem 隐私清单要求](https://capacitorjs.com/docs/apis/filesystem)

CLI 的 `xcode` 间接依赖通过限定 override 使用 `uuid@11.1.1`，避免旧版本公告问题；该组合已用于生成和解析本仓库 Xcode 工程。
