import type { PaperData, PaperOrganization } from '../../../../packages/sync-core/src/index.ts';
import { organizationOf, readingStatusLabels } from '../library/organization.ts';

export function PaperOrganizationFields({ paper, enabled, onChange }: {
  paper: PaperData; enabled: boolean; onChange: (value: PaperOrganization) => void;
}) {
  const value = organizationOf(paper);
  const edit = (update: Partial<PaperOrganization>) => onChange({ ...value, ...update });
  return <fieldset className="organization-fields" disabled={!enabled}>
    <legend>整理与阅读</legend>
    {!enabled && <p className="muted">同步服务启用书库分类后，即可编辑收藏、标签和队列。</p>}
    <div className="field-row">
      <label className="check-field"><input type="checkbox" checked={value.favorite}
        onChange={(event) => edit({ favorite: event.target.checked })} />收藏</label>
      <label className="field">阅读状态<select value={value.readingStatus}
        onChange={(event) => edit({ readingStatus: event.target.value as PaperOrganization['readingStatus'] })}>
        {Object.entries(readingStatusLabels).map(([key, label]) => <option key={key} value={key}>{label}</option>)}
      </select></label>
    </div>
    <label className="field">标签<input value={value.tags.join('; ')} maxLength={5184}
      placeholder="多个标签用分号分隔" onChange={(event) => edit({ tags: event.target.value.split(/[;；]/).map((item) => item.trimStart()) })} /></label>
    <label className="field">合集<input value={value.collections.join('; ')} maxLength={2592}
      placeholder="多个合集用分号分隔" onChange={(event) => edit({ collections: event.target.value.split(/[;；]/).map((item) => item.trimStart()) })} /></label>
    <label className="check-field"><input type="checkbox" checked={value.queueRank !== null}
      onChange={(event) => edit({ queueRank: event.target.checked ? Date.now() : null })} />加入阅读队列</label>
    {value.queueRank !== null && <label className="field">队列顺序（较小的排在前面）<input type="number" min={0} max={Number.MAX_SAFE_INTEGER}
      step={1} value={value.queueRank} onChange={(event) => {
        const rank = Number(event.target.value);
        if (Number.isSafeInteger(rank) && rank >= 0) edit({ queueRank: rank });
      }} /></label>}
  </fieldset>;
}
