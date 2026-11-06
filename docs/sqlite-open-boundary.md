# SQLite 打开与路径边界

共享文库的检查与后端启动之间，供应方可能替换尚不存在的笔记库、RAG 库或附属文件。已有文库的规范路径在注册后保持原值；启动、复核和后端派生路径时不再通过新出现的链接重新授权目标。

`nodeSqlite.cjs` 为文件连接取得 retained no-follow 目录能力，再通过 `paperquay-pinned` VFS 打开数据库。主库、WAL、SHM、回滚日志和多库日志均复用该能力。POSIX 使用 `openat`、`fstatat`、`unlinkat`；Windows 使用单组件 `NtCreateFile`、句柄信息与按句柄删除。叶文件必须是单链接普通文件；截断发生在句柄验证后。文件名相同的目录替换和原地重解析点变更无法改变已保留的目录对象。

VFS 通过 SQLite 公开的扩展 API 表及系统调用接口接入宿主 SQLite，继续使用宿主的文件 I/O、锁、WAL、共享内存、映射和同步实现。代码不链接第二份 SQLite，也不访问 Node 或 SQLite 私有对象布局。所需 VFS 版本、系统调用与注册信息在运行时校验；接口缺失或被替换时拒绝打开。公开头文件的固定来源和摘要见 [`electron/native/sqlite-api/README.md`](../electron/native/sqlite-api/README.md)。

每个连接和相关 SQLite 文件分别持有能力。显式关闭连接后，最后一个文件关闭才释放目录；构造、打开或模式初始化失败时清理已取得的能力。未显式关闭而进入 GC 的连接保留目录至进程退出，避免依赖 JS 与 SQLite finalizer 的执行顺序。内存连接及 SQLite 自行创建的匿名临时文件沿用宿主行为。快照为目的路径另行取得能力，避免 `VACUUM INTO` 绕过边界。

自动回归使用真实 SQLite、文件链接、目录替换和子进程。Windows 另实际设置并清除测试目录的重解析点，覆盖不经过重命名的替换。测试核对外部哨兵数据库字节、附属文件、并发 WAL 读取、跨进程锁、重开持久化及快照恢复。Electron smoke 同时验证实际宿主加载扩展与双连接 WAL；三个 POSIX CI 环境运行边界与恢复测试。真实共享存储和具体文件系统的运行表现仍需对应环境验证。
