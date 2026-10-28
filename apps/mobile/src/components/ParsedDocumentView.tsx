import { memo, useMemo } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import rehypeKatex from 'rehype-katex';
import katex from 'katex';
import type { ParsedBlock, ParsedDocumentPackage } from '../../../../packages/sync-core/src/parsedDocument.ts';

const mathOptions = { trust: false, maxExpand: 100, maxSize: 10, strict: 'error' as const, throwOnError: false };
const remarkPlugins = [remarkGfm, remarkMath];
const rehypePlugins: [typeof rehypeKatex, typeof mathOptions][] = [[rehypeKatex, mathOptions]];

function safeLink(value: string) {
  try { const url = new URL(value); return ['https:', 'http:', 'mailto:'].includes(url.protocol)
    && !url.username && !url.password ? url.href : ''; } catch { return ''; }
}

export const ParsedMarkdown = memo(function ParsedMarkdown({ text }: { text: string }) {
  return <div className="parsed-markdown"><Markdown remarkPlugins={remarkPlugins} rehypePlugins={rehypePlugins} skipHtml
    urlTransform={safeLink} components={{
      img: ({ alt }) => <span className="muted">[图片：{alt || '未附入解析包'}]</span>,
      a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{children}</a> : <span>{children}</span>,
    }}>{text}</Markdown></div>;
});

const Equation = memo(function Equation({ latex }: { latex: string }) {
  const markup = useMemo(() => {
    try { return katex.renderToString(latex, { ...mathOptions, displayMode: true, macros: {} }); }
    catch { return null; }
  }, [latex]);
  return markup ? <div className="parsed-equation" dangerouslySetInnerHTML={{ __html: markup }} />
    : <pre aria-label="公式原文">{latex}</pre>;
});

function ParsedTable({ block }: { block: ParsedBlock }) {
  const table = block.table!;
  const rows = (section: 'head' | 'body' | 'foot') => table.rows.filter((row) => row.section === section).map((row, index) => <tr key={index}>
    {row.cells.map((cell, cellIndex) => cell.header
      ? <th key={cellIndex} rowSpan={cell.rowSpan} colSpan={cell.colSpan}><ParsedMarkdown text={cell.text} /></th>
      : <td key={cellIndex} rowSpan={cell.rowSpan} colSpan={cell.colSpan}><ParsedMarkdown text={cell.text} /></td>)}
  </tr>);
  return <div className="parsed-table-scroll" role="region" aria-label={table.caption || '解析表格'} tabIndex={0}>
    <table>{table.caption && <caption><ParsedMarkdown text={table.caption} /></caption>}
      <thead>{rows('head')}</thead><tbody>{rows('body')}</tbody><tfoot>{rows('foot')}</tfoot></table>
  </div>;
}

const Block = memo(function Block({ block, imageUrl, onJump }: { block: ParsedBlock; imageUrl?: string; onJump(page: number): void }) {
  return <article className={`parsed-block parsed-${block.kind}`} data-block-id={block.id}>
    {block.kind === 'equation' && block.latex ? <Equation latex={block.latex} />
      : block.kind === 'table' && block.table ? <ParsedTable block={block} />
        : block.kind === 'image' ? imageUrl ? <img src={imageUrl} alt={block.text || block.caption || '解析插图'} loading="lazy" />
          : <p>图片未包含在此解析包中。{block.text}</p>
          : block.kind === 'heading' ? <h4><ParsedMarkdown text={block.markdown || block.text} /></h4>
            : <ParsedMarkdown text={block.markdown || block.text} />}
    {block.caption && block.caption !== block.table?.caption && <div className="parsed-caption"><ParsedMarkdown text={block.caption} /></div>}
    {block.footnote && <div className="parsed-footnote"><ParsedMarkdown text={block.footnote} /></div>}
    {block.sourceBlockId && <small className="muted">续接前文 / 表格</small>}
    <button type="button" className="parsed-jump" onClick={() => onJump(block.pageIndex)}>查看 PDF 第 {block.pageIndex + 1} 页</button>
  </article>;
});

export function ParsedDocumentView({ document, pageIndex, offset, urls, onJump }: {
  document: ParsedDocumentPackage; pageIndex: number; offset: number; urls: ReadonlyMap<string, string>;
  onJump(page: number): void;
}) {
  // Continuations may carry only sourceBlockId. Resolve content without moving
  // the continuation's identity or navigation target to the source page.
  const resolved = useMemo(() => {
    const originals = new Map(document.blocks.map((block) => [block.id, block]));
    const complete = new Map<string, ParsedBlock>();
    for (const block of document.blocks) {
      const chain: ParsedBlock[] = []; const seen = new Set<string>();
      let current: ParsedBlock | undefined = block;
      while (current && !complete.has(current.id) && !seen.has(current.id)) {
        seen.add(current.id); chain.push(current);
        current = current.sourceBlockId ? originals.get(current.sourceBlockId) : undefined;
      }
      for (let index = chain.length - 1; index >= 0; index--) {
        const own = chain[index], source = own.sourceBlockId ? complete.get(own.sourceBlockId) : undefined;
        complete.set(own.id, source ? { ...source, ...own, text: own.text || source.text,
          markdown: own.markdown || source.markdown, latex: own.latex || source.latex,
          table: own.table ?? source.table, assetId: own.assetId ?? source.assetId,
          caption: own.caption || source.caption, footnote: own.footnote || source.footnote,
        } : own);
      }
    }
    return document.blocks.map((block) => complete.get(block.id)!);
  }, [document]);
  const blocks = useMemo(() => resolved.filter((block) => block.pageIndex === pageIndex), [resolved, pageIndex]);
  return <div className="parsed-blocks" aria-label={`第 ${pageIndex + 1} 页解析内容`}>
    {blocks.length ? blocks.slice(offset, offset + 40).map((block) => <Block key={block.id} block={block}
      imageUrl={block.assetId ? urls.get(block.assetId) : undefined} onJump={onJump} />)
      : <p className="pr-muted">此页没有解析块，仍可查看 PDF 原页。</p>}
  </div>;
}
