import {sha256} from '@noble/hashes/sha2.js';
import type {AuthSubject} from './oidc.ts';

/** Matches the sync server's bounded sid claim contract. */
export const MAX_SESSION_ID_LENGTH=512;

/** An opaque, non-credential session discriminator. Never persist the raw SID. */
export function authSubject(profile:{iss?:unknown;sub?:unknown;sid?:unknown},authority:string):AuthSubject|null {
  if(profile.iss!==authority||typeof profile.sub!=='string'||!profile.sub||profile.sub.length>2048)return null;
  const sid=profile.sid;
  return {issuer:authority,subject:profile.sub,...(typeof sid==='string'&&sid.length>0&&sid.length<=MAX_SESSION_ID_LENGTH
    ?{sessionKey:Array.from(sha256(new TextEncoder().encode(JSON.stringify([authority,profile.sub,sid]))),byte=>byte.toString(16).padStart(2,'0')).join('')}: {})};
}
