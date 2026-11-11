import { AiError } from './errors.ts';
import type { AiProviderConfig } from './types.ts';

export function responsesRequest(
  config: AiProviderConfig,
  messages: { role: string; content: string }[],
  stream: boolean,
) {
  const instructions = messages.filter(message => message.role === 'system')
    .map(message => message.content).join('\n\n');
  const input = messages.filter(message => message.role !== 'system').map(message => {
    const assistant = message.role === 'assistant';
    return {
      role: assistant ? 'assistant' : 'user',
      content: [{ type: assistant ? 'output_text' : 'input_text', text: message.content }],
    };
  });
  return {
    model: config.model, input, instructions: instructions || undefined,
    stream, max_output_tokens: config.maxOutputTokens, store: false,
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new AiError('INVALID_RESPONSE');
  }
  return value as Record<string, unknown>;
}

/** Adapt text responses to the existing bounded and credential-redacting collector. */
export function responsesCompletion(value: unknown) {
  const data = record(value);
  if (data.error) throw new AiError('INVALID_RESPONSE');
  let finishReason = 'stop';
  if (data.status === 'incomplete') {
    const reason = record(data.incomplete_details).reason;
    if (reason === 'max_output_tokens') finishReason = 'length';
    else if (reason === 'content_filter') finishReason = 'content_filter';
    else throw new AiError('INVALID_RESPONSE');
  } else if (data.status !== undefined && data.status !== 'completed') {
    throw new AiError('INVALID_RESPONSE');
  }
  const texts: string[] = [];
  if (data.output !== undefined) {
    if (!Array.isArray(data.output)) throw new AiError('INVALID_RESPONSE');
    for (const value of data.output) {
      const item = record(value);
      if (item.type === 'reasoning') continue;
      if (item.type !== 'message' || item.role !== 'assistant' || !Array.isArray(item.content)) {
        throw new AiError('UNSUPPORTED_RESPONSE');
      }
      for (const value of item.content) {
        const part = record(value);
        const text = part.type === 'output_text' ? part.text
          : part.type === 'refusal' ? part.refusal : undefined;
        if (typeof text !== 'string') throw new AiError('UNSUPPORTED_RESPONSE');
        texts.push(text);
      }
    }
  }
  const content = texts.length ? texts.join('') : data.output_text;
  if (typeof content !== 'string') throw new AiError('INVALID_RESPONSE');
  const usage = data.usage == null ? null : record(data.usage);
  return {
    choices: [{ index: 0, message: { content }, finish_reason: finishReason }],
    usage: usage && {
      prompt_tokens: usage.input_tokens,
      completion_tokens: usage.output_tokens,
      total_tokens: usage.total_tokens,
    },
  };
}

export function responsesEvent(value: unknown) {
  const event = record(value);
  if (event.type === 'response.output_text.delta' || event.type === 'response.refusal.delta') {
    if (typeof event.delta !== 'string') throw new AiError('INVALID_RESPONSE');
    return { delta: { choices: [{ index: 0, delta: { content: event.delta } }] } };
  }
  if (event.type === 'response.completed' || event.type === 'response.incomplete') {
    return { completed: responsesCompletion(event.response) };
  }
  if (event.type === 'error' || event.type === 'response.failed' || event.type === 'response.cancelled') {
    throw new AiError('INVALID_RESPONSE');
  }
  return {};
}
