import { useEffect, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { useLocaleText } from '../../../i18n/uiLanguage';

export default function LibrarySearchInput({ value, onChange }: {
  value: string;
  onChange: (value: string) => void;
}) {
  const l = useLocaleText();
  const [draft, setDraft] = useState(value);
  const composing = useRef(false);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (!composing.current) setDraft(value); }, [value]);
  const clear = () => {
    composing.current = false;
    setDraft('');
    onChange('');
    input.current?.focus();
  };
  return (
    <div className="relative min-w-[260px] flex-1">
      <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" strokeWidth={1.8} />
      <input
        ref={input}
        value={draft}
        aria-label={l('搜索文献', 'Search papers')}
        onChange={(event) => {
          setDraft(event.target.value);
          if (!composing.current) onChange(event.target.value);
        }}
        onCompositionStart={() => { composing.current = true; }}
        onCompositionEnd={(event) => {
          composing.current = false;
          setDraft(event.currentTarget.value);
          onChange(event.currentTarget.value);
        }}
        onBlur={(event) => {
          composing.current = false;
          onChange(event.currentTarget.value);
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && !composing.current && !event.nativeEvent.isComposing && event.keyCode !== 229) {
            event.preventDefault();
            clear();
          }
        }}
        placeholder={l('搜索标题、作者、摘要、DOI...', 'Search title, author, abstract, DOI...')}
        className="pq-input h-9 w-full pl-9 pr-9 text-sm placeholder:text-[var(--pq-text-faint)]"
      />
      {draft ? <button type="button" aria-label={l('清空搜索', 'Clear search')} title={l('清空搜索（Esc）', 'Clear search (Esc)')}
        onClick={clear} className="absolute right-1 top-1/2 flex h-7 w-7 -translate-y-1/2 items-center justify-center rounded-md text-[var(--pq-text-muted)] hover:bg-[var(--pq-accent-soft)]">
        <X className="h-4 w-4" strokeWidth={1.8} />
      </button> : null}
    </div>
  );
}
