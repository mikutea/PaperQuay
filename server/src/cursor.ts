import { createHmac, timingSafeEqual } from 'node:crypto';
import { UUID_PATTERN } from '../../packages/sync-core/src/index.ts';
import { ApiError } from './errors.ts';

interface CursorPayload { v: 1; kind: 'changes' | 'conflicts'; account: string; epoch: string; seq: string }
const uuid = new RegExp(UUID_PATTERN);

export class CursorCodec {
  readonly secret: Uint8Array;
  constructor(secret: Uint8Array) {
    if (secret.length < 32) throw new ApiError('CONFIGURATION_INVALID', 500);
    this.secret = new Uint8Array(secret);
  }
  encode(kind: CursorPayload['kind'], account: string, epoch: string, seq: string): string {
    const value: CursorPayload = { v: 1, kind, account, epoch, seq };
    const body = Buffer.from(JSON.stringify(value)).toString('base64url');
    return `${body}.${createHmac('sha256', this.secret).update(body).digest('base64url')}`;
  }
  decode(input: string | undefined, kind: CursorPayload['kind'], account: string, epoch: string): bigint {
    if (!input) return 0n;
    if (input.length > 4096 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(input)) throw new ApiError('CURSOR_INVALID');
    const [body, signature] = input.split('.');
    const expected = createHmac('sha256', this.secret).update(body).digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new ApiError('CURSOR_INVALID');
    let value: unknown;
    try { value = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')); } catch { throw new ApiError('CURSOR_INVALID'); }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ApiError('CURSOR_INVALID');
    const candidate = value as Record<string, unknown>;
    if (Object.keys(candidate).sort().join(',') !== 'account,epoch,kind,seq,v'
      || candidate.v !== 1 || candidate.kind !== kind || candidate.account !== account
      || typeof candidate.epoch !== 'string' || !uuid.test(candidate.epoch)
      || typeof candidate.seq !== 'string' || !/^(0|[1-9][0-9]{0,18})$/.test(candidate.seq)) {
      throw new ApiError('CURSOR_INVALID');
    }
    if (candidate.epoch !== epoch) throw new ApiError('SYNC_RESET_REQUIRED', 409);
    return BigInt(candidate.seq);
  }
}
