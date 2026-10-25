import { randomUUID } from 'node:crypto';
import type { EntityDataMap, EntityType, SyncOperation } from '../../packages/sync-core/src/index.ts';
import type { VerifiedIdentity } from '../src/auth.ts';
import { loadConfig } from '../src/config.ts';

export const fixtureIssuer = 'https://identity.example.test/realms/paperquay';

export function identity(subject = randomUUID(), sessionId = randomUUID()): VerifiedIdentity {
  return { issuer: fixtureIssuer, subject, sessionId, clientId: 'paperquay-test' };
}

export function operation<T extends EntityType>(entityType: T, data: EntityDataMap[T] | null,
  options: Partial<{ entityId: string; opId: string; baseRevision: number; mutation: 'put' | 'delete' | 'restore' }> = {}): SyncOperation<T> {
  return { opId: randomUUID(), entityType, entityId: randomUUID(), mutation: 'put', baseRevision: 0,
    schemaVersion: 1, data, clientCreatedAt: new Date().toISOString(), ...options } as SyncOperation<T>;
}

export function paper(title = 'A synthetic research paper'): EntityDataMap['paper'] {
  return { title, doi: null, year: '2026', publication: null, abstractText: null, authors: ['Synthetic Author'], keywords: [] };
}

export function version(paperId: string, pageCount: number | null = 8): EntityDataMap['attachmentVersion'] {
  return { paperId, attachmentId: randomUUID(), sha256: 'a'.repeat(64), sizeBytes: 512,
    mediaType: 'application/pdf', fileName: 'synthetic.pdf', pageCount };
}

export function checkpoint(paperId: string, attachmentVersionId: string, pageIndex = 0): EntityDataMap['readingPosition'] {
  return { paperId, attachmentVersionId, pageIndex, offsetRatio: 0.2,
    furthestPageIndex: pageIndex, furthestOffsetRatio: 0.2, sessionId: randomUUID(),
    deviceSequence: 1, observedAt: new Date().toISOString() };
}

export function testConfig(overrides: NodeJS.ProcessEnv = {}) {
  return loadConfig({
    PAPERQUAY_DATABASE_URL: 'postgresql://runtime@127.0.0.1:5432/isolated_test',
    PAPERQUAY_OIDC_ISSUER: fixtureIssuer,
    PAPERQUAY_OIDC_AUDIENCE: 'paperquay-sync', PAPERQUAY_OIDC_CLIENT_IDS: 'paperquay-test',
    PAPERQUAY_CURSOR_SECRET: Buffer.alloc(32, 71).toString('base64'),
    PAPERQUAY_ALLOWED_ORIGINS: 'http://127.0.0.1:5174',
    ...overrides,
  });
}
