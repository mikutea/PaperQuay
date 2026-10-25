/** Public errors deliberately contain codes, never rejected values or driver messages. */
export class ApiError extends Error {
  readonly code: string;
  readonly statusCode: number;
  constructor(code: string, statusCode = 400) {
    super(code);
    this.name = 'ApiError';
    this.code = code;
    this.statusCode = statusCode;
  }
}

export function databaseErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== 'object' || !('code' in error)) return undefined;
  return typeof error.code === 'string' ? error.code : undefined;
}

export function isTransientDatabaseError(error: unknown): boolean {
  const code = databaseErrorCode(error);
  const driverTimeout = error instanceof Error && [
    'timeout exceeded when trying to connect',
    'Connection terminated due to connection timeout',
    'Connection terminated unexpectedly',
    'Connection terminated',
    'timeout expired',
    'Query read timeout',
  ].includes(error.message);
  return driverTimeout || code === '40001' || code === '40P01' || code === '55P03' || code === '57014'
    || code === '53300' || code === '57P01' || code === '57P02' || code === '57P03'
    || Boolean(code?.startsWith('08')) || code === 'ECONNREFUSED' || code === 'ECONNRESET'
    || code === 'ETIMEDOUT' || code === 'EPIPE';
}
