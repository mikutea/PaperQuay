# PaperQuay 账号同步服务 M1

本目录提供独立 Fastify API、PostgreSQL 持久层和 OIDC 访问令牌校验。服务只同步文献元数据、附件版本描述、Markdown 笔记、PDF 批注和阅读位置；不接收 PDF 文件、桌面数据库、绝对路径、第三方模型密钥或账号密码。现有桌面库的导出/导入由 `packages/sync-core` 与桌面适配器负责，服务端不连接用户本地库。

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

默认 API 监听 `127.0.0.1:4311`。非回环监听必须显式设置 `PAPERQUAY_ALLOW_NON_LOOPBACK=1`；HTTP issuer 和前端 origin 只允许回环地址，其余必须为 HTTPS。代理头不参与可信客户端地址判断。多副本/公网代理所需的共享限流、TLS、代理信任和身份服务运营需要单独验证。

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
| `PAPERQUAY_REQUESTS_PER_MINUTE` | 每个直连 IP 的内存限流，默认 120 |

数据库迁移只管理 `paperquay` schema。所有文件在一个事务中执行，以 advisory lock 排斥并发迁移，并记录文件校验和；已应用迁移改写或出现未知版本会失败。`deploy/runtime-role.sql` 仅向已经存在的 `paperquay_runtime` 角色授予所需表权限，不创建账号或改密码。`002_receipt_quota.sql` 在同一个锁定事务内回填回执计数，并恢复 FORCE RLS；触发器使旧进程在升级窗口内的回执写入也计入配额。

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
| `GET /v1/capabilities` | 协议/实体 schema、实际配额、`deviceBinding: oidc-session`、`pdfStorage: false` |
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

`opId` 在账号内唯一，请求内容使用稳定哈希校验；同 opId + 同内容返回原回执，同 opId + 不同内容返回 `IDEMPOTENCY_MISMATCH`。每个 batch 允许部分操作先提交；遇到中途断线或撤销后，可依靠原 opId 确认已提交部分，不能为重试生成新 opId。数据库事务失败、缺失依赖以及响应预算不足不保存永久拒绝回执。

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
| 每账号活跃 / 保留会话 | 100 / 1000 |

M1 不清理 tombstone、历史变更、回执或已撤销会话，因此触及保留配额后明确拒绝新增内容，已有内容仍可读取和重放。生产的归档/压缩/epoch 重建需要后续设计和验证。达到响应预算时，未提交操作返回 `RESPONSE_LIMIT_REACHED` 且 `retryable:true`，客户端可在已处理操作退出队列后重试剩余项。异常的单记录分页超限返回显式错误，不返回一个永远无法推进的空页。

## 验证

```sh
npm run typecheck
npm test
npm run test:integration
```

如果当前 Windows/npm shell 无法找到 `node` 或 shim，可直接执行对应命令：

```sh
node node_modules/typescript/bin/tsc --noEmit
node --test tests/unit/*.test.ts
node --test --test-concurrency=1 tests/integration/*.test.ts
```

集成测试必须使用隔离库。缺少 `PAPERQUAY_DATABASE_URL`、`PAPERQUAY_TEST_ALLOW_DATABASE_WRITES=1` 或 OIDC 必需配置时直接失败，不跳过。真实 IdP 测试另需 `PAPERQUAY_TEST_PASSWORD`，默认客户端 `paperquay-integration`、用户 `qa-reader`/`qa-other`，可由 `.env.example` 中相应变量覆盖。测试只新建合成账号/文献；不会清空数据库或连接用户桌面库。

当前本机验证覆盖真实 PostgreSQL 非 owner/NOBYPASSRLS 角色、并发 CAS 和回执、事务回滚重试、账号隔离、撤销与等待写入的锁顺序、精确版本绑定、冲突保留/显式恢复、分页响应预算与新连接恢复，以及真实 Keycloak discovery/JWKS/访问令牌/刷新/两个账号隔离。新连接恢复证明数据库状态可重读；操作系统级重启、备份恢复、正式公网部署和真实移动设备仍需各自验收。
