import { parseAccountIdentity, type AccountIdentity } from '../api.ts';
import type { AuthSubject } from '../auth/oidc.ts';
import type { AppConfig } from '../config.ts';
import { ClientError } from '../errors.ts';
import type { SecretStore } from '../platform/secretStore.ts';
import { WebBindingStorage, type BindingStorage } from './verifiedBindingStorage.ts';

const queues=new WeakMap<BindingStorage,Map<string,Promise<unknown>>>();
function serialize<T>(storage:BindingStorage,address:string,action:()=>Promise<T>):Promise<T>{
  let entries=queues.get(storage);if(!entries){entries=new Map();queues.set(storage,entries);}
  const result=(entries.get(address)??Promise.resolve()).then(action),tail=result.catch(()=>undefined);entries.set(address,tail);
  void tail.then(()=>{if(entries!.get(address)===tail)entries!.delete(address);});return result;
}

/** Credentials stay in memory on Web; the independently verified mapping must
 * survive reload together with the IndexedDB payloads it permits us to erase. */
export function createVerifiedBinding(config: AppConfig, secrets: SecretStore, subject: () => AuthSubject | null,
  options: { indexedDB?: IDBFactory; databaseName?: string } = {}) {
  const storage = secrets.persistence === 'system' ? secrets : new WebBindingStorage(options);
  return { ...verifiedBinding(config, storage, subject),
    close: async () => { if (storage instanceof WebBindingStorage) await storage.close(); } };
}

/** This is a previously server-verified mapping, never a token-claim account id. */
export function verifiedBinding(config: AppConfig, secrets: BindingStorage, subject: () => AuthSubject | null) {
  const namespace = JSON.stringify(['verified-account-v1', config.apiBaseUrl, config.oidcAuthority, config.oidcClientId]);
  let recoveryRead:{key:string;raw:string}|null=null;
  const currentSubject = () => {
    const current = subject();
    if (!current || current.issuer !== config.oidcAuthority || !current.subject || current.subject.length > 2048)
      throw new ClientError('AUTH_REQUIRED');
    if(current.sessionKey!==undefined&&!/^[a-f0-9]{64}$/.test(current.sessionKey))throw new ClientError('AUTH_REQUIRED');
    return {...current};
  };
  const keyFor=(who:AuthSubject)=>JSON.stringify([namespace,who.subject,...(who.sessionKey?[who.sessionKey]:[])]);
  const check=(who:AuthSubject)=>{if(keyFor(currentSubject())!==keyFor(who))throw new ClientError('ACCOUNT_CHANGED');};
  const address = async (sub: string,sessionKey?:string) => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify([namespace, sub,...(sessionKey?['session',sessionKey]:[])])));
    return `paperquay-verified-account:${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('')}`;
  };
  const parse=(raw:string,who:AuthSubject,sessionOnly=false):AccountIdentity|null=>{
    try{
      const row=JSON.parse(raw);
      if(row.version!==1||row.subject!==who.subject||sessionOnly&&row.sessionKey!==who.sessionKey)return null;
      const identity=parseAccountIdentity(row.identity);return identity.device.revokedAt===null?identity:null;
    }catch{throw new ClientError('STORAGE_CORRUPT');}
  };
  const readSession=async():Promise<AccountIdentity|null>=>{
    const who=currentSubject();if(!who.sessionKey)return null;
    const raw=await secrets.get(await address(who.subject,who.sessionKey),'identity');check(who);
    return raw?parse(raw,who,true):null;
  };
  const removeIf=(at:string,expected:string)=>serialize(secrets,at,async()=>{
    if(secrets.removeIf)await secrets.removeIf(at,'identity',expected);
    else if(await secrets.get(at,'identity')===expected)await secrets.remove(at,'identity');
  });
  return {
    key: () => {
      const current = subject();
      return current?.issuer === config.oidcAuthority ? keyFor(current) : null;
    },
    readSession,
    async read(): Promise<AccountIdentity | null> {
      const who = currentSubject();
      const owned=await readSession();check(who);if(owned)return owned;
      // Subject recovery permits explicit local cleanup after a new login. It
      // never proves ownership of the original server erasure acknowledgement.
      const stored = await secrets.get(await address(who.subject), 'identity');check(who);
      if (!stored) return null;
      const identity=parse(stored,who);if(identity)recoveryRead={key:keyFor(who),raw:stored};return identity;
    },
    async write(identity: AccountIdentity): Promise<void> {
      const who = currentSubject();
      const verified = parseAccountIdentity(identity);
      if (verified.device.revokedAt !== null) throw new ClientError('SESSION_REVOKED');
      const raw=JSON.stringify({version:1,subject:who.subject,...(who.sessionKey?{sessionKey:who.sessionKey}:{}),identity:verified});
      if(who.sessionKey){const at=await address(who.subject,who.sessionKey);check(who);
        await serialize(secrets,at,async()=>{check(who);await secrets.set(at,'identity',raw);});check(who);}
      const at=await address(who.subject);check(who);
      await serialize(secrets,at,async()=>{check(who);await secrets.set(at,'identity',raw);});check(who);
    },
    async remove(): Promise<void> {
      const who=currentSubject(),at=await address(who.subject);check(who);
      const ownAt=who.sessionKey?await address(who.subject,who.sessionKey):at;check(who);
      const own=await secrets.get(ownAt,'identity');check(who);
      const expected=own??(recoveryRead?.key===keyFor(who)?recoveryRead.raw:null);
      if(own){await removeIf(ownAt,own);check(who);}
      if(expected&&ownAt!==at){await removeIf(at,expected);check(who);}
      recoveryRead=null;
    },
  };
}
