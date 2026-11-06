import { useRef, useState, useSyncExternalStore } from 'react';
import { ClientError, describeError } from '../errors.ts';
import { planExternalLibraryImport } from '../library/externalLibrary.ts';
import { validateZoteroRefreshResult } from '../library/zoteroRefresh.ts';
import { zoteroSourceId, type ZoteroLibraryConfig } from '../library/zoteroClient.ts';
import type { AccountScope } from '../storage/accountStore.ts';
import type { SecretStore } from '../platform/secretStore.ts';
import { externalLibraryEntities, type WorkspaceController } from '../sync/workspace.ts';
import { ReaderSheet } from './ReaderSheet.tsx';
import { ZoteroRefreshPanel } from './ZoteroRefreshPanel.tsx';
import './zoteroRefresh.css';
interface Props {
  controller: WorkspaceController; scope: AccountScope; scopeKey: string; secretStore: SecretStore;
  accountCurrent(): boolean; onClose(): void;
}
export function ZoteroLibrarySheet(props: Props) {
  const state = useSyncExternalStore(props.controller.subscribe, props.controller.getSnapshot, props.controller.getSnapshot);
  const [config, setConfig] = useState<ZoteroLibraryConfig | undefined>(), [epoch, setEpoch] = useState(0), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const latest = useRef(props); latest.current = props;
  function current() {
    const p = latest.current, snapshot = p.controller.getSnapshot(), sync = snapshot.workspace?.sync;
    return p.accountCurrent() && snapshot.status === 'ready' && sync?.accountId === p.scope.accountId
      && JSON.stringify([sync.accountId,sync.deviceId,sync.generation]) === p.scopeKey;
  }
  return <ReaderSheet open title="Zotero 增量接入" onClose={props.onClose} className="zotero-library-sheet">
    <div className="pr-panel-content">
      <p>这里读取 Zotero 题录并逐项比较，明确采用后才更新 PaperQuay。来源映射与读取版本保存在此账号的本设备；题录按账号正常同步。不会修改 Zotero，也不会自动下载附件。</p>
      <div className="zotero-refresh-buttons"><button type="button" className="secondary" disabled={busy} onClick={() => { setConfig(undefined); setEpoch(value=>value+1); setError(''); }}>接入另一份文库</button></div>
      {!!state.workspace?.zoteroLibraries?.entries.length && <ul className="ai-sync-list" aria-label="本设备已保存的 Zotero 来源">
        {state.workspace.zoteroLibraries.entries.map(value => <li key={zoteroSourceId(value.config)}>
          <button type="button" className="text-button" disabled={busy} onClick={() => { setConfig(value.config); setEpoch(value=>value+1); setError(''); }}>{value.config.name} · {value.config.kind==='user'?'个人库':'群组库'} {value.config.libraryId} · 版本 {value.cursor??'待全量读取'}</button>
          <button type="button" className="text-button" disabled={busy} onClick={() => {
            if(!current())return;
            void props.controller.resetZoteroCursor(value.config).then(() => { if(current()){setConfig(value.config);setEpoch(number=>number+1);setError('');} }).catch(error=>{if(current())setError(describeError(error));});
          }}>下次重新全量读取此来源</button>
        </li>)}
      </ul>}
      {error&&<p role="alert" className="inline-error">{error}</p>}
      <ZoteroRefreshPanel key={`${props.scopeKey}:${config?zoteroSourceId(config):'new'}:${epoch}`} scopeKey={props.scopeKey} accountScope={props.scope}
        accountCurrent={current} secretStore={props.secretStore} initialConfig={config} onBusyChange={setBusy}
        getCursor={config => props.controller.getZoteroCursor(config)} paperLabel={id => {
          const workspace=props.controller.getSnapshot().workspace;
          const paper=workspace&&externalLibraryEntities(workspace).find(value=>value.entityType==='paper'&&value.entityId===id);
          return paper?.data&&'authors'in paper.data?paper.data.title:id.slice(0,8);
        }} preview={(result,decisions) => {
          if(!current())throw new ClientError('ACCOUNT_CHANGED');validateZoteroRefreshResult(result);
          const workspace=props.controller.getSnapshot().workspace!;
          if(props.controller.getZoteroCursor(result.config)!==result.expectedCursor)throw new ClientError('IMPORT_CHANGED');
          return planExternalLibraryImport(result.snapshot,workspace.externalLibraries,externalLibraryEntities(workspace),decisions);
        }} onAdopt={async(result,decisions,signature,scopeKey) => {
          if(!current())throw new ClientError('ACCOUNT_CHANGED');
          return props.controller.adoptZoteroRefresh(result,decisions,signature,scopeKey);
        }} />
    </div>
  </ReaderSheet>;
}
