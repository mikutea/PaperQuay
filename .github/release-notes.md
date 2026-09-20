# PaperQuay 0.1.26-mikutea.1 — Unofficial fork test build

> This is an unofficial modified build from the `mikutea/PaperQuay` fork. It contains the proposed changes from upstream PR [#20](https://github.com/WangQrkkk/PaperQuay/pull/20) and is not endorsed or authorized by the upstream PaperQuay maintainers. Use it for testing and manual installation only.

## Downloads

This fork release provides Windows x64 artifacts:

- `.exe`: NSIS installer
- `.msi`: MSI installer
- `.zip`: unpacked portable directory
- `SHA256SUMS.txt`: SHA-256 checksums for all three packages

## Changes

- MinerU batch parsing now discovers PDFs from the complete library instead of only papers already opened in Reader.
- Reader preferences show the processable-PDF count, progress, status, and actionable errors.
- Manual and automatic starts share a preflight lock, preventing duplicate batch uploads.
- Native-library refreshes are authoritative, so deleted papers and stale attachment paths are excluded.
- OCR fallback is reserved for empty structured output; authentication, network, timeout, HTTP 429, and server errors are not retried as OCR.
- HTTP 429 stops the current run after in-flight work settles, and MinerU full-library concurrency is capped at 2.
- Successful cache writes update library parsed status; cache-write failures are surfaced instead of counted as success.

## Verification

- TypeScript `--noEmit` check passed.
- Full test suite passed: 182/182.
- Production web build and Windows x64 Electron packaging passed.

## Source and licensing

Corresponding source is available at tag `app-v0.1.26-mikutea.1` in the [mikutea/PaperQuay fork](https://github.com/mikutea/PaperQuay). Original copyright and AGPL-3.0-only notices are retained. The PaperQuay name and branding remain subject to the upstream trademark notice.

---

# PaperQuay 0.1.26-mikutea.1 — 非官方 fork 测试构建

> 这是 `mikutea/PaperQuay` fork 提供的非官方修改版，包含上游 PR [#20](https://github.com/WangQrkkk/PaperQuay/pull/20) 的候选修复，不代表 PaperQuay 上游维护者认可、授权或背书。仅建议用于测试和手动安装。

## 下载

本 fork Release 提供 Windows x64 构建：

- `.exe`：NSIS 安装包
- `.msi`：MSI 安装包
- `.zip`：免安装解压目录
- `SHA256SUMS.txt`：上述三个包的 SHA-256 校验值

## 本次变更

- MinerU 批处理改为读取完整文库 PDF，不再局限于阅读器中已经打开过的论文。
- 设置页会显示可处理 PDF 数量、进度、状态与可操作错误，不再出现视觉上的“按钮无响应”。
- 自动和手动启动共用预检互斥锁，避免重复提交同一批文献。
- 文库刷新采用权威快照，已删除论文和旧附件路径不会重新进入批次。
- OCR 回退仅用于结构化结果为空；认证、网络、超时、HTTP 429 和服务端错误不会误触发 OCR 重试。
- HTTP 429 会在当前并发任务结束后停止本轮，全库 MinerU 并发安全上限为 2。
- 缓存写入成功后同步文库解析状态；缓存写入失败会明确报错，不会被计为成功。

## 验证

- TypeScript `--noEmit` 检查通过。
- 完整测试 182/182 通过。
- 生产前端构建与 Windows x64 Electron 打包通过。

## 源码与许可

对应源码位于 [mikutea/PaperQuay](https://github.com/mikutea/PaperQuay) 的 `app-v0.1.26-mikutea.1` 标签。保留原始版权与 AGPL-3.0-only 许可声明；PaperQuay 名称和品牌仍受上游商标说明约束。
