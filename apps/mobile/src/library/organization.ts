import type { PaperData, PaperOrganization, VisibleEntity } from '../../../../packages/sync-core/src/index.ts';

export const readingStatusLabels = { unread: '未读', reading: '在读', read: '已读' } as const;
export function organizationOf(paper: PaperData): PaperOrganization {
  return paper.organization ?? { favorite: false, readingStatus: 'unread', tags: [], collections: [], queueRank: null };
}
export function normalizeOrganization(value: PaperOrganization): PaperOrganization {
  const names = (items: string[]) => [...new Set(items.map((item) => item.trim()).filter(Boolean))];
  return { ...value, tags: names(value.tags), collections: names(value.collections) };
}
export interface LibraryFilter {
  query: string;
  favorite: boolean;
  readingStatus: '' | PaperOrganization['readingStatus'];
  tag: string;
  collection: string;
  year: string;
  queued: boolean;
}
export function filterPapers(papers: VisibleEntity[], filter: LibraryFilter): VisibleEntity[] {
  const query = filter.query.trim().toLocaleLowerCase();
  const result = papers.filter((entity) => {
    if (entity.entityType !== 'paper') return false;
    if (!entity.data) return !query && !filter.favorite && !filter.readingStatus && !filter.tag && !filter.collection && !filter.year && !filter.queued;
    const paper = entity.data as PaperData;
    const org = organizationOf(paper);
    return (!filter.favorite || org.favorite) &&
      (!filter.readingStatus || org.readingStatus === filter.readingStatus) &&
      (!filter.tag || org.tags.includes(filter.tag)) &&
      (!filter.collection || org.collections.includes(filter.collection)) &&
      (!filter.year || paper.year === filter.year) &&
      (!filter.queued || org.queueRank !== null) &&
      (!query || [paper.title, ...paper.authors, ...paper.keywords, ...org.tags, ...org.collections,
        paper.year, paper.doi, paper.publication, paper.abstractText]
        .some((value) => value?.toLocaleLowerCase().includes(query)));
  });
  if (filter.queued) result.sort((a, b) => {
    const rankA = organizationOf(a.data as PaperData).queueRank!;
    const rankB = organizationOf(b.data as PaperData).queueRank!;
    return rankA - rankB || a.entityId.localeCompare(b.entityId);
  });
  return result;
}
