# 生产打包与恢复

这些文件提供通用部署与恢复工具。实际主机、域名、证书、账号、环境文件、
恢复密钥、备份和运维收据全部保存在 Git 仓库外，不能作为 PR 或 release 附件上传。
本工具的自动化测试也不代替实机、签名、外网客户端和部署现场验收。

## 独立部署

需要 Linux、现有 Docker/Compose 管理权限、Python 3 和发行版提供的 `age`。
建立专用 Compose 项目和数据库卷，不能套用到共享 PostgreSQL 或现有业务项目。
生产模板只把 Web 入口绑定到操作系统回环地址；数据库、身份管理端口和同步端口不对宿主机发布。
现有入口代理负责受信任的 HTTPS。不得通过关闭证书验证完成部署。

从已审查提交构建 `Server.Dockerfile`、`Web.Dockerfile`、`Identity.Dockerfile`。所有外部 `FROM` 和演练 PostgreSQL 输入均固定为官方注册表 manifest 的 SHA-256 摘要；不提供基础镜像 build-arg 覆盖。升级摘要必须经过 PR 审查和完整恢复演练。
构建上下文采用白名单，不接收部署环境文件；Web 构建也不传入实际服务地址。
为构建指定 `PAPERQUAY_REVISION`，正式部署记录基础镜像摘要及最终镜像 ID。
`compose.env` 的四个镜像必须使用 `sha256:…` 或 `repository@sha256:…`。

操作目录权限为 `0700`，环境文件为当前操作用户所有、权限 `0600`。
复制 `compose.production.yml` 和 `init-production.sql`，并在该目录准备：
`init-production.sql` 是不含密码的通用模板，需为 `0644`，使容器切换到 PostgreSQL
用户后仍可读取绑定挂载；不要把密码写入 SQL。父目录保持 `0700`。

| 文件 | 内容 |
| --- | --- |
| `compose.env` | `PAPERQUAY_PROJECT`（`paperquay-` 前缀）、未占用的 `PAPERQUAY_LOCAL_PORT`、未占用的私有 IPv4 `/24`–`/28` 网段 `PAPERQUAY_APPLICATION_SUBNET`、该网段内 Web 固定地址 `PAPERQUAY_WEB_IP`、经核实的入口代理地址 `PAPERQUAY_INGRESS_PROXY_IPS`（空格分隔，最多 8 个单独 IP），以及 `PAPERQUAY_POSTGRES_IMAGE`、`PAPERQUAY_IDENTITY_IMAGE`、`PAPERQUAY_SYNC_IMAGE`、`PAPERQUAY_WEB_IMAGE` |
| `database.env` | 独立随机的 `POSTGRES_PASSWORD`、`PAPERQUAY_MIGRATION_DB_PASSWORD`、`PAPERQUAY_RUNTIME_DB_PASSWORD`、`PAPERQUAY_IDENTITY_DB_PASSWORD` |
| `identity.env` | HTTPS `KC_HOSTNAME`、对应的 `KC_DB_PASSWORD`、首次引导使用的管理员设置。引导完成后按身份服务规则移除引导配置 |
| `migration.env` | 仅迁移容器使用的 `PAPERQUAY_MIGRATION_DATABASE_URL` |
| `sync.env` | 运行角色的 `PAPERQUAY_DATABASE_URL`、OIDC issuer/audience/client IDs、允许的客户端 origins、独立随机且固定保存的 `PAPERQUAY_CURSOR_SECRET`；按需开启文件或任务能力 |
| `runtime-config.json` | 仅包含 `apiBaseUrl`、`oidcAuthority`、`oidcClientId` 三个公开连接字段，权限 `0644`。例如 API 使用所选 HTTPS origin 下的 `/api`，issuer 使用 `/identity/realms/paperquay` |

环境文件每行使用 `NAME=literal-value`，不使用引号、`export`、命令替换或环境插值。
数据库用户名固定为 `paperquay_migrate`、`paperquay_runtime`、`paperquay_erasure`、`paperquay_identity`。
两个数据库为 `paperquay` 和 `paperquay_identity`，内部数据库主机名为 `database`。
Node 应用的完整变量及额度规则见 `server/src/config.ts`。

Web 固定地址不能使用网关、网络或广播地址。Compose 将其明确传给 API 的
`PAPERQUAY_TRUSTED_PROXY_IPS`，不能省略该信任链，也不信任整个容器网段。
外层 HTTPS 入口必须覆盖客户端提供的转发头，以真实连接来源设置 `X-Forwarded-For`；
在现场核对 Web 实际看到的入口对端 IP 后，才填写 `PAPERQUAY_INGRESS_PROXY_IPS`。
Web 只信任这些单独地址，从右向左解析并向 API 发送单个已解析的客户端 IP。
未受信任来源伪造转发头不能获得新限流桶；不同客户端不再共用 Caddy 的匿名限额。
规则依据 [Caddy 可信代理](https://caddyserver.com/docs/caddyfile/options#trusted-proxies)
与 [Fastify trustProxy](https://fastify.dev/docs/latest/Reference/Server/#trustproxy)。

先启动数据库，显式执行 `migrate` profile，再启动身份服务和 Web。
在隔离的身份管理通道建立 `paperquay` realm，默认关闭自助注册，由管理员开通；
公开客户端使用 PKCE、精确 Web/原生回调及 API audience，不使用客户端密钥。
配置恢复渠道与隐私说明后，核对真实 HTTPS discovery 和签名密钥，再启动 `sync`。
Web 入口不会代理 master realm 或身份管理控制台。

执行命令时，使用所选操作目录的 `compose.env`、`compose.production.yml` 和
`--project-directory`，避免把 shell 当前目录或其他项目带入操作。

## 备份与全新实例恢复演练

恢复密钥由部署方单独保存，并在另一受控位置保留恢复副本。
备份加密所用公钥可以进入操作配置，私钥不能与备份放在同一存储故障域。
普通日志不记录数据库内容、身份凭据、文件、模型文本或密钥。

```sh
python3 /reviewed-source/server/deploy/ops.py --directory /private/operator check
python3 /reviewed-source/server/deploy/ops.py --directory /private/operator backup \
  --output /private/backups/snapshot.tar.age --recipient AGE_PUBLIC_RECIPIENT
python3 /reviewed-source/server/deploy/ops.py --directory /private/operator restore-drill \
  --backup /private/backups/snapshot.tar.age --expected-sha256 RECEIPT_SHA256 \
  --identity /private/recovery/age-identity
```

备份短暂停止本项目原本运行的同步服务和身份服务，使两个数据库处于同一静止点。
完成数据库读取后恢复这些服务，原本停止的服务保持停止；不停止 Web 或其他项目。
备份包含完整 PostgreSQL 集群逻辑转储、角色、业务历史、冲突、PDF/任务二进制、
身份 realm/签名密钥、全部部署配置、游标密钥和四个精确运行镜像。
明文只存在于权限受限的临时目录；最终文件使用 `age` 加密，路径必须为新文件。
单份备份支持最多 32 GiB 未压缩载荷（包括镜像、配置及 manifest）；超限在加密发布前
以 `BACKUP_TOO_LARGE` 停止，不生成成功收据，不能把该上限当作已实测容量。

独立保存命令返回的加密文件 SHA-256 收据。恢复前先核对该收据，再解密，
逐文件核验，拒绝额外路径、链接、损坏内容、未知或不连续的 schema。
演练只新建带唯一标签的容器和卷，没有网络和对外端口，不挂载原数据库卷。
恢复后逐表比较条数和全部行内容哈希，包括二进制文件及身份数据，并核对角色。
通过后仅清理本次演练创建的容器和卷；失败保留隔离实例供诊断。
输出记录备份静止时间和恢复耗时，不能据此承诺未实测的 RPO/RTO。

整机丢失时，可在新主机先校验收据、解密并核验文件，再从镜像归档恢复精确镜像、
在隔离实例恢复集群。恢复的配置须经部署方复核域名、入口、卷和目录后才可启用；
不能把备份配置直接覆盖到正在运行的主机。该提升为正式服务的步骤需另留现场收据。

## 升级与回滚

1. 保存当前镜像 ID、配置、健康状态及完整加密备份，先通过一次恢复演练。
2. 使用候选版本的 `ops.py check` 核对原数据库。`upgrade_required` 只表示已知 schema 的完整前缀；未知版本或校验不符直接停止。
3. 停止同步写入，显式运行候选版本迁移和运行角色授权，再核对候选就绪。迁移事务失败时停止切换，确认原 schema 完整后才恢复原程序。
4. 仅在就绪后切换同步与 Web 镜像；数据库、身份版本升级使用各自验证过的独立维护流程，不顺带升级。
5. 回滚前使用目标旧版本的检查工具读取当前 schema。只有 `compatible` 才允许复用当前卷切回旧程序；`upgrade_required` 或 `SCHEMA_UNSUPPORTED` 均阻止回滚。

不通过降级数据库、逆向执行迁移或覆盖原卷完成回滚。不兼容时在全新实例恢复升级前备份，
核对恢复后内容以及切换后新增数据，再由既定入口切换流程处理；原实例保留。

## 验证范围

`operations_test.py` 验证归档、校验、schema 和失败后的服务状态边界。
`operations_docker.py --allow-disposable-docker-writes` 仅用于一次性 Linux CI：
构建三个生产镜像，启动真实 PostgreSQL/Keycloak/Web，写入合成业务、冲突和云 PDF，
执行加密备份与全新数据库恢复，核对全部表和角色，并拒绝损坏备份。
真实 Fastify/Caddy 路径还核对可信入口后的两客户端限流隔离、直接连接的两客户端隔离，
以及不可信来源伪造转发头不能重置限额；认证成功流仍由独立 OIDC 套件验证。
同步 API 的 OIDC/事务业务另由原服务集成套件验证；该演练不包含浏览器登录或实机。

账号注销额外使用 `paperquay_erasure` 独立 LOGIN 角色与独立密码。`database.env` 的 `PAPERQUAY_ERASURE_DB_PASSWORD` 只用于新集群初始化，`sync.env` 的 `PAPERQUAY_ERASURE_DATABASE_URL` 指向同一应用数据库。`grant-runtime.ts` 同时应用 `erasure-role.sql` 的窄授权。普通运行角色无此角色成员资格，也没有 `erase_account` EXECUTE；普通 SQL 凭据泄露不能调用注销 definer。API 只在确认、最近的签名认证和当前会话校验后使用最多两连接的注销池。没有该配置时注销返回不可用，绝不回退到运行角色或迁移角色。生产初始化仅适用于新专用集群；旧环境先由受控管理员创建独立角色，应用迁移及授权，再切换配置。

## 私有监测

在 `sync.env` 显式设置 `PAPERQUAY_PRIVATE_METRICS_INTERVAL_SECONDS=60` 开启汇总；默认关闭，可选 15–3600 秒。固定大小的计数、状态类别、延迟直方图和进程资源写入容器的有界日志，不建立可从客户端访问的指标接口，不记录 URL、账号、设备、请求 ID、正文、凭据或异常文本。

```sh
python3 /reviewed-source/server/deploy/monitor.py --directory /private/operator \
  --output-directory /private/monitor --samples 1
```

输出目录须在 Git 外且为 `0700`。采集仅检查本项目的四个容器，记录 CPU/RSS、重启、网络及块读写累计值、磁盘剩余空间、就绪结果、任务队列数量和两库大小。SQL 使用只读事务及五秒期限；日志仅允许经过重新构造的数字字段。缺失或超过汇总周期上限的指标明确报错。收据为两个各至多 4 MiB 的 `0600` JSONL 文件；不上传遥测。需要连续观察时显式提供样本数和间隔，或由既有受控调度每分钟调用。累计计数只可在相同进程启动周期内相减，容器重启必须另记，不能将重置误报为零错误。

`benchmark.py --profile /private/load.json --receipt /private/capacity.json` 使用 Git 外 `0600` profile 中的 `apiBaseUrl`、短期 `accessToken` 和精确 `revision`。仅访问固定的同步拉取 GET；不重定向、不重试、不执行模型、上传或写入。使用专门的合成验收账号，测试数据至少每页 100 条且响应达到 128 KiB；空库不能得到容量通过收据。先预热 10 次，再按每秒 1 次测量 120 次，最多 4 个并行请求；P95 ≤ 500 ms、P99 ≤ 1500 ms、零失败及零限流才通过。所有请求连同失败都计入统计，收据不含地址、token、游标或正文。账号和入口仍遵守实际限流，不能为跑分关闭保护。测试期间连续采集 monitor，另外保存容器峰值内存、数据库/磁盘及网络增量；探针本身不冒充全机资源测量。这个初始邀请服务预算只描述该只读负载，不能推及并发写入、大 PDF、弱网设备或 AI 的容量。

## 私有账号开通与恢复

`realm.py --web-origin HTTPS_ORIGIN --output /private/operator/production-realm.json` 只生成不含用户及凭据的正式 `paperquay` realm。输出位置和实际 origin 都留在仓库外。通过已有内部管理员通道导入新 realm；已有 realm 先备份并核对差异，不覆盖导入。它只开启管理员邀请和 Code+S256 PKCE，禁用密码 grant、implicit、自助注册、离线授权和服务账号；移动 Web 的回调及退出地址精确匹配 HTTPS origin。桌面回环只允许既定 IPv4 回调路径，由 Keycloak 的原生回环规则接受临时端口。

本模板不授权原生移动端的自定义 scheme；原生开发工程只可接隔离开发 realm。正式原生客户端必须使用独立 client ID 及受平台认领的 HTTPS App/Universal Links，并核对实际发布签名、域名关联文件及系统回跳后才开通。PKCE 防止截获者兑换别人的 code，但不能让恶意应用无法以自己的 verifier 发起同一个 public client 请求。缺少签名/关联证据时保留关闭状态，不能把可用 Web 服务标作已完成原生签名发布。

使用固定版本 Keycloak 的 `basic` 默认 scope 提供真实 `sub` 和会话 `auth_time`，不以常量、用户可编辑属性或刷新时间替代。上线时验证实际签名 token，而不是只检查 JSON 配置。协议配置依据 [Keycloak 管理指南](https://www.keycloak.org/docs/latest/server_admin/)，`auth_time` 的具体实现见[固定版本源码](https://github.com/keycloak/keycloak/blob/26.8.1/services/src/main/java/org/keycloak/protocol/oidc/OIDCLoginProtocolFactory.java)。

首次引导只建立管理员通道，不生成公开测试用户。管理员按身份核验结果单独开通，用户在受信任的系统浏览器设置密码并选择 MFA；不得通过聊天、仓库、普通日志传递初始密码或恢复链接。未配置并实际验证 SMTP 时关闭邮件找回，使用既有管理通道协助恢复，并在部署方的服务说明中公开该流程。恢复前核实主体及请求、备份身份状态，恢复后撤销旧会话并验证重新登录；应用账号注销和身份服务账号删除分别处理。身份管理控制台与 master realm 始终不从应用 Web 入口公开。
