import { createHash, randomUUID } from 'node:crypto';
import type { RemoteIndexArtifact } from '../packages/sync-core/src/remoteTasks.ts';
import type { RemoteRetrievalRequest, RemoteRetrievalSource } from '../packages/sync-core/src/remoteRetrieval.ts';
export const retrievalHash = (value:string|Uint8Array) => createHash('sha256').update(value).digest('hex');
export function retrievalFixture(texts = ['城乡 community urban design', 'Local urban study', '城乡日常生活']) {
  const chunks=texts.map((text,i)=>({id:'chunk-'+i,pageIndex:i%2,text,vector:[0.25,-0.5]}));
  const artifact:RemoteIndexArtifact={format:'paperquay-vector-index',version:1,paperId:randomUUID(),attachmentVersionId:randomUUID(),
    pdf:{sha256:'a'.repeat(64),sizeBytes:512,pageCount:2},parseDigest:'b'.repeat(64),model:'synthetic-embedding',
    chunker:{id:'parsed-v1',revision:1,digest:'c'.repeat(64)},dimension:2,chunkCount:chunks.length,contentHash:retrievalHash(JSON.stringify(chunks)),chunks};
  const bytes=Buffer.from(JSON.stringify(artifact));
  const source:RemoteRetrievalSource={taskId:randomUUID(),artifactDigest:retrievalHash(bytes),artifactBytes:bytes.length,
    target:{paperId:artifact.paperId,attachmentVersionId:artifact.attachmentVersionId,paperRevision:1,versionRevision:1,sha256:artifact.pdf.sha256,
      sizeBytes:512,pageCount:2,fileName:'synthetic.pdf'},parseDigest:artifact.parseDigest,model:artifact.model,dimension:2,chunker:artifact.chunker,
    chunkCount:chunks.length,contentHash:artifact.contentHash,textCharacters:texts.reduce((n,t)=>n+t.length,0)};
  const request:RemoteRetrievalRequest={version:1,requestId:randomUUID(),mode:'lexical-v1',query:'城乡 urban',topK:24,sources:[source]};
  return{artifact,source,request,bytes};
}
