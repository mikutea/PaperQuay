import {OidcClient,User,InMemoryWebStorage,WebStorageStateStore} from 'oidc-client-ts';
import type {AppConfig} from '../config.ts';
import {ClientError} from '../errors.ts';
import {MAX_SESSION_ID_LENGTH} from './subject.ts';

/** Refresh only the retained volatile session. Never call UserManager storage,
 * persist credentials, perform a new login, or accept a different OIDC SID. */
export async function erasureSession(config:AppConfig,user:User,protocol?:Pick<OidcClient,'useRefreshToken'>):Promise<User> {
  if((user.expires_in??0)>30||!user.refresh_token&&user.expired===false)return user;
  if(!user.refresh_token||typeof user.profile.sid!=='string'||!user.profile.sid||user.profile.sid.length>MAX_SESSION_ID_LENGTH)throw new ClientError('AUTH_REQUIRED');
  try {
    const client=protocol??new OidcClient({authority:config.oidcAuthority,client_id:config.oidcClientId,
      redirect_uri:config.redirectUri,response_type:'code',scope:user.scope,disablePKCE:false,
      loadUserInfo:false,requestTimeoutInSeconds:20,fetchRequestCredentials:'omit',
      stateStore:new WebStorageStateStore({store:new InMemoryWebStorage()})});
    const response=await client.useRefreshToken({state:{refresh_token:user.refresh_token,id_token:user.id_token,
      session_state:user.session_state,scope:user.scope,profile:user.profile}});
    const next=new User({...response,refresh_token:response.refresh_token??user.refresh_token,id_token:response.id_token??user.id_token});
    const audience=typeof next.profile.aud==='string'?[next.profile.aud]:next.profile.aud;
    if(next.expired!==false||next.profile.iss!==config.oidcAuthority||next.profile.iss!==user.profile.iss
      ||next.profile.sub!==user.profile.sub||next.profile.sid!==user.profile.sid
      ||!Array.isArray(audience)||!audience.includes(config.oidcClientId)
      ||audience.length>1&&next.profile.azp!==config.oidcClientId
      ||next.profile.azp!==undefined&&next.profile.azp!==config.oidcClientId
      ||typeof next.access_token!=='string'||!next.access_token||next.access_token.length>65536
      ||next.token_type?.toLowerCase()!=='bearer'
      ||next.refresh_token!==undefined&&(typeof next.refresh_token!=='string'||next.refresh_token.length>65536))throw new Error();
    return next;
  }catch{throw new ClientError('AUTH_REQUIRED');}
}
