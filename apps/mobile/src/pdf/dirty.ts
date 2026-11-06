import { useLayoutEffect, useRef } from 'react';
import type { PositionStatus } from './position.ts';

/** Persistence completion and navigation share this state even before React commits a render. */
export class ReaderDirtyState {
  private position: PositionStatus = 'idle';
  private commentChanged = false;
  private readonly comments = new Set<symbol>();
  private readonly annotations = new Set<symbol>();

  constructor(private readonly notify: (dirty: boolean) => void) {}

  get annotationSaving(): boolean { return this.annotations.size > 0; }
  get dirty(): boolean {
    return this.commentChanged || this.comments.size > 0 || this.annotationSaving
      || this.position === 'saving' || this.position === 'error';
  }

  publish(): boolean {
    const dirty = this.dirty;
    this.notify(dirty);
    return dirty;
  }

  setPosition(status: PositionStatus): void { this.position = status; this.publish(); }
  setComment(draft: { comment: string; saved: string } | null): void {
    this.commentChanged = Boolean(draft && draft.comment !== draft.saved);
    this.publish();
  }

  beginSave(kind: 'comment' | 'annotation'): () => void {
    const pending = kind === 'comment' ? this.comments : this.annotations;
    const token = Symbol(kind); pending.add(token); this.publish();
    return () => { if (pending.delete(token)) this.publish(); };
  }
}

export function useReaderDirty(onDirtyChange?: (dirty: boolean) => void): ReaderDirtyState {
  const listener = useRef(onDirtyChange); listener.current = onDirtyChange;
  const active = useRef(false);
  const state = useRef<ReaderDirtyState | null>(null);
  state.current ??= new ReaderDirtyState((dirty) => { if (active.current) listener.current?.(dirty); });
  useLayoutEffect(() => {
    active.current = true; state.current!.publish();
    return () => { active.current = false; };
  }, [onDirtyChange]);
  return state.current;
}
