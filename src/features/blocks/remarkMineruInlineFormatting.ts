import { normalizeExplicitMathSyntax, normalizeMarkdownMath } from '../../utils/markdown.ts';

interface MarkdownNode {
  type: string;
  value?: string;
  children?: MarkdownNode[];
  data?: { hName?: string };
}

function readInlineTag(node: MarkdownNode): { name: 'sup' | 'sub'; closing: boolean } | null {
  if (node.type !== 'html' || typeof node.value !== 'string') {
    return null;
  }

  const match = /^<\s*(\/?)\s*(sup|sub)\s*>$/i.exec(node.value.trim());

  return match
    ? { name: match[2].toLowerCase() as 'sup' | 'sub', closing: Boolean(match[1]) }
    : null;
}

function renderInlineTags(children: MarkdownNode[]): MarkdownNode[] {
  const rendered: MarkdownNode[] = [];

  for (let index = 0; index < children.length; index += 1) {
    const node = children[index];
    const opening = readInlineTag(node);

    if (opening && !opening.closing) {
      let depth = 1;
      let closingIndex = index + 1;

      for (; closingIndex < children.length; closingIndex += 1) {
        const tag = readInlineTag(children[closingIndex]);

        if (tag?.name !== opening.name) {
          continue;
        }

        depth += tag.closing ? -1 : 1;

        if (depth === 0) {
          break;
        }
      }

      if (depth === 0) {
        rendered.push({
          type: 'mineruInlineFormatting',
          data: { hName: opening.name },
          children: renderInlineTags(children.slice(index + 1, closingIndex)),
        });
        index = closingIndex;
        continue;
      }
    }

    if (node.children) {
      node.children = renderInlineTags(node.children);
    }

    rendered.push(node);
  }

  return rendered;
}

export function normalizeMineruReaderMarkdown(markdown: string): string {
  const tags: string[] = [];
  const explicitMathMarkdown = normalizeExplicitMathSyntax(markdown);
  const protectedMarkdown = explicitMathMarkdown.replace(/<\s*\/?\s*(?:sup|sub)\s*>/gi, (tag) => {
    const marker = `\uE200${tags.length}\uE201`;
    tags.push(tag);
    return marker;
  });

  return normalizeMarkdownMath(protectedMarkdown).replace(
    /\uE200(\d+)\uE201/g,
    (_marker, index: string) => tags[Number(index)] ?? '',
  );
}

// Only recognize MinerU's paired inline formatting tags. Other raw HTML stays literal.
export function remarkMineruInlineFormatting() {
  return (tree: unknown) => {
    const root = tree as MarkdownNode;

    if (root.children) {
      root.children = renderInlineTags(root.children);
    }
  };
}
