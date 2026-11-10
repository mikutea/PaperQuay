import type { AccountSyncState, OutboxEntry, VisibleEntity } from '../../../packages/sync-core/src/index.ts';
import type { WorkspaceSnapshot } from './sync/workspace.ts';

/** Old-session checkpoints stay local; they are not retryable current-device work. */
export function syncSummary(state: WorkspaceSnapshot, conflicts: number) {
  const retained: OutboxEntry[] = [], blocked: OutboxEntry[] = [];
  let pending = Object.keys(state.workspace?.pendingResolutions ?? {}).length;
  for (const entry of state.workspace?.sync.outbox ?? []) {
    if (entry.operation.entityType === 'readingPosition' && entry.status === 'device-blocked'
      && entry.errorCode === 'DEVICE_CHANGED' && entry.originDeviceId !== state.workspace!.sync.deviceId) {
      retained.push(entry);
    } else {
      pending++;
      if (entry.status === 'rejected' || entry.status === 'device-blocked') blocked.push(entry);
    }
  }
  const label = !state.online
    ? pending ? `离线 · ${pending} 项待同步` : retained.length ? '离线 · 旧阅读位置已保留在本机' : '离线 · 本地内容可用'
    : state.needsLogin ? '请重新登录'
      : conflicts ? `${conflicts} 项冲突待处理`
        : state.syncing ? '同步中'
          : blocked.length ? '部分改动同步受阻'
            : pending ? `${pending} 项待同步`
              : retained.length ? '旧阅读位置已保留在本机'
                : state.lastSyncedAt ? '已同步' : '等待首次同步';
  const needsAttention = Boolean(conflicts || blocked.length || state.needsLogin);
  const icon: 'offline' | 'warning' | 'sync' | 'device' | 'check' = !state.online ? 'offline' : needsAttention ? 'warning'
    : state.syncing ? 'sync' : retained.length ? 'device' : 'check';
  return { label, icon, needsAttention, pending, retained, blocked };
}

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
