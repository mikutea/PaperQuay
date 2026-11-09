import { Capacitor } from '@capacitor/core';
import { Network } from '@capacitor/network';

interface ConnectionStatus { connected: boolean; connectionType?: 'wifi' | 'cellular' | 'none' | 'unknown' }
interface Subscription { remove(): Promise<void> }
export interface ConnectivityRuntime {
  native: boolean;
  available: boolean;
  online(): boolean;
  events: Pick<EventTarget, 'addEventListener' | 'removeEventListener'>;
  document: Pick<Document, 'visibilityState' | 'addEventListener' | 'removeEventListener'>;
  network: {
    getStatus(): Promise<ConnectionStatus>;
    addListener(event: 'networkStatusChange', listener: (status: ConnectionStatus) => void): Promise<Subscription>;
  };
}

function runtime(): ConnectivityRuntime {
  return {
    native: Capacitor.isNativePlatform(),
    available: Capacitor.isPluginAvailable('Network'),
    online: () => navigator.onLine,
    events: window,
    document,
    network: Network,
  };
}

function hasConnection(status: ConnectionStatus): boolean {
  // A private service can remain reachable over Wi-Fi when OS Internet
  // validation is unavailable. Keep active links; API reachability is separate.
  return status.connected === true || status.connectionType === 'wifi'
    || status.connectionType === 'cellular' || status.connectionType === 'unknown';
}

/** Native WebViews can report navigator.onLine=true in airplane mode. Wait for
 * the OS connection read; this is a connection hint, not service reachability. */
export function initialOnline(environment: ConnectivityRuntime = runtime()): boolean {
  return !environment.native && environment.online();
}

/** Resume refreshes re-read the OS before asking the workspace to reconnect.
 * Late reads/events are fenced after cleanup and cannot overwrite newer events. */
export function observeConnectivity(
  listener: (online: boolean) => void,
  environment: ConnectivityRuntime = runtime(),
): () => void {
  let current = true;
  let last: boolean | undefined;
  let eventVersion = 0;
  let requestVersion = 0;
  let subscription: Subscription | undefined;
  const emit = (online: boolean, refresh = false) => {
    if (!current || !refresh && online === last) return;
    last = online;
    listener(online);
  };
  const refresh = async () => {
    if (!current) return;
    if (!environment.native) { emit(environment.online(), true); return; }
    if (!environment.available) { emit(false); return; }
    const request = ++requestVersion, events = eventVersion;
    try {
      const status = await environment.network.getStatus();
      if (current && request === requestVersion && events === eventVersion) emit(hasConnection(status), true);
    } catch {
      if (current && request === requestVersion && events === eventVersion) emit(false, true);
    }
  };
  const foreground = () => {
    if (environment.document.visibilityState === 'visible') void refresh();
  };
  const browserChange = () => emit(environment.online());
  environment.document.addEventListener('visibilitychange', foreground);
  if (environment.native) {
    emit(false);
    if (environment.available) {
      const attach = async () => environment.network.addListener('networkStatusChange', status => {
        if (!current) return;
        eventVersion++;
        emit(hasConnection(status));
      });
      void attach().then(handle => {
        if (!current) { void handle.remove().catch(() => undefined); return; }
        subscription = handle;
        void refresh();
      }).catch(() => { if (current) void refresh(); });
    }
  } else {
    environment.events.addEventListener('online', browserChange);
    environment.events.addEventListener('offline', browserChange);
    emit(environment.online());
  }
  return () => {
    current = false;
    requestVersion++;
    environment.document.removeEventListener('visibilitychange', foreground);
    environment.events.removeEventListener('online', browserChange);
    environment.events.removeEventListener('offline', browserChange);
    void subscription?.remove().catch(() => undefined);
  };
}
