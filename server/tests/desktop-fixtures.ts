import { createHash, randomUUID } from 'node:crypto';
import { buildApp } from '../src/app.ts';
import type { VerifiedIdentity } from '../src/auth.ts';
import type { DesktopPdfTimings } from '../src/desktop-pdf.ts';
import { ApiError } from '../src/errors.ts';
import type { DesktopPdfRepository, DesktopPdfTarget, SessionView, SyncRepository } from '../src/types.ts';
import { identity, testConfig } from './fixtures.ts';

export const desktopBytes = Buffer.from('%PDF-1.7\nSynthetic desktop transfer fixture\n%%EOF\n');
export function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

export function desktopFixture(content = desktopBytes) {
  const owner = randomUUID(); const stranger = randomUUID();
  const identities: Record<string, VerifiedIdentity> = {
    consumer: identity(owner), provider: identity(owner), provider2: identity(owner), peer: identity(owner),
    other: identity(stranger), otherProvider: identity(stranger),
  };
  for (const who of Object.values(identities)) who.expiresAtMs = Date.now() + 300000;
  const accounts = new Map<string, string>([[owner, randomUUID()], [stranger, randomUUID()]]);
  const views = new Map<string, SessionView>();
  for (const [name, who] of Object.entries(identities)) views.set(who.sessionId, {
    accountId: accounts.get(who.subject)!, device: { id: randomUUID(), name: 'Synthetic ' + name,
      platform: name.toLowerCase().includes('provider') ? 'windows' : 'web',
      createdAt: new Date().toISOString(), lastSeenAt: new Date().toISOString(), revokedAt: null },
  });
  const paperId = randomUUID();
  const target: DesktopPdfTarget = {
    paper: { entityId: paperId, revision: 1, title: 'Synthetic desktop document' },
    version: { entityId: randomUUID(), revision: 1, data: { paperId, attachmentId: randomUUID(),
      sha256: createHash('sha256').update(content).digest('hex'), sizeBytes: content.byteLength,
      mediaType: 'application/pdf', fileName: 'synthetic.pdf', pageCount: 1 } },
  };
  const state = { paperDeleted: false, versionDeleted: false, checks: 0, metadataReads: 0,
    beforeCheck: undefined as undefined | (() => Promise<void>),
    beforeTarget: undefined as undefined | (() => Promise<void>) };
  const session = (who: VerifiedIdentity) => {
    const view = views.get(who.sessionId);
    if (!view || view.accountId !== accounts.get(who.subject)) throw new ApiError('DEVICE_NOT_REGISTERED', 403);
    if (view.device.revokedAt) throw new ApiError('SESSION_REVOKED', 403);
    return view;
  };
  const getTarget = (who: VerifiedIdentity, id: string) => {
    session(who);
    if (who.subject !== owner || id !== target.version.entityId) throw new ApiError('NOT_FOUND', 404);
    if (state.paperDeleted || state.versionDeleted) throw new ApiError('ATTACHMENT_VERSION_UNAVAILABLE', 410);
    return structuredClone(target);
  };
  const repository: SyncRepository = {
    ready: async () => true, me: async (who) => session(who), registerDevice: async (who) => session(who),
    listDevices: async (who) => ({ devices: [...views.values()].filter((view) => view.accountId === session(who).accountId).map((view) => view.device) }),
    revokeDevice: async (who, id) => {
      const accountId = session(who).accountId;
      const view = [...views.values()].find((view) => view.accountId === accountId && view.device.id === id);
      if (!view) throw new ApiError('NOT_FOUND', 404);
      view.device.revokedAt = new Date().toISOString();
      return { revoked: true, deviceId: id };
    },
    push: async () => ({ protocolVersion: 1, results: [] }),
    pull: async () => ({ protocolVersion: 1, records: [], nextCursor: null, hasMore: false }),
    listConflicts: async () => ({ conflicts: [], nextCursor: '', hasMore: false }),
    resolveConflict: async (_who, _id, request) => ({ opId: request.opId, status: 'rejected', replayed: false }),
  };
  const desktop: DesktopPdfRepository = {
    desktopPdfSession: async (who) => session(who),
    listDesktopPdfVersions: async (who, after) => {
      state.metadataReads++; session(who);
      const items = who.subject === owner && !state.paperDeleted && !state.versionDeleted
        && (!after || target.version.entityId > after) ? [structuredClone(target)] : [];
      return { items, nextAfter: null, hasMore: false };
    },
    getDesktopPdfVersion: async (who, id) => {
      state.metadataReads++; await state.beforeTarget?.(); return getTarget(who, id);
    },
    checkDesktopPdfTransfer: async (consumer, provider, expected) => {
      state.checks++; await state.beforeCheck?.();
      const current = getTarget(consumer, expected.version.entityId);
      if (current.paper.revision !== expected.paper.revision || current.version.revision !== expected.version.revision
        || current.version.data.sha256 !== expected.version.data.sha256 || current.version.data.sizeBytes !== expected.version.data.sizeBytes) {
        throw new ApiError('DESKTOP_PDF_CHANGED', 409);
      }
      if (provider && (provider.subject !== consumer.subject || provider.issuer !== consumer.issuer || provider.sessionId === consumer.sessionId)) {
        throw new ApiError('NOT_FOUND', 404);
      }
      let providerDeviceId: string | null = null;
      if (provider) {
        try { providerDeviceId = session(provider).device.id; }
        catch { throw new ApiError('DESKTOP_PDF_UNAVAILABLE', 404); }
      }
      return { accountId: session(consumer).accountId, consumerDeviceId: session(consumer).device.id, providerDeviceId };
    },
  };
  const headers = (name = 'consumer') => ({ authorization: 'Bearer ' + name });
  const create = (timings: Partial<DesktopPdfTimings> = {}, enabled = true) => buildApp({
    config: testConfig({ PAPERQUAY_DESKTOP_PDF_ENABLED: enabled ? '1' : '0' }),
    repository, desktopPdfRepository: desktop, rateLimitEnabled: false,
    desktopPdfTimings: { requestTtlMs: 2000, pollTimeoutMs: 30, presenceTtlMs: 2000, claimTimeoutMs: 500,
      recheckIntervalMs: 20, recheckTimeoutMs: 100, ...timings },
    verifyToken: async (header) => {
      const who = header?.startsWith('Bearer ') ? identities[header.slice(7)] : undefined;
      if (!who) throw new ApiError('AUTHENTICATION_REQUIRED', 401);
      return { ...who };
    },
  });
  return { identities, views, target, state, repository, desktop, headers, create };
}
