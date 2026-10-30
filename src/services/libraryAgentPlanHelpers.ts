import {
  assignPaperToLibraryCategory,
  createLibraryCategory,
  listLibraryCategories,
  updateLibraryPaper,
} from './library';
import { lookupLiteratureMetadata } from './metadata';
import type {
  CreateCategoryRequest,
  LiteratureCategory,
  LiteraturePaper,
  UpdatePaperRequest,
} from '../types/library';
import type { MetadataLookupResult } from '../types/metadata';
import type {
  ApplyLibraryAgentPlanResult,
  LibraryAgentPlan,
  LibraryAgentPlanItem,
  RenameOperation,
} from './libraryAgent';
import { paperPdfPath as resolveLibraryPaperPdfPath } from '../utils/libraryPaper';

import { createAgentPlanCore } from '../../packages/agent-core/index.mjs';
const core = createAgentPlanCore();
const { newPlanId, metadataUpdateForPaper } = core;
const AUTO_CLASSIFY_PARENT_NAME = 'Agent 自动归类';
export const { normalizeComparable, stripKnownReadPrefix, normalizeAgentTagName, uniqueTags, paperAuthors, parseRenameCommand, buildRenamePlan, inferSmartTagsForPaper, inferCollectionNameForPaper, buildSmartTagPlan, buildCleanTagsPlan, buildAutoClassifyPlan } = core;


export function paperPdfPath(paper: LiteraturePaper): string | null {
  return resolveLibraryPaperPdfPath(paper);
}

export async function buildMetadataCompletionPlan(
  papers: LiteraturePaper[],
  onProgress?: (message: string) => void,
): Promise<LibraryAgentPlan> {
  const items: LibraryAgentPlanItem[] = [];

  for (const [index, paper] of papers.entries()) {
    onProgress?.(`正在补全元数据 ${index + 1}/${papers.length}: ${paper.title}`);

    const metadata = await lookupLiteratureMetadata({
      doi: paper.doi,
      title: paper.title,
      path: paperPdfPath(paper),
    });

    if (!metadata) {
      continue;
    }

    const updateRequest = metadataUpdateForPaper(paper, metadata);

    if (!updateRequest) {
      continue;
    }

    const changedFields = Object.keys(updateRequest).filter((key) => key !== 'paperId');

    items.push({
      id: `${paper.id}:metadata`,
      tool: 'metadata',
      paperId: paper.id,
      paperTitle: paper.title,
      title: '自动补全文献元数据',
      description: `来源：${metadata.source}；字段：${changedFields.join(', ')}`,
      before: [
        paper.title,
        paperAuthors(paper).join(', '),
        paper.year,
        paper.publication,
        paper.doi,
      ]
        .filter(Boolean)
        .join(' · '),
      after: [
        updateRequest.title ?? paper.title,
        updateRequest.authors?.join(', ') ?? paperAuthors(paper).join(', '),
        updateRequest.year ?? paper.year,
        updateRequest.publication ?? paper.publication,
        updateRequest.doi ?? paper.doi,
      ]
        .filter(Boolean)
        .join(' · '),
      updateRequest,
      metadataSource: metadata.source,
    });
  }

  return {
    id: newPlanId('metadata'),
    tool: 'metadata',
    title: '自动补全元数据',
    description: `识别到 ${items.length} 条可更新记录。`,
    items,
    createdAt: Date.now(),
  };
}

function categoryKey(name: string, parentId: string | null): string {
  return `${parentId ?? 'root'}::${normalizeComparable(name)}`;
}

async function ensureCategory(
  categories: LiteratureCategory[],
  request: CreateCategoryRequest,
): Promise<{ category: LiteratureCategory; categories: LiteratureCategory[] }> {
  const expectedKey = categoryKey(request.name, request.parentId ?? null);
  const existing = categories.find(
    (category) => categoryKey(category.name, category.parentId) === expectedKey,
  );

  if (existing) {
    return { category: existing, categories };
  }

  const category = await createLibraryCategory(request);

  return {
    category,
    categories: [...categories, category],
  };
}

export async function applyLibraryAgentPlan(
  plan: LibraryAgentPlan,
  itemIds: Set<string>,
): Promise<ApplyLibraryAgentPlanResult> {
  let applied = 0;
  let failed = 0;
  const errors: string[] = [];
  let categories = await listLibraryCategories();

  for (const item of plan.items) {
    if (!itemIds.has(item.id)) {
      continue;
    }

    try {
      if (item.updateRequest) {
        await updateLibraryPaper(item.updateRequest);
        applied += 1;
        continue;
      }

      if (item.tool === 'classify' && item.targetCategoryName) {
        const parentResult = await ensureCategory(categories, {
          name: item.targetCategoryParentName ?? AUTO_CLASSIFY_PARENT_NAME,
          parentId: null,
        });
        categories = parentResult.categories;

        const childResult = await ensureCategory(categories, {
          name: item.targetCategoryName,
          parentId: parentResult.category.id,
        });
        categories = childResult.categories;

        await assignPaperToLibraryCategory({
          paperId: item.paperId,
          categoryId: childResult.category.id,
        });
        applied += 1;
        continue;
      }
    } catch (error) {
      failed += 1;
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }

  return { applied, failed, errors };
}