import type { WorkspaceController } from '../sync/workspace.ts';
import { RetrievalClient, RetrievalError } from './client.ts';
import { applyRetrievalStatus, readRetrievalSession, receiveRetrievalSession, type RetrievalSession } from './session.ts';
export interface RetrievalCandidate { session: RetrievalSession; expected: { requestId: string; revision: number } }
export interface RetrievalRunState { busy: boolean; candidate: RetrievalCandidate | null; error: unknown | null }
const expected = (session: RetrievalSession) => ({ requestId: session.request.requestId, revision: session.revision });

/** All methods represent explicit user actions. Opening or restoring a view
 * neither sends a query nor polls for its result. */
export class RetrievalRunner {
  private state: RetrievalRunState = { busy: false, candidate: null, error: null };
  private listeners = new Set<() => void>(); private abort: AbortController | null = null; private epoch = 0; private disposed = false;
  constructor(private client: RetrievalClient, private controller: WorkspaceController, private current: () => boolean) {}
  getSnapshot = () => this.state;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(patch: Partial<RetrievalRunState>) { this.state = { ...this.state, ...patch }; for (const listener of this.listeners) listener(); }
  private async run(work: (call: { signal: AbortSignal; current(): boolean }) => Promise<void>) {
    if (this.disposed || this.state.busy || !this.current()) return;
    const epoch = ++this.epoch, abort = new AbortController(); this.abort = abort;
    const current = () => !this.disposed && this.epoch === epoch && !abort.signal.aborted && this.current();
    this.publish({ busy: true, error: null });
    try { await work({ signal: abort.signal, current }); }
    catch (error) { if (!this.disposed && this.epoch === epoch) this.publish({ error }); }
    finally { if (!this.disposed && this.epoch === epoch) { this.abort = null; this.publish({ busy: false }); } }
  }
  private async save(candidate: RetrievalCandidate, current: () => boolean) {
    if (!current()) throw new RetrievalError('CHANGED');
    this.publish({ candidate });
    await this.controller.saveRetrievalSession(candidate.session, candidate.expected, current);
    if (!current()) throw new RetrievalError('CHANGED'); this.publish({ candidate: null });
  }
  execute(input: RetrievalSession) {
    if (this.state.candidate) return Promise.resolve();
    const session = readRetrievalSession(input);
    return this.run(async call => {
      const begun = await this.controller.beginRetrievalRequest(expected(session), call.current);
      if (!call.current()) throw new RetrievalError('CHANGED');
      const receipt = await this.client.execute(begun.request, call);
      await this.save({ session: receiveRetrievalSession(begun, receipt), expected: expected(begun) }, call.current);
    });
  }
  query(input: RetrievalSession) {
    if (this.state.candidate) return Promise.resolve(); const session = readRetrievalSession(input);
    return this.run(async call => {
      const result = await this.client.status(session.request.requestId, call);
      await this.save({ session: applyRetrievalStatus(session, result), expected: expected(session) }, call.current);
    });
  }
  remove(input: RetrievalSession) {
    if (this.state.candidate) return Promise.resolve(); const session = readRetrievalSession(input);
    return this.run(async call => {
      const result = await this.client.remove(session.request.requestId, call);
      await this.save({ session: applyRetrievalStatus(session, result), expected: expected(session) }, call.current);
    });
  }
  retrySave() { const candidate = this.state.candidate; return candidate ? this.run(call => this.save(candidate, call.current)) : Promise.resolve(); }
  stop() { this.abort?.abort(); }
  activate() { this.disposed = false; }
  dispose() { this.disposed = true; this.epoch++; this.abort?.abort(); this.abort = null; this.state = { busy: false, candidate: null, error: null }; }
}
