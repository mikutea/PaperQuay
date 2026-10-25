export type ClientErrorCode =
  | 'CONFIG_MISSING'
  | 'CONFIG_INVALID'
  | 'AUTH_REQUIRED'
  | 'AUTH_FAILED'
  | 'SESSION_REVOKED'
  | 'NETWORK_UNAVAILABLE'
  | 'REQUEST_TIMEOUT'
  | 'INVALID_RESPONSE'
  | 'STORAGE_UNAVAILABLE'
  | 'STORAGE_FAILED'
  | 'STORAGE_CORRUPT'
  | 'ACCOUNT_CHANGED'
  | 'ACCOUNT_STORAGE_LIMIT'
  | 'SYNC_FAILED'
  | 'NATIVE_NOT_READY'
  | 'CONFLICT_CHANGED'
  | 'EDIT_CHANGED';

const messages: Record<ClientErrorCode, string> = {
  CONFIG_MISSING: '请先配置账号服务地址和客户端标识。',
  CONFIG_INVALID: '服务配置无效，请检查 HTTPS 地址和客户端标识。',
  AUTH_REQUIRED: '登录已过期，请重新登录。此设备已保存的改动会保留。',
  AUTH_FAILED: '登录未完成，请重试并确认账号服务配置。',
  SESSION_REVOKED: '此登录会话已被撤销。退出旧会话后可重新登录；未同步改动仍保存在此设备。',
  NETWORK_UNAVAILABLE: '暂时无法连接服务。已保存的改动会在恢复连接后同步。',
  REQUEST_TIMEOUT: '连接超时，请稍后重试。已保存的改动不会丢失。',
  INVALID_RESPONSE: '服务返回了无法识别的数据，请检查服务版本后重试。',
  STORAGE_UNAVAILABLE: '此浏览器无法使用本地数据库，请检查隐私设置或更换浏览器。',
  STORAGE_FAILED: '未能保存到此设备，请检查存储空间后重试。',
  STORAGE_CORRUPT: '此设备的缓存格式无法读取。请保留本地数据并联系维护者。',
  ACCOUNT_CHANGED: '账号已切换，本次同步已停止。',
  ACCOUNT_STORAGE_LIMIT: '账号同步存储额度已满。改动仍保存在此设备，请联系服务管理员处理额度后重试。',
  SYNC_FAILED: '同步未完成，请重试或查看待处理操作。',
  NATIVE_NOT_READY: '当前阶段仅支持 Web 验证，原生登录和安全存储尚未接入。',
  CONFLICT_CHANGED: '这条记录又有更新，请重新查看双方内容后解决冲突。',
  EDIT_CHANGED: '编辑期间收到新版本。你的草稿仍在，请查看当前版本后再保存。',
};

export class ClientError extends Error {
  readonly code: ClientErrorCode;
  readonly retryable: boolean;
  constructor(code: ClientErrorCode, retryable = false) {
    super(messages[code]);
    this.name = 'ClientError';
    this.code = code;
    this.retryable = retryable;
  }
}

export function describeError(error: unknown): string {
  return error instanceof ClientError ? messages[error.code] : messages.SYNC_FAILED;
}

export function errorFromResponse(status: number, serverCode?: string): ClientError {
  if (serverCode === 'DEVICE_REVOKED' || serverCode === 'SESSION_REVOKED')
    return new ClientError('SESSION_REVOKED');
  if (status === 401 || status === 403) return new ClientError('AUTH_REQUIRED');
  if (status === 409) return new ClientError('CONFLICT_CHANGED');
  return new ClientError('SYNC_FAILED', status === 429 || status >= 500);
}
