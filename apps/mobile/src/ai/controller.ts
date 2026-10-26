import { AiClient } from './client.ts';
import { citedPages, prepareAiContext } from './context.ts';
import { AiError, aiFailure } from './errors.ts';
import { aiAccountKey, parseAiProvider } from './provider.ts';
import type { AiAccountScope, AiAction, AiProviderConfig, AiResult, AiSaveContext, AiSnapshot, PdfAiContext, PreparedAiContext } from './types.ts';

const emptySnapshot = (): AiSnapshot => ({ busy: null, result: null, previousResult: null, failure: null, models: [], connection: 'untested' });

/** Request-local state; changing account, version, text, settings or credentials invalidates callbacks. */
export class AiSessionController {
  #client: AiClient;
  #scope: AiAccountScope | null = null;
  #config: AiProviderConfig | null = null;
  #context: PreparedAiContext | null = null;
  #contextError: AiError = new AiError('CONTEXT_MISSING');
  #binding = '';
  #snapshot: AiSnapshot = emptySnapshot();
  #listeners = new Set<() => void>();
  #epoch = 0;
  #abort: AbortController | null = null;
  #disposed = false;
  constructor(client: AiClient) { this.#client = client; }
  getSnapshot = (): AiSnapshot => this.#snapshot;
  subscribe = (listener: () => void): (() => void) => { this.#listeners.add(listener); return () => this.#listeners.delete(listener); };
  #publish(snapshot: AiSnapshot): void {
    this.#snapshot = snapshot;
    for (const listener of this.#listeners) listener();
  }
  #invalidate(): void { this.#epoch++; this.#abort?.abort(); this.#abort = null; }
  bind(scope: AiAccountScope, config: AiProviderConfig, context: PdfAiContext | null): void {
    if (this.#disposed) { this.#disposed = false; this.#binding = ''; }
    const account = aiAccountKey(scope);
    const provider = parseAiProvider(config);
    let prepared: PreparedAiContext | null = null;
    try { prepared = prepareAiContext(context); }
    catch (error) { this.#contextError = error instanceof AiError ? error : new AiError('CONTEXT_INVALID'); }
    const binding = JSON.stringify([account, provider, prepared?.identity ?? (context ? 'invalid' : 'missing')]);
    if (binding === this.#binding) return;
    this.#invalidate(); this.#binding = binding;
    this.#scope = { ...scope }; this.#config = provider; this.#context = prepared;
    this.#publish(emptySnapshot());
  }
  credentialsChanged(): void { this.#invalidate(); this.#publish(emptySnapshot()); }
  #current(epoch: number): boolean { return !this.#disposed && this.#epoch === epoch; }
  async probe(): Promise<void> {
    if (!this.#scope || !this.#config || this.#disposed) return;
    if (this.#snapshot.busy === 'generate') this.cancel();
    this.#invalidate(); const epoch = this.#epoch;
    const abort = new AbortController(); this.#abort = abort;
    this.#publish({ ...this.#snapshot, busy: 'probe', failure: null, connection: 'checking' });
    try {
      const models = await this.#client.listModels({ accountScope: this.#scope, config: this.#config, signal: abort.signal });
      if (this.#current(epoch)) this.#publish({ ...this.#snapshot, busy: null, models, failure: null, connection: 'reachable' });
    } catch (error) {
      if (this.#current(epoch)) this.#publish({ ...this.#snapshot, busy: null, failure: aiFailure(error), connection: 'failed' });
    } finally { if (this.#current(epoch)) this.#abort = null; }
  }
  async start(action: AiAction, question = ''): Promise<void> {
    if (!this.#scope || !this.#config || this.#disposed) return;
    const prior = this.#snapshot.result;
    const previousResult = prior?.text.trim() ? (prior.status === 'running'
      ? { ...prior, status: 'cancelled' as const, failure: { code: 'CANCELLED' as const } } : prior) : this.#snapshot.previousResult;
    this.#invalidate(); const epoch = this.#epoch;
    const context = this.#context;
    if (!context) { this.#publish({ ...this.#snapshot, busy: null, failure: aiFailure(this.#contextError) }); return; }
    const scope = this.#scope; const config = this.#config;
    const requestId = crypto.randomUUID();
    const result: AiResult = {
      requestId, action, model: config.model, source: {
        paperId: context.source.paperId, attachmentVersionId: context.source.attachmentVersionId,
        sha256: context.source.sha256, label: context.source.label, scope: context.source.scope,
        scopeLabel: context.scopeLabel, pageIndices: [...context.pageIndices], characters: context.characters,
        completeDocument: context.completeDocument,
      },
      text: '', status: 'running', finishReason: null, usage: null, cost: 'unknown', failure: null,
      citations: [], unverifiedPageNumbers: [],
    };
    const abort = new AbortController(); this.#abort = abort;
    this.#publish({ ...this.#snapshot, busy: 'generate', failure: null, result, previousResult });
    const update = (change: Partial<AiResult>) => {
      if (!this.#current(epoch) || !this.#snapshot.result) return;
      const updated = { ...this.#snapshot.result, ...change };
      if (change.text !== undefined) Object.assign(updated, citedPages(change.text, context, requestId));
      this.#publish({ ...this.#snapshot, result: updated });
    };
    try {
      const completed = await this.#client.generate({
        accountScope: scope, config, context, action, question, signal: abort.signal,
        onText: (text) => update({ text }), onUsage: (usage) => update({ usage }),
      });
      if (!this.#current(epoch)) return;
      const failure = completed.finishReason === 'length' ? { code: 'OUTPUT_TRUNCATED' as const }
        : completed.finishReason === 'content_filter' ? { code: 'CONTENT_FILTERED' as const } : null;
      update({ ...completed, status: failure ? 'incomplete' : 'complete', failure });
      this.#publish({ ...this.#snapshot, busy: null, failure });
    } catch (error) {
      if (!this.#current(epoch)) return;
      const failure = aiFailure(error);
      update({ status: failure.code === 'CANCELLED' ? 'cancelled' : this.#snapshot.result?.text ? 'incomplete' : 'failed', failure });
      this.#publish({ ...this.#snapshot, busy: null, failure });
    } finally { if (this.#current(epoch)) this.#abort = null; }
  }
  cancel(): void {
    const busy = this.#snapshot.busy;
    if (!busy) return;
    this.#invalidate();
    const failure = { code: 'CANCELLED' as const };
    this.#publish({ ...this.#snapshot, busy: null, failure,
      ...(busy === 'generate' && this.#snapshot.result ? { result: { ...this.#snapshot.result, status: 'cancelled' as const, failure } } : {}),
      ...(busy === 'probe' ? { connection: 'untested' as const } : {}),
    });
  }
  saveContext(requestId: string): AiSaveContext {
    const result = this.#snapshot.result?.requestId === requestId ? this.#snapshot.result : this.#snapshot.previousResult;
    if (!this.#scope || !result || result.requestId !== requestId || result.status === 'running') throw new AiError('CONTEXT_INVALID');
    return {
      accountScope: { ...this.#scope }, requestId, paperId: result.source.paperId,
      attachmentVersionId: result.source.attachmentVersionId, sha256: result.source.sha256,
    };
  }
  hasResult(requestId: string): boolean {
    return this.#snapshot.result?.requestId === requestId || this.#snapshot.previousResult?.requestId === requestId;
  }
  dispose(): void { this.#disposed = true; this.#invalidate(); this.#listeners.clear(); }
}
