import type { AiErrorCode, AiFailure } from './types.ts';

const messages: Record<AiErrorCode, string> = {
  CONFIG_INVALID: '请检查 API 基础地址、模型和输出设置；地址不能包含账号、查询参数或片段。',
  KEY_MISSING: '此服务尚未配置本设备的 API 密钥。',
  KEY_INVALID: '密钥格式无效，请重新输入；不要包含换行或空格。',
  SECRET_STORAGE_FAILED: '无法访问本设备的安全密钥存储，请稍后重试。',
  CONTEXT_MISSING: '先在阅读器中选择选段、当前页或整篇可提取文本。',
  CONTEXT_INVALID: '阅读文本与附件版本不匹配，请在阅读器中重新选择。',
  CONTEXT_TOO_LARGE: '本次文本超出 192 KiB 上限，请改选单页或选段。',
  TEXT_MISSING: '这个范围没有取到可发送的文字；扫描页面可能需要另行识别。',
  QUESTION_REQUIRED: '请输入要向模型提出的问题。',
  INPUT_TOO_LARGE: '本次输入超过发送上限，请缩小文本范围或缩短问题。',
  AUTHENTICATION_FAILED: '服务拒绝了 API 密钥（401），请检查或更换密钥。',
  ACCESS_DENIED: '服务拒绝访问（403），请检查账号或模型权限。',
  RATE_LIMITED: '服务正在限流（429）；稍后手动重试，当前内容已保留。',
  QUOTA_EXCEEDED: '服务报告额度不足；请检查服务商额度后手动重试。',
  MODEL_OR_REQUEST_REJECTED: '服务不接受当前模型或兼容参数，请检查模型及输出参数设置。',
  ENDPOINT_NOT_FOUND: '服务地址没有提供这个接口；可检查基础地址，或手动输入模型 ID。',
  PROVIDER_UNAVAILABLE: '模型服务暂时不可用，请稍后手动重试。',
  NETWORK_OR_CORS: '网络、浏览器跨域限制或服务重定向使请求失败；请检查直连服务的配置。',
  REDIRECT_BLOCKED: '已阻止服务重定向，请直接填写最终的 API 基础地址。',
  TIMEOUT: '请求超过总时间上限，已停止等待；已有输出可能不完整。',
  IDLE_TIMEOUT: '服务长时间没有返回数据，已停止等待；已有输出可能不完整。',
  CANCELLED: '已取消请求；服务商可能已处理部分内容，最终用量以其记录为准。',
  STREAM_INTERRUPTED: '流在结束标记前中断；已有输出为部分结果。',
  INVALID_RESPONSE: '服务返回了无法识别的响应格式，未将其当作完成结果。',
  RESPONSE_TOO_LARGE: '服务响应超过本机接收上限，已停止接收。',
  OUTPUT_LIMIT: '输出达到本机长度上限，已停止接收；现有内容为部分结果。',
  OUTPUT_TRUNCATED: '模型达到输出上限，现有内容可能不完整。',
  CONTENT_FILTERED: '服务限制了部分输出，当前结果可能不完整。',
  UNSUPPORTED_RESPONSE: '服务返回了当前阅读助手不支持的工具或多媒体响应。',
  SETTINGS_STORAGE_FAILED: '本机模型设置未能保存，请检查浏览器存储后重试。',
};

/** Errors contain only a fixed code/message, never upstream messages, headers, keys, or bodies. */
export class AiError extends Error implements AiFailure {
  readonly code: AiErrorCode;
  readonly retryAfterSeconds?: number;
  constructor(code: AiErrorCode, retryAfterSeconds?: number) {
    super(messages[code]);
    this.name = 'AiError';
    this.code = code;
    if (Number.isFinite(retryAfterSeconds) && retryAfterSeconds! >= 0 && retryAfterSeconds! <= 3600) {
      this.retryAfterSeconds = Math.ceil(retryAfterSeconds!);
    }
  }
}
export function describeAiError(error: AiFailure): string {
  const delay = error.retryAfterSeconds;
  return messages[error.code] + (delay !== undefined && delay > 0 ? ' 服务建议等待约 ' + delay + ' 秒。' : '');
}
export function aiFailure(error: unknown, fallback: AiErrorCode = 'NETWORK_OR_CORS'): AiFailure {
  if (error instanceof AiError) return {
    code: error.code,
    ...(error.retryAfterSeconds !== undefined ? { retryAfterSeconds: error.retryAfterSeconds } : {}),
  };
  return { code: fallback };
}
