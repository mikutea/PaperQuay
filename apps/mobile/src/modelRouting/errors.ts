export const MODEL_SERVICE_CODES=[
 'MODEL_GATEWAY_BUSY','MODEL_GATEWAY_CLOSED','MODEL_GATEWAY_UNAVAILABLE',
 'MODEL_INFERENCE_ACTIVE','MODEL_INFERENCE_BUSY','MODEL_INFERENCE_CHANGED','MODEL_INFERENCE_COMPUTER_REQUIRED',
 'MODEL_INFERENCE_DISABLED','MODEL_INFERENCE_HISTORY_FULL','MODEL_INFERENCE_INVALID','MODEL_INFERENCE_LEASE_CHANGED',
 'MODEL_INFERENCE_LIMIT','MODEL_INFERENCE_NOT_FOUND','MODEL_INFERENCE_PROFILE_UNAVAILABLE','MODEL_INFERENCE_PROVIDER_LIMIT',
 'MODEL_INFERENCE_QUEUE_FULL','MODEL_INFERENCE_STORAGE_CORRUPT','MODEL_INFERENCE_STORAGE_FAILED','MODEL_INFERENCE_STORAGE_FULL',
 'MODEL_INFERENCE_TEMPORARILY_UNAVAILABLE','MODEL_RESPONSE_INVALID'
]as const;
export type ModelServiceCode=typeof MODEL_SERVICE_CODES[number];
export function isModelServiceCode(code:unknown):code is ModelServiceCode{return typeof code==='string'&&MODEL_SERVICE_CODES.includes(code as ModelServiceCode);}
const labels:Partial<Record<ModelServiceCode,string>>={
 MODEL_GATEWAY_BUSY:'网关暂时繁忙，原请求仍保留。',MODEL_GATEWAY_CLOSED:'网关正在关闭，原请求不会自动重发。',
 MODEL_GATEWAY_UNAVAILABLE:'当前账号暂时不能使用此模型网关。',MODEL_INFERENCE_DISABLED:'当前同步服务尚未开启模型调用。',
 MODEL_INFERENCE_CHANGED:'原请求身份与内容不一致，操作已停止。',MODEL_INFERENCE_PROFILE_UNAVAILABLE:'所选电脑或模型配置已变化，请重新查看可用模型。',
 MODEL_INFERENCE_LEASE_CHANGED:'原执行会话已变化，不能接管这次调用。',MODEL_INFERENCE_HISTORY_FULL:'模型调用记录已满，未创建新的请求。',
 MODEL_INFERENCE_QUEUE_FULL:'模型队列已满，未创建新的请求。',MODEL_INFERENCE_STORAGE_FULL:'模型结果存储已满，未发起新的调用。',
 MODEL_INFERENCE_LIMIT:'本次文本或输出预算超过模型调用上限。',MODEL_INFERENCE_NOT_FOUND:'没有找到这份模型记录。',
 MODEL_RESPONSE_INVALID:'模型服务返回的记录无法验证，未采用结果。'
};
export class ModelServiceError extends Error{
 readonly code:ModelServiceCode;readonly status:number;
 constructor(code:ModelServiceCode,status=0){super(labels[code]??'模型服务操作未完成，原请求及已保存内容仍保留。');this.name='ModelServiceError';this.code=code;this.status=status;}
}
