# 架构与协议 v1

## 平台与服务

复用 React/TypeScript 的业务类型与纯逻辑；桌面保留 Electron 适配器，手机/平板使用独立 React + Capacitor 入口。核心仓库接口不依赖 Electron invoke；网络、文件、安全存储、生命周期与数据库分别适配。响应式 Web 客户端是 M1 的实际验证载体，不代表原生包验收。

服务使用 TypeScript + Fastify + PostgreSQL；成熟 OIDC 身份提供方采用 Keycloak 参考部署。身份键为 `(issuer, sub)`，邮箱不是主键。原生登录走系统浏览器、Authorization Code + PKCE S256；M1 Web 使用相同授权码流程。

M1 的设备条目代表 **OIDC 登录会话**：JWT 的 issuer/sub/sid 与服务器设备记录绑定，注册时由服务器产生 deviceId。同一登录会话不能换 deviceId 绕过撤销。每次请求验证签名、issuer、audience、有效期、允许的 client、会话与撤销状态；请求里的 deviceId 必须匹配认证上下文。该方案不声称硬件设备证明或防止已窃取 Bearer token 被使用；原生安全存储、身份提供方退出联动和 DPoP 加固在正式原生发布前评估验收。

业务服务不实现自制密码登录。浏览器令牌只留内存，授权跳转的短时 state/PKCE 状态使用独立 sessionStorage；令牌、API key 和文件路径不得进入账号同步。退出清除当前认证状态，清理账号数据须使用独立明确动作。

## 数据实体

所有 ID 为不含业务秘密的 UUID。服务器从认证上下文获得 accountId，不接受客户端指定 owner。账号作用域参与数据库主键、引用、游标和冲突查询。新 ID 与本机别名通过可信 profile 中的映射关联；DOI、标题、绝对路径都不充当同步主键。

| entityType | data 字段（拒绝额外字段） |
| --- | --- |
| `paper` | `title, doi:null|string, year:null|string, publication:null|string, abstractText:null|string, authors:string[], keywords:string[], organization?:PaperOrganization` |
| `attachmentVersion` | `paperId, attachmentId, sha256, sizeBytes, mediaType:'application/pdf', fileName, pageCount:null|integer` |
| `note` | `paperId:null|UUID, title, body, format:'markdown'` |
| `annotation` | `paperId, attachmentVersionId, kind:'highlight'|'underline'|'area', color, comment, anchor` |
| `readingPosition` | `paperId, attachmentVersionId, pageIndex, offsetRatio, furthestPageIndex, furthestOffsetRatio, sessionId, deviceSequence, observedAt` |

`sha256` 为经验证的 64 位小写十六进制；附件身份、hash、sizeBytes 不可变。`fileName` 仅 basename。附件/批注/阅读位置必须引用同账号且匹配 paperId 的实体。未知 hash 不伪造 attachmentVersion。

`anchor` 为 `{pageIndex, coordinateSpace:'pdf-crop-box-unrotated-normalized', quads:number[8][], quote:{exact,prefix,suffix}|null}`。页码从 0 开始，坐标/offset 在 `[0,1]`。锚点以**未旋转 CropBox** 归一化：`x=(pdfX-xMin)/width`，`y=(pdfY-yMin)/height`，Y 轴向上；四个角按多边形顺序保存。选区先逆变换当前 viewport，显示时再应用 viewport，因此文件自带旋转、用户旋转和缩放不会改写锚点。阅读位置每设备/版本独立；不允许设备写另一个设备的检查点。最近阅读位置与最远阅读进度分开；时间只显示，不用于冲突胜负。

`PaperOrganization` 为 `{favorite:boolean, readingStatus:'unread'|'reading'|'read', tags:string[], collections:string[], queueRank:number|null}`。它是可选的完整对象，标签至多 64 个、合集至多 32 个，每项至多 80 字符；队列顺序为非负安全整数或 null。清空分类必须显式写入空值，不能靠省略对象清空。

`GET /v1/capabilities` 返回 `features.paperOrganization:1` 后，新客户端才发送 `X-PaperQuay-Features: paper-organization-v1` 并开放分类编辑。旧客户端收到的 pull、push、冲突和解决结果投影掉新增对象；旧客户端 put/restore 省略它时服务端保留当前分类，且仍按合并后的完整载荷计算配额。升级后的本地库只重置一次拉取游标，保留 outbox/冲突；同 revision 只允许旧投影补回这一字段，其他同版本内容变化仍拒绝。

记录信封为：

```ts
type SyncRecord = {
  entityType: EntityType; entityId: string; schemaVersion: 1;
  revision: number; deletedAt: string | null; updatedAt: string;
  modifiedByDeviceId: string; data: EntityData | null;
};
type SyncOperation = {
  opId: string; entityType: EntityType; entityId: string;
  mutation: 'put' | 'delete' | 'restore'; baseRevision: number;
  schemaVersion: 1; data: EntityData | null; clientCreatedAt: string;
};
```

创建 baseRevision 为 0。服务端分配 revision/updatedAt；delete 的 data 为 null。restore 必须显式且引用当前墓碑 revision，不能以普通 put 复活。

## API 与事务

| API | 行为 |
| --- | --- |
| `GET /health/live`、`GET /health/ready` | 无敏感内容的存活/数据库就绪检查 |
| `GET /v1/capabilities` | 协议/schema/请求上限；不泄露其他账号信息 |
| `POST /v1/devices` | 当前 OIDC 会话注册；body `{name,platform}`；返回当前设备 |
| `GET /v1/me`、`GET /v1/devices`、`DELETE /v1/devices/:id` | 当前身份、本人设备会话、撤销 |
| `POST /v1/sync/push` | `{protocolVersion:1,deviceId,operations:SyncOperation[]}` |
| `GET /v1/sync/pull?cursor=...&limit=100` | `{protocolVersion:1,records:SyncRecord[],nextCursor,hasMore}` |
| `GET /v1/conflicts` | 本人未解决冲突，含当前/尝试版本 |
| `POST /v1/conflicts/:id/resolve` | 新 opId + expectedRevision + 明确选择；在同事务内解决冲突并写变更 |

push 结果为 `{opId,status:'applied'|'conflict'|'rejected',replayed,record?,conflictId?,code?,retryable?}`；没有含糊的 duplicate 状态。同账号同 opId 同内容返回原结果并设置 replayed；同 ID 不同内容返回 `IDEMPOTENCY_MISMATCH`。冲突重放仍是 conflict，不能当成功应用。依赖未到/临时故障不写永久 receipt，客户端保留原操作重试。

每个操作在同一数据库事务内锁账号行，锁后重新检查设备，检查 revision 与引用，再写实体/冲突、变更事件、receipt。每账号的 seq 在锁内分配，事务一起提交；不能用普通 bigserial 的分配顺序假装提交顺序。批次按输入顺序逐操作处理，允许部分成功且结果一一对应。撤销使用同一账号锁，确保撤销成功后旧会话不能继续提交。

cursor 是绑定账号/epoch/seq 的不透明值。M1 不裁剪 changelog；过期游标/备份恢复后的 epoch 处理和一致性快照属于正式长期开通前的门槛。数据库约束与查询必须同时携带账号；运行角色、迁移角色和 RLS 的实际配置在部署验收中记录。

## 本地状态与冲突

- 本地服务端镜像与未提交编辑分开保存；编辑和 outbox 在同一事务提交后才显示“已保存”。
- 已发送或结果未知的操作不可改写。后继编辑作为本地 overlay；前项 ack 后才能确定新操作 baseRevision。不能猜测服务器下一 revision。
- 只能合并从未发送的同实体操作。回包不得覆盖请求途中产生的新编辑。
- pull 应用与 cursor 原子落盘。push ack 不推进 pull cursor。
- 冲突保存 attempted operation 与 current record；解决冲突要验证当前 revision，期间又有更新则继续提示，不覆盖新版本。
- 本地数据按账号独立；网络身份与存储账号必须一致，账号切换停止旧同步。暂时故障保留 outbox，永久拒绝和冲突有可见处理入口。

M2 Web 快照使用 IndexedDB，原生快照使用 SQLite 事务；原生登录令牌与模型密钥使用系统安全存储。原生离线恢复仅接受此前通过服务端注册确认的 `(api, issuer, client, sub) → account/device` 绑定及已有本地快照，过期凭据不用于网络请求。网络恢复后先重新验证身份/设备，再同步；撤销会话不能借离线绑定重新注册。异步令牌获取、网络返回及本地写入均检查主体，旧账号任务不能写入新账号内容。

笔记与批注的“已保存”表示本地事务完成。保存期间的新输入继续保持未保存状态；位置、评论和并行批注分别计入离开守卫。保存完成后的即时返回读取同一份实时状态，不等待 React 下一次渲染。

## 文件与 AI 的独立边界

账号元数据同步、PDF 传输、向模型发送文本是三个独立能力。服务器默认不存 PDF；内容来源按版本/可用性/成本选择。PDF 可用来源失败时保留题录和笔记，不阻塞整个文库。

公开源并不天然可信，DOI 落地页不等于 PDF。部分 Range 下载未完成前不能宣称整文件 SHA-256 已核验；可用可信 chunk 清单验证已取字节，或待完整临时下载后再启用精确版本锚定。默认关闭自动全文件预取；不支持 Range 的源由用户选择完整下载。

M2 具体实现先检查公开源，再由用户明确选择完整读取并核对 SHA-256、字节数与 PDF 解析结果；即使来源支持 Range，也不把部分下载当作已验证版本。单文件最多 64 MiB/2000 页；同时渲染至多 3 页、单 canvas 至多 4M 像素。账号缓存总上限 256 MiB，其中临时 128 MiB、主动保留 192 MiB，条目至多 512；默认清理只删临时副本，显式清理账号包含主动保留副本，原始来源文件与同步记录不随之删除。

阅读器首次按需加载时携带匹配版本的 PDF.js worker、CMap、标准字体与 WASM 白名单资源。以后新开文档和首次渲染其他文字页不再请求远端解码资源；每次文档独立持有工作线程，取消/关闭释放资源。资源不可用与文件本身无效分别报告。该离线保证针对已加载应用或原生打包资源；Web 未提供离线冷启动 PWA，刷新后仍需重新加载应用与登录。

电脑提供文件时只接受授权附件 ID，由电脑适配器解析已导入路径；不开放任意路径/URL 读取。信令、直传与中继均绑定账号、设备、附件版本、权限和有效期。云副本由用户明确上传；流量、空间和删除单独管理。

AI 请求由用户选择的设备直连或受控网关执行，必须有实际选段/全文上下文及可核查引用。模型配置引用可同步，密钥与鉴权 headers 不进入普通同步；不会将已有桌面密钥默默搬到云端。

## 官方依据

- [Capacitor](https://capacitorjs.com/docs)：跨平台容器与原生插件能力。
- [RFC 8252](https://www.rfc-editor.org/rfc/rfc8252)：原生 OAuth 的外部浏览器与 PKCE。
- [Keycloak ZIP 开发环境](https://www.keycloak.org/getting-started/getting-started-zip)：本地隔离验证方式；不是生产配置。
- [PostgreSQL 行锁](https://www.postgresql.org/docs/current/explicit-locking.html)：事务与账号内提交序列。
- [Fastify Schema 验证](https://fastify.dev/docs/latest/Reference/Validation-and-Serialization/)：服务端固定 schema 与输入输出限制。
- [PDF.js 加载参数](https://mozilla.github.io/pdf.js/api/draft/module-pdfjsLib.html)：Range、自动预取与 streaming 边界。
