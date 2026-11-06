import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

export function MarkdownPreview({ body }: { body: string }) {
  return <div className="markdown-preview" aria-label="Markdown 预览"><Markdown remarkPlugins={[remarkGfm]} skipHtml
    urlTransform={(value) => {
      try {
        const url = new URL(value);
        return ['https:', 'http:', 'mailto:'].includes(url.protocol) && !url.username && !url.password ? url.href : '';
      } catch { return ''; }
    }} components={{
      // A note can contain untrusted links; preview never initiates image requests.
      img: ({ alt }) => <span className="muted">[图片：{alt || '未命名'}]</span>,
      a: ({ href, children }) => href ? <a href={href} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer">{children}</a> : <span>{children}</span>,
    }}>{body || '（正文为空）'}</Markdown></div>;
}
