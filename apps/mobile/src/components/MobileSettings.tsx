import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { Icon } from './Icon.tsx';

export type AccountSettingsPage = 'account' | 'sync' | 'storage';
type Page = 'home' | AccountSettingsPage | 'ai' | 'transfer' | 'tools';
type Action = () => void;
export interface SettingsActions {
  privacy?:Action;
  cloud?: Action;
  remote?: Action;
  capabilities: Action;
  agent?: Action;
  graph?: Action;
  zotero?: Action;
  incoming?: Action;
  export?: Action;
  research?: Action;
  review?: Action;
}
interface Props {
  displayName?: string;
  accountStatus: string;
  syncStatus: string;
  actions: SettingsActions;
  renderAccount(page: AccountSettingsPage): ReactNode;
  renderAi?: (onBack: Action) => ReactNode;
  openAi?: boolean;
  onAiOpened?: Action;
}

export function SettingsRow({ label, detail, icon, onClick, disabled = false }: {
  label: string;
  detail?: string;
  icon?: Parameters<typeof Icon>[0]['name'];
  onClick: Action;
  disabled?: boolean;
}) {
  const description = useId();
  return <button type="button" className="settings-row" aria-label={label} aria-describedby={detail ? description : undefined} onClick={onClick} disabled={disabled}>
    {icon && <span className="settings-row-icon"><Icon name={icon} /></span>}
    <span className="settings-row-copy"><span className="settings-row-label">{label}</span>
      {detail && <span id={description} className="settings-row-detail">{detail}</span>}
    </span>
    <Icon name="chevron" className="settings-row-chevron" />
  </button>;
}

export function MobileSettings(props: Props) {
  const [page, setPage] = useState<Page>('home');
  const heading = useRef<HTMLHeadingElement>(null);
  const previousPage = useRef(page);
  const go = (next: Page) => setPage(next);
  const titles: Record<Page, string> = {
    home: '设置', account: '账号与设备', sync: '同步与存储', storage: '本机存储',
    ai: 'AI 助手', transfer: '导入与导出', tools: '阅读工具',
  };
  useEffect(() => {
    if (previousPage.current === page) return;
    previousPage.current = page;
    heading.current?.focus({ preventScroll: true });
    heading.current?.closest('.main-content')?.scrollTo?.({ top: 0 });
  }, [page]);
  const a = props.actions;
  useEffect(() => {
    if (props.openAi && props.renderAi) { setPage('ai'); props.onAiOpened?.(); }
  }, [props.openAi, props.onAiOpened, props.renderAi]);
  return <div className="mobile-settings" data-settings-page={page}>
    {page === 'ai' && props.renderAi ? props.renderAi(() => go('home')) : <>
      <header className="settings-page-header">
        {page !== 'home' && <button type="button" className="settings-back" onClick={() => go(page === 'storage' ? 'sync' : 'home')}>
          <Icon name="back" />{page === 'storage' ? '同步与存储' : '设置'}
        </button>}
        <h1 tabIndex={-1} ref={heading}>{titles[page]}</h1>
      </header>
      {page === 'home' && <>
        <div className="settings-list settings-profile">
          <SettingsRow icon="account" label={props.displayName || '我的 PaperQuay'} detail={props.accountStatus} onClick={() => go('account')} />
        </div>
        <section className="settings-group" aria-label="常用设置">
          <div className="settings-list">
            {props.renderAi && <SettingsRow icon="sparkles" label="AI 助手" onClick={() => go('ai')} />}
            <SettingsRow icon="sync" label="同步与存储" detail={props.syncStatus} onClick={() => go('sync')} />
            <SettingsRow icon="transfer" label="导入与导出" onClick={() => go('transfer')} />
          </div>
        </section>
        <section className="settings-group" aria-label="更多">
          <div className="settings-list">
            <SettingsRow icon="library" label="阅读工具" onClick={() => go('tools')} />
            <SettingsRow icon="help" label="功能支持" onClick={a.capabilities} />
          </div>
        </section>
        <p className="settings-footer">PaperQuay</p>
      </>}
      {page === 'account' && <>{props.renderAccount('account')}{a.privacy&&<div className="settings-list"><SettingsRow icon="account" label="数据与隐私" detail="导出个人数据、注销应用账号" onClick={a.privacy}/></div>}</>}
      {page === 'sync' && <>
        {props.renderAccount('sync')}
        <div className="settings-list">
          {a.cloud && <SettingsRow icon="cloud" label="云端 PDF" detail="查看云端文件和剩余空间" onClick={a.cloud} />}
          <SettingsRow icon="device" label="本机存储" onClick={() => go('storage')} />
        </div>
      </>}
      {page === 'storage' && props.renderAccount('storage')}
      {page === 'transfer' && <div className="settings-list">
        {a.zotero && <SettingsRow icon="library" label="连接 Zotero" detail="导入已有的文献库" onClick={a.zotero} />}
        {a.incoming && <SettingsRow icon="plus" label="接收其他应用分享" onClick={a.incoming} />}
        {a.export && <SettingsRow icon="transfer" label="导出笔记与引用" onClick={a.export} />}
        {!a.zotero && !a.incoming && !a.export && <p className="settings-empty">当前环境暂不支持导入与导出。</p>}
      </div>}
      {page === 'tools' && <div className="settings-list">
        {a.research && <SettingsRow icon="sparkles" label="多篇文献问答" onClick={a.research} />}
        {a.review && <SettingsRow icon="note" label="文献综述" onClick={a.review} />}
        {a.graph && <SettingsRow icon="library" label="知识图谱" onClick={a.graph} />}
        {a.agent && <SettingsRow icon="check" label="智能整理文库" onClick={a.agent} />}
        {a.remote && <SettingsRow icon="device" label="用电脑处理文献" detail="解析 PDF，准备问答内容" onClick={a.remote} />}
      </div>}
    </>}
  </div>;
}
