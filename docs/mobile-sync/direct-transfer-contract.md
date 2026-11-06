# M3 设备直连协议

本文件冻结本轮桌面、移动端与同步服务的交互约定。实现与隔离验证结果另见检查点；本协议不代表手机实机、公网 NAT 或正式安装验收通过。

## 能力与兼容

保留 `features.desktopPdfTransfer: 1` 和 `desktopPdf.transport: "http-relay-v1"`。新增可选 `desktopPdf.direct`：

```json
{
  "transport": "webrtc-data-v1",
  "attemptMs": 6000,
  "maxSdpBytes": 32768,
  "stunUrls": []
}
```

旧服务、旧客户端、无 RTCPeerConnection 的客户端继续使用现有中继。提供方 `POST /v1/desktop-pdfs/provider/poll` 接受原 `{}` 或新增 `{ "direct": true }`；旧提供方收到的 job 保持原形。能力中已知字段必须校验，未知可选字段不构成错误。

`PAPERQUAY_DESKTOP_PDF_STUN_URLS` 由服务管理员设置，逗号分隔、默认空、最多两个 `stun:` / `stuns:` URI，整个配置最多 256 字符。仅允许 host 与可选 port；不接受用户名、密码、路径、查询、片段或 TURN。两端只采用已验证的服务能力，不采用 SDP 附带的配置。默认不连接公共 STUN；此时直连适用于可直接发现的本地对端。配置 STUN 不保证 NAT 穿透成功。

不创建音视频轨、不请求摄像头或麦克风。SDP 必须有界、ASCII、最多 32 个 candidate、一个 `m=application`；拒绝音视频和 `typ relay`。没有单独的 trickle ICE 接口。两端先收集候选再发送一次 SDP，收集最多 1500 ms，不允许未完成操作在回退后继续写入状态。

## 同一租约的信令

以下请求均沿用已验证的 Bearer 身份、同账号不同已注册会话、精确附件版本和现有请求租约。路径前缀均为 `/v1/desktop-pdfs`。

| 请求 | 输入 | 响应与边界 |
| --- | --- | --- |
| `POST /requests` | `{attachmentVersionId,direct?:{offer:string}}` | 原 `{requestId,attachmentVersionId,expiresAt}`；只预留一次槽位和流量预算 |
| 提供方 poll job | 原 job，直连时加 `direct:{offer,expiresAt}` | 新 `expiresAt` 是直连截止；原顶层截止仍是整个租约 |
| `GET /requests/:id/direct` | 无正文 | 下述控制状态；仅原消费者或分配到的提供方，每个角色最多一个在途 |
| `POST /requests/:id/direct/answer` | `{sdp:string}` | `{accepted:true}`；仅提供方，至多一个 answer；相同重试幂等，变更拒绝 |
| `POST /requests/:id/direct/authorize` | `{}` | `{authorizedUntil}`；仅提供方，最终块与 EOF 前重新检查双方会话和目标，并标记最终检查已通过 |
| `POST /requests/:id/direct/complete` | `{sha256,sizeBytes}` | `{received:true}`；仅消费者，须完整文件核验和提供方最终检查已通过，服务再次检查当前权限 |
| `POST /requests/:id/direct/fallback` | `{}` | `{state:"relay"}`；任一已绑定角色可调用，幂等、单向，保持原租约、目标、槽位和预算 |

控制状态：

```ts
{
  state: 'direct' | 'relay' | 'complete';
  answer: string | null;
  expiresAt: string;
  directExpiresAt: string;
  authorizedUntil: string | null;
  relayReady: boolean;
}
```

直连截止为建租约后最多 6000 ms，且不得晚于原租约截止；移动端电脑来源总等待仍是 15 秒。两端每 1000 ms 读取控制状态。只有当次数据库权限检查成功的 `direct` 状态可发出最多 2000 ms 的许可，且不超过直连及租约截止；许可失效后两端关闭连接。提供方第一次获得许可后才能启动传输 helper；helper 自身也有独立许可定时器。

`relayReady` 仅表示原消费者 `GET /requests/:id/content` 已挂接且输出流就绪。消费者关闭 peer、丢弃部分字节、完成 fallback 后挂接原 GET content。提供方关闭 peer 后等待 `relayReady`，然后调用原 POST content。只有旧提供方时服务直接进入 relay；不要求旧提供方实现控制接口。

直连超时自动切换 relay。连接失败可降级；明确取消、账号或版本改变、令牌失效、撤销或墓碑必须终止。原 DELETE request、DELETE provider 和 unavailable 的边界不变。回退不能重新分配请求 ID、重新计费、续租或重新打开直连。

已进入 relay 的 answer、authorize、complete 返回 `409 DESKTOP_PDF_DIRECT_FALLBACK`；只有这个特定状态冲突可降级，不能忽略普通 `409 DESKTOP_PDF_CHANGED`。完成已赢时 fallback 返回 `409 DESKTOP_PDF_REQUEST_IN_USE`；最终提供方检查尚未通过的 complete 也返回 `DESKTOP_PDF_REQUEST_IN_USE`。完成回执通过 GET direct 查询。

`complete` 与 `fallback` 在最后一个异步检查后用同步状态变更决出唯一结果；迟到 answer、authorize、complete 都不能复活直连。成功先保存回执，再释放活跃槽。成功回执最多 64 条，创建直连时预留容量；TTL 为 `min(完成+5秒, 原租约截止)`。仅保存双方 issuer/subject/session/client、请求和目标版本摘要，不保存 SDP 或文件。重放 complete 和读取 complete 状态仍须校验当前身份与目标，不延长回执，也不发新许可。

## DataChannel 线格式

消费者创建唯一 DataChannel：`label` 和 `protocol` 都为 `paperquay-pdf-v1`，`ordered: true`，可靠传输，不设置重传次数或存活时间上限，不使用预协商 channel ID。提供方拒绝多余 channel 或不匹配的属性。

顺序固定为 metadata、二进制分块、EOF、ACK。每个 JSON 控制帧最多 1024 UTF-8 字节，只接受约定字段：

```ts
// 提供方 -> 消费者，开始之前
{ type: 'metadata', requestId, attachmentVersionId, sha256, sizeBytes }
// 提供方 -> 消费者，全部二进制数据之后
{ type: 'eof', requestId, sha256, sizeBytes }
// 消费者 -> 提供方，完整校验与服务端 complete 成功之后
{ type: 'ack', requestId, sha256, sizeBytes }
```

每个二进制消息最多 16384 字节，且不超过协商的最大消息尺寸。发送使用 `bufferedAmount` / `bufferedamountlow` 背压，队列高水位最多 256 KiB。总长度严格等于版本长度，单文件仍最多 64 MiB。提供方在最后一块与 EOF 前获得最终许可；消费者只有完整长度、SHA-256、PDF 外形和服务端 complete 都通过后才能返回字节。阅读器继续执行原有解析与缓存校验。

断连、停止提供、关闭阅读器、切换账号或文库、取消、许可到期均销毁 peer/channel 和相应定时器；不能把残缺数据写入缓存。服务器在直连期间只交换有界信令，PDF 字节通过 WebRTC DTLS 传输。HTTP 中继仍由服务读取和转发文件；不得把中继称为设备间端到端加密。

## Electron 边界

使用现有 Electron Chromium 的 RTCPeerConnection，无新增原生 WebRTC 依赖。专用隐藏 BrowserWindow 使用独立内存 session、`sandbox:true`、`contextIsolation:true`、`nodeIntegration:false`、`webSecurity:true`；只加载固定本地空 HTML，CSP 默认禁止资源和网络，禁止导航、新窗口、权限请求及下载。

DOM-only preload 执行 WebRTC，无页面脚本、无通用 contextBridge。主进程保持令牌、文件路径、附件映射与授权句柄。仅在通过本地文件和服务器授权后，以独立复制的 16 KiB Uint8Array 交给 helper；最多一个待确认 IPC 块，避免重复克隆完整底层 ArrayBuffer。

IPC 必须同时检查固定 channel、精确 webContents/mainFrame、当前任务 nonce 与状态；普通页面和子 frame 无权调用。退出或最后一个真实窗口关闭时停止 provider，并销毁 helper，不能让隐藏窗口阻止应用退出。许可期限在主进程和 helper 两侧独立执行。

## 验证依据

隔离验收需记录真实选中 ICE candidate pair 的非敏感类型，证明未走 relay；直连成功时没有 HTTP PDF content 请求。失败用明确记录的 ICE 故障注入，再验证同一 request ID 经原 HTTP content 收到完整文件。不得保存 SDP、IP 地址、凭据、认证状态、HAR 或 trace。

还需验证旧客户端/提供方、双会话绑定、跨账号拒绝、并发与预算、回退/完成竞争、撤销/墓碑、取消、超时、迟到消息、helper 关闭，以及缓存和 UI 的可见状态。手机/平板、公网 NAT、系统默认浏览器和签名安装验收继续暂缓。

依据：[WebRTC 标准](https://www.w3.org/TR/webrtc/)、[MDN DataChannel](https://developer.mozilla.org/en-US/docs/Web/API/WebRTC_API/Using_data_channels)、[MDN ICE 配置](https://developer.mozilla.org/en-US/docs/Web/API/RTCPeerConnection/RTCPeerConnection)、[Electron 安全指南](https://www.electronjs.org/docs/latest/tutorial/security)。
