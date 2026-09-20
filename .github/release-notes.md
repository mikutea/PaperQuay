# PaperQuay 0.1.26-mikutea.2 — Unofficial fork build

> This is an unofficial modified build from the `mikutea/PaperQuay` fork. It is not endorsed by the upstream PaperQuay maintainers. Source review is tracked in the fork's [PR #1](https://github.com/mikutea/PaperQuay/pull/1); no new PR for this release is being submitted upstream.

## Downloads

Windows x64 artifacts:

- `.exe`: NSIS installer
- `.msi`: MSI installer
- `.zip`: portable directory whose root contains `PaperQuay.exe`
- `SHA256SUMS.txt`: SHA-256 checksums for all three packages

The binaries are not code-signed. Windows SmartScreen may show an unrecognized-app warning; verify the published SHA-256 before running them.

## Changes

- MinerU batch parsing discovers every processable PDF in the authoritative local library, including papers not previously opened in Reader.
- Adds an opt-in full-library English-to-Chinese translation action and an optional automatic pipeline: MinerU → overview → translation.
- English detection fails closed for Chinese, non-English, bilingual, short, or ambiguous material.
- Translation caches are bound to exact structured source fingerprints; stale and legacy caches are not reused as completed work.
- Translation resumes completed blocks after cancellation or cache-write failure, preserves the active request result, and stops promptly while waiting for an RPM slot.
- Shared request pacing, 429 stop behavior, progress, pause/cancel controls, and source-bound cache recovery are covered by regression tests.

Personal device-to-device library synchronization is intentionally not an application feature and is not included in these binaries.

## Verification

- Full test suite: 209/209 passed.
- TypeScript check and production Vite build passed.
- Windows x64 Electron packaging passed.

## Source and licensing

Corresponding source is available at tag `app-v0.1.26-mikutea.2` in the [mikutea/PaperQuay fork](https://github.com/mikutea/PaperQuay). Original copyright and AGPL-3.0-only notices are retained. The PaperQuay name and branding remain subject to the upstream trademark notice.

---

# PaperQuay 0.1.26-mikutea.2 — 非官方 fork 构建

> 这是 `mikutea/PaperQuay` fork 提供的非官方修改版，不代表 PaperQuay 上游维护者认可或背书。源码审查保留在 fork 内部 [PR #1](https://github.com/mikutea/PaperQuay/pull/1)；本版本不再向上游提交新的 PR。

## 下载

Windows x64 构建：

- `.exe`：NSIS 安装包
- `.msi`：MSI 安装包
- `.zip`：根目录直接包含 `PaperQuay.exe` 的免安装版
- `SHA256SUMS.txt`：上述三个包的 SHA-256 校验值

这些二进制文件未做代码签名，Windows SmartScreen 可能提示“无法识别的应用”；运行前请核对发布页中的 SHA-256。

## 本次变更

- MinerU 批处理按权威本地文库发现全部可处理 PDF，包括此前未在阅读器中打开的论文。
- 新增显式开启的全库英文论文中译，以及可选自动流水线：MinerU → 概览 → 翻译。
- 语言门禁采用失败关闭策略，中文、其他外语、双语、短文本与歧义文本不会误送英文翻译。
- 译文缓存绑定结构化正文源指纹，旧版或正文已变化的缓存不会被误当作已完成结果。
- 取消或缓存写入失败后可从已完成块续传；当前请求返回结果会保留，RPM 等待中的取消会立即生效。
- 共享请求限速、HTTP 429 停止、进度、暂停/取消和源绑定缓存恢复均有回归测试。

两台个人设备之间的文献同步明确不是应用功能，也不包含在本软件二进制中。

## 验证

- 完整测试 209/209 通过。
- TypeScript 检查与生产 Vite 构建通过。
- Windows x64 Electron 打包通过。

## 源码与许可

对应源码位于 [mikutea/PaperQuay](https://github.com/mikutea/PaperQuay) 的 `app-v0.1.26-mikutea.2` 标签。保留原始版权与 AGPL-3.0-only 许可声明；PaperQuay 名称和品牌仍受上游商标说明约束。
