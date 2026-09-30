import { invoke } from '../platform/electron/core';
import { listen } from '../platform/electron/event';
import type {
  OpenAICompatibleQaOptions,
} from '../types/reader';
import { cleanQaAssistantOutput } from '../utils/qaOutput';

const QA_STREAM_EVENT = 'paperquay://qa-stream';

interface QaStreamEventPayload {
  requestId: string;
  kind: 'delta' | 'thinking' | 'done' | 'error';
  text?: string | null;
  error?: string | null;
}

interface QaStreamHandlers {
  onDelta?: (text: string, fullText: string) => void;
  onThinking?: (text: string, fullText: string) => void;
  onDone?: (fullText: string) => void;
  onError?: (message: string) => void;
}

function toErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === 'string') {
    return error;
  }

  return fallback;
}

export async function askDocumentOpenAICompatible(
  options: OpenAICompatibleQaOptions,
): Promise<string> {
  try {
    return cleanQaAssistantOutput(await invoke<string>('ask_document_openai_compatible', { options }));
  } catch (error) {
    throw new Error(toErrorMessage(error, '调用论文问答接口失败'));
  }
}

export async function askDocumentOpenAICompatibleStream(
  options: OpenAICompatibleQaOptions,
  handlers: QaStreamHandlers = {},
): Promise<string> {
  const requestId = crypto.randomUUID();
  let answer = '';
  let thinking = '';
  let streamError = '';
  const unlisten = await listen<QaStreamEventPayload>(QA_STREAM_EVENT, (event) => {
    const payload = event.payload;

    if (!payload || payload.requestId !== requestId) {
      return;
    }

    if (payload.kind === 'thinking') {
      const delta = payload.text ?? '';
      thinking += delta;
      if (delta) handlers.onThinking?.(delta, thinking);
      return;
    }

    if (payload.kind === 'delta') {
      const delta = payload.text ?? '';

      if (!delta) {
        return;
      }

      answer += delta;
      handlers.onDelta?.(delta, cleanQaAssistantOutput(answer));
      return;
    }

    if (payload.kind === 'error') {
      streamError = payload.error || '论文问答流式输出失败';
      handlers.onError?.(streamError);
      return;
    }

    handlers.onDone?.(cleanQaAssistantOutput(answer));
  });

  try {
    await invoke<void>('ask_document_openai_compatible_stream', {
      requestId,
      options,
    });

    if (streamError) {
      throw new Error(streamError);
    }

    if (!cleanQaAssistantOutput(answer).trim()) {
      throw new Error('模型未返回回答正文，请重试或检查模型配置。');
    }

    return cleanQaAssistantOutput(answer);
  } catch (error) {
    const message = toErrorMessage(error, streamError || '调用论文问答流式接口失败');
    handlers.onError?.(message);
    throw new Error(message);
  } finally {
    unlisten();
  }
}
