import {
  canonicalJson, getVisibleEntity, listVisibleEntities,
  type AccountSyncState, type EntityDataMap, type LocalEdit, type VisibleEntity,
} from '../../../../packages/sync-core/src/index.ts';
import {
  validateAiConversation, validateAiTemplate, type AiConversationData, type AiTemplateData,
} from '../../../../packages/ai-core/src/conversation.ts';
import type { AiAccountScope } from '../ai/types.ts';
import type { StoredWorkspace, WorkspaceController } from '../sync/workspace.ts';
import { ClientError } from '../errors.ts';

export type AiSyncKind = 'aiConversation' | 'aiTemplate';
export interface AiSyncEntry<T> { id: string; revision: number; data: T; status: VisibleEntity['status']; conflicted: boolean }
export interface AiSyncBridge {
  enabled: boolean;
  conversations: AiSyncEntry<AiConversationData>[];
  templates: AiSyncEntry<AiTemplateData>[];
  saveConversation(data: AiConversationData, previous?: AiSyncEntry<AiConversationData>): Promise<string>;
  saveTemplate(data: AiTemplateData, previous?: AiSyncEntry<AiTemplateData>): Promise<string>;
  remove(kind: AiSyncKind, entry: AiSyncEntry<AiConversationData | AiTemplateData>): Promise<void>;
}
type Controller = Pick<WorkspaceController, 'getSnapshot' | 'save'>;

function assertScope(controller: Controller, scope: AiAccountScope, sync: Readonly<AccountSyncState>) {
  const snapshot = controller.getSnapshot();
  if (snapshot.status !== 'ready' || snapshot.identity?.accountId !== scope.accountId || sync.accountId !== scope.accountId)
    throw new ClientError('ACCOUNT_CHANGED');
  if (snapshot.workspace?.aiConversationsVersion !== 1) throw new ClientError('SYNC_FEATURE_UNAVAILABLE');
}
function hasConflict(sync: Readonly<AccountSyncState>, workspace: Readonly<StoredWorkspace>, kind: AiSyncKind, id: string) {
  return Object.values(sync.conflicts).some(value => value.attempted.entityType === kind && value.attempted.entityId === id)
    || Object.values(workspace.pendingResolutions).some(value => value.entityType === kind && value.entityId === id);
}
function assertPrevious(sync: Readonly<AccountSyncState>, workspace: Readonly<StoredWorkspace> | undefined, kind: AiSyncKind, id: string, previous?: AiSyncEntry<unknown>) {
  if (!workspace || hasConflict(sync, workspace, kind, id)) throw new ClientError('EDIT_CHANGED');
  const current = getVisibleEntity(sync, kind, id);
  if (previous ? !current || current.deleted || current.revision !== previous.revision || current.status === 'conflict'
    || canonicalJson(current.data) !== canonicalJson(previous.data)
    : Boolean(current)) throw new ClientError('EDIT_CHANGED');
}
function assertConversationSource(sync: Readonly<AccountSyncState>, data: AiConversationData) {
  const paper = getVisibleEntity(sync, 'paper', data.paperId);
  const version = getVisibleEntity(sync, 'attachmentVersion', data.attachmentVersionId);
  if (!paper?.data || paper.deleted || !version?.data || version.deleted
    || !('sha256' in version.data) || version.data.paperId !== data.paperId || version.data.sha256 !== data.sha256)
    throw new ClientError('EDIT_CHANGED');
}

/** The review snapshot is checked again inside the account storage transaction.
 * Revisions alone do not identify an unsent local edit; compare its full data too. */
export function createAiSyncBridge(controller: Controller, scope: AiAccountScope): AiSyncBridge {
  const snapshot = controller.getSnapshot(), sync = snapshot.workspace?.sync;
  const visible = sync ? listVisibleEntities(sync) : [];
  const entries = <K extends AiSyncKind>(kind: K): AiSyncEntry<EntityDataMap[K]>[] => visible
    .filter(value => value.entityType === kind && !value.deleted && value.data)
    .map(value => ({ id: value.entityId, revision: value.revision, data: value.data as EntityDataMap[K],
      status: value.status, conflicted: value.status === 'conflict' || Boolean(sync && snapshot.workspace && hasConflict(sync,snapshot.workspace,kind,value.entityId)) }));
  async function save<K extends AiSyncKind>(kind: K, input: EntityDataMap[K], previous?: AiSyncEntry<EntityDataMap[K]>) {
    const data = kind === 'aiConversation' ? validateAiConversation(input) : validateAiTemplate(input);
    const captured = previous ? structuredClone(previous) : undefined;
    if (captured?.conflicted) throw new ClientError('EDIT_CHANGED');
    const id = captured?.id ?? crypto.randomUUID();
    await controller.save({ entityType: kind, entityId: id, mutation: 'put', data } as LocalEdit, captured?.revision ?? 0,
      (state,workspace) => {
        assertScope(controller, scope, state); assertPrevious(state,workspace, kind, id, captured);
        if (!captured && listVisibleEntities(state).filter(value => value.entityType === kind && !value.deleted).length >= (kind === 'aiConversation' ? 50 : 100))
          throw new ClientError('AI_COLLECTION_LIMIT');
        if (kind === 'aiConversation') assertConversationSource(state, data as AiConversationData);
      });
    return id;
  }
  return {
    enabled: snapshot.status === 'ready' && snapshot.identity?.accountId === scope.accountId && snapshot.workspace?.aiConversationsVersion === 1,
    conversations: entries('aiConversation'), templates: entries('aiTemplate'),
    saveConversation: (data, previous) => save('aiConversation', data, previous),
    saveTemplate: (data, previous) => save('aiTemplate', data, previous),
    remove: async (kind, entry) => {
      const captured = structuredClone(entry);
      if (captured.conflicted) throw new ClientError('EDIT_CHANGED');
      await controller.save({ entityType: kind, entityId: captured.id, mutation: 'delete', data: null }, captured.revision,
        (state,workspace) => { assertScope(controller, scope, state); assertPrevious(state,workspace, kind, captured.id, captured); });
    },
  };
}
