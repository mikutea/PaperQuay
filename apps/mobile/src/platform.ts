import { Capacitor } from '@capacitor/core';
import { ClientError } from './errors.ts';

export function getPlatformCapabilities() {
  const native = Capacitor.isNativePlatform();
  return {
    platform: Capacitor.getPlatform(),
    native,
    validatedRuntime: 'automated-only' as const,
    nativeAuthentication: native && Capacitor.isPluginAvailable('App') && Capacitor.isPluginAvailable('Browser'),
    nativeSecureStorage: native && Capacitor.isPluginAvailable('SecureStorage'),
    nativeAccountStorage: native && Capacitor.isPluginAvailable('CapacitorSQLite'),
    pdfReading: true,
    directModelApi: true,
  };
}

export function assertPlatformReady(): void {
  if (Capacitor.isNativePlatform() && ['App', 'Browser', 'SecureStorage', 'CapacitorSQLite', 'Filesystem']
    .some((name) => !Capacitor.isPluginAvailable(name))) throw new ClientError('NATIVE_NOT_READY');
}

/** Compatibility alias for callers migrating from the M1 shell. */
export const assertM1WebRuntime = assertPlatformReady;
