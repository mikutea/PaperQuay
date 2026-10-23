import type { AccountSyncState, VisibleEntity } from '../../../packages/sync-core/src/index.ts';

export function hasEntityConflict(
  state: AccountSyncState,
  entity: Pick<VisibleEntity, 'entityType' | 'entityId'>,
): boolean {
  return state.outbox.some(
    (entry) =>
      entry.operation.entityType === entity.entityType &&
      entry.operation.entityId === entity.entityId &&
      entry.status === 'conflict',
  );
}

export function entityStatus(entity?: VisibleEntity | null, hasConflict = false): string {
  if (!entity) return '新建内容尚未保存';
  if (hasConflict || entity.status === 'conflict') return '需要处理冲突';
  if (entity.status === 'rejected' || entity.status === 'device-blocked')
    return '已保存在此设备 · 同步受阻';
  if (entity.pending) return '已保存在此设备 · 待同步';
  return '已同步';
}
