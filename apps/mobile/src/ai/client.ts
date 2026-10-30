import {validateReviewRequest,type ReviewRequest} from '../review/requests.ts';
import { buildConversationMessages, type AiConversationData } from '../../../../packages/ai-core/src/conversation.ts';
import { AiError } from './errors.ts';
import { buildResearchMessages, type ResearchContext } from '../research/context.ts';
import { AI_SECRET_KEY, aiAccountKey, aiSecretNamespace, checkedApiKey, parseAiProvider } from './provider.ts';
import { AiSseParser, ChatOutput, type ChatCompletionResult } from './stream.ts';
import { AiRequestGuard, boundedAiLimits, cancelResponseBody, ensureDirectResponse, fetchAiTransport, readAiBody } from './transport.ts';
import type { AiAccountScope, AiAction, AiLimits, AiProviderConfig, AiTransport, AiUsage, PreparedAiContext, SecretStore } from './types.ts';

interface RequestOptions { accountScope: AiAccountScope; config: AiProviderConfig; signal?: AbortSignal; current?():boolean }
export interface ReviewGenerateOptions extends RequestOptions {request:ReviewRequest;onText(text:string):void;onUsage?(usage:AiUsage):void}
export interface ResearchGenerateOptions extends RequestOptions {
  context: ResearchContext;
  onText(text: string): void;
  onUsage?(usage: AiUsage): void;
}
export interface GenerateOptions extends RequestOptions {
  context: PreparedAiContext;
  action: AiAction;
  question: string;
  conversation?: AiConversationData;
  onText(text: string): void;
  onUsage?(usage: AiUsage): void;
}

/** No network activity occurs until listModels or generate is called explicitly. */
export class AiClient {
  #secrets: SecretStore;
  #transport: AiTransport;
  #limits: AiLimits;
  constructor(secrets: SecretStore, transport: AiTransport = fetchAiTransport, limits: Partial<AiLimits> = {}) {
    if (transport.redirectPolicy !== 'error') throw new AiError('CONFIG_INVALID');
    this.#secrets = secrets; this.#transport = transport; this.#limits = boundedAiLimits(limits);
  }
  async #key(scope: AiAccountScope, config: AiProviderConfig, guard: AiRequestGuard, checkCurrent:()=>void=()=>{}): Promise<string | null> {
    aiAccountKey(scope);
    if (!config.requiresKey) return null;
    try {
      const namespace = await guard.wait(aiSecretNamespace(scope, config));
      guard.check(); checkCurrent();
      const key = await guard.wait(this.#secrets.get(namespace, AI_SECRET_KEY));
      guard.check(); checkCurrent();
      if (!key) throw new AiError('KEY_MISSING');
      return checkedApiKey(key);
    } catch (error) {
      guard.check(); checkCurrent();
      if (error instanceof AiError) throw error;
      throw new AiError('SECRET_STORAGE_FAILED');
    }
  }
  async #request(config: AiProviderConfig, suffix: string, key: string | null, guard: AiRequestGuard, body?: string): Promise<Response> {
    guard.check();
    const pending = this.#transport.request({
      url: config.endpoint + suffix, method: body === undefined ? 'GET' : 'POST', signal: guard.signal,
      headers: { Accept: body !== undefined && config.stream && this.#transport.supportsStreaming ? 'text/event-stream' : 'application/json',
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...(key ? { Authorization: 'Bearer ' + key } : {}),
      },
      ...(body === undefined ? {} : { body }),
    }).then((response) => {
      if (guard.signal.aborted) cancelResponseBody(response);
      return response;
    });
    let response: Response;
    try { response = await guard.wait(pending); }
    catch (error) {
      guard.check();
      if (error instanceof AiError) throw error;
      throw new AiError('NETWORK_OR_CORS');
    }
    guard.check(); ensureDirectResponse(response);
    if (!response.ok) await this.#httpError(response, guard);
    return response;
  }
  async #httpError(response: Response, guard: AiRequestGuard): Promise<never> {
    const delay = response.headers.get('retry-after');
    const retryAfter = delay && /^\d{1,4}$/.test(delay) ? Number(delay) : undefined;
    if (response.status === 429) {
      let quota = false;
      try {
        const parsed = JSON.parse(await readAiBody(response, guard, 65536, this.#limits.idleTimeoutMs)) as { error?: { code?: unknown; type?: unknown } };
        quota = parsed?.error?.code === 'insufficient_quota' || parsed?.error?.type === 'insufficient_quota';
      } catch { guard.check(); }
      throw new AiError(quota ? 'QUOTA_EXCEEDED' : 'RATE_LIMITED', retryAfter);
    }
    cancelResponseBody(response);
    throw new AiError(response.status === 401 ? 'AUTHENTICATION_FAILED'
      : response.status === 403 ? 'ACCESS_DENIED' : response.status === 404 ? 'ENDPOINT_NOT_FOUND'
        : response.status >= 500 ? 'PROVIDER_UNAVAILABLE' : 'MODEL_OR_REQUEST_REJECTED');
  }
  async listModels(options: RequestOptions): Promise<string[]> {
    const config = parseAiProvider(options.config);
    const guard = new AiRequestGuard(options.signal, this.#limits.probeTimeoutMs);
    try {
      const key = await this.#key(options.accountScope, config, guard);
      const response = await this.#request(config, '/models', key, guard);
      const body = await readAiBody(response, guard, this.#limits.modelListBytes, this.#limits.idleTimeoutMs);
      let value: unknown;
      try { value = JSON.parse(body); } catch { throw new AiError('INVALID_RESPONSE'); }
      if (!value || typeof value !== 'object' || !Array.isArray((value as { data?: unknown }).data)) throw new AiError('INVALID_RESPONSE');
      const models = new Set<string>();
      for (const entry of (value as { data: unknown[] }).data) {
        if (!entry || typeof entry !== 'object') continue;
        const id = (entry as { id?: unknown }).id;
        if (typeof id === 'string' && /^[A-Za-z0-9_./:@+-]{1,160}$/.test(id) && (!key || !id.includes(key))) models.add(id);
        if (models.size >= this.#limits.models) break;
      }
      return [...models].sort();
    } catch (error) {
      guard.check();
      if (error instanceof AiError) throw error;
      throw new AiError('INVALID_RESPONSE');
    } finally { guard.close(); }
  }
  async generate(options: GenerateOptions): Promise<ChatCompletionResult> {
    const config = parseAiProvider(options.config, true);
    const messages = buildConversationMessages(options.context, options.action, options.question, options.conversation);
    if (options.context.bytes > this.#limits.contextBytes) throw new AiError('CONTEXT_TOO_LARGE');
    return this.#complete(options, messages, config);
  }
  async generateResearch(options: ResearchGenerateOptions): Promise<ChatCompletionResult> {
    const config = parseAiProvider(options.config, true);
    const messages = await buildResearchMessages(options.context);
    if (new TextEncoder().encode(JSON.stringify(messages)).byteLength > this.#limits.contextBytes) throw new AiError('CONTEXT_TOO_LARGE');
    return this.#complete(options, messages, config);
  }
  async generateReview(options:ReviewGenerateOptions):Promise<ChatCompletionResult>{
    const request=await validateReviewRequest(options.request);
    if(options.signal?.aborted||options.current&&!options.current())throw new AiError('CANCELLED');
    const config=parseAiProvider(options.config,true);
    return this.#complete(options,request.messages,config);
  }
  async #complete(options: RequestOptions & { onText(text: string): void; onUsage?(usage: AiUsage): void },
    messages: { role: string; content: string }[], config: AiProviderConfig): Promise<ChatCompletionResult> {
    const streaming = config.stream && this.#transport.supportsStreaming;
    const body = JSON.stringify({ model: config.model, messages, n: 1, stream: streaming,
      [config.tokenParameter]: config.maxOutputTokens,
      ...(streaming && config.includeUsage ? { stream_options: { include_usage: true } } : {}),
    });
    if (new TextEncoder().encode(body).byteLength > this.#limits.requestBytes) throw new AiError('INPUT_TOO_LARGE');
    const guard = new AiRequestGuard(options.signal, this.#limits.totalTimeoutMs);
    const check=()=>{guard.check();if(options.current&&!options.current())throw new AiError('CANCELLED');};
    try {
      check();const key = await this.#key(options.accountScope, config, guard,check);check();
      const response = await this.#request(config, '/chat/completions', key, guard, body);
      const output = new ChatOutput(key, this.#limits,
        (text) => { check(); options.onText(text); },
        (usage) => { check(); options.onUsage?.(usage); });
      if (!streaming) {
        const text = await readAiBody(response, guard, this.#limits.streamBytes, this.#limits.idleTimeoutMs);
        let value: unknown;
        try { value = JSON.parse(text); } catch { throw new AiError('INVALID_RESPONSE'); }
        output.accept(value, false);
      } else {
        if (!response.headers.get('content-type')?.toLowerCase().startsWith('text/event-stream') || !response.body) {
          cancelResponseBody(response); throw new AiError('INVALID_RESPONSE');
        }
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8', { fatal: true });
        const parser = new AiSseParser(this.#limits, (value) => output.accept(value, true));
        let receivedBytes = 0;
        try {
          while (!parser.done) {
            const chunk = await guard.wait(reader.read(), this.#limits.idleTimeoutMs);
            check();
            if (chunk.done) break;
            receivedBytes += chunk.value.byteLength;
            if (receivedBytes > this.#limits.streamBytes) throw new AiError('RESPONSE_TOO_LARGE');
            parser.feed(decoder.decode(chunk.value, { stream: true }));
          }
          parser.feed(decoder.decode());
          parser.finish();
        } catch (error) {
          check();
          if (error instanceof AiError) throw error;
          // Fetch may throw TypeError for a truncated socket; never expose its cause.
          throw new AiError('STREAM_INTERRUPTED');
        } finally {
          void reader.cancel().catch(() => {});
          reader.releaseLock();
        }
      }
      check();
      return output.finish();
    } catch (error) {
      check();
      if (error instanceof AiError) throw error;
      throw new AiError('INVALID_RESPONSE');
    } finally { guard.close(); }
  }
}
