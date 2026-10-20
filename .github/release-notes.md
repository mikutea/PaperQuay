# PaperQuay {{VERSION}} — Unofficial integrated fork build

> This is an unofficial modified build from the `mikutea/PaperQuay` fork. It is not endorsed by the upstream PaperQuay maintainers. The fork integration branch and `main` combine the fixes proposed upstream in PRs [#18](https://github.com/WangQrkkk/PaperQuay/pull/18), [#19](https://github.com/WangQrkkk/PaperQuay/pull/19), and [#20](https://github.com/WangQrkkk/PaperQuay/pull/20).

## Downloads

Windows x64 artifacts:

- `.exe`: NSIS installer
- `.msi`: MSI installer
- `.zip`: portable directory; start with `Start-PaperQuay.cmd` after extraction so the sandbox ACL is prepared
- `SHA256SUMS.txt`: SHA-256 checksums for all three packages

The binaries are not code-signed. Windows SmartScreen may show an unrecognized-app warning; verify the published SHA-256 before running them.

Linux x64 packages and macOS Intel/Apple Silicon disk images are also provided. This is a prerelease, not a stable-release or live-upgrade guarantee.

## Known limitation

The startup database-path P2 reported in [#26](https://github.com/mikutea/PaperQuay/pull/26#discussion_r4214657505) remains unfixed in this prerelease. If another party can modify an adopted library while it is being opened, the SQLite path can be redirected outside that library. Use only library/profile directories that you control and that untrusted users cannot modify; accepting a library does not remove this risk.

## Changes since app-v0.1.26-mikutea.13

- Adds PDF highlights and underlines to the selection popup, supports activating the highlighter before selecting text, preserves the selection after adding a note, and restores the correct tool color palette ([#28](https://github.com/mikutea/PaperQuay/pull/28)).
- Saves highlights and underlines in structured original and translated text. Marks remain available with selection translation disabled and stay attached to image captions, tables, and equations when switching display modes ([#28](https://github.com/mikutea/PaperQuay/pull/28)).
- Prevents PDF page-count updates from restarting the same document load and avoids showing a previous document's page count after switching sources ([#29](https://github.com/mikutea/PaperQuay/pull/29)).
- Matches Crossref metadata against five title candidates before accepting a DOI, year, or title ([#29](https://github.com/mikutea/PaperQuay/pull/29)).
- Makes Chinese the default README while preserving the complete English version and language links ([#30](https://github.com/mikutea/PaperQuay/pull/30)).

## Earlier changes in app-v0.1.26-mikutea.13 (since .12)

- Remembers the selected library across restarts and updates, and provides consent-based recovery of an existing library instead of silently replacing it with an empty one ([#26](https://github.com/mikutea/PaperQuay/pull/26)).
- Loads the complete paginated library, including collections over 1,000 papers, and preserves accurate counts and manual ordering after filtering ([#26](https://github.com/mikutea/PaperQuay/pull/26)).
- Adds system-theme following and startup update preferences; pending Reader and application settings are preserved during Zotero import ([#26](https://github.com/mikutea/PaperQuay/pull/26)).
- Improves the notes workspace with complete collection loading, debounced autosave, layout fixes, and source-bound image access ([#26](https://github.com/mikutea/PaperQuay/pull/26)).
- Keeps WebDAV collection roots canonical while retaining local path aliases, and makes notes/RAG database restoration transactional with pinned source checks ([#26](https://github.com/mikutea/PaperQuay/pull/26)).
- Tightens native file read/write/delete and directory-listing authorization, migration inputs, renderer navigation, and MinerU PDF upload boundaries. These fixes do not resolve the startup limitation above ([#26](https://github.com/mikutea/PaperQuay/pull/26)).

## Earlier changes in app-v0.1.26-mikutea.12 (since .11)

- Restores readable dark-mode Reader Markdown and knowledge-graph labels, including live theme changes ([#23](https://github.com/mikutea/PaperQuay/pull/23)).
- Shows waiting, provider-supplied reasoning and answer-stream progress in document QA; keeps reasoning separately expandable, handles failed/empty streams, and avoids duplicating final reasoning snapshots ([#23](https://github.com/mikutea/PaperQuay/pull/23)).
- Fits tall figure previews to the window, supports original-size scrolling and Escape/focus return, and restores a usable default QA-sidebar width ([#23](https://github.com/mikutea/PaperQuay/pull/23)).
- Preserves local MinerU figure locations when reopening cached results. Source content must match the cached artifact before its directory is reused; late QA failures no longer overwrite a newly selected session's error or attachments ([#24](https://github.com/mikutea/PaperQuay/pull/24)).

Local figure assets still depend on their original directory. Older manual-import caches without source provenance may require selecting the original JSON once again.

## Earlier changes in app-v0.1.26-mikutea.11 (since .10)

- Updates Tiptap and XML/ZIP dependencies to address reported advisories; MinerU ZIP extraction now rejects pre-existing symlink or junction paths outside its output directory ([#20](https://github.com/mikutea/PaperQuay/pull/20)).
- Updates the packaged Electron runtime and the release/build toolchain, including electron-builder, Vite, and PostCSS. The complete npm dependency audit reports zero advisories for this lockfile ([#21](https://github.com/mikutea/PaperQuay/pull/21)).

## Earlier changes in app-v0.1.26-mikutea.10 (since .9)

- Structured Reading now displays MinerU superscripts/subscripts and keeps inline math inside its Markdown table cells ([#10](https://github.com/mikutea/PaperQuay/pull/10), [#11](https://github.com/mikutea/PaperQuay/pull/11)).
- MinerU visual captions, notes, and assets remain attached to their source blocks; numeric-keyed page dictionaries and empty cross-page table fragments retain their content sources ([#12](https://github.com/mikutea/PaperQuay/pull/12), [#17](https://github.com/mikutea/PaperQuay/pull/17), [#18](https://github.com/mikutea/PaperQuay/pull/18)).
- Hidden graph workspaces defer layout until visible, and RAG embedding requests repair malformed UTF-16 input ([#13](https://github.com/mikutea/PaperQuay/pull/13), [#14](https://github.com/mikutea/PaperQuay/pull/14)).
- The library deduplicates case-insensitive tags, and the model picker stays inside the viewport near the bottom edge ([#15](https://github.com/mikutea/PaperQuay/pull/15), [#16](https://github.com/mikutea/PaperQuay/pull/16)).

## Integrated fixes

- Restores readable MinerU structured-reading content in dark mode by removing the light radial background image and applying explicit dark text colors to lists and table captions.
- Adds optional `query: ` / `passage: ` embedding input prefixes across Reader QA, Agent context, semantic reranking, and indexed RAG content while preserving plain-text compatibility by default.
- Runs MinerU batches against every processable PDF in the authoritative library, including papers that have not previously been opened in Reader.
- Adds opt-in, resumable English-to-Chinese full-library translation with conservative language detection, source-bound caches, shared rate limiting, and pause/cancel/progress controls.
- Includes Pizzip's `pako` runtime dependency in packaged builds, preventing the main-process `Cannot find module 'pako/dist/pako.es5.min.js'` startup error.
- Grants the Windows Chromium sandbox the minimum inherited read/execute access it requires, using the localized-independent `S-1-15-2-2` SID instead of disabling the sandbox.
- Verifies the packaged `app.asar` can resolve the Pizzip/Pako runtime chain before release assets are published.
- Keeps library-wide translation strictly serial, resumes saved translated blocks, and stops the run promptly when the translation service is unavailable instead of failing every paper.
- Lets a manual “Generate All Overviews” request take priority over an automatic MinerU or translation batch after the current in-flight item finishes.
- Makes batch translation, library status, and Reader use the same visible MinerU blocks and source fingerprint. Older mismatched local translation caches are rejected and can be regenerated with the configured translation model.
- Preserves the validated Windows `--user-data-dir` profile path so the real library is not replaced by an empty nested profile.
- Resolves actionable review findings on fork PRs #1, #4, #5, and #6: batches cover more than 1,000 papers, automatic jobs stop on limits and outages, overview preemption resumes translation, and concurrent translation cannot overwrite a paper's cache.
- Checks this fork's complete prereleases in-app; NSIS installers use the selected release's update manifest, while portable builds remain manual and start through the sandbox-ACL launcher.

The local MiyuoAPI/LM Studio router and its Windows watchdog are personal device configuration, not bundled in the PaperQuay installers. Both TranslateGemma and Nemotron embedding are loaded on demand through the router, switched mutually exclusively, and given a 300-second idle unload TTL.

Personal device-to-device library synchronization is intentionally not an application feature and is not included in these binaries.

## Verification

- PR #28 completed code review and validation, but its security review did not start and was waived for that merge by explicit maintainer authorization. This is not a completed security review.

- The tagged commit is checked by the complete test suite, TypeScript, and production Vite build before publication.
- Windows x64, Linux x64, macOS Intel, and macOS Apple Silicon packaging and packaged-runtime smoke verification are performed by the release workflow before publication.
- Packaged-runtime smoke checks do not establish a successful installer upgrade or validate every existing library on a real device.

## Source and licensing

Corresponding source is available at tag `app-v{{VERSION}}` in the [mikutea/PaperQuay fork](https://github.com/mikutea/PaperQuay). Original copyright and AGPL-3.0-only notices are retained. The PaperQuay name and branding remain subject to the upstream trademark notice.

---

# PaperQuay {{VERSION}} — 非官方集成版

> 这是 `mikutea/PaperQuay` fork 提供的非官方修改版，不代表 PaperQuay 上游维护者认可或背书。fork 的集成分支与 `main` 同时包含向上游提交的 [#18](https://github.com/WangQrkkk/PaperQuay/pull/18)、[#19](https://github.com/WangQrkkk/PaperQuay/pull/19) 和 [#20](https://github.com/WangQrkkk/PaperQuay/pull/20) 三项修复。

## 下载

Windows x64 构建：

- `.exe`：NSIS 安装包
- `.msi`：MSI 安装包
- `.zip`：免安装版；解压后通过 `Start-PaperQuay.cmd` 启动，以便先设置沙箱所需权限
- `SHA256SUMS.txt`：上述三个包的 SHA-256 校验值

这些二进制文件未做代码签名，Windows SmartScreen 可能提示“无法识别的应用”；运行前请核对发布页中的 SHA-256。

同时提供 Linux x64 安装包，以及 macOS Intel／Apple Silicon 磁盘映像。这是预发布版本，不代表稳定版或真实设备升级已经验收。

## 已知限制

[#26](https://github.com/mikutea/PaperQuay/pull/26#discussion_r4214657505) 中的启动数据库路径 P2 在此预发布中仍未修复。若其他人能在已有文库打开期间修改其目录，SQLite 路径可能被重定向到文库之外。请仅使用由你控制、且不可信用户无法修改的文库／配置目录；同意接入文库并不能消除这一风险。

## 相比 app-v0.1.26-mikutea.13 的更新

- PDF 划词浮层可添加高亮和下划线，荧光笔支持先启用再选字；加入笔记后仍保留选区，并恢复正确的工具色板（[#28](https://github.com/mikutea/PaperQuay/pull/28)）。
- 右栏原文和译文可保存高亮、下划线；关闭划词翻译后仍可标记，图片说明、表格和公式的标记在切换显示模式后保持对应文字范围（[#28](https://github.com/mikutea/PaperQuay/pull/28)）。
- 修复 PDF 页数变化导致同一文档重复加载，以及切换来源后短暂显示旧页数的问题（[#29](https://github.com/mikutea/PaperQuay/pull/29)）。
- Crossref 元数据先在五个候选中匹配题名，再接受 DOI、年份和题名，减少误取无关首条结果（[#29](https://github.com/mikutea/PaperQuay/pull/29)）。
- 仓库默认 README 切换为中文，完整保留英文版及语言互链（[#30](https://github.com/mikutea/PaperQuay/pull/30)）。

## .13 中已有的更新（相对 .12）

- 重启和更新后记住所选文库，并在获得确认后恢复已有文库，避免静默替换为空文库（[#26](https://github.com/mikutea/PaperQuay/pull/26)）。
- 完整加载分页文库，覆盖超过 1000 篇论文的集合，筛选后仍保持正确计数和手动排序（[#26](https://github.com/mikutea/PaperQuay/pull/26)）。
- 新增跟随系统主题及启动更新检查选项；Zotero 导入期间保留尚未保存的阅读器与应用设置（[#26](https://github.com/mikutea/PaperQuay/pull/26)）。
- 改善笔记工作区的完整集合加载、延迟自动保存、布局和绑定来源的图片访问（[#26](https://github.com/mikutea/PaperQuay/pull/26)）。
- WebDAV 备份统一集合根路径并保留本地路径别名；笔记／RAG 数据库恢复采用事务处理及固定源检查（[#26](https://github.com/mikutea/PaperQuay/pull/26)）。
- 收紧原生文件读取、写入、删除和目录列表授权，以及迁移输入、渲染器导航和 MinerU PDF 上传边界。这些修复不包含上述启动路径限制（[#26](https://github.com/mikutea/PaperQuay/pull/26)）。

## .12 中已有的更新（相对 .11）

- 修复阅读器 Markdown 和知识图谱在深色模式下的文字可读性，并支持实时切换主题（[#23](https://github.com/mikutea/PaperQuay/pull/23)）。
- 文档问答显示等待、模型返回的思考内容及回答流进度；思考内容可独立展开，正确处理失败或空响应，避免重复显示最终思考摘要（[#23](https://github.com/mikutea/PaperQuay/pull/23)）。
- 长图预览适配窗口，支持原始尺寸滚动、Esc 关闭与焦点返回，并恢复问答侧栏的合理默认宽度（[#23](https://github.com/mikutea/PaperQuay/pull/23)）。
- 重开缓存结果时保留本地 MinerU 图片的来源位置，只有源内容与对应缓存一致才复用其目录；旧问答会话的延迟失败不再覆盖新会话的错误提示或附件（[#24](https://github.com/mikutea/PaperQuay/pull/24)）。

本地图片仍依赖原始目录。旧的手动导入缓存若未记录来源，可能需要重新选择一次原 JSON。

## .11 中已有的更新（相对 .10）

- 更新 Tiptap 及 XML／ZIP 依赖以处理已报告的安全告警；MinerU 解压会拒绝通过预置符号链接或目录联接写出目标目录的路径（[#20](https://github.com/mikutea/PaperQuay/pull/20)）。
- 更新打包后的 Electron 运行时和 electron-builder、Vite、PostCSS 等构建发布工具链；此锁文件的完整 npm 依赖审计报告为 0 项告警（[#21](https://github.com/mikutea/PaperQuay/pull/21)）。

## .10 中已有的更新（相对 .9）

- 结构化阅读正确显示 MinerU 上下标，并避免 Markdown 表格中的行内公式跨单元格解析（[#10](https://github.com/mikutea/PaperQuay/pull/10)、[#11](https://github.com/mikutea/PaperQuay/pull/11)）。
- 保留 MinerU 图表的标题、注释和资源关联；兼容以数字页码为键的页面字典，并让跨页空表格片段引用原始内容（[#12](https://github.com/mikutea/PaperQuay/pull/12)、[#17](https://github.com/mikutea/PaperQuay/pull/17)、[#18](https://github.com/mikutea/PaperQuay/pull/18)）。
- 知识图谱在工作区可见后才布局，RAG 嵌入请求会修复格式错误的 UTF-16 输入（[#13](https://github.com/mikutea/PaperQuay/pull/13)、[#14](https://github.com/mikutea/PaperQuay/pull/14)）。
- 文库按大小写不敏感规则去重标签，底部的模型选择菜单不再被视口裁切（[#15](https://github.com/mikutea/PaperQuay/pull/15)、[#16](https://github.com/mikutea/PaperQuay/pull/16)）。

## 集成修复

- 深色模式下移除 MinerU 结构化阅读区遗留的浅色径向背景，并为列表和表格标题补充明确的深色文字样式，恢复正文可读性。
- 为 Reader 问答、Agent 上下文、语义重排和 RAG 索引增加可选的 `query: ` / `passage: ` 向量输入前缀；默认仍保持原有纯文本兼容模式。
- MinerU 批处理按权威本地文库发现全部可处理 PDF，包括此前未在阅读器中打开的论文。
- 新增显式开启、可续跑的全库英文论文中译，并提供保守语言识别、源指纹缓存、共享限速、进度与暂停/取消控制。
- 在发行包中纳入 Pizzip 的 `pako` 运行时依赖，避免主进程因 `Cannot find module 'pako/dist/pako.es5.min.js'` 而启动报错。
- 使用不受系统显示语言影响的 `S-1-15-2-2` SID，为 Windows Chromium 沙箱补充最小继承式读取/执行权限，不关闭沙箱。
- 发布前对实际 `app.asar` 执行 Pizzip/Pako 运行时解析烟雾测试。
- 全库翻译严格串行、续用已保存段落，并在翻译服务不可用时及时停止本轮，避免逐篇失败。
- 手动“全部生成概览”可以在当前进行中的自动 MinerU／翻译项目结束后优先运行。
- 让批量翻译、文库状态和阅读器使用同一组可见 MinerU 块及源指纹。旧批次中指纹不匹配的本地译文缓存不再复用，可通过已配置的翻译模型重新生成。
- 保留已验证的 Windows `--user-data-dir` 路径，避免误建空白嵌套文库。
- 处理 fork 的 #1、#4、#5、#6 PR 中可执行的审查意见：全库任务覆盖超过 1000 篇论文，自动任务在限流或服务不可用时停止，手动概览抢占后恢复翻译，并避免同一论文并发翻译覆盖缓存。
- 应用内检查本 fork 的完整预发布；NSIS 安装版使用对应发布的更新清单，免安装版通过沙箱权限启动脚本运行并采用手动更新。

本机 MiyuoAPI／LM Studio 路由及 Windows 看护任务属于个人设备配置，不包含在 PaperQuay 安装包中。TranslateGemma 与 Nemotron embedding 均由路由按需装载、互斥切换，空闲 300 秒后卸载。

两台个人设备之间的文献同步明确不是应用功能，也不包含在本软件二进制中。

## 验证

- PR #28 已完成代码审查和验证；其安全审查未能启动，经维护者明确授权在该次合并中豁免，不记为安全审查通过。

- 发布前对标签提交运行完整测试集、TypeScript 检查和生产版 Vite 构建。
- Windows x64、Linux x64、macOS Intel 与 macOS Apple Silicon 打包及发行物运行时烟雾测试由发行工作流完成，并在发布前作为门禁。
- 发行物烟雾测试不等于安装器升级成功，也不代表所有已有文库均已在真实设备上验收。

## 源码与许可

对应源码位于 [mikutea/PaperQuay](https://github.com/mikutea/PaperQuay) 的 `app-v{{VERSION}}` 标签。保留原始版权与 AGPL-3.0-only 许可声明；PaperQuay 名称和品牌仍受上游商标说明约束。
