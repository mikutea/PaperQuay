import { Component, type ReactNode, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import type { Components } from 'react-markdown';
import rehypeKatex from 'rehype-katex';
import remarkGfm from 'remark-gfm';
import remarkMath from 'remark-math';
import 'katex/dist/katex.min.css';
import type { LibraryAgentRagCitation } from '../../services/libraryAgent';
import { normalizeMarkdownMath } from '../../utils/markdown';

class AgentMarkdownBoundary extends Component<
  {
    children: ReactNode;
    fallback: ReactNode;
    resetKey: string;
  },
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidUpdate(previousProps: { resetKey: string }) {
    if (previousProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

function AgentMarkdownFallback({ content }: { content: string }) {
  return (
    <pre className="whitespace-pre-wrap rounded-[var(--pq-radius-md)] border border-[var(--pq-border)] bg-[var(--pq-surface-2)] px-4 py-3 text-sm leading-7 text-[var(--pq-text-muted)]">
      {content}
    </pre>
  );
}

function protectBarePaperIds(content: string): string {
  const fenceParts = content.split(/(```[\s\S]*?```)/g);

  return fenceParts
    .map((part) => {
      if (part.startsWith('```')) {
        return part;
      }

      return part
        .split(/(`[^`\n]+`)/g)
        .map((inlinePart) => {
          if (inlinePart.startsWith('`') && inlinePart.endsWith('`')) {
            return inlinePart;
          }

          return inlinePart.replace(
            /(^|[^\w`])((?:paper|category)_[A-Za-z0-9_-]{8,})(?=$|[^\w`])/g,
            (_match, prefix: string, id: string) => `${prefix}\`${id}\``,
          );
        })
        .join('');
    })
    .join('');
}

function buildAgentCitationHref(label: string): string {
  return `#agent-cite-${encodeURIComponent(label)}`;
}

function normalizeAgentCitationHref(href: string): string {
  const trimmed = href.trim();

  if (trimmed.startsWith('#agent-cite-')) {
    return decodeURIComponent(trimmed.slice('#agent-cite-'.length));
  }

  if (trimmed.startsWith('%23agent-cite-')) {
    return decodeURIComponent(trimmed.slice('%23agent-cite-'.length));
  }

  return '';
}

function findCitationByHref(
  href: string | undefined,
  citations: LibraryAgentRagCitation[] | undefined,
): LibraryAgentRagCitation | null {
  if (!href || !citations?.length) {
    return null;
  }

  const label = normalizeAgentCitationHref(href);
  return citations.find((citation) => citation.label === label) ?? null;
}

function injectAgentCitationLinks(
  content: string,
  citations: LibraryAgentRagCitation[] | undefined,
): string {
  if (!citations?.length) {
    return content;
  }

  const labels = new Set(citations.map((citation) => citation.label));
  const normalizedContent = content
    .replace(/\[(\d+(?:\s*[,，、]\s*\d+)+)\]/g, (_match, group: string) =>
      group
        .split(/\s*[,，、]\s*/)
        .map((label) => `[${label}]`)
        .join(' '),
    )
    .replace(/\](?=\[\d+\])/g, '] ');

  return normalizedContent.replace(/\[(\d+)\](?!\()/g, (match, label: string) => {
    if (!labels.has(label)) {
      return match;
    }

    return `[${label}](${buildAgentCitationHref(label)})`;
  });
}

export default function AgentMarkdown({
  content,
  citations,
  onCitationClick,
}: {
  content: string;
  citations?: LibraryAgentRagCitation[];
  onCitationClick?: (citation: LibraryAgentRagCitation) => void;
}) {
  const normalizedContent = useMemo(() => {
    try {
      return protectBarePaperIds(normalizeMarkdownMath(injectAgentCitationLinks(content, citations)));
    } catch {
      return protectBarePaperIds(injectAgentCitationLinks(content, citations));
    }
  }, [citations, content]);
  const components = useMemo<Components>(
    () => ({
      a: ({ href, children, ...props }) => {
        const citation = findCitationByHref(href, citations);

        if (citation && onCitationClick) {
          return (
            <button
              type="button"
              onClick={() => onCitationClick(citation)}
              className="inline-flex items-center rounded-full border border-[var(--pq-accent-border)] bg-[var(--pq-accent-soft)] px-1.5 py-0.5 text-xs font-semibold text-[var(--pq-accent)] transition hover:border-[var(--pq-accent)] hover:bg-[var(--pq-surface)]"
              title={`${citation.paperTitle}${citation.pageIndex !== null && citation.pageIndex !== undefined ? ` · Page ${citation.pageIndex + 1}` : ''}`}
            >
              [{children}]
            </button>
          );
        }

        return (
          <a href={href} target="_blank" rel="noreferrer" {...props}>
            {children}
          </a>
        );
      },
    }),
    [citations, onCitationClick],
  );
  const fallback = <AgentMarkdownFallback content={content} />;

  return (
    <AgentMarkdownBoundary resetKey={normalizedContent} fallback={fallback}>
      <ReactMarkdown
        className={[
          'max-w-none text-[15px] leading-7 text-[var(--pq-text)]',
          '[&>*:first-child]:mt-0 [&>*:last-child]:mb-0',
          '[&_h1]:mb-3 [&_h1]:mt-5 [&_h1]:border-b [&_h1]:border-[var(--pq-border)] [&_h1]:pb-2 [&_h1]:text-2xl [&_h1]:font-semibold [&_h1]:tracking-tight [&_h1]:text-[var(--pq-text)]',
          '[&_h2]:mb-3 [&_h2]:mt-5 [&_h2]:text-xl [&_h2]:font-semibold [&_h2]:tracking-tight [&_h2]:text-[var(--pq-text)]',
          '[&_h3]:mb-2 [&_h3]:mt-4 [&_h3]:text-base [&_h3]:font-semibold [&_h3]:text-[var(--pq-text)]',
          '[&_p]:my-2 [&_p]:leading-7 [&_strong]:font-semibold [&_strong]:text-[var(--pq-text)] [&_em]:text-[var(--pq-text-muted)]',
          '[&_ul]:my-3 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-5 [&_ol]:my-3 [&_ol]:list-decimal [&_ol]:space-y-1.5 [&_ol]:pl-5 [&_li]:pl-1',
          '[&_blockquote]:my-4 [&_blockquote]:rounded-[var(--pq-radius-md)] [&_blockquote]:border [&_blockquote]:border-[var(--pq-border)] [&_blockquote]:bg-[var(--pq-surface-2)] [&_blockquote]:px-4 [&_blockquote]:py-3 [&_blockquote]:text-[var(--pq-text-muted)]',
          '[&_hr]:my-5 [&_hr]:border-[var(--pq-border)]',
          '[&_code]:rounded-md [&_code]:bg-[var(--pq-surface-2)] [&_code]:px-1.5 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.88em] [&_code]:text-[var(--pq-accent)]',
          '[&_pre]:my-4 [&_pre]:overflow-x-auto [&_pre]:rounded-[var(--pq-radius-md)] [&_pre]:border [&_pre]:border-[var(--pq-border)] [&_pre]:bg-[#111827] [&_pre]:p-4 [&_pre_code]:bg-transparent [&_pre_code]:p-0 [&_pre_code]:text-slate-100',
          '[&_a]:font-semibold [&_a]:text-[var(--pq-accent)] [&_a]:underline [&_a]:underline-offset-4',
          '[&_table]:my-4 [&_table]:w-full [&_table]:border-collapse [&_table]:overflow-hidden [&_table]:rounded-[var(--pq-radius-md)] [&_th]:border [&_th]:border-[var(--pq-border)] [&_th]:bg-[var(--pq-surface-2)] [&_th]:px-3 [&_th]:py-2 [&_th]:text-left [&_th]:font-semibold [&_td]:border [&_td]:border-[var(--pq-border)] [&_td]:px-3 [&_td]:py-2',
          '[&_.katex]:text-[var(--pq-text)] [&_.katex-display]:my-4 [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden [&_.katex-display]:py-2',
        ].join(' ')}
        remarkPlugins={[remarkGfm, remarkMath]}
        rehypePlugins={[[rehypeKatex, { strict: 'ignore', throwOnError: true }]]}
        components={components}
      >
        {normalizedContent}
      </ReactMarkdown>
    </AgentMarkdownBoundary>
  );
}
