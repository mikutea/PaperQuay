# M2 独立阅读辅助接口

本模块直接请求用户配置的 OpenAI Chat Completions 兼容服务。业务同步服务和桌面不参与模型请求。只有明确点击“发送”或“测试连接”才发起请求；M2 不持久化或同步 AI 会话。

同一输入范围内仅在内存保留本次和上一条有正文的结果。新请求失败或取消时，可切换回上一条并保存；不会形成持久会话历史。账号、文本/附件版本、模型/endpoint 或密钥切换会清除这两条结果。离开该组件后结果不再保留，明确保存的笔记走原有笔记存储流程。

## 集成

组件为 apps/mobile/src/components/AiWorkspace.tsx；样式单独引入 aiWorkspace.css。Props 导出在 ai/types.ts：

    <AiWorkspace
      accountScope={{ apiBaseUrl, accountId }}
      context={pdfAiContext}
      secretStore={secretStore}
      onSaveNote={(note, source) => saveScopedNote(note, source)}
      onNavigateCitation={(target) => navigatePdf(target)}
    />

context 使用 PDF 模块的 PdfAiContext，允许 null（此时仍可设置模型，但不能发送）。onSaveNote 接受已有 NoteData 和 AiSaveContext；集成方应确认 source.accountScope 仍是写入目标账号，并通过已有本地笔记/outbox 流程保存。onNavigateCitation 使用 PDF 模块 PdfCitationTarget，接收方须匹配 attachmentVersionId 和 sha256。

SecretStore 直接使用 platform/secretStore.ts。Web 密钥仅内存，原生使用系统安全存储。密钥命名空间由业务服务地址、accountId、模型服务 id、规范化模型 endpoint 的 SHA-256 构成；非密钥模型配置仅保存到当前账号的本机 localStorage。模型、endpoint 或文本范围切换会取消旧请求并隔离旧回调。

默认 AiTransport 使用标准 fetch，redirect:error、credentials:omit、cache:no-store 与 AbortSignal。保持 CapacitorHttp 全局 fetch patch 关闭。不能由同步服务代理密钥；浏览器/WebView 的 CORS 失败明确显示。HTTP 地址可配置，但可能被平台的混合内容或明文网络策略阻止，本模块不绕过这些策略。可注入的 transport 必须同样阻止重定向并尊重取消；不能把完整 HTTP 响应模拟成字符流。

## 输入与输出

scope 支持 selection、page、document。只有 document、complete:true 且页码完整覆盖 0..totalPages-1 时标为“整篇可提取文本”；不声称读取图像或未提取内容。超限输入直接拒绝，不默默截断。只允许输入中有文字的页码产生可点击引用；模型提出其他页码会显示未核验。

真实 SSE 流按 Chat Completions delta 解析；取消、总超时、空闲超时、缺终止标记、401、429、无用量和未知费用均独立显示。仅采纳服务商实际返回的 token 统计，费用始终标为未知。错误不保存或展示上游原始 body、headers 或异常消息。

固定上限见 types.ts：输入文本 192 KiB、请求 256 KiB、输出 240 KiB（为笔记来源信息留出空间）、流总量 2 MiB、单事件 128 KiB、总时间 120 秒、空闲 20 秒。输出 token 参数可显式选择 max_completion_tokens 或兼容服务的 max_tokens，无自动付费重试。

## 官方协议依据

- [Chat Completions 创建请求](https://developers.openai.com/api/reference/resources/chat/subresources/completions/methods/create)
- [Chat Completions 流事件及 usage](https://developers.openai.com/api/reference/resources/chat/subresources/completions/streaming-events)
- [模型列表](https://developers.openai.com/api/reference/resources/models/methods/list)

本轮使用本机合成 HTTP/provider fixtures 验证，不使用真实文库或付费 API。原生实机、真实提供商 CORS 和系统安全存储的设备表现仍需后续验收。
