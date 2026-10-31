# PaperQuay 账号同步与可选私有 PDF 服务

本目录提供独立 Fastify API、PostgreSQL 持久层和 OIDC 访问令牌校验。账号同步包含文献元数据、附件版本描述、Markdown 笔记、PDF 批注和阅读位置。私有 PDF 副本是默认关闭的独立能力，启用后仍需用户对已同步版本明确上传；不接收桌面数据库、绝对路径、第三方模型密钥或账号密码。现有桌面库的导出/导入由 `packages/sync-core` 与桌面适配器负责，服务端不连接用户本地库。

M1 的“设备”是 `(issuer, sub, sid)` 对应的 OIDC 登录会话。服务生成设备 UUID，忽略任何客户端自报的账号归属。刷新令牌仍沿用同一 `sid`；重新登录可以得到新会话。这个设计不证明硬件身份，也不阻止仍有效的 Bearer token 被盗用。原生发布的安全存储、DPoP、正式 IdP/TLS/备份运维属于后续验收。

## 启动已有开发环境

需要 Node.js 24.14 或更新的 24.x，以及已经准备好的 PostgreSQL 和 OIDC realm。依赖锁定于 `package-lock.json`。

```sh
cd server
npm ci --ignore-scripts
node scripts/migrate.ts
node scripts/grant-runtime.ts
node src/main.ts
```

这些命令从进程环境读取配置。也可以把本机合成测试配置写入被 Git 忽略的 `.env`，逐条使用 `node --env-file=.env ...`。`.env.example` 只有占位值，不能直接用于启动。真实运行进程只注入 runtime 数据库凭据；migration/admin 凭据只给独立维护命令。

默认 API 监听 `127.0.0.1:4311`。非回环监听必须显式设置 `PAPERQUAY_ALLOW_NON_LOOPBACK=1`；HTTP issuer 和前端 origin 只允许回环地址，其余必须为 HTTPS。默认不信任转发头；反向代理必须通过下列配置明确指定可信来源。多副本共享限流、TLS 和身份服务运营仍需单独验证。

| 配置 | 用途 |
| --- | --- |
| `PAPERQUAY_DATABASE_URL` | runtime 角色连接串，不能使用 owner/superuser/BYPASSRLS 角色 |
| `PAPERQUAY_MIGRATION_DATABASE_URL` | 单独的 schema owner 连接串，仅迁移和授权命令使用 |
| `PAPERQUAY_OIDC_ISSUER` | 精确 issuer；启动时校验 discovery 中的 issuer，并限制 JWKS 同源 |
| `PAPERQUAY_OIDC_AUDIENCE` | 同步 API 专用 audience，不能配置为登录客户端 ID |
| `PAPERQUAY_OIDC_CLIENT_IDS` | 允许的 `azp`/`client_id`，逗号分隔 |
| `PAPERQUAY_ALLOWED_ORIGINS` | 明确的前端 origin 列表，空值禁用跨域授权 |
| `PAPERQUAY_CURSOR_SECRET` | 32–128 字节随机密钥的规范 Base64；重启时保留同一值 |
| `PAPERQUAY_HOST` / `PAPERQUAY_PORT` | 默认 `127.0.0.1` / `4311` |
| `PAPERQUAY_TRUSTED_PROXY_IPS` | 逗号分隔的可信代理 IPv4/IPv6 地址，最多 32 项；默认空，不接受主机名、CIDR、通配或未指定地址 |
| `PAPERQUAY_REQUESTS_PER_MINUTE` | 每个分桶每 60 秒的请求额度，默认 120；业务按账号，健康和公开请求分别按实际来源地址 |
| `PAPERQUAY_MAX_ACCOUNT_RETAINED_BYTES` | 每账号保留内容预算，默认 `268435456`（256 MiB）；必须为 1–10737418240 的整数字节数，最高 10 GiB |

来源地址默认取连接的 socket IP。配置可信代理后，Fastify 从直连端开始校验代理链，停在最近的不可信来源；直接连接的不可信客户端不能借伪造 `X-Forwarded-For` 更换身份。代理应规范化转发头，且实际代理链和后端访问边界需要按部署核验。配置依据见 [Fastify trustProxy](https://fastify.dev/docs/latest/Reference/Server/#trustproxy)。

| 内存限流分桶 | 识别依据与共享范围 |
| --- | --- |
| 健康检查 | 实际来源 IP；`/health/live` 与 `/health/ready` 共享额度 |
| 公开请求及认证失败 | 实际来源 IP；capabilities、404 与验证失败的请求共享额度 |
| 已认证业务 | 验证后的 `(issuer, sub)`；所有业务路由、登录会话和来源 IP 共享同一账号额度 |

三个分桶互相隔离，匿名健康调用不会消耗业务额度。业务在令牌验证成功后才计入账号桶；请求中的账号字段、未验证令牌和转发头不能选择账号桶。复用同一个 limiter，避免每个业务路由得到一份新的额度。该实现使用已安装的 [Fastify rate-limit](https://github.com/fastify/fastify-rate-limit) 单进程内存缓存；进程重启或 LRU 淘汰会重置相应计数，多实例也不共享计数。它不是连接数、网络带宽或令牌验证成本的总量保护，边缘代理限流与正式多实例容量仍需独立配置和验收。本轮 HTTP 测试模拟了可信与不可信代理来源，没有执行生产 TLS 反代部署。

数据库迁移只管理 `paperquay` schema。所有文件在一个事务中执行，以 advisory lock 排斥并发迁移，并记录文件校验和；已应用迁移改写或出现未知版本会失败。`deploy/runtime-role.sql` 仅向已经存在的 `paperquay_runtime` 角色授予所需表权限，不创建账号或改密码。`002_receipt_quota.sql` 在同一个锁定事务内回填回执计数，并恢复 FORCE RLS；触发器使旧进程在升级窗口内的回执写入也计入配额。

`003_retained_bytes_quota.sql` 锁定账号及四类内容表，按现存内容回填 `accounts.retained_bytes`。回填期间只有 migration owner 在事务内临时解除 FORCE RLS，提交前全部恢复；失败则整体回滚。迁移保留所有历史，即使旧账号已经超出新预算也允许升级，随后保持可读并阻止新增写入。数据量较大时应预留维护窗口，迁移不获取锁会按现有 10 秒 lock timeout 失败，不能把超时当作已完成。

字节触发器使用调用者权限和账号行锁，runtime 角色继续保持非 owner、NOBYPASSRLS，不增加 schema CREATE、历史表 UPDATE/DELETE 或禁用触发器权限。配额值由可信 API 配置写入事务局部设置，不接受请求参数；没有设置值的旧进程按 256 MiB 默认值执行数据库限制。所有 API 副本应部署同一个配置值，升级后再启动新进程；自定义预算的混合配置不构成一致的配额策略。

## 可选的本机容器参考

`deploy/compose.reference.yml` 只启动回环绑定的 PostgreSQL 18.6 与 Keycloak 26.8.1。API 仍在宿主机通过 Node 启动。该 Compose 是参考配置；本次本机实际验收使用 Windows 独立 PostgreSQL/Keycloak 进程，没有把 Compose 启动当作已验证事实。

1. 复制 `.env.example` 为 `.env`，用相互独立的随机值替换所有密码和 cursor secret；数据库 URL 中的密码需 URL 编码。保持已存在测试 realm 的密码一致，重启导入不会覆盖现有 realm。
2. 从 `server/` 运行 `node --env-file=.env ../.github/scripts/create-sync-test-realm.mjs .runtime/realm/paperquay-local-realm.json`。生成文件含合成测试凭据，只保存在被忽略的 `.runtime/`。
3. 确认 55439 和 18081 没有被另一套开发服务占用，再运行 `docker compose --env-file .env -f deploy/compose.reference.yml up -d`。
4. 等待 PostgreSQL health 通过，并确认 `http://127.0.0.1:18081/realms/paperquay-local/.well-known/openid-configuration` 可读，再依次运行 `node --env-file=.env scripts/migrate.ts`、`node --env-file=.env scripts/grant-runtime.ts`、`node --env-file=.env src/main.ts`。

测试 realm 中 `paperquay-mobile` 使用 Authorization Code + PKCE S256。`paperquay-integration` 的 direct grant 只给隔离的自动化测试使用；正式 realm 必须移除这个测试客户端和合成用户。Keycloak `start-dev`、本机密码文件以及容器参考均不构成生产部署方案。配置依据见 [Keycloak 容器说明](https://www.keycloak.org/server/containers) 与 [PostgreSQL psql 变量说明](https://www.postgresql.org/docs/18/app-psql.html)。

## HTTP 接口

除健康检查和 capabilities 外，接口都要求 `Authorization: Bearer <access_token>`。JWT 校验 issuer、API audience、签名算法、`sub`、`sid`、`exp`、`iat` 和允许客户端。响应携带 `Cache-Control: no-store`。输入采用共享白名单 schema，未知字段不会被静默剥离后接受。

| 方法与路径 | 行为 |
| --- | --- |
| `GET /health/live` | 进程活性 |
| `GET /health/ready` | 数据库可访问且迁移版本与服务一致；不声称 IdP 持续可达 |
| `GET /v1/capabilities` | 协议/实体 schema、实际配额、`deviceBinding: oidc-session`；私有副本默认 `pdfStorage: false`，启用后另见下节 |
| `POST /v1/devices` | `{name,platform}`，注册当前 OIDC 会话；返回 `{accountId,device}` |
| `GET /v1/me` | 返回当前账号和会话设备；尚未注册为 403 |
| `GET /v1/devices` | 返回当前账号的 `{devices: [...]}` |
| `DELETE /v1/devices/:id` | 撤销本账号会话；返回 `{revoked:true,deviceId}` |
| `POST /v1/sync/push` | 共享 `PushRequest`；返回每个 op 的 `PushResult` |
| `GET /v1/sync/pull?cursor=&limit=` | 有序变更页；首次省略 cursor |
| `GET /v1/conflicts?cursor=&limit=` | 未解决冲突；保留 attempted、当时 observed 和最新 current 记录 |
| `POST /v1/conflicts/:id/resolve` | 带 opId 与 expectedRevision 的明确选择；直接返回 `PushResult` |

分页空列表也返回字符串 `nextCursor`；客户端只在持久化整页记录后保存游标。cursor 与账号、流类型、数据 epoch 绑定并签名，不接受跨账号复用或超前序列。不要计划外更换 cursor secret；密钥变化会使已有 cursor 无效。

冲突解决请求有三种形式：

```json
{"opId":"<uuid>","expectedRevision":2,"choice":"current"}
{"opId":"<uuid>","expectedRevision":2,"choice":"attempted"}
{"opId":"<uuid>","expectedRevision":2,"choice":"merged","mutation":"put","data":{"...":"符合该实体的完整数据"}}
```

`merged` 也接受 `delete` + `data:null`，或明确的 `restore`。普通 `put`、接受 attempted 都不会隐式复活 tombstone。当前 revision 已改变时返回 conflict，原冲突保持开放。选择 current 关闭冲突并追加当前记录的变更事件，实体 revision 和作者保持不变。解决成功后，原 opId 的重试先查回执，即使冲突已关闭也返回原成功结果。

## 一致性与隔离边界

每个操作在数据库事务中锁定账号行，然后检查当前会话是否撤销，最后进行 CAS、实体写入、账号序列分配、变更事件和幂等回执提交。同一账号的事务串行提交，因此 pull 不会越过尚未提交的较小序列。不同账号独立加锁。

`opId` 在账号内唯一，请求内容使用稳定哈希校验；同 opId + 同内容返回原回执，同 opId + 不同内容返回 `IDEMPOTENCY_MISMATCH`。每个 batch 允许部分操作先提交；遇到中途断线或撤销后，可依靠原 opId 确认已提交部分，不能为重试生成新 opId。数据库事务失败、缺失依赖、响应预算不足及保留字节预算不足不保存永久拒绝回执。

账号对象使用复合主键/外键和 FORCE RLS。身份与账号设置只存在于事务内，连接归还池后不保留租户上下文。RLS 是可信 API 的额外隔离层；不能把数据库凭据或任意 SQL 能力交给客户端。附件版本的哈希、大小、文献与附件绑定不可修改；批注和阅读位置必须引用同账号精确版本。阅读位置只允许创建它的登录会话更新，最后位置可回退，furthest 进度不可回退。

所有 HTTP 错误仅返回 `{error:{code,requestId}}`，不包含 SQL、输入值、令牌或堆栈。请求自动日志关闭，服务错误日志仅写错误码和服务器生成的 requestId。

## 数量和大小上限

| 项目 | M1 上限 |
| --- | --- |
| HTTP 请求 / 响应 | 各 4 MiB |
| 单个实体 JSON | 1 MiB，并受共享字段长度限制 |
| push batch | 100 个操作 |
| pull / conflict page | 1000 / 100 条，另受字节预算限制 |
| 每账号实体 / change / conflict | 100,000 / 1,000,000 / 100,000 |
| 每账号永久回执 | 2,000,000 |
| 每账号保留内容预算 | 默认 256 MiB，可配置，最高 10 GiB |
| 每账号活跃 / 保留会话 | 100 / 1000 |

保留内容预算同时计算 `entities.data`（包括 tombstone 后保留的数据）、每条 `changes.record`、每份 `operation_receipts.result`，以及每条冲突的 `attempted_operation` 和 `observed_record`。按 PostgreSQL JSONB 文本的 UTF-8 字节数计费，每个保留行另加 512 字节固定保留额；历史中的重复正文逐份计算。更新当前实体按新旧字节差计费，UPSERT 不重复计费。`GET /v1/capabilities` 公布当前配置值和每行保留额。

账号锁和数据库 BEFORE 触发器在写入每份内容前原子预留预算。如果后续历史、冲突或回执超额，整个操作的实体、序列、冲突状态、回执和计费都回滚。push 中该操作返回 HTTP 200 的标准 `PushResult`：`status:'rejected', code:'ACCOUNT_STORAGE_LIMIT', retryable:true`；resolve 使用同一结果格式。客户端应保留原 opId，待管理员调整容量后手动重试；同批已经提交的操作仍有正常回执。已提交操作的回执查找在配额检查之前，满额账号的幂等重放不会重复计费。

M1 不清理 tombstone、历史变更、回执、已解决冲突或已撤销会话，达到预算后已有内容、游标和回执仍然保留。删除内容也会保留历史，不能用删除操作释放这项预算。生产的归档/压缩/epoch 重建需要后续设计和验证。这是保留应用内容的逻辑预算，不等同于 PostgreSQL 数据文件、索引、TOAST、WAL、膨胀或备份的实际磁盘用量；这些仍需单独容量管理。

Push 在账号事务锁内构造完整候选结果，并在实体、变更记录、冲突及回执写入前检查实际序列化响应字节；回执重放也计入预算。首次超限的操作及本批后续全部操作按原顺序返回 `RESPONSE_LIMIT_REACHED` 且 `retryable:true`，后续操作不再开启事务或读取快照；本批不会为延期操作新增回执，已有历史回执保持不变。前面已提交的操作及其回执保持有效；客户端可在已处理操作退出队列后，使用原 opId 重试剩余项。异常的单记录分页超限返回显式错误，不返回一个永远无法推进的空页。

本批首次遇到 `ACCOUNT_STORAGE_LIMIT` 后，后续操作仍会验证会话并优先读取历史回执，已有回执按原内容重放并计入响应预算；没有回执的新操作直接以同码及 `retryable:true` 延后，不再读取实体快照或尝试内容写入，也不新增回执。这避免临近配额时反复读取大正文、写入后再回滚；本批延后标志在下一次请求重新开始，较小的操作或增加配额后的原操作可重新尝试。

首笔内容写入之前，服务还会在同一账号锁内以只读 PostgreSQL 查询预检完整保留成本，按迁移 003 相同的 JSONB 文本 UTF-8 字节规则计算实体替换差额、变更记录、冲突和最终回执的所有副本。删除保留原实体正文，实体差额为零；已有正文在数据库中参与计算，不会为预检重新发送，新增正文在预检查询中只传入一次。实体缩小带来的负差额按实际值计算，已满额账号仍遵循前述拒绝新写入规则。`resolve` 保留当前内容时也在变更记录写入前检查变更及回执两份成本，其余永久拒绝或无实体变更的结果检查回执成本。预检读取数据库实际计数且不预扣字节，数据库触发器仍是唯一计账及最终校验入口。

## 可选私有 PDF 副本

`PAPERQUAY_CLOUD_PDF_ENABLED=1` 才开放副本接口；默认 `0`，不会自动上传。`PAPERQUAY_CLOUD_PDF_ACCOUNT_BYTES` 默认 `1073741824`（1 GiB），接受 1–10737418240 的整数字节数。单文件固定最多 64 MiB，每账号固定最多 512 份；这些是原始 PDF 字节的逻辑预算，与同步 JSON 的 retained 预算分开，也不等于 PostgreSQL 的 TOAST、索引、WAL、膨胀与备份磁盘用量。多实例应使用一致配置。

启用后 capabilities 保留既有协议与限制字段，增加 `features.privatePdfStorage:1`、`pdfStorage:true` 和 `cloudPdf:{maxFileBytes,maxAccountBytes,maxCopies}`。关闭时后两项中的 `cloudPdf` 对象和 feature 键不出现；已有同步 DTO 不变。

| 方法与路径 | 返回值 |
| --- | --- |
| `GET /v1/cloud-pdfs` | `{copies,quota}`，包含全部至多 512 份副本，墓碑副本也可见 |
| `GET /v1/cloud-pdfs/:id` | `{copy:null或CloudPdfCopy,quota}`；id 是当前账号的附件版本 UUID |
| `PUT /v1/cloud-pdfs/:id` | `application/pdf` 原始完整 bytes；成功为 `{copy,replayed,quota}` |
| `GET /v1/cloud-pdfs/:id/content` | 完整 PDF 字节与 `Content-Length`、附件下载头；不支持 Range |
| `DELETE /v1/cloud-pdfs/:id` | `{attachmentVersionId,deleted,quota}`；只删除云副本 |

所有成功响应均为 HTTP 200。`CloudPdfCopy` 是 `{attachmentVersionId,paperId,sha256,sizeBytes,fileName,createdAt,available}`，保存上传时的必要元数据。`quota` 是 `{usedBytes,maxBytes,usedCopies,maxCopies}`。已删除的 paper 或版本令 `available=false`，副本仍占用额度，可以检查并明确删除。调低预算后可能 `usedBytes>maxBytes`，已有内容仍可读取、重复确认或清理。

所有请求先校验 OIDC 令牌，所有仓库动作再在账号锁内检查已注册、未撤销的会话。上传读 body 前还检查版本、父文献、文件上限和配额；收完后重新取得账号锁并重查会话、版本、SHA-256、完整大小和配额。仅检查 PDF 头与末尾 EOF 标记，不声称完整 PDF 语义、页数或安全性解析；客户端仍需完整校验和阅读器解析。服务不接收来源 URL，也不会代客户端抓取任意路径或链接。

同版本同字节的重试返回 `replayed:true`，不会重复计费；重放仍验证当前授权和实际上传字节。删除即使遇到尚无副本的版本，也推进内部 `cloud_pdf_generation`。删除前获得准入、删除后才提交的旧上传返回 `CLOUD_PDF_CHANGED`，只有之后的明确新请求能重新上传。该字段不改变实体 revision、正文、updatedAt 或 changelog。连接中断可能发生在数据库提交之后，客户端必须刷新状态确认，不自动补删。

迁移 `004_private_cloud_pdfs.sql` 把内容和计费保存在同一 PostgreSQL 事务，使用 bytea、复合账号外键、FORCE RLS、数据库 SHA-256/长度约束和账号锁内的计费触发器。没有临时文件或数据库与文件系统双写恢复窗口。runtime 新增云表 SELECT/INSERT/DELETE，不能更新云内容，也不增加历史表删除权限。数据库提交失败会一起回滚内容、字节计数、份数和内部 generation；显式删除释放云额度，不删除附件元数据、笔记、批注或本地缓存。

整文件 bytea 仍需要有界内存，驱动编码、SQL 和 HTTP 可能产生额外副本。本进程同时最多 2 个传输、每账号最多 1 个；上传收 body 前取槽，下载一直保留到响应 finish/close，数据库动作未结束时也不提前释放。下载按 64 KiB 分块交给 HTTP 流，使套接字背压生效，完整 bytea Buffer 仍驻留内存；分块本身不替代传输槽限制。每个传输有 45 秒绝对截止时间，超时仅关闭该连接；状态、删除和设备撤销不占传输槽。限额属于单 API 进程，不能代替反向代理带宽控制、全局账号数管理和实际部署容量验收。

| 错误码 | HTTP | 含义 |
| --- | --- | --- |
| `CLOUD_PDF_STORAGE_DISABLED` | 503 | 管理员未启用此能力 |
| `NOT_FOUND` | 404 | 版本不存在或不属于当前账号 |
| `CLOUD_PDF_NOT_FOUND` | 404 | 当前版本没有云副本 |
| `ATTACHMENT_VERSION_UNAVAILABLE` | 410 | 版本或文献已删除，不能上传或下载 |
| `PDF_INTEGRITY_MISMATCH` | 422 | 完整字节数或 SHA-256 不匹配 |
| `INVALID_PDF` | 415 | 缺少规定的 PDF 头或 EOF 标记 |
| `CLOUD_PDF_QUOTA_EXCEEDED` | 409 | 账号字节或副本数上限不足 |
| `CLOUD_PDF_CHANGED` | 409 | 上传准入被后续云删除动作取代 |
| `CLOUD_PDF_TRANSFER_BUSY` | 429 | 当前账号或进程的传输槽已占用，含 Retry-After |
| `REQUEST_TOO_LARGE` | 413 | 超过 64 MiB 单文件上限 |

认证、撤销、输入格式和服务临时故障仍沿用已有错误码。所有副本响应继续携带 `Cache-Control:no-store`；已开始发送的字节不能追回，撤销提交后的请求与上传提交都会重新拒绝旧会话。

## 可选在线桌面 PDF 取回

`PAPERQUAY_DESKTOP_PDF_ENABLED=1` 才开放在线桌面传输；默认 `0`，与私有云副本开关相互独立。启用后 capabilities 增加 `features.desktopPdfTransfer:1` 和 `desktopPdf:{transport:'http-relay-v1',maxFileBytes,requestTtlMs,pollTimeoutMs,byteWindowMs,accountWindowBytes,processWindowBytes,direct}`。HTTP 回退通过 API 进程实时转发字节；支持直连的客户端可先交换有界信令，用 WebRTC DataChannel 传输。两条路径均不生成云 PDF 副本，不把传输状态或文件字节写入数据库、磁盘；本机连接测试不构成公网、移动真机或多实例验收。

桌面端先通过现有同步接口发布文献与精确附件版本元数据，再注册当前 OIDC 会话并主动轮询。消费者和提供者必须属于同一 `(issuer,sub)`、使用不同 `sid`；每次传输还绑定各自已验证的客户端和会话。服务接受已注册平台为 `windows`、`macos`、`linux` 的提供者；平台字段用于功能选择，不是设备可信证明。服务只接受精确附件版本 UUID，不接受本地路径、来源 URL 或任意文件标识。

| 方法与路径 | 返回值或行为 |
| --- | --- |
| `GET /v1/desktop-pdfs/versions?after=&limit=` | `{items,nextAfter,hasMore}`；UUID keyset 分页，默认 25、最多 100 条 |
| `GET /v1/desktop-pdfs/versions/:id` | 当前有效的 `Target`；同时检查父文献、版本与 64 MiB 上限 |
| `POST /v1/desktop-pdfs/provider/poll` | 原 `{}` 或支持直连的 `{direct:true}`，最长等待 20 秒；返回 `{request:null}` 或 `{request:Job}` |
| `DELETE /v1/desktop-pdfs/provider` | 停止当前提供者并终止其已分配传输；返回 `{stopped:true}` |
| `POST /v1/desktop-pdfs/requests` | `{attachmentVersionId,direct?:{offer}}`；HTTP 201 仍返回 `{requestId,attachmentVersionId,expiresAt}` |
| `GET /v1/desktop-pdfs/requests/:id/content` | 仅请求创建会话可用，一次性完整 PDF 流；无 Range 支持 |
| `POST /v1/desktop-pdfs/requests/:id/content` | 仅分配到的提供会话可用；原始 `application/pdf`、精确 `Content-Length`；消费者响应完成后返回 `{sent:true}` |
| `POST /v1/desktop-pdfs/requests/:id/unavailable` | 提供者用空 JSON `{}` 拒绝当前任务；返回 `{acknowledged:true}`，尝试另一个在线会话 |
| `DELETE /v1/desktop-pdfs/requests/:id` | 创建会话取消请求；返回 `{cancelled:true}`，已结束请求为 404 |

`Target` 为 `{paper:{entityId,revision,title},version:{entityId,revision,data:AttachmentVersionData}}`。列表只包含当前账号、父文献和版本都未删除且大小合规的 PDF 元数据；没有本地文件路径或来源 URL。分页不是数据库快照，并发新增 UUID 可能位于当前 `after` 之前，刷新列表应从头开始。该元数据表示同步版本存在，不保证此刻有桌面在线或仍保有对应本地文件。

原 `Job` 为 `{requestId,attachmentVersionId,sha256,sizeBytes,expiresAt}`；直连任务仅向主动选择直连的提供者追加 `direct:{offer,expiresAt}`，其中内层截止属于直连阶段。提供者每次长轮询只领取一个任务，同一请求最多依次尝试 4 个不同提供会话；声明不可用或普通中继任务领取后 10 秒内未开始上传才切换候选者，不向已尝试会话重复派发。直连阶段采用下述固定 6 秒期限。没有提供者时明确返回不可用，不能通过未知 UUID 观察其他账号或其他会话的请求。

每次请求从创建起有最长 30 秒的固定期限，同时不超过消费者令牌的验证后 `exp`。正常配置下剩余有效期不足 2 秒拒绝创建；提供者轮询令牌需覆盖完整请求期限，上传时新令牌不能延长期限。传输过程中每秒重查会话、父文献与版本，并在释放最后一块前再次核验。删除后恢复也会改变 revision，不能让旧请求继续；设备撤销接口成功后还会立即中断本进程相关连接。数据库读校验使用短只读事务、事务局部 RLS 和 1 秒语句/锁等待上限，不获取账号写锁、不更新 last-seen。超过 1.5 秒仍未返回的检查使传输失败，未完成的数据库动作继续占用准入槽，避免无限叠加查询。

HTTP 流按最多 64 KiB 分块，增量计算 SHA-256、完整长度、PDF 头和末尾 EOF 标记；末块在完整性和最终授权通过前不发出。应用只保留有界流缓冲，不整文件收集。已经发出的前缀无法追回，客户端必须以完整长度、哈希和阅读器解析通过后才能接纳缓存；这些检查也不等同于完整 PDF 语义或安全性解析。消费者断线、提供者断线、取消、撤销、版本变化或超时会终止两端未完成的流；已发送响应头后的失败关闭连接，不能再返回 JSON 错误。

| 单 API 进程限制 | 数值 |
| --- | --- |
| 单文件 | 64 MiB |
| 活跃请求 | 每账号 1 个、进程 2 个；从创建至传输/未完成校验结束保留 |
| 提供会话 | 每账号 4 个、进程 32 个；在线状态最长 30 秒，需持续轮询 |
| 15 分钟准入字节预算 | 每账号 256 MiB、进程 1 GiB；最多跟踪 256 个账号窗口 |

字节预算在请求准入时按版本声明的完整大小计入，取消或未完成不退还，以限制反复创建并中断传输。窗口与所有会话/请求状态仅在内存中保存；重启后旧请求失败，额度重置。多实例之间不共享会话、请求和预算，当前版本要求参与同一传输的请求落到同一 API 进程，不声称已支持多实例调度。以上限制不替代反向代理的连接、请求、带宽控制；代理还需允许长轮询和流式转发。

| 错误码 | HTTP | 含义 |
| --- | --- | --- |
| `DESKTOP_PDF_TRANSFER_DISABLED` | 503 | 管理员未启用此能力 |
| `DESKTOP_PDF_PROVIDER_REQUIRED` | 403 | 当前注册平台不在提供者范围内 |
| `DESKTOP_PDF_UNAVAILABLE` | 404 | 无可用提供者，或被选提供者停止/失效 |
| `NOT_FOUND` | 404 | 版本/请求不存在、不属于当前账号或不属于当前调用会话 |
| `DESKTOP_PDF_REQUEST_IN_USE` | 409 | 同一角色控制请求、轮询、消费者或上传已占用，或完成/回退状态冲突 |
| `DESKTOP_PDF_DIRECT_FALLBACK` | 409 | 已进入 HTTP 回退；迟到 answer、authorize、complete 不得重开直连 |
| `DESKTOP_PDF_CHANGED` | 409 | 请求被取消或传输绑定状态已变化 |
| `DESKTOP_PDF_TIMEOUT` | 408 | 固定请求期限或等待期限已到 |
| `DESKTOP_PDF_TRANSFER_BUSY` | 429 | 请求、提供者或字节预算已满；含 `Retry-After` |
| `ATTACHMENT_VERSION_UNAVAILABLE` | 410 | 版本或父文献已删除 |
| `PDF_INTEGRITY_MISMATCH` / `INVALID_PDF` | 422 / 415 | 字节/哈希不符，或 PDF 标记无效 |
| `REQUEST_TOO_LARGE` | 413 | 超过单文件上限 |

认证、会话撤销、输入格式和服务临时故障继续使用已有错误码。所有响应保持 `Cache-Control:no-store`；错误正文不包含令牌、路径或输入内容。默认环境示例允许 `paperquay-desktop` 客户端，但身份提供商的客户端、回调地址和 PKCE 策略仍需与实际部署匹配。

### 可选设备直连

`desktopPdf.direct` 为 `{transport:'webrtc-data-v1',attemptMs:6000,maxSdpBytes:32768,stunUrls:[]}`。`PAPERQUAY_DESKTOP_PDF_STUN_URLS` 默认空，不主动连接公共 STUN；可配置最多两个逗号分隔的 `stun:` / `stuns:` 地址，配置总长最多 256 字符，只允许主机和可选端口，不允许凭据、路径、查询、片段或 TURN。无 STUN 时只尝试可直接发现的本地对端，配置 STUN 也不保证 NAT 穿透成功。客户端不支持直连、只有旧提供者在线或连接失败时沿用 HTTP 中继。

SDP 限制为 ASCII、最多 32 KiB、512 行、每行 1024 字符、32 个 candidate 和一个 data-only `m=application`，拒绝音视频和 `typ relay`。没有单独的 ICE candidate 接口。服务只转交有界 SDP，不用 candidate 发起网络请求；直连文件通过对端 WebRTC DTLS 传输。HTTP 中继仍可读取文件，不能称为设备间端到端加密。

以下路径均在 `/v1/desktop-pdfs/requests/:id/direct` 下，仅允许原消费者或已分配的提供者；每个角色同时最多一个控制操作，客户端正常每秒查询一次状态。

| 方法与后缀 | 输入及行为 |
| --- | --- |
| `GET` | `{state,answer,expiresAt,directExpiresAt,authorizedUntil,relayReady}`；state 为 `direct`、`relay` 或 `complete` |
| `POST /answer` | 提供者 `{sdp}` → `{accepted:true}`；相同 answer 幂等，不允许替换 |
| `POST /authorize` | 提供者 `{}` → `{authorizedUntil}`；最后一块和 EOF 前重新检查权限 |
| `POST /complete` | 消费者 `{sha256,sizeBytes}` → `{received:true}`；须摘要完全一致且提供者最终检查已通过 |
| `POST /fallback` | 任一绑定角色 `{}` → `{state:'relay'}`；幂等、单向，清除 SDP 和直连许可 |

建请求即预留一次活跃槽和完整字节预算，直连及回退共享原 request ID、精确版本和总期限。直连最多占建请求后的 6 秒，自动或显式回退都不续租、不重新计费。每次成功的直连状态检查签发最多 2 秒的许可，且不超过直连、总租约和当前已验证令牌截止；回退及完成状态不签发许可。提供者完成最终检查、消费者完整核验后，complete 仍需再次查数据库。撤销、目标变化、取消和授权失败终止请求，不作为可回退的连接故障。

消费者回退后丢弃直连部分字节，再挂接原 GET content；`relayReady` 只在该输出流准备好后为 true。提供者先关闭 peer，再等此标志并向原 POST content 上传。complete 与 fallback 在最终数据库检查之后通过一个同步状态变更决定结果；完成已赢时 fallback 返回 `DESKTOP_PDF_REQUEST_IN_USE`，回退已赢时迟到的完成返回 `DESKTOP_PDF_DIRECT_FALLBACK`。

成功先安装内存回执再释放活跃槽。最多保留 64 条回执，直连创建时即预留容量；TTL 为完成后 5 秒与原租约截止的较早者。回执只存双方身份绑定和目标摘要，不存 SDP、文件或令牌。查询及相同 complete 重试仍核验当前会话和目标，不延长回执、不签发许可；未结束的数据库校验仍占原槽或回执容量。重启不会恢复这些状态。

客户端的 DataChannel、分块、最终 ACK 与 Electron helper 隔离约定见 [设备直连协议](../docs/mobile-sync/direct-transfer-contract.md)。服务端 socket 测试只证明真实 HTTP 控制与回退；真实 WebRTC candidate pair、Electron helper 生命周期、手机和公网 NAT 须分别验收。

## 验证

```sh
npm run typecheck
npm test
npm run test:socket
npm run test:integration
```

如果当前 Windows/npm shell 无法找到 `node` 或 shim，可直接执行对应命令：

```sh
node node_modules/typescript/bin/tsc --noEmit
node --test tests/unit/*.test.ts
node --test tests/socket/*.test.ts
node --test --test-concurrency=1 tests/integration/*.test.ts
```

直连边界由 `tests/unit/desktop-direct.test.ts`、`tests/socket/desktop-direct.test.ts` 和 `tests/integration/desktopPdf.test.ts` 覆盖，包括双方绑定、旧客户端兼容、回退/完成竞争、回执上限、连接断开和真实 PostgreSQL 撤销/墓碑检查。集成测试只可在隔离数据库且显式设置 `PAPERQUAY_TEST_ALLOW_DATABASE_WRITES=1` 后运行。

集成测试必须使用隔离库。缺少 `PAPERQUAY_DATABASE_URL`、`PAPERQUAY_TEST_ALLOW_DATABASE_WRITES=1` 或 OIDC 必需配置时直接失败，不跳过。迁移回归另需 `PAPERQUAY_MIGRATION_DATABASE_URL`，在独立命名 schema 的事务内构造旧数据、执行历史迁移，最后 ROLLBACK，不改写现有 schema 的版本或校验和。真实 IdP 测试另需 `PAPERQUAY_TEST_PASSWORD`，默认客户端 `paperquay-integration`、用户 `qa-reader`/`qa-other`，可由 `.env.example` 中相应变量覆盖。测试只使用合成账号/文献；不会清空数据库或连接用户桌面库。

当前本机验证覆盖真实 PostgreSQL 非 owner/NOBYPASSRLS 角色、并发 CAS 和回执、事务回滚重试、账号隔离、撤销与等待写入的锁顺序、精确版本绑定、冲突保留/显式恢复、分页响应预算与新连接恢复，以及真实 Keycloak discovery/JWKS/访问令牌/刷新/两个账号隔离。保留字节回归覆盖 UTF-8 精确临界、四类内容的独立 SQL 汇总、并发争用、回执最后一字节超限导致全回滚、满额幂等重放、各类 resolve 分支，以及旧账号超过默认 256 MiB 后的完整迁移与 RLS 恢复。新连接恢复证明数据库状态可重读；操作系统级重启、备份恢复、正式公网部署和真实移动设备仍需各自验收。

私有副本新增真实数据库回归验证独立配额、512/513 份边界、SHA-256 数据库约束、账号隔离、墓碑、撤销、删除 generation 和故障回滚。真实回环 HTTP 连接验证部分上传期间的删除/撤销、主动中断、准入等待期间断连、绝对截止时间，以及暂停读取 64 MiB 下载时服务器响应确实未 finish、同账号第二下载被拒绝、断开后传输槽可复用。测试使用合成 PDF 标记内容；它们不声称真实论文的完整语义解析。截止时间测试通过仅限 AppOptions 的测试入口缩短等待，普通进程环境仍固定为 45 秒。

在线桌面取回另有真实 PostgreSQL 隔离、撤销、元数据分页和版本变化回归，以及无需数据库的真实回环 HTTP 流测试。后者覆盖末块等待最终授权、双向断线、取消后的晚到上传、设备撤销、固定截止时间、哈希失败，以及暂停读取 64 MiB 时服务端响应未完成、上游未整份读入、应用缓冲有界且传输槽仍占用。Windows TCP 发送缓冲可能接纳整份客户端写入，因此测试不把客户端 `write` 完成误当作服务端完整接收。生产公网代理、真实手机到桌面的链路和进程重启后的交互仍需单独验收。

## 批次请求回执与取消预留（M4）

启用既有远程任务后，新增加 `GET /v1/remote-tasks/requests/:id` 和 `POST /v1/remote-tasks/requests/:id/cancel`（请求体 `{}`）。二者均需既有Bearer、注册会话和当前账号授权；不会创建或恢复执行任务。响应为 `{requestId,status,task}`，status是absent、known、cancelled（创建前已预留取消）或removed（旧任务已清理）；只有known带闭合任务DTO。查询未知ID不保存回执。

取消与创建共用账号锁。known沿用单任务取消规则；absent写入取消预留，随后以该ID创建返回 `REMOTE_TASK_REQUEST_CANCELLED` /410；removed与cancelled均可幂等重试。取消去重请求会影响其共用任务；运行中仍为cancel_requested，直到执行者确认，不承诺外部费用退还。取消预留与普通创建回执共同计入既有2000条上限，不自动清除或重开。跨账号同UUID独立隔离。

升级先应用 `009_remote_request_cancellation.sql`；增加非空默认false字段及取消预留不得指向任务的约束，既有回执不变。ready检查要求009，不回退到“部分就绪”。runtime继续只有SELECT/INSERT与UPDATE(job_id)，不授予更新取消标记的权限；新写入的域分离摘要也使旧二进制对取消预留的迟到创建失败。迁移前备份、维护窗口及正式部署仍需相应流程；本轮只迁移专用测试库。

## 可选模型调用（AI-07，开发预览）

模型调用使用独立的 `model-invocations-v1` 协议，不复用 PDF 解析或向量任务。迁移 `010_model_inference.sql` 增加强制账号 RLS 的 provider/job 表；先按现有维护流程备份、迁移并重新运行 runtime 授权，再启动同版本 API。该变更没有在真实服务部署，移动端业务入口仍在接入中。

默认 `PAPERQUAY_MODEL_INFERENCE_ENABLED=0`。只开启这一项可让已登录的 Windows/macOS/Linux 客户端明确选择并提供一个聊天模型。电脑预设仅支持 Chat Completions，一次最多 2048 输出 tokens；每次启动与登录后默认关闭，需要新的配置确认。服务端只收到公开模型名称、版本及不可猜测的配置摘要，不接收电脑端点或密钥。凭据变更、服务能力撤回、退出账号、文库变化或关闭应用会停止本机工作器。未发布 PDF 也能独立提供模型。

网关另外要求 `PAPERQUAY_MODEL_GATEWAY_ENABLED=1`，且父功能已开启。以下配置只由部署者注入进程，客户端不能通过请求覆盖：

| 环境变量 | 要求 |
| --- | --- |
| `PAPERQUAY_MODEL_GATEWAY_ENDPOINT` | 固定的 HTTP(S) API 基址；无账号、查询或片段，不带 `chat/completions` |
| `PAPERQUAY_MODEL_GATEWAY_MODEL` | 固定模型名称 |
| `PAPERQUAY_MODEL_GATEWAY_API_KEY` | 部署者的私有密钥，不发送给客户端 |
| `PAPERQUAY_MODEL_GATEWAY_ALLOWED_SUBJECTS` | 非空 JSON 字符串数组，逐项列出当前 issuer 中允许的 OIDC `sub`；禁止 `*` |
| `PAPERQUAY_MODEL_GATEWAY_REQUIRE_KEY` | 默认 `1`；无密钥的已知本地服务需显式改为 `0` |
| `PAPERQUAY_MODEL_GATEWAY_TOKEN_PARAMETER` | `max_tokens`（默认）或 `max_completion_tokens` |
| `PAPERQUAY_MODEL_GATEWAY_MAX_OUTPUT_TOKENS` | 默认 2048，范围 64–8192 |
| `PAPERQUAY_MODEL_GATEWAY_ALLOW_INSECURE_HTTP` | 默认 `0`；非回环 HTTP 基址必须另外显式开启 |

网关白名单不会隐式授权所有账号。私有配置变化使公开配置摘要变化；创建或领取时配置不匹配则拒绝。适配器只发送一次固定的非流式 Chat Completions 请求，不接受工具调用，不跟随重定向，不自动替换模型或重新付费。它对 UTF-8、重复 JSON 键、大小、分片数和等待时间均设上限，保存前替换响应中出现的实际私有密钥；这不构成任意敏感信息识别。

| 接口（均需已验证且已注册的当前会话） | 行为 |
| --- | --- |
| `GET /v1/model-inference/availability` | 当前账号的网关公开配置和在线电脑；只读 |
| `PUT /v1/model-inference/provider` | 电脑发布 `{profiles}`，在线租期 45 秒 |
| `DELETE /v1/model-inference/provider` | 撤回本会话电脑配置 |
| `POST /v1/model-inference/jobs` | 完整规范请求；仅新创建、已确认提交的网关请求可启动首次执行 |
| `GET /v1/model-inference/jobs` | 最多 50 份保留任务与当前账号配额；只读 |
| `GET /v1/model-inference/requests/:id` | 按原 UUID 查看状态与已保存结果；只读 |
| `POST /v1/model-inference/requests/:id/cancel` | `{}`；不存在时也保留取消身份，阻止晚到创建 |
| `DELETE /v1/model-inference/jobs/:id` | 清理该任务内容，保留原 UUID 墓碑 |
| `POST /v1/model-inference/jobs/:id/dispatch` | `{}`；明确启动仍在排队、从未领取的网关请求 |
| `GET /v1/model-inference/jobs/:id/recovery` | 网关本进程保存状态；只读 |
| `GET /v1/model-inference/jobs/:id/recovery/candidate` | 备份已收到但尚未确认保存的本进程候选结果；只读 |
| `POST /v1/model-inference/jobs/:id/recover` | `{}`；只重试原结果或失败状态的保存，不调用模型 |
| `DELETE /v1/model-inference/jobs/:id/recovery` | 明确丢弃该网关内存候选副本，不重新执行 |
| `POST /v1/model-inference/provider/claim` | `{}`；本电脑领取一次尚未执行的任务 |
| `POST /v1/model-inference/jobs/:id/heartbeat` | 原 `{fence}`；延长仍有效的执行租期 |
| `POST /v1/model-inference/jobs/:id/complete` | 原 `{lease,output}`；保存严格验证的同一结果 |
| `POST /v1/model-inference/jobs/:id/fail` | 原 `{lease,code}`；受限失败码，不接收上游原文 |

请求 UUID、目标、配置引用、输入摘要与首次 fence 不可替换。每账号最多 1 项执行、4 项排队、50 项内容、2000 项永久身份，模型内容逻辑预算为 16 MiB；在执行前为每个尚无结果的任务预留完整 256 KiB 输出空间。单请求最多 32 条消息、192 KiB 文本输入；完整请求最多 256 KiB，结果文本最多 240 KiB。租期过期、撤销、崩溃或不确定提交不会把任务重新放回队列；确认回复丢失后先查看原 UUID，不能换 UUID 自动重发。尚未保存的晚到已知结果只接受原 fence。

输入与结果自创建起可读至多 24 小时，过期即不可读；账号后续访问时才清空数据库内容，保留身份墓碑。没有后台清理调度，不能承诺闲置数据库在 24 小时后物理擦除。数据库、WAL、索引与备份容量仍需部署者管理。

网关的数据库保存失败候选暂留本进程内存，限 16 份且进程最多并行 2 次上游调用；保存成功或明确丢弃后才释放相应空间；下载备份本身不会清除候选。进程终止会丢失尚未持久化的内存候选，不能声称重启恢复这些内容。电脑工作器在上游调用之前先通过系统加密存储确认执行意图；已收到结果先落加密本机记录，失败时保留本进程副本。重新打开只显示历史，只有用户明确操作才重试保存或把无结果意图标记为未知；旧登录会话不能被新设备会话静默接管。系统加密不可用或为明文后端时拒绝开启。记录最多 16 项，已保存内容由用户备份后明确清理，未确认记录保留。

这一路径不改变同步实体 schema、普通 outbox/游标或 PDF/向量恢复语义。真实 OIDC 链、真实计费模型、跨设备业务、生产部署与实机仍需独立验收。


### 协商图谱关系

迁移011_graph_relations.sql扩展graphRelation类型；旧客户端无graph-relations-v1能力时，拉取和冲突列表隐藏该类型并推进游标，写入与解决被拒绝。文献/笔记端点按当前账号检查，删除后不能借关系恢复。每账号512条活动关系、2MiB实际JSON内容，历史副本继续受保留额度约束；部署前按现有流程备份和迁移。详细实现及真实环境缺口见[图谱关系检查点](../docs/mobile-sync/m4-graph-relations-checkpoint.md)。
