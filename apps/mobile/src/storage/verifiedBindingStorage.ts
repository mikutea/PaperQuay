import { ClientError } from '../errors.ts';

/** Only server-verified, non-credential account metadata belongs here. */
export interface BindingStorage {
  get(namespace: string, key: string): Promise<string | null>;
  set(namespace: string, key: string, value: string): Promise<void>;
  remove(namespace: string, key: string): Promise<void>;
  removeIf?(namespace:string,key:string,expected:string):Promise<void>;
}

export class WebBindingStorage implements BindingStorage {
  private readonly database: Promise<IDBDatabase>;
  constructor(options: { indexedDB?: IDBFactory; databaseName?: string } = {}) {
    this.database = new Promise((resolve, reject) => {
      const factory = options.indexedDB ?? globalThis.indexedDB;
      if (!factory) { reject(new ClientError('STORAGE_UNAVAILABLE')); return; }
      let request: IDBOpenDBRequest;
      try { request = factory.open(options.databaseName ?? 'paperquay-verified-bindings-v1', 1); }
      catch { reject(new ClientError('STORAGE_UNAVAILABLE')); return; }
      request.onupgradeneeded = () => request.result.createObjectStore('bindings');
      request.onerror = request.onblocked = () => reject(new ClientError('STORAGE_UNAVAILABLE'));
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => db.close();
        resolve(db);
      };
    });
    void this.database.catch(() => undefined);
  }

  private address(namespace: string, key: string) {
    if (!/^paperquay-verified-account:[a-f0-9]{64}$/.test(namespace) || key !== 'identity')
      throw new ClientError('STORAGE_FAILED');
    return namespace;
  }

  async get(namespace: string, key: string): Promise<string | null> {
    const address = this.address(namespace, key), db = await this.database;
    return new Promise((resolve, reject) => {
      const tx = db.transaction('bindings', 'readonly'), request = tx.objectStore('bindings').get(address);
      let value: string | null = null, failure: ClientError | undefined;
      request.onsuccess = () => {
        if (request.result !== undefined && (typeof request.result !== 'string' || request.result.length > 16384)) {
          failure = new ClientError('STORAGE_CORRUPT'); tx.abort();
        } else value = request.result ?? null;
      };
      tx.oncomplete = () => resolve(value);
      tx.onerror = tx.onabort = () => reject(failure ?? new ClientError('STORAGE_FAILED'));
    });
  }

  private async mutate(namespace: string, key: string, value?: string): Promise<void> {
    const address = this.address(namespace, key), db = await this.database;
    if (value !== undefined && (typeof value !== 'string' || value.length > 16384)) throw new ClientError('STORAGE_FAILED');
    return new Promise((resolve, reject) => {
      const tx = db.transaction('bindings', 'readwrite', { durability: 'strict' }), store = tx.objectStore('bindings');
      if (value === undefined) store.delete(address); else store.put(value, address);
      tx.oncomplete = () => resolve();
      tx.onerror = tx.onabort = () => reject(new ClientError('STORAGE_FAILED'));
    });
  }
  set(namespace: string, key: string, value: string) { return this.mutate(namespace, key, value); }
  remove(namespace: string, key: string) { return this.mutate(namespace, key); }
  async removeIf(namespace:string,key:string,expected:string):Promise<void> {
    const address=this.address(namespace,key),db=await this.database;
    return new Promise((resolve,reject)=>{
      const tx=db.transaction('bindings','readwrite',{durability:'strict'}),store=tx.objectStore('bindings'),request=store.get(address);
      request.onsuccess=()=>{if(request.result===expected)store.delete(address);};
      tx.oncomplete=()=>resolve();tx.onerror=tx.onabort=()=>reject(new ClientError('STORAGE_FAILED'));
    });
  }
  async close() { (await this.database).close(); }
}
