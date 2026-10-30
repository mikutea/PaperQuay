import{sha256}from'@noble/hashes/sha2.js';import{bytesToHex}from'@noble/hashes/utils.js';
import{createRadarCore}from'../../../../packages/radar-core/index.cjs';
export type * from '../../../../packages/radar-core/types.ts';
export const radarHash=(value:string)=>bytesToHex(sha256(new TextEncoder().encode(value)));
export const radarCore=createRadarCore({hash:value=>radarHash(value).slice(0,24),randomUUID:()=>crypto.randomUUID()});
