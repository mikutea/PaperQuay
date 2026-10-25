import type { NoteData } from '../../../../packages/sync-core/src/index.ts';
import type { PdfAiContext, PdfCitationTarget } from '../pdf/types.ts';
import type { SecretStore } from '../platform/secretStore.ts';

export type { PdfAiContext, PdfCitationTarget, SecretStore };

export interface AiAccountScope { apiBaseUrl: string; accountId: string }
export type AiAction = 'explain' | 'translate' | 'ask' | 'rewrite' | 'summarize';
export interface AiProviderConfig {
  version: 1;
  id: string;
  endpoint: string;
  model: string;
  stream: boolean;
  includeUsage: boolean;
  requiresKey: boolean;
  maxOutputTokens: number;
  tokenParameter: 'max_completion_tokens' | 'max_tokens';
}

/** Transport implementations must not follow redirects or persist request headers. */
export interface AiTransport {
  readonly kind: 'fetch' | 'native';
  readonly supportsStreaming: boolean;
  readonly redirectPolicy: 'error';
  request(input: {
    url: string;
    method: 'GET' | 'POST';
    headers: Record<string, string>;
    body?: string;
    signal: AbortSignal;
  }): Promise<Response>;
}

export const AI_LIMITS = Object.freeze({
  contextBytes: 192 * 1024,
  requestBytes: 256 * 1024,
  questionBytes: 8 * 1024,
  // Leaves room for source metadata within the existing note body limit.
  outputBytes: 240 * 1024,
  streamBytes: 2 * 1024 * 1024,
  eventBytes: 128 * 1024,
  events: 10000,
  modelListBytes: 512 * 1024,
  models: 500,
  pages: 2000,
  totalTimeoutMs: 120000,
  idleTimeoutMs: 20000,
  probeTimeoutMs: 20000,
});
export type AiLimits = { -readonly [Key in keyof typeof AI_LIMITS]: number };

export interface PreparedAiContext {
  source: PdfAiContext;
  identity: string;
  scopeLabel: string;
  completeDocument: boolean;
  characters: number;
  bytes: number;
  pageIndices: number[];
  citationPages: number[];
}

export interface AiUsage {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
}

export type AiErrorCode =
  | 'CONFIG_INVALID' | 'KEY_MISSING' | 'KEY_INVALID' | 'SECRET_STORAGE_FAILED'
  | 'CONTEXT_MISSING' | 'CONTEXT_INVALID' | 'CONTEXT_TOO_LARGE' | 'TEXT_MISSING'
  | 'QUESTION_REQUIRED' | 'INPUT_TOO_LARGE' | 'AUTHENTICATION_FAILED' | 'ACCESS_DENIED'
  | 'RATE_LIMITED' | 'QUOTA_EXCEEDED' | 'MODEL_OR_REQUEST_REJECTED' | 'ENDPOINT_NOT_FOUND'
  | 'PROVIDER_UNAVAILABLE' | 'NETWORK_OR_CORS' | 'REDIRECT_BLOCKED' | 'TIMEOUT'
  | 'IDLE_TIMEOUT' | 'CANCELLED' | 'STREAM_INTERRUPTED' | 'INVALID_RESPONSE'
  | 'RESPONSE_TOO_LARGE' | 'OUTPUT_LIMIT' | 'OUTPUT_TRUNCATED' | 'CONTENT_FILTERED'
  | 'UNSUPPORTED_RESPONSE' | 'SETTINGS_STORAGE_FAILED';

export interface AiFailure { code: AiErrorCode; retryAfterSeconds?: number }
export interface AiSourceSummary {
  paperId: string;
  attachmentVersionId: string;
  sha256: string;
  label: string;
  scope: PdfAiContext['scope'];
  scopeLabel: string;
  pageIndices: number[];
  characters: number;
  completeDocument: boolean;
}
export interface AiCitation { pageNumber: number; target: PdfCitationTarget }
export interface AiResult {
  requestId: string;
  action: AiAction;
  model: string;
  source: AiSourceSummary;
  text: string;
  status: 'running' | 'complete' | 'incomplete' | 'cancelled' | 'failed';
  finishReason: string | null;
  usage: AiUsage | null;
  cost: 'unknown';
  failure: AiFailure | null;
  citations: AiCitation[];
  unverifiedPageNumbers: number[];
}
export interface AiSnapshot {
  busy: 'generate' | 'probe' | null;
  result: AiResult | null;
  previousResult: AiResult | null;
  failure: AiFailure | null;
  models: string[];
  connection: 'untested' | 'checking' | 'reachable' | 'failed';
}
export interface AiSaveContext {
  accountScope: AiAccountScope;
  requestId: string;
  paperId: string;
  attachmentVersionId: string;
  sha256: string;
}
export interface AiWorkspaceProps {
  accountScope: AiAccountScope;
  context: PdfAiContext | null;
  secretStore: SecretStore;
  transport?: AiTransport;
  onSaveNote(note: NoteData, source: AiSaveContext): Promise<void>;
  onNavigateCitation(target: PdfCitationTarget): void;
}
