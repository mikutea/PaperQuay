import { Capacitor } from '@capacitor/core';
import { ClientError } from './errors.ts';

export function getPlatformCapabilities() {
  return {
    platform: Capacitor.getPlatform(),
    native: Capacitor.isNativePlatform(),
    validatedRuntime: 'web' as const,
    nativeAuthentication: false,
    nativeSecureStorage: false,
    pdfReading: false,
    directModelApi: false,
  };
}

export function assertM1WebRuntime(): void {
  if (Capacitor.isNativePlatform()) throw new ClientError('NATIVE_NOT_READY');
}
