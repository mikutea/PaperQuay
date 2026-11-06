import {sha256} from '@noble/hashes/sha2.js';
import {bytesToHex} from '@noble/hashes/utils.js';
import {canonicalJson} from '../../../../packages/sync-core/src/index.ts';
/** Synchronous SHA-256 keeps the exact source check inside the storage transaction. */
export function reviewFingerprint(value:unknown):string{return bytesToHex(sha256(new TextEncoder().encode(canonicalJson(value))));}
