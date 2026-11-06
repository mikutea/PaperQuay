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
  | 'GRAPH_COLLECTION_LIMIT'
  | 'AI_COLLECTION_LIMIT'
  | 'AGENT_CAPACITY'
  | 'REMOTE_REQUEST_PENDING'
  | 'SYNC_FAILED'
  | 'SYNC_FEATURE_UNAVAILABLE'
  | 'NATIVE_NOT_READY'
  | 'CONFLICT_CHANGED'
  | 'EDIT_CHANGED'
  | 'IMPORT_CHANGED'
  | 'IMPORT_INVALID'
  | 'IMPORT_UNSUPPORTED'
  | 'IMPORT_CAPACITY'
  | 'IMPORT_RECEIPT_FULL';

const messages: Record<ClientErrorCode, string> = {
  CONFIG_MISSING: '请先配置账号服务地址和客户端标识。',
  CONFIG_INVALID: '服务配置无效，请检查 HTTPS 地址和客户端标识。',
  AUTH_REQUIRED: '登录已过期，请重新登录。此设备已保存的改动会保留。',
  AUTH_FAILED: '登录未完成，请重试并确认账号服务配置。',
  SESSION_REVOKED: '此登录会话已被撤销。退出旧会话后可重新登录；未同步改动仍保存在此设备。',
  NETWORK_UNAVAILABLE: '暂时无法连接服务。已保存的改动会在恢复连接后同步。',
  REQUEST_TIMEOUT: '连接超时，请稍后重试。已保存的改动不会丢失。',
  INVALID_RESPONSE: '服务返回了无法识别的数据，请检查服务版本后重试。',
  STORAGE_UNAVAILABLE: '此设备暂时无法打开本地安全存储或数据库，请检查设备状态后重试。',
  STORAGE_FAILED: '未能保存到此设备，请检查存储空间后重试。',
  STORAGE_CORRUPT: '此设备的缓存格式无法读取。请保留本地数据并联系维护者。',
  ACCOUNT_CHANGED: '账号已切换，本次同步已停止。',
  ACCOUNT_STORAGE_LIMIT: '账号同步存储额度已满。改动仍保存在此设备，请联系服务管理员处理额度后重试。',
  GRAPH_COLLECTION_LIMIT:'当前账号的关系数量或内容已达到上限（最多512条、2MiB）。请先删除不再使用的关系；原有材料与关系仍保留。',
  AI_COLLECTION_LIMIT: '此账号最多保存50个同步会话和100个同步模板。请先删除不再需要的内容；原有内容已保留。',
  AGENT_CAPACITY: '本机文库、待同步队列或 Agent 记录容量不足，本次没有应用任何改动。请先同步或减少选择后重试。',
  REMOTE_REQUEST_PENDING: '上一条远程任务的创建结果尚未确认。请先重试同一请求或查询任务，再发起新的工作。',
  SYNC_FAILED: '同步未完成，请重试或查看待处理操作。',
  SYNC_FEATURE_UNAVAILABLE:'当前账号服务尚未支持这类内容。已保存的内容与待同步操作会保留，请连接支持相应能力的服务后重试。',
  NATIVE_NOT_READY: '此安装包缺少所需原生组件，请使用完整构建的应用。',
  CONFLICT_CHANGED: '这条记录又有更新，请重新查看双方内容后解决冲突。',
  EDIT_CHANGED: '编辑期间收到新版本。你的草稿仍在，请查看当前版本后再保存。',
  IMPORT_CHANGED: '文库或导入选择已有变化，请重新预览并确认后导入。',
  IMPORT_INVALID: '导入内容或文献关联无效，本次没有保存任何条目。请检查文件后重试。',
  IMPORT_UNSUPPORTED: '当前无法确认文献分类可完整同步，本次没有保存任何条目。请连接支持分类的账号服务后重试。',
  IMPORT_RECEIPT_FULL: '当前账号已达到本机分享导入回执上限，未保存本次内容。待处理原文仍保留；可关闭面板后使用普通文件导入。',
  IMPORT_CAPACITY: '本地文库、来源映射或待同步队列容量不足，本次没有保存任何条目。请先同步或减少导入数量。',
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
  if(serverCode==='FEATURE_NOT_NEGOTIATED')return new ClientError('SYNC_FEATURE_UNAVAILABLE');
  if (serverCode === 'DEVICE_REVOKED' || serverCode === 'SESSION_REVOKED')
    return new ClientError('SESSION_REVOKED');
  if (status === 401 || status === 403) return new ClientError('AUTH_REQUIRED');
  if (status === 409) return new ClientError('CONFLICT_CHANGED');
  return new ClientError('SYNC_FAILED', status === 429 || status >= 500);
}
