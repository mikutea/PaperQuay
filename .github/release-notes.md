# PaperQuay {{VERSION}} — Unofficial integrated fork build

> This is an unofficial modified build from the `mikutea/PaperQuay` fork. It is not endorsed by the upstream PaperQuay maintainers. The fork integration branch and `main` combine the fixes proposed upstream in PRs [#18](https://github.com/WangQrkkk/PaperQuay/pull/18), [#19](https://github.com/WangQrkkk/PaperQuay/pull/19), and [#20](https://github.com/WangQrkkk/PaperQuay/pull/20).

## Downloads

Windows x64 artifacts:

- `.exe`: NSIS installer
- `.msi`: MSI installer
- `.zip`: portable directory whose root contains `PaperQuay.exe`
- `SHA256SUMS.txt`: SHA-256 checksums for all three packages

The binaries are not code-signed. Windows SmartScreen may show an unrecognized-app warning; verify the published SHA-256 before running them.

## Integrated fixes

- Restores readable MinerU structured-reading content in dark mode by removing the light radial background image and applying explicit dark text colors to lists and table captions.
- Adds optional `query: ` / `passage: ` embedding input prefixes across Reader QA, Agent context, semantic reranking, and indexed RAG content while preserving plain-text compatibility by default.
- Runs MinerU batches against every processable PDF in the authoritative library, including papers that have not previously been opened in Reader.
- Adds opt-in, resumable English-to-Chinese full-library translation with conservative language detection, source-bound caches, shared rate limiting, and pause/cancel/progress controls.
- Includes Pizzip's `pako` runtime dependency in packaged builds, preventing the main-process `Cannot find module 'pako/dist/pako.es5.min.js'` startup error.
- Grants the Windows Chromium sandbox the minimum inherited read/execute access it requires, using the localized-independent `S-1-15-2-2` SID instead of disabling the sandbox.
- Verifies the packaged `app.asar` can resolve the Pizzip/Pako runtime chain before release assets are published.

Personal device-to-device library synchronization is intentionally not an application feature and is not included in these binaries.

## Verification

- Full test suite: 213/213 passed on the integrated commit graph.
- TypeScript check and production Vite build passed.
- Windows x64 Electron packaging and packaged-runtime smoke verification are performed by the release workflow before publication.

## Source and licensing

Corresponding source is available at tag `app-v{{VERSION}}` in the [mikutea/PaperQuay fork](https://github.com/mikutea/PaperQuay). Original copyright and AGPL-3.0-only notices are retained. The PaperQuay name and branding remain subject to the upstream trademark notice.

---

# PaperQuay {{VERSION}} — 非官方集成版

> 这是 `mikutea/PaperQuay` fork 提供的非官方修改版，不代表 PaperQuay 上游维护者认可或背书。fork 的集成分支与 `main` 同时包含向上游提交的 [#18](https://github.com/WangQrkkk/PaperQuay/pull/18)、[#19](https://github.com/WangQrkkk/PaperQuay/pull/19) 和 [#20](https://github.com/WangQrkkk/PaperQuay/pull/20) 三项修复。

## 下载

Windows x64 构建：

- `.exe`：NSIS 安装包
- `.msi`：MSI 安装包
- `.zip`：根目录直接包含 `PaperQuay.exe` 的免安装版
- `SHA256SUMS.txt`：上述三个包的 SHA-256 校验值

这些二进制文件未做代码签名，Windows SmartScreen 可能提示“无法识别的应用”；运行前请核对发布页中的 SHA-256。

## 集成修复

- 深色模式下移除 MinerU 结构化阅读区遗留的浅色径向背景，并为列表和表格标题补充明确的深色文字样式，恢复正文可读性。
- 为 Reader 问答、Agent 上下文、语义重排和 RAG 索引增加可选的 `query: ` / `passage: ` 向量输入前缀；默认仍保持原有纯文本兼容模式。
- MinerU 批处理按权威本地文库发现全部可处理 PDF，包括此前未在阅读器中打开的论文。
- 新增显式开启、可续跑的全库英文论文中译，并提供保守语言识别、源指纹缓存、共享限速、进度与暂停/取消控制。
- 在发行包中纳入 Pizzip 的 `pako` 运行时依赖，避免主进程因 `Cannot find module 'pako/dist/pako.es5.min.js'` 而启动报错。
- 使用不受系统显示语言影响的 `S-1-15-2-2` SID，为 Windows Chromium 沙箱补充最小继承式读取/执行权限，不关闭沙箱。
- 发布前对实际 `app.asar` 执行 Pizzip/Pako 运行时解析烟雾测试。

两台个人设备之间的文献同步明确不是应用功能，也不包含在本软件二进制中。

## 验证

- 集成提交图上的完整测试 213/213 通过。
- TypeScript 检查与生产 Vite 构建通过。
- Windows x64 Electron 打包与发行物运行时烟雾测试由发行工作流完成，并在发布前作为门禁。

## 源码与许可

对应源码位于 [mikutea/PaperQuay](https://github.com/mikutea/PaperQuay) 的 `app-v{{VERSION}}` 标签。保留原始版权与 AGPL-3.0-only 许可声明；PaperQuay 名称和品牌仍受上游商标说明约束。
