import { AiError } from './errors.ts';
import type { AiLimits, AiUsage } from './types.ts';

/** Removes reflected credentials before any output enters React/controller state. */
export class KeyRedactor {
  #key: string;
  #prefix: number[];
  #pending = '';
  constructor(key: string | null) {
    this.#key = key ?? '';
    this.#prefix = new Array(this.#key.length).fill(0);
    for (let i = 1, length = 0; i < this.#key.length; i++) {
      while (length && this.#key[i] !== this.#key[length]) length = this.#prefix[length - 1];
      if (this.#key[i] === this.#key[length]) length++;
      this.#prefix[i] = length;
    }
  }
  push(text: string): string {
    if (!this.#key) return text;
    const output: string[] = [];
    for (const character of text) {
      while (this.#pending.length && character !== this.#key[this.#pending.length]) {
        const fallback = this.#prefix[this.#pending.length - 1];
        output.push(this.#pending.slice(0, this.#pending.length - fallback));
        this.#pending = this.#pending.slice(this.#pending.length - fallback);
      }
      if (character === this.#key[this.#pending.length]) {
        this.#pending += character;
        if (this.#pending.length === this.#key.length) {
          output.push('[已隐藏凭据]');
          this.#pending = '';
        }
      } else output.push(character);
    }
    return output.join('');
  }
  finish(): string {
    const tail = this.#pending;
    this.#pending = '';
    return tail;
  }
}

export function actualAiUsage(value: unknown): AiUsage | null {
  if (!value || typeof value !== 'object') return null;
  const usage = value as Record<string, unknown>;
  const counts = [usage.prompt_tokens, usage.completion_tokens, usage.total_tokens];
  if (!counts.every((count) => typeof count === 'number' && Number.isSafeInteger(count) && count >= 0 && count <= 1_000_000_000)) return null;
  const [promptTokens, completionTokens, totalTokens] = counts as number[];
  if (totalTokens !== promptTokens + completionTokens) return null;
  return { promptTokens, completionTokens, totalTokens };
}

export interface ChatCompletionResult { text: string; usage: AiUsage | null; finishReason: string }

/** The collector accepts only text from choice zero; tools and multimedia are never executed. */
export class ChatOutput {
  #redactor: KeyRedactor;
  #limits: AiLimits;
  #rawBytes = 0;
  #safeBytes = 0;
  #text = '';
  #usage: AiUsage | null = null;
  #finishReason: string | null = null;
  #onText: (text: string) => void;
  #onUsage: (usage: AiUsage) => void;
  constructor(key: string | null, limits: AiLimits, onText: (text: string) => void, onUsage: (usage: AiUsage) => void) {
    this.#redactor = new KeyRedactor(key); this.#limits = limits; this.#onText = onText; this.#onUsage = onUsage;
  }
  #append(text: string): void {
    this.#rawBytes += new TextEncoder().encode(text).byteLength;
    if (this.#rawBytes > this.#limits.outputBytes) throw new AiError('OUTPUT_LIMIT');
    this.#publish(this.#redactor.push(text));
  }
  #publish(safe: string): void {
    this.#safeBytes += new TextEncoder().encode(safe).byteLength;
    if (this.#safeBytes > this.#limits.outputBytes) throw new AiError('OUTPUT_LIMIT');
    if (safe) { this.#text += safe; this.#onText(this.#text); }
  }
  accept(value: unknown, streaming: boolean): void {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AiError('INVALID_RESPONSE');
    const data = value as Record<string, unknown>;
    if (data.error) throw new AiError('INVALID_RESPONSE');
    const usage = actualAiUsage(data.usage);
    if (usage) { this.#usage = usage; this.#onUsage(usage); }
    if (!Array.isArray(data.choices)) throw new AiError('INVALID_RESPONSE');
    if (!data.choices.length && streaming && Object.hasOwn(data, 'usage')) return;
    const choice = data.choices.find((entry: unknown) => entry && typeof entry === 'object' && (entry as { index?: unknown }).index === 0);
    if (!choice || typeof choice !== 'object') throw new AiError('INVALID_RESPONSE');
    const part = streaming ? choice.delta : choice.message;
    if (!part || typeof part !== 'object' || Array.isArray(part)) throw new AiError('INVALID_RESPONSE');
    if (part.tool_calls || part.function_call || part.audio) throw new AiError('UNSUPPORTED_RESPONSE');
    if (part.content !== undefined && part.content !== null && typeof part.content !== 'string') throw new AiError('UNSUPPORTED_RESPONSE');
    if (part.refusal !== undefined && part.refusal !== null && typeof part.refusal !== 'string') throw new AiError('INVALID_RESPONSE');
    if (typeof part.content === 'string') this.#append(part.content);
    if (typeof part.refusal === 'string') this.#append(part.refusal);
    if (choice.finish_reason !== undefined && choice.finish_reason !== null) {
      if (!['stop', 'length', 'content_filter', 'tool_calls', 'function_call'].includes(choice.finish_reason)) throw new AiError('INVALID_RESPONSE');
      if (choice.finish_reason === 'tool_calls' || choice.finish_reason === 'function_call') throw new AiError('UNSUPPORTED_RESPONSE');
      this.#finishReason = choice.finish_reason;
    }
  }
  finish(): ChatCompletionResult {
    if (!this.#finishReason) throw new AiError('INVALID_RESPONSE');
    const tail = this.#redactor.finish();
    this.#publish(tail);
    if (!this.#text.trim()) throw new AiError('INVALID_RESPONSE');
    return { text: this.#text, usage: this.#usage, finishReason: this.#finishReason };
  }
}

/** Incremental SSE framing, including split UTF-8/CRLF, comments and multiline data. */
export class AiSseParser {
  #line = '';
  #afterCr = false;
  #data: string[] = [];
  #event = '';
  #bytes = 0;
  #events = 0;
  #limits: AiLimits;
  #onValue: (value: unknown) => void;
  done = false;
  constructor(limits: AiLimits, onValue: (value: unknown) => void) { this.#limits = limits; this.#onValue = onValue; }
  feed(text: string): void {
    for (const character of text) {
      if (this.done) return;
      if (this.#afterCr) { this.#afterCr = false; if (character === '\n') continue; }
      if (character === '\r' || character === '\n') {
        this.#consumeLine(this.#line);
        this.#line = '';
        this.#afterCr = character === '\r';
      } else {
        this.#line += character;
        // A UTF-8 string uses at least one byte per UTF-16 code unit except surrogate pairs.
        if (this.#line.length > this.#limits.eventBytes) throw new AiError('RESPONSE_TOO_LARGE');
      }
    }
    if (this.#bytes + new TextEncoder().encode(this.#line).byteLength > this.#limits.eventBytes) throw new AiError('RESPONSE_TOO_LARGE');
  }
  #consumeLine(line: string): void {
    this.#bytes += new TextEncoder().encode(line).byteLength + 1;
    if (this.#bytes > this.#limits.eventBytes) throw new AiError('RESPONSE_TOO_LARGE');
    if (line === '') {
      if (this.#data.length) {
        if (++this.#events > this.#limits.events) throw new AiError('RESPONSE_TOO_LARGE');
        const payload = this.#data.join('\n');
        if (payload.trim() === '[DONE]') this.done = true;
        else {
          if (this.#event === 'error') throw new AiError('INVALID_RESPONSE');
          let value: unknown;
          try { value = JSON.parse(payload); } catch { throw new AiError('INVALID_RESPONSE'); }
          this.#onValue(value);
        }
      }
      this.#bytes = 0; this.#data = []; this.#event = '';
      return;
    }
    if (line.startsWith(':')) return;
    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'data') this.#data.push(value);
    else if (field === 'event') this.#event = value;
  }
  finish(): void { if (!this.done) throw new AiError('STREAM_INTERRUPTED'); }
}
