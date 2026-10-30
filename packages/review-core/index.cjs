'use strict';
/** Shared review business and Word core. No filesystem, Electron, credential or network access.
 * Runtime adapters are supplied by desktop or the mobile export path. */
function createReviewCore(adapters = {}) {
const cleanString = value => typeof value === 'string' ? value.trim() : '';
const { PizZip, Docxtemplater, temml, mathml2omml, DOMParser } = adapters;
const binaryType = adapters.binaryType || 'uint8array';
const warn = adapters.warn || (() => {});
const readReviewFigureImageForDocx = adapters.readFigure || (async () => { throw new Error('Figure bytes are unavailable'); });
function imageTargetPath(target) {
 if (adapters.imageTargetPath) return adapters.imageTargetPath(target);
 const joined = 'word/' + target.replace(/\\/g, '/'), parts=[];
 for (const part of joined.split('/')) { if (!part || part==='.') continue; if (part==='..' && parts.length && parts[parts.length-1]!=='..') parts.pop(); else if(part!=='.') parts.push(part); }
 const result=parts.join('/')||'.'; return joined.endsWith('/')&&result!=='.'?result+'/':result;
}
const view = value => new DataView(value.buffer,value.byteOffset,value.byteLength);
const readU32BE=(value,offset)=>view(value).getUint32(offset,false);
const readU16BE=(value,offset)=>view(value).getUint16(offset,false);
const readU16LE=(value,offset)=>view(value).getUint16(offset,true);
const REVIEW_CONTEXT_SUMMARY_CHAR_LIMIT = 700;

const REVIEW_TASK_CONTEXT_CHAR_LIMIT = 1400;

const REVIEW_MAX_SECTION_COUNT = 6;

const REVIEW_MAX_CONTEXT_PER_TASK = 4;

const REVIEW_MAX_PARAGRAPHS_PER_SECTION = 4;

const REVIEW_MAX_FIGURES_PER_REVIEW = 6;

const REVIEW_MAX_FIGURES_PER_SOURCE = 6;

const REVIEW_WRITING_CONCURRENCY = 3;

const REVIEW_MAX_WRITING_CONCURRENCY = 8;

const REVIEW_FIGURE_MARKER_PREFIX = '__PAPERQUAY_REVIEW_FIGURE_';

const REVIEW_FIGURE_ANCHOR_PATTERN = /\[\s*(?:Image|Figure|Fig\.?|图|图片|插图)\s*(?::|#|编号|ID)?\s*([A-Za-z0-9_-]+)\s*]/gi;

const WORD_EMU_PER_INCH = 914400;

const WORD_ASSUMED_IMAGE_DPI = 96;

const WORD_EMU_PER_PIXEL = Math.round(WORD_EMU_PER_INCH / WORD_ASSUMED_IMAGE_DPI);

const REVIEW_SECTION_TITLES = {
  zh: {
    abstract: '摘要',
    keywordsLabel: '关键词：',
    intent: '写作意图',
    thesis: '核心观点',
    introduction: '引言',
    body: '正文综述',
    figures: '图表',
    figureLabel: '图',
    figureMissing: '图片加载失败',
    comparison: '比较分析',
    gaps: '研究不足',
    future: '未来方向',
    conclusion: '结论',
    references: '参考文献',
  },
  en: {
    abstract: 'Abstract',
    keywordsLabel: 'Keywords: ',
    intent: 'Writing Intent',
    thesis: 'Core Thesis',
    introduction: 'Introduction',
    body: 'Literature Review',
    figures: 'Figures',
    figureLabel: 'Figure',
    figureMissing: 'Figure unavailable',
    comparison: 'Comparative Analysis',
    gaps: 'Research Gaps',
    future: 'Future Directions',
    conclusion: 'Conclusion',
    references: 'References',
  },
};

function isEnglishReviewOutput(outputLanguage) {
  return /english|^en\b|^en[-_]/i.test(cleanString(outputLanguage));
}

function reviewSectionTitles(outputLanguage) {
  return isEnglishReviewOutput(outputLanguage) ? REVIEW_SECTION_TITLES.en : REVIEW_SECTION_TITLES.zh;
}

function normalizeReviewJsonDraft(value) {
  const draft = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const stringArray = (items) =>
    Array.isArray(items) ? items.map((item) => cleanString(item)).filter(Boolean) : [];
  const sourceIds = new Set(
    Array.isArray(draft.sources)
      ? draft.sources.map((source) => cleanString(source?.id)).filter(Boolean)
      : [],
  );

  return {
    title: cleanString(draft.title),
    abstract: stripReviewImagePlaceholders(draft.abstract),
    keywords: stringArray(draft.keywords),
    intentSummary: stripReviewImagePlaceholders(draft.intentSummary),
    thesis: stripReviewImagePlaceholders(draft.thesis),
    introduction: stripReviewImagePlaceholders(draft.introduction),
    sections: Array.isArray(draft.sections)
      ? draft.sections.map((section, index) => ({
          id: cleanString(section?.id) || `section-${index + 1}`,
          heading: cleanString(section?.heading) || `Section ${index + 1}`,
          content: stripReviewImagePlaceholders(section?.content),
          citations: stringArray(section?.citations).filter((id) => sourceIds.size === 0 || sourceIds.has(id)),
        })).filter((section) => section.heading || section.content)
      : [],
    comparisonTable: Array.isArray(draft.comparisonTable)
      ? draft.comparisonTable.map((row) => ({
          theme: cleanString(row?.theme),
          papers: stringArray(row?.papers).filter((id) => sourceIds.size === 0 || sourceIds.has(id)),
          conclusion: stripReviewImagePlaceholders(row?.conclusion),
        })).filter((row) => row.theme || row.conclusion || row.papers.length > 0)
      : [],
    researchGaps: stringArray(draft.researchGaps).map(stripReviewImagePlaceholders).filter(Boolean),
    futureDirections: stringArray(draft.futureDirections).map(stripReviewImagePlaceholders).filter(Boolean),
    conclusion: stripReviewImagePlaceholders(draft.conclusion),
    references: Array.isArray(draft.references)
      ? draft.references.map((reference) => ({
          id: cleanString(reference?.id),
          title: cleanString(reference?.title),
          authors: cleanString(reference?.authors),
          year: cleanString(reference?.year),
          journal: cleanString(reference?.journal || reference?.publication || reference?.venue),
          pages: cleanString(reference?.pages),
          doi: cleanString(reference?.doi),
        })).filter((reference) => reference.id || reference.title)
      : [],
    sources: Array.isArray(draft.sources)
      ? draft.sources.map((source) => ({
          id: cleanString(source?.id),
          title: cleanString(source?.title),
          sourceType: cleanString(source?.sourceType),
          relevance: cleanString(source?.relevance),
        })).filter((source) => source.id || source.title)
      : [],
    figures: normalizeReviewFigures(draft.figures || draft.selectedFigures, '').slice(0, REVIEW_MAX_FIGURES_PER_REVIEW),
  };
}

function truncateReviewText(value, maxLength) {
  const text = cleanString(value).replace(/\n{3,}/g, '\n\n').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function stringArrayValue(items) {
  if (Array.isArray(items)) {
    return items.map((item) => cleanString(item)).filter(Boolean);
  }

  const text = cleanString(items);
  return text ? [text] : [];
}

function stripReviewImagePlaceholders(value) {
  return cleanString(value)
    .replace(/!\[[^\]]*]\([^)]*\)/g, '')
    .replace(/(?:^|\n)\s*(?:Image|Figure)\s*#?\s*\d+\s*:\s*(?=\n|$)/gi, '\n')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeOptionalNumber(value) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? Math.max(0, Math.floor(numeric)) : undefined;
}

function normalizeReviewFigures(items, defaultSourceId = '') {
  const defaultId = normalizeReferenceId(defaultSourceId);

  return (Array.isArray(items) ? items : [])
    .map((item, index) => {
      const sourceId = normalizeReferenceId(
        item?.sourceId ||
        item?.paperSourceId ||
        item?.source ||
        defaultId,
      );
      const id = cleanString(item?.id) || (sourceId ? `${sourceId}-F${index + 1}` : `F${index + 1}`);

      return {
        id,
        sourceId,
        title: cleanString(item?.title),
        sourceTitle: cleanString(item?.sourceTitle),
        caption: cleanString(item?.caption || item?.captionText || item?.description),
        path: cleanString(item?.path || item?.assetPath || item?.localPath),
        pageIndex: normalizeOptionalNumber(item?.pageIndex),
        blockId: cleanString(item?.blockId),
        kind: cleanString(item?.kind || item?.type) || 'image',
        placement: cleanString(item?.placement),
        reason: cleanString(item?.reason),
      };
    })
    .filter((figure) => figure.id && (figure.caption || figure.path || figure.title));
}

function normalizeReviewContextItems(items) {
  return (Array.isArray(items) ? items : [])
    .map((item, index) => {
      const id = cleanString(item?.id) || `S${index + 1}`;
      return {
        id,
        sourceType: cleanString(item?.sourceType) || 'paper',
        title: cleanString(item?.title) || id,
        authors: cleanString(item?.authors),
        year: cleanString(item?.year),
        journal: cleanString(item?.journal || item?.publication || item?.venue),
        pages: cleanString(item?.pages),
        doi: cleanString(item?.doi),
        text: cleanString(item?.text),
        paperId: cleanString(item?.paperId),
        noteId: cleanString(item?.noteId),
        score: Number.isFinite(item?.score) ? item.score : 0,
        figures: normalizeReviewFigures(item?.figures, id).slice(0, REVIEW_MAX_FIGURES_PER_SOURCE),
      };
    })
    .filter((item) => item.id && (item.title || item.text));
}

function reviewContextForPrompt(item, maxLength) {
  return {
    id: item.id,
    sourceType: item.sourceType,
    title: item.title,
    authors: item.authors,
    year: item.year,
    doi: item.doi,
    text: truncateReviewText(item.text, maxLength),
    figures: (item.figures || []).map((figure) => ({
      id: figure.id,
      sourceId: figure.sourceId || item.id,
      kind: figure.kind,
      page: typeof figure.pageIndex === 'number' ? figure.pageIndex + 1 : undefined,
      caption: truncateReviewText(figure.caption || figure.title, 220),
    })),
  };
}

function normalizeEvidenceIds(value, validIds, fallbackIds = []) {
  const rawItems = Array.isArray(value)
    ? value
    : cleanString(value)
      ? cleanString(value).split(/[\s,;，；]+/)
      : [];
  const normalized = [];
  const seen = new Set();

  for (const rawItem of rawItems) {
    const id = normalizeReferenceId(rawItem);
    if (!id || !validIds.has(id) || seen.has(id)) {
      continue;
    }

    seen.add(id);
    normalized.push(id);
  }

  if (normalized.length > 0) {
    return normalized.slice(0, REVIEW_MAX_CONTEXT_PER_TASK);
  }

  return fallbackIds.filter((id) => validIds.has(id)).slice(0, REVIEW_MAX_CONTEXT_PER_TASK);
}

function defaultReviewEvidenceIds(contextItems, maxCount = REVIEW_MAX_CONTEXT_PER_TASK) {
  return contextItems
    .map((item) => normalizeReferenceId(item.id))
    .filter(Boolean)
    .slice(0, maxCount);
}

function normalizeReviewSectionHeading(section, index) {
  const rawHeading = cleanString(section?.heading) || cleanString(section?.title);
  return rawHeading || `Section ${index + 1}`;
}

function normalizeBlueprintTask(value, fallbackTask, validIds, fallbackIds) {
  const item = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const task =
    cleanString(item.task) ||
    cleanString(item.instruction) ||
    cleanString(item.writingTask) ||
    cleanString(item.description) ||
    cleanString(value) ||
    fallbackTask;

  return {
    task,
    evidenceIds: normalizeEvidenceIds(
      item.evidenceIds || item.sourceIds || item.citations || item.papers,
      validIds,
      fallbackIds,
    ),
    retrievalNotes:
      cleanString(item.retrievalNotes) ||
      cleanString(item.sourceFocus) ||
      cleanString(item.query) ||
      '',
    keyEvidence: stringArrayValue(item.keyEvidence || item.claims || item.mustUse).slice(0, 8),
    target: cleanString(item.target || item.targetLength || item.expectedLength),
  };
}

function normalizeSectionParagraphTasks(section, sectionTask, validIds, fallbackIds) {
  const taskFallbackIds = Array.isArray(sectionTask.evidenceIds) && sectionTask.evidenceIds.length > 0
    ? sectionTask.evidenceIds
    : fallbackIds;
  const rawTasks = Array.isArray(section?.paragraphTasks)
    ? section.paragraphTasks
    : Array.isArray(section?.paragraphs)
      ? section.paragraphs
      : Array.isArray(section?.tasks)
        ? section.tasks
        : [];
  const normalizedTasks = rawTasks
    .map((item, index) => ({
      id: cleanString(item?.id) || `paragraph-${index + 1}`,
      ...normalizeBlueprintTask(
        item,
        `${sectionTask.task} Write paragraph ${index + 1} for this section.`,
        validIds,
        taskFallbackIds,
      ),
    }))
    .filter((item) => item.task)
    .slice(0, REVIEW_MAX_PARAGRAPHS_PER_SECTION);

  if (normalizedTasks.length > 0) {
    return normalizedTasks;
  }

  return [{
    id: 'paragraph-1',
    ...normalizeBlueprintTask(
      {},
      sectionTask.task,
      validIds,
      taskFallbackIds,
    ),
  }];
}

function referenceFromContextItem(item) {
  return {
    id: item.id,
    title: item.title,
    authors: item.authors,
    year: item.year,
    journal: item.journal,
    pages: item.pages,
    doi: item.doi,
  };
}

function sourceFromContextItem(item, relevance = '') {
  return {
    id: item.id,
    title: item.title,
    sourceType: item.sourceType,
    relevance: cleanString(relevance) || truncateReviewText(item.text, 180),
  };
}

function collectReviewFiguresFromContext(contextItems) {
  const figures = [];
  const seenIds = new Set();

  for (const item of contextItems || []) {
    const sourceId = normalizeReferenceId(item.id);

    for (const figure of item.figures || []) {
      const id = cleanString(figure.id);
      const normalizedFigureId = id.toUpperCase();

      if (!id || seenIds.has(normalizedFigureId)) {
        continue;
      }

      seenIds.add(normalizedFigureId);
      figures.push({
        ...figure,
        id,
        sourceId: normalizeReferenceId(figure.sourceId) || sourceId,
        sourceTitle: cleanString(figure.sourceTitle) || item.title,
      });
    }
  }

  return figures;
}

function normalizeSelectedReviewFigures(value, contextItems) {
  const available = collectReviewFiguresFromContext(contextItems);
  const byId = new Map(available.map((figure) => [figure.id.toUpperCase(), figure]));
  const rawFigures = Array.isArray(value) ? value : [];
  const selected = [];
  const seenIds = new Set();

  for (const rawFigure of rawFigures) {
    const requestedId = cleanString(
      rawFigure?.id ||
      rawFigure?.figureId ||
      rawFigure?.assetId,
    ).toUpperCase();
    const figure = byId.get(requestedId);

    if (!figure || seenIds.has(figure.id.toUpperCase())) {
      continue;
    }

    seenIds.add(figure.id.toUpperCase());
    selected.push({
      ...figure,
      title: cleanString(rawFigure?.title) || figure.title,
      caption: cleanString(rawFigure?.caption || rawFigure?.captionText) || figure.caption,
      placement: cleanString(rawFigure?.placement || rawFigure?.sectionId),
      reason: cleanString(rawFigure?.reason || rawFigure?.rationale),
    });
  }

  return selected.slice(0, REVIEW_MAX_FIGURES_PER_REVIEW);
}

function defaultReviewFiguresFromContext(contextItems, preferredSourceIds = []) {
  const available = collectReviewFiguresFromContext(contextItems);
  if (available.length === 0) {
    return [];
  }

  const preferred = new Set(preferredSourceIds.map(normalizeReferenceId).filter(Boolean));
  const ordered = [
    ...available.filter((figure) => preferred.has(normalizeReferenceId(figure.sourceId))),
    ...available.filter((figure) => !preferred.has(normalizeReferenceId(figure.sourceId))),
  ];
  const selected = [];
  const seenIds = new Set();

  for (const figure of ordered) {
    const id = cleanString(figure.id);
    const normalizedId = id.toUpperCase();
    if (!id || seenIds.has(normalizedId)) {
      continue;
    }

    seenIds.add(normalizedId);
    selected.push({
      ...figure,
      placement: cleanString(figure.placement),
      reason: cleanString(figure.reason) || 'Automatically included from retrieved visual evidence.',
    });

    if (selected.length >= REVIEW_MAX_FIGURES_PER_REVIEW) {
      break;
    }
  }

  return selected;
}

function reviewFiguresForPrompt(contextItems) {
  return collectReviewFiguresFromContext(contextItems)
    .slice(0, REVIEW_MAX_FIGURES_PER_REVIEW * REVIEW_MAX_CONTEXT_PER_TASK)
    .map((figure) => ({
      id: figure.id,
      sourceId: figure.sourceId,
      sourceTitle: figure.sourceTitle,
      kind: figure.kind,
      page: typeof figure.pageIndex === 'number' ? figure.pageIndex + 1 : undefined,
      caption: truncateReviewText(figure.caption || figure.title, 260),
    }));
}

function normalizeReviewBlueprint(value, options = {}) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const contextItems = normalizeReviewContextItems(options.contextItems);
  const validIds = new Set(contextItems.map((item) => normalizeReferenceId(item.id)));
  const fallbackIds = defaultReviewEvidenceIds(contextItems, 4);
  const title =
    cleanString(raw.title) ||
    cleanString(options.intent).split(/\r?\n/)[0] ||
    'Literature Review';
  const fallbackSectionTask =
    'Draft one evidence-grounded body section for a research synthesis note. Follow the planned analytical flow, compare methods where supported, and cite internal source IDs.';

  let sections = (Array.isArray(raw.sections) ? raw.sections : [])
    .map((section, index) => {
      const normalizedTask = normalizeBlueprintTask(
        section,
        fallbackSectionTask,
        validIds,
        fallbackIds,
      );

      return {
        id: cleanString(section?.id) || `section-${index + 1}`,
        heading: normalizeReviewSectionHeading(section, index),
        ...normalizedTask,
        paragraphTasks: normalizeSectionParagraphTasks(section, normalizedTask, validIds, fallbackIds),
      };
    })
    .filter((section) => section.heading || section.task)
    .slice(0, REVIEW_MAX_SECTION_COUNT);

  if (sections.length === 0) {
    sections = [{
      id: 'section-1',
      heading: 'Section 1',
      ...(() => {
        const task = normalizeBlueprintTask({}, fallbackSectionTask, validIds, fallbackIds);
        return {
          ...task,
          paragraphTasks: normalizeSectionParagraphTasks({}, task, validIds, fallbackIds),
        };
      })(),
    }];
  }

  const comparisonTable = (Array.isArray(raw.comparisonTable) ? raw.comparisonTable : [])
    .map((row, index) => ({
      id: cleanString(row?.id) || `comparison-${index + 1}`,
      theme: cleanString(row?.theme) || cleanString(row?.heading) || `Comparison ${index + 1}`,
      ...normalizeBlueprintTask(
        row,
        'Compare the selected sources and write a concise synthesis for this comparison theme.',
        validIds,
        fallbackIds,
      ),
    }))
    .filter((row) => row.theme || row.task)
    .slice(0, 4);
  const researchGaps = (Array.isArray(raw.researchGaps) ? raw.researchGaps : [])
    .map((item, index) => ({
      id: `gap-${index + 1}`,
      ...normalizeBlueprintTask(
        item,
        'Identify an evidence-grounded research gap without inventing unsupported claims.',
        validIds,
        fallbackIds,
      ),
    }))
    .slice(0, 5);
  const futureDirections = (Array.isArray(raw.futureDirections) ? raw.futureDirections : [])
    .map((item, index) => ({
      id: `future-${index + 1}`,
      ...normalizeBlueprintTask(
        item,
        'Propose an evidence-grounded future research direction.',
        validIds,
        fallbackIds,
      ),
    }))
    .slice(0, 5);
  const selectedFigures = normalizeSelectedReviewFigures(
    raw.figures || raw.selectedFigures || raw.figureSelections,
    contextItems,
  );
  const preferredFigureSourceIds = [
    ...sections.flatMap((section) => section.evidenceIds || []),
    ...comparisonTable.flatMap((row) => row.evidenceIds || []),
    ...researchGaps.flatMap((gap) => gap.evidenceIds || []),
    ...futureDirections.flatMap((direction) => direction.evidenceIds || []),
  ];

  return {
    title,
    keywords: stringArrayValue(raw.keywords).slice(0, 8),
    intentSummary: cleanString(raw.intentSummary) || cleanString(options.intent),
    thesis: cleanString(raw.thesis) || 'The review should synthesize retrieved evidence into a coherent research narrative.',
    abstractTask: normalizeBlueprintTask(
      raw.abstractTask || raw.abstract,
      'Draft a concise abstract-style summary after all sections are generated.',
      validIds,
      fallbackIds,
    ),
    introductionTask: normalizeBlueprintTask(
      raw.introductionTask || raw.introduction,
      'Draft the opening context by defining the topic boundary, research background, and synthesis logic.',
      validIds,
      fallbackIds,
    ),
    sections,
    comparisonTable,
    researchGaps,
    futureDirections,
    conclusionTask: normalizeBlueprintTask(
      raw.conclusionTask || raw.conclusion,
      'Draft the closing synthesis by summarizing the major evidence-backed findings and implications.',
      validIds,
      fallbackIds,
    ),
    references: (Array.isArray(raw.references) ? raw.references : [])
      .map((reference) => ({
        id: normalizeReferenceId(reference?.id),
        title: cleanString(reference?.title),
        authors: cleanString(reference?.authors),
        year: cleanString(reference?.year),
        journal: cleanString(reference?.journal || reference?.publication || reference?.venue),
        pages: cleanString(reference?.pages),
        doi: cleanString(reference?.doi),
      }))
      .filter((reference) => reference.id),
    sources: (Array.isArray(raw.sources) ? raw.sources : [])
      .map((source) => ({
        id: normalizeReferenceId(source?.id),
        title: cleanString(source?.title),
        sourceType: cleanString(source?.sourceType),
        relevance: cleanString(source?.relevance),
      }))
      .filter((source) => source.id),
    figures: selectedFigures.length > 0
      ? selectedFigures
      : defaultReviewFiguresFromContext(contextItems, preferredFigureSourceIds),
  };
}

function normalizeReviewWritingConcurrency(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return REVIEW_WRITING_CONCURRENCY;
  }

  return Math.max(1, Math.min(REVIEW_MAX_WRITING_CONCURRENCY, Math.trunc(numeric)));
}

function reviewWritingTaskCount(blueprint) {
  return (
    3 +
    blueprint.sections.reduce((count, section) => count + Math.max(1, (section.paragraphTasks || []).length), 0) +
    blueprint.comparisonTable.length +
    blueprint.researchGaps.length +
    blueprint.futureDirections.length
  );
}

function buildReviewBlueprintPrompt(options) {
  const outputLanguage = cleanString(options.outputLanguage) || 'the same language as the user intent';
  const contextItems = normalizeReviewContextItems(options.contextItems);
  const blueprintExample = {
    title: 'Retrieval-Augmented Scholarly Reading: Foundations, Workflows, and Research Agenda',
    keywords: ['retrieval-augmented generation', 'scholarly reading', 'literature review'],
    intentSummary: 'The user asks for a rigorous academic review that synthesizes retrieved papers and notes into a coherent research narrative.',
    thesis: 'Retrieval-augmented scholarly reading should be analyzed as an evidence-grounded workflow that connects document parsing, semantic retrieval, interactive annotation, and synthesis support.',
    abstractTask: {
      task: 'Write a concise abstract after the body sections are generated, summarizing the research scope, organizing framework, major synthesis points, and open problems.',
      evidenceIds: ['P1', 'P2'],
      retrievalNotes: 'Use P1 for the research background and P2 for the workflow comparison.',
      keyEvidence: ['P1 motivates retrieval-grounded reading.', 'P2 compares annotation and retrieval workflows.'],
      target: 'one paragraph',
    },
    introductionTask: {
      task: 'Introduce the research problem, define the review boundary, explain why synthesis is needed, and preview the analytical structure.',
      evidenceIds: ['P1'],
      retrievalNotes: 'Use P1 for the problem setting and cite it when stating the need for retrieval-grounded reading.',
      keyEvidence: ['P1 frames scholarly reading as a multi-step evidence use problem.'],
      target: '2-3 paragraphs',
    },
    sections: [
      {
        id: 'section-1',
        heading: 'Conceptual Foundations and Review Scope',
        task: 'Define the core concepts, delimit the review scope, and explain how this section establishes the conceptual basis for later taxonomy and comparison.',
        evidenceIds: ['P1', 'P2'],
        retrievalNotes: 'Use selected evidence to define concepts, establish boundaries, and prepare the reader for later taxonomy and comparison sections.',
        keyEvidence: ['Evidence point from P1.', 'Evidence point from P2.'],
        target: '2-4 academic paragraphs',
        paragraphTasks: [
          {
            id: 'paragraph-1',
            task: 'Write the first paragraph: define key concepts, delimit the review scope, and cite the most relevant source.',
            evidenceIds: ['P1'],
            retrievalNotes: 'Use P1 for the background claim and cite it if used.',
            keyEvidence: ['Background claim from P1.'],
            target: 'one academic paragraph',
          },
          {
            id: 'paragraph-2',
            task: 'Write the second paragraph: synthesize why this scope leads to the following analytical framework or taxonomy.',
            evidenceIds: ['P1', 'P2'],
            retrievalNotes: 'Use P1 and P2 to connect scope, conceptual categories, and the rest of the review structure.',
            keyEvidence: ['Conceptual cue from P1.', 'Scope cue from P2.'],
            target: 'one academic paragraph',
          },
        ],
      },
    ],
    comparisonTable: [
      {
        id: 'comparison-1',
        theme: 'Comparison theme',
        task: 'Compare the selected sources on this analytical theme, emphasizing similarities, differences, and implications for the review argument.',
        evidenceIds: ['P1', 'P2'],
        retrievalNotes: 'Focus on method differences and limitations.',
        keyEvidence: ['Comparison cue.'],
        target: 'one concise comparison paragraph',
      },
    ],
    researchGaps: [
      {
        task: 'Identify one evidence-grounded research gap and explain why the retrieved sources leave it unresolved.',
        evidenceIds: ['P1'],
        retrievalNotes: 'Use explicit limitations only.',
        keyEvidence: ['Limitation from P1.'],
        target: 'one sentence',
      },
    ],
    futureDirections: [
      {
        task: 'Propose one evidence-grounded future direction that logically follows from the identified gap.',
        evidenceIds: ['P2'],
        retrievalNotes: 'Base the direction on retrieved limitations.',
        keyEvidence: ['Future cue from P2.'],
        target: 'one sentence',
      },
    ],
    conclusionTask: {
      task: 'Conclude the review by synthesizing the major findings, clarifying the contribution of the review, and restating the future agenda.',
      evidenceIds: ['P1', 'P2'],
      retrievalNotes: 'Use the strongest evidence from all sections.',
      keyEvidence: ['Overall conclusion cue.'],
      target: 'one paragraph',
    },
    references: [
      {
        id: 'P1',
        title: 'Paper title',
        authors: 'Author A; Author B',
        year: '2025',
        doi: '10.xxxx/example',
      },
    ],
    sources: [
      {
        id: 'P1',
        title: 'Paper title',
        sourceType: 'paper',
        relevance: 'Why this source should be used.',
      },
    ],
    figures: [
      {
        id: 'P1-F1',
        caption: 'Concise caption adapted from the source figure.',
        placement: 'section-1',
        reason: 'This figure helps compare the core taxonomy or evidence pattern.',
      },
    ],
  };

  const systemPrompt = [
    'You are PaperQuay research synthesis planning assistant.',
    'Your job is to create a rigorous academic writing plan for the user\'s own research-reading notes. This is an intermediate planning step, not final prose.',
    'Infer the user intent, topic boundary, target audience, review type, and evidence plan from the retrieved context.',
    `Write every user-visible planning value in ${outputLanguage}.`,
    'Return strict JSON only. Do not return Markdown fences, comments, or prose outside JSON.',
    'Do not write full body paragraphs in this planning call. Instead, create detailed next-step section tasks.',
    'The plan should follow the standards of high-quality scholarly literature reviews: clear problem framing, explicit scope, conceptual definitions, method or theme taxonomy, comparative synthesis, limitations, research gaps, and future agenda.',
    'Make every body-section heading analytically meaningful and journal-style. Prefer field-specific noun phrases over generic labels.',
    'Each section must contribute a distinct role in the argument. Avoid overlapping sections and avoid repeating the same evidence plan.',
    'Treat abstract, introduction, and conclusion as separate fields. Body sections must not duplicate Introduction, Conclusion, References, or Appendix.',
    'Design the body-section flow as a formal research synthesis: conceptual foundations and scope -> theoretical or analytical framework -> taxonomy of methods or research streams -> comparative evidence and evaluation -> limitations, open challenges, and research gaps -> future research agenda.',
    'Adapt that flow to the user intent and available evidence; omit or merge a step only when evidence is insufficient or the requested review type demands it.',
    'Section headings must be concise academic noun phrases suitable for a journal review article. Avoid vague labels such as Section 1, Theme, Findings, Methods, Discussion, Background, Related Work, Research Gaps, Future Work, Introduction, or Conclusion.',
    'Do not number section headings. Do not write headings as questions, full sentences, or commands.',
    'Good English heading examples: "Retrieval-Centric Architectures for Scholarly Reading", "Evidence Alignment and Citation-Grounded Synthesis", "Evaluation Protocols and Reproducibility Constraints".',
    'Good Chinese heading examples: "面向学术阅读的检索增强架构", "证据对齐与引文约束的综合生成", "评价协议与可复现性约束".',
    'Bad heading examples: "Methods", "Discussion", "Future Work", "Section 2", "What are the challenges?".',
    'The exact heading string you put in sections[].heading will be preserved in the editable outline and the exported Word document, so choose final publication-quality headings now.',
    'Each section must include paragraphTasks. A paragraphTask is a task object for exactly one downstream model call to write exactly one paragraph.',
    'Each task must include evidenceIds, retrievalNotes, keyEvidence, and target length so a second model call can write that part independently.',
    'For each section, create 2 to 4 paragraphTasks unless the user intent clearly requires a shorter section. Paragraph tasks should move from definition/context to comparison/synthesis to implications or limitations.',
    'Use only contextItems IDs such as P1 or N1. Do not invent papers, notes, facts, citations, experiments, metrics, or references.',
    'If availableFigures contains source figures relevant to the review, select up to 4 figures by ID in figures. Prefer figures that support taxonomy, workflow, method comparison, or evaluation evidence. Do not invent figure IDs, file paths, or captions.',
    'Figure captions should be concise academic-style captions. The local image file path is handled by PaperQuay and must not be generated by the model.',
    'Prefer 4 to 6 coherent body sections unless the user asks for a different structure. Use at most 6 body sections.',
    'Do not invent numeric references such as [1]. PaperQuay converts internal IDs like [P1] into formal Word citations during export.',
    'The required JSON shape is shown in requiredBlueprintShape. Follow the same keys exactly, with values adapted to the retrieved sources.',
  ].join('\n');

  const sectionArchitecture = {
    rule: 'Create formal body sections only; introduction and conclusion are separate fields.',
    preferredFlow: [
      'Conceptual foundations and review scope',
      'Theoretical perspectives or analytical framework',
      'Methodological taxonomy or research-stream classification',
      'Comparative evidence and evaluation',
      'Limitations, open challenges, and research gaps',
      'Future research agenda',
    ],
    headingRules: [
      'Concise journal-style academic noun phrase',
      'No numbering',
      'No questions',
      'No generic labels such as Methods, Findings, Discussion, Background, Related Work, Introduction, Conclusion',
      'The chosen heading is final and must be preserved exactly in the Word export',
    ],
    goodHeadingExamples: [
      'Retrieval-Centric Architectures for Scholarly Reading',
      'Evidence Alignment and Citation-Grounded Synthesis',
      '面向学术阅读的检索增强架构',
      '证据对齐与引文约束的综合生成',
    ],
    badHeadingExamples: ['Methods', 'Discussion', 'Future Work', 'Section 2'],
  };
  const userPayload = {
    intent: cleanString(options.intent),
    reviewType: cleanString(options.reviewType),
    sourceScope: cleanString(options.sourceScope),
    targetAudience: cleanString(options.targetAudience),
    outputLanguage,
    sectionArchitecture,
    requiredBlueprintShape: blueprintExample,
    contextItems: contextItems.map((item) => reviewContextForPrompt(item, REVIEW_CONTEXT_SUMMARY_CHAR_LIMIT)),
    availableFigures: reviewFiguresForPrompt(contextItems),
  };

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: JSON.stringify(userPayload, null, 2) },
  ];
}

function contextItemsForTask(task, contextItems) {
  const byId = new Map(contextItems.map((item) => [normalizeReferenceId(item.id), item]));
  const selected = [];

  for (const id of task.evidenceIds || []) {
    const item = byId.get(normalizeReferenceId(id));
    if (item) selected.push(item);
  }

  const fallback = selected.length > 0 ? selected : contextItems.slice(0, REVIEW_MAX_CONTEXT_PER_TASK);
  return fallback
    .slice(0, REVIEW_MAX_CONTEXT_PER_TASK)
    .map((item) => reviewContextForPrompt(item, REVIEW_TASK_CONTEXT_CHAR_LIMIT));
}

function buildReviewPartPrompt({ options, blueprint, kind, heading, task, contextItems }) {
  const outputLanguage = cleanString(options.outputLanguage) || 'the same language as the user intent';
  const partExample = {
    content: 'Retrieval-augmented scholarly reading reframes reading as an evidence-navigation workflow rather than a linear consumption process [P1]. This perspective helps connect document parsing, semantic retrieval, and annotation into a unified analytical pipeline [P2].',
    citations: ['P1', 'P2'],
  };
  const systemPrompt = [
    'You are PaperQuay research synthesis drafting assistant.',
    'Write only the requested part of the user\'s academic literature review. Do not rewrite the whole document.',
    `Write every user-visible value in ${outputLanguage}.`,
    'Use only the selected context evidence. Do not invent papers, notes, facts, citations, experiments, metrics, or references.',
    'Use internal evidence IDs such as [P1] or [N1] in the content when making evidence-backed claims.',
    'Do not use numeric citations such as [1]. PaperQuay will convert internal IDs into formal numeric references during Word export.',
    'Return strict JSON only with keys: content, citations.',
    'content must be polished academic prose: analytical, concise, coherent, and suitable for a research review.',
    'Use topic sentences, synthesis language, and explicit relationships such as contrast, convergence, limitation, implication, and research gap when evidence supports them.',
    'If selectedFigures contains a figure that directly supports this part, place it with a short anchor such as [Figure: P1-F1] near the relevant sentence or paragraph. Use only selected figure IDs. PaperQuay will replace the anchor with the actual image in the Word export.',
    'Avoid bullet lists, Markdown headings, code fences, casual language, unsupported claims, and source-by-source summaries without synthesis.',
    'Do not write Markdown image syntax or long image placeholders. Prefer a single concise figure anchor only when the figure is genuinely useful.',
    'citations must be an array of context item IDs actually used in content.',
  ].join('\n');
  const userPayload = {
    kind,
    heading: cleanString(heading),
    task: {
      instruction: cleanString(task.task),
      retrievalNotes: cleanString(task.retrievalNotes),
      keyEvidence: stringArrayValue(task.keyEvidence),
      target: cleanString(task.target),
      evidenceIds: task.evidenceIds || [],
    },
    reviewBlueprint: {
      title: blueprint.title,
      intentSummary: blueprint.intentSummary,
      thesis: blueprint.thesis,
      sectionOutline: blueprint.sections.map((section) => ({
        id: section.id,
        heading: section.heading,
        evidenceIds: section.evidenceIds,
        paragraphTasks: (section.paragraphTasks || []).map((paragraphTask) => ({
          id: paragraphTask.id,
          task: paragraphTask.task,
          evidenceIds: paragraphTask.evidenceIds,
          target: paragraphTask.target,
        })),
      })),
    },
    selectedContext: contextItemsForTask(task, contextItems),
    selectedFigures: (blueprint.figures || []).map((figure) => ({
      id: figure.id,
      sourceId: figure.sourceId,
      caption: truncateReviewText(figure.caption || figure.title, 220),
      placement: figure.placement,
    })),
    outputShape: {
      content: 'Drafted prose for this single part only, with internal citations like [P1] and optional concise figure anchors like [Figure: P1-F1].',
      citations: ['P1'],
    },
    outputExample: partExample,
  };

  return [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: JSON.stringify(userPayload, null, 2) },
  ];
}

function normalizeGeneratedReviewPart(value, task, validIds) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const content =
    cleanString(raw.content) ||
    cleanString(raw.text) ||
    cleanString(raw.paragraph) ||
    cleanString(raw.conclusion);

  if (!content) {
    throw new Error(`Model returned empty review content for task: ${task.task}`);
  }

  return {
    content,
    citations: normalizeEvidenceIds(
      raw.citations || raw.evidenceIds || raw.sourceIds,
      validIds,
      task.evidenceIds || [],
    ),
  };
}

function mergeGeneratedParagraphParts(paragraphs) {
  const citations = [];
  const seenIds = new Set();

  for (const paragraph of paragraphs || []) {
    for (const id of paragraph?.citations || []) {
      const normalizedId = normalizeReferenceId(id);
      if (!normalizedId || seenIds.has(normalizedId)) continue;
      seenIds.add(normalizedId);
      citations.push(normalizedId);
    }
  }

  return {
    content: (paragraphs || [])
      .map((paragraph) => cleanString(paragraph?.content))
      .filter(Boolean)
      .join('\n\n'),
    citations,
    paragraphs,
  };
}

function emptyReviewGeneratedPartsForBlueprint(blueprint) {
  return {
    abstract: null,
    introduction: null,
    sectionParagraphs: blueprint.sections.map((section) => {
      const paragraphTasks = section.paragraphTasks || [section];
      return new Array(paragraphTasks.length).fill(null);
    }),
    comparisonTable: new Array(blueprint.comparisonTable.length).fill(null),
    researchGaps: new Array(blueprint.researchGaps.length).fill(null),
    futureDirections: new Array(blueprint.futureDirections.length).fill(null),
    conclusion: null,
  };
}

function normalizeGeneratedReviewPartCheckpoint(value, validIds) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const content =
    cleanString(raw.content) ||
    cleanString(raw.text) ||
    cleanString(raw.paragraph) ||
    cleanString(raw.conclusion);

  if (!content) {
    return null;
  }

  return {
    content,
    citations: normalizeEvidenceIds(raw.citations || raw.evidenceIds || raw.sourceIds, validIds, []),
  };
}

function normalizeReviewGeneratedParts(value, blueprint, validIds) {
  const raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const parts = emptyReviewGeneratedPartsForBlueprint(blueprint);

  parts.abstract = normalizeGeneratedReviewPartCheckpoint(raw.abstract, validIds);
  parts.introduction = normalizeGeneratedReviewPartCheckpoint(raw.introduction, validIds);
  parts.conclusion = normalizeGeneratedReviewPartCheckpoint(raw.conclusion, validIds);

  if (Array.isArray(raw.sectionParagraphs)) {
    for (const [sectionIndex, section] of parts.sectionParagraphs.entries()) {
      const rawSection = Array.isArray(raw.sectionParagraphs[sectionIndex])
        ? raw.sectionParagraphs[sectionIndex]
        : [];
      for (const [paragraphIndex] of section.entries()) {
        section[paragraphIndex] = normalizeGeneratedReviewPartCheckpoint(rawSection[paragraphIndex], validIds);
      }
    }
  }

  for (const key of ['comparisonTable', 'researchGaps', 'futureDirections']) {
    if (!Array.isArray(raw[key])) {
      continue;
    }

    for (const [index] of parts[key].entries()) {
      parts[key][index] = normalizeGeneratedReviewPartCheckpoint(raw[key][index], validIds);
    }
  }

  return parts;
}

function countCompletedReviewGeneratedParts(parts) {
  let count = 0;
  if (parts.abstract) count += 1;
  if (parts.introduction) count += 1;
  if (parts.conclusion) count += 1;
  for (const section of parts.sectionParagraphs || []) {
    for (const paragraph of section || []) {
      if (paragraph) count += 1;
    }
  }
  for (const key of ['comparisonTable', 'researchGaps', 'futureDirections']) {
    for (const part of parts[key] || []) {
      if (part) count += 1;
    }
  }
  return count;
}

function mergeReferencesFromBlueprintAndContext(blueprint, contextItems, usedIds) {
  const contextById = new Map(contextItems.map((item) => [normalizeReferenceId(item.id), item]));
  const referenceById = new Map((blueprint.references || []).map((item) => [normalizeReferenceId(item.id), item]));
  const sourceById = new Map((blueprint.sources || []).map((item) => [normalizeReferenceId(item.id), item]));
  const references = [];
  const sources = [];

  for (const id of usedIds) {
    const normalizedId = normalizeReferenceId(id);
    const contextItem = contextById.get(normalizedId);
    const reference = referenceById.get(normalizedId) || (contextItem ? referenceFromContextItem(contextItem) : null);
    const source = sourceById.get(normalizedId) || (contextItem ? sourceFromContextItem(contextItem) : null);

    if (reference) {
      references.push({ ...reference, id: normalizedId });
    }

    if (source) {
      sources.push({ ...source, id: normalizedId });
    }
  }

  return { references, sources };
}

function composeReviewDraftFromGeneratedParts({ blueprint, contextItems, parts }) {
  const usedIds = [];
  const seenIds = new Set();
  const addUsedIds = (ids) => {
    for (const id of ids || []) {
      const normalizedId = normalizeReferenceId(id);
      if (!normalizedId || seenIds.has(normalizedId)) continue;
      seenIds.add(normalizedId);
      usedIds.push(normalizedId);
    }
  };

  addUsedIds(parts.abstract?.citations);
  addUsedIds(parts.introduction?.citations);
  for (const item of parts.sections || []) addUsedIds(item.citations);
  for (const item of parts.comparisonTable || []) addUsedIds(item.citations);
  for (const item of parts.researchGaps || []) addUsedIds(item.citations);
  for (const item of parts.futureDirections || []) addUsedIds(item.citations);
  addUsedIds(parts.conclusion?.citations);

  if (usedIds.length === 0) {
    addUsedIds(defaultReviewEvidenceIds(contextItems, 4));
  }

  const { references, sources } = mergeReferencesFromBlueprintAndContext(blueprint, contextItems, usedIds);

  return normalizeReviewJsonDraft({
    title: blueprint.title,
    abstract: parts.abstract?.content || '',
    keywords: blueprint.keywords,
    intentSummary: blueprint.intentSummary,
    thesis: blueprint.thesis,
    introduction: parts.introduction?.content || '',
    sections: blueprint.sections.map((section, index) => ({
      heading: section.heading,
      content: parts.sections?.[index]?.content || '',
      citations: parts.sections?.[index]?.citations || section.evidenceIds || [],
    })),
    comparisonTable: blueprint.comparisonTable.map((row, index) => ({
      theme: row.theme,
      papers: parts.comparisonTable?.[index]?.citations || row.evidenceIds || [],
      conclusion: parts.comparisonTable?.[index]?.content || '',
    })),
    researchGaps: (parts.researchGaps || []).map((item) => item.content),
    futureDirections: (parts.futureDirections || []).map((item) => item.content),
    conclusion: parts.conclusion?.content || '',
    references,
    sources,
    figures: blueprint.figures || [],
  });
}

function normalizeReferenceId(value) {
  return cleanString(value).toUpperCase();
}

function collectInternalCitationIds(text) {
  const ids = [];
  const value = cleanString(text);
  const pattern = /\[([A-Za-z]\d+)\]/g;
  let match = pattern.exec(value);

  while (match) {
    ids.push(normalizeReferenceId(match[1]));
    match = pattern.exec(value);
  }

  return ids;
}

function referencePart(value) {
  return cleanString(value).replace(/[.。;；,\s]+$/g, '');
}

function formatReferenceText(reference, source) {
  const authors = referencePart(reference?.authors);
  const title = referencePart(reference?.title || source?.title);
  const journal = referencePart(reference?.journal || source?.publication || source?.journal);
  const year = referencePart(reference?.year);
  const pages = referencePart(reference?.pages);
  const doi = referencePart(reference?.doi);
  const parts = [authors, title, journal, year].filter(Boolean);

  if (pages) {
    parts.push(/^\d/.test(pages) ? `pp. ${pages}` : pages);
  }

  if (doi) {
    parts.push(`DOI: ${doi.replace(/^doi:\s*/i, '')}`);
  }

  if (parts.length === 0) {
    parts.push(referencePart(source?.title) || referencePart(source?.relevance) || 'PaperQuay source');
  }

  return parts.map((part) => (/[.!?。！？]$/.test(part) ? part : `${part}.`)).join(' ');
}

function stripOuterReviewMarkdownFence(value) {
  const text = cleanString(value).replace(/^\uFEFF/, '').trim();
  const match = text.match(/^```(?:markdown|md|text)?\s*\n([\s\S]*?)\n```$/i);
  return match ? match[1].trim() : text;
}

function normalizeReviewMarkdownInline(value) {
  const protectedTokens = [];
  const protect = (token) => {
    const marker = `\uE000${protectedTokens.length}\uE001`;
    protectedTokens.push(token);
    return marker;
  };
  let text = cleanString(value)
    .replace(/\$\$[\s\S]*?\$\$|\$[^$\n]+\$|\[\s*(?:Image|Figure|Fig\.?)\s*(?::|#)?\s*[A-Za-z0-9_-]+\s*]|\[[A-Za-z]\d+]/gi, protect)
    .replace(/!\[([^\]]*)]\([^)]+\)/g, '$1')
    .replace(/\[([^\]]+)]\([^)]+\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/(^|[^\w])\*([^*\n]+)\*(?=$|[^\w])/g, '$1$2')
    .replace(/(^|[^\w])_([^_\n]+)_(?=$|[^\w])/g, '$1$2')
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/\\([\\`*_[\]{}()#+\-.!>])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  for (const [index, token] of protectedTokens.entries()) {
    text = text.replaceAll(`\uE000${index}\uE001`, token);
  }

  return text;
}

function reviewMarkdownBlock(kind, text, marker = '') {
  const normalizedText = kind === 'equation'
    ? cleanString(text).replace(/\s*\n\s*/g, ' ').trim()
    : normalizeReviewMarkdownInline(text);

  if (!normalizedText) {
    return null;
  }

  return {
    kind,
    text: normalizedText,
    marker,
    suffixText: '',
    isParagraph: kind === 'paragraph',
    isList: kind === 'bullet' || kind === 'ordered',
    isHeading: kind === 'heading',
    isQuote: kind === 'quote',
    isEquation: kind === 'equation',
  };
}

function reviewHeadingKey(value) {
  return normalizeReviewMarkdownInline(value)
    .replace(/^\d+(?:\.\d+)*[.、]?\s*/, '')
    .replace(/[\s:：。.!?？]+/g, '')
    .toLowerCase();
}

function parseReviewMarkdownBlocks(value, options = {}) {
  const text = stripOuterReviewMarkdownFence(value).replace(/\r\n?/g, '\n');
  if (!text) return [];

  const lines = text.split('\n');
  const blocks = [];
  const paragraphLines = [];
  const addBlock = (kind, blockText, marker = '') => {
    const block = reviewMarkdownBlock(kind, blockText, marker);
    if (block) blocks.push(block);
  };
  const flushParagraph = () => {
    if (paragraphLines.length === 0) return;
    addBlock('paragraph', paragraphLines.join(' '));
    paragraphLines.length = 0;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();

    if (!trimmed) {
      flushParagraph();
      continue;
    }

    if (/^(```+|~~~+)/.test(trimmed)) {
      flushParagraph();
      const fence = trimmed.match(/^(```+|~~~+)/)?.[1] || '```';
      const codeLines = [];
      index += 1;
      while (index < lines.length && !lines[index].trim().startsWith(fence)) {
        codeLines.push(lines[index]);
        index += 1;
      }
      addBlock('quote', codeLines.join(' '));
      continue;
    }

    if (trimmed.startsWith('$$') || trimmed.startsWith('\\[')) {
      flushParagraph();
      const closesInline = trimmed.startsWith('$$')
        ? /^\$\$[\s\S]+\$\$$/.test(trimmed)
        : /^\\\[[\s\S]+\\\]$/.test(trimmed);
      const mathLines = [trimmed];

      if (!closesInline) {
        const closing = trimmed.startsWith('$$') ? '$$' : '\\]';
        index += 1;
        while (index < lines.length) {
          mathLines.push(lines[index].trim());
          if (lines[index].trim().endsWith(closing)) break;
          index += 1;
        }
      }

      const mathText = mathLines.join(' ')
        .replace(/^\\\[/, '$$')
        .replace(/\\\]$/, '$$');
      addBlock('equation', mathText);
      continue;
    }

    const headingMatch = trimmed.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      flushParagraph();
      addBlock('heading', headingMatch[1]);
      continue;
    }

    if (/^(?:-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushParagraph();
      continue;
    }

    const bulletMatch = line.match(/^\s*[-+*]\s+(.+)$/);
    if (bulletMatch) {
      flushParagraph();
      addBlock('bullet', bulletMatch[1], '• ');
      continue;
    }

    const orderedMatch = line.match(/^\s*(\d+)[.)、]\s+(.+)$/);
    if (orderedMatch) {
      flushParagraph();
      addBlock('ordered', orderedMatch[2], `${orderedMatch[1]}. `);
      continue;
    }

    const quoteMatch = line.match(/^\s*>\s?(.*)$/);
    if (quoteMatch) {
      flushParagraph();
      addBlock('quote', quoteMatch[1]);
      continue;
    }

    paragraphLines.push(trimmed);
  }

  flushParagraph();

  const expectedHeadingKey = reviewHeadingKey(options.expectedHeading);
  if (
    expectedHeadingKey &&
    blocks[0]?.isHeading &&
    reviewHeadingKey(blocks[0].text) === expectedHeadingKey
  ) {
    blocks.shift();
  }

  return blocks;
}

function reviewBlocksToPlainText(blocks) {
  return (blocks || [])
    .map((block) => `${block.marker || ''}${block.text || ''}`.trim())
    .filter(Boolean)
    .join('\n\n');
}

function cleanReviewTextAfterFigureAnchorRemoval(value) {
  return cleanString(value)
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([,.;:!?，。；：！？])/g, '$1')
    .replace(/([（(])\s+/g, '$1')
    .replace(/\s+([）)])/g, '$1')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function normalizeReviewFigureAnchorKey(value) {
  return cleanString(value)
    .replace(/^#/, '')
    .replace(/^FIG(?:URE)?[-_\s#]*/i, 'F')
    .toUpperCase();
}

function figureAnchorKeys(figure, index) {
  const keys = new Set();
  const number = cleanString(figure?.number) || String(index + 1);
  const id = cleanString(figure?.id);
  const sourceId = normalizeReferenceId(figure?.sourceId);

  for (const key of [
    id,
    number,
    `F${number}`,
    `FIG${number}`,
    `FIGURE${number}`,
    sourceId && `${sourceId}-F${number}`,
  ]) {
    const normalizedKey = normalizeReviewFigureAnchorKey(key);
    if (normalizedKey) {
      keys.add(normalizedKey);
    }
  }

  return keys;
}

function buildReviewFigureAnchorMap(figures) {
  const byAnchor = new Map();

  for (const [index, figure] of figures.entries()) {
    for (const key of figureAnchorKeys(figure, index)) {
      if (!byAnchor.has(key)) {
        byAnchor.set(key, figure);
      }
    }
  }

  return byAnchor;
}

function extractInlineReviewFigures(paragraph, figureByAnchor, usedFigureNumbers, figureLabel = 'Figure') {
  const inlineFigures = [];
  const anchorLabels = [];
  const textWithAnchorLabels = cleanString(paragraph).replace(REVIEW_FIGURE_ANCHOR_PATTERN, (_match, rawAnchor) => {
    const figure = figureByAnchor.get(normalizeReviewFigureAnchorKey(rawAnchor));
    const figureNumber = cleanString(figure?.number);

    if (figure && figureNumber && !usedFigureNumbers.has(figureNumber)) {
      usedFigureNumbers.add(figureNumber);
      inlineFigures.push(figure);
      const token = `__PAPERQUAY_FIGURE_REF_${anchorLabels.length}__`;
      anchorLabels.push([token, `${figureLabel} ${figureNumber}`]);
      return token;
    }

    return '';
  });
  const textWithoutAnchors = cleanReviewTextAfterFigureAnchorRemoval(
    anchorLabels.reduce((text, [token]) => text.replaceAll(token, ''), textWithAnchorLabels),
  );
  const text = textWithoutAnchors
    ? cleanReviewTextAfterFigureAnchorRemoval(
      anchorLabels.reduce((nextText, [token, label]) => nextText.replaceAll(token, label), textWithAnchorLabels),
    )
    : '';

  return {
    text,
    inlineFigures,
  };
}

function figurePlacementMatchesSection(figure, section, sectionIndex) {
  const placement = cleanString(figure?.placement).toUpperCase();
  if (!placement) {
    return false;
  }

  const sectionId = cleanString(section?.id || `section-${sectionIndex + 1}`).toUpperCase();
  const heading = cleanString(section?.heading).toUpperCase();
  const number = String(sectionIndex + 1);

  return (
    placement === sectionId ||
    placement === `SECTION-${number}` ||
    placement === `SECTION ${number}` ||
    placement === number ||
    (heading && (placement === heading || placement.includes(heading) || heading.includes(placement)))
  );
}

function stripReviewFigureAnchors(value) {
  return cleanReviewTextAfterFigureAnchorRemoval(
    cleanString(value).replace(REVIEW_FIGURE_ANCHOR_PATTERN, ''),
  );
}

function reviewTextParagraphs(value, options = {}) {
  return parseReviewMarkdownBlocks(value, options)
    .map((block) => {
      const text = options.stripFigureAnchors
        ? stripReviewFigureAnchors(block.text)
        : block.text;
      return {
        ...block,
        text,
        hasText: Boolean(text),
        inlineFigures: [],
        hasInlineFigures: false,
      };
    })
    .filter((block) => block.hasText);
}

function prepareReviewDocxData(value, outputLanguage = '') {
  const draft = normalizeReviewJsonDraft(value);
  const t = reviewSectionTitles(outputLanguage || value?.outputLanguage);
  const referenceById = new Map();
  const sourceById = new Map();

  for (const reference of draft.references) {
    const id = normalizeReferenceId(reference.id);
    if (id && !referenceById.has(id)) {
      referenceById.set(id, reference);
    }
  }

  for (const source of draft.sources) {
    const id = normalizeReferenceId(source.id);
    if (id && !sourceById.has(id)) {
      sourceById.set(id, source);
    }
  }

  const orderedIds = [];
  const seenIds = new Set();
  const addId = (id) => {
    const normalizedId = normalizeReferenceId(id);
    if (!/^[A-Z]\d+$/.test(normalizedId) || seenIds.has(normalizedId)) {
      return;
    }

    seenIds.add(normalizedId);
    orderedIds.push(normalizedId);
  };

  for (const text of [draft.abstract, draft.intentSummary, draft.thesis, draft.introduction]) {
    for (const id of collectInternalCitationIds(text)) addId(id);
  }
  for (const section of draft.sections) {
    for (const id of collectInternalCitationIds(section.content)) addId(id);
    for (const id of section.citations) addId(id);
  }
  for (const row of draft.comparisonTable) {
    for (const id of row.papers) addId(id);
    for (const id of collectInternalCitationIds(row.conclusion)) addId(id);
  }
  for (const text of [...draft.researchGaps, ...draft.futureDirections, draft.conclusion]) {
    for (const id of collectInternalCitationIds(text)) addId(id);
  }
  for (const figure of draft.figures) addId(figure.sourceId);
  for (const reference of draft.references) addId(reference.id);
  for (const source of draft.sources) addId(source.id);

  const citationLabelById = new Map();
  const references = orderedIds.map((id, index) => {
    const number = String(index + 1);
    const label = `[${number}]`;
    const reference = referenceById.get(id) || {};
    const source = sourceById.get(id) || {};
    citationLabelById.set(id, label);

    return {
      id,
      number,
      label,
      title: cleanString(reference.title || source.title),
      authors: cleanString(reference.authors),
      year: cleanString(reference.year),
      journal: cleanString(reference.journal || source.publication || source.journal),
      pages: cleanString(reference.pages),
      doi: cleanString(reference.doi),
      sourceType: cleanString(source.sourceType),
      formattedText: formatReferenceText(reference, source),
    };
  });

  const replaceInternalCitations = (text) =>
    cleanString(text).replace(/\[([A-Za-z]\d+)\]/g, (match, id) => citationLabelById.get(normalizeReferenceId(id)) || match);
  const citationLabels = (ids) =>
    Array.from(new Set(ids.map((id) => citationLabelById.get(normalizeReferenceId(id))).filter(Boolean)));
  const figures = draft.figures.map((figure, index) => {
    const sourceId = normalizeReferenceId(figure.sourceId);
    const source = sourceById.get(sourceId) || {};
    const label = citationLabelById.get(sourceId) || '';
    const number = String(index + 1);
    const caption = replaceInternalCitations(figure.caption || figure.title || `Figure ${number}`);

    return {
      ...figure,
      number,
      marker: `${REVIEW_FIGURE_MARKER_PREFIX}${number}__`,
      sourceId,
      sourceLabel: label,
      sourceTitle: cleanString(figure.sourceTitle || source.title),
      caption,
      captionText: `${t.figureLabel} ${number}. ${caption}${label && !caption.includes(label) ? ` ${label}` : ''}`,
    };
  });
  const figureByAnchor = buildReviewFigureAnchorMap(figures);
  const usedFigureNumbers = new Set();
  const sections = draft.sections.map((section, sectionIndex) => {
    const rawContent = replaceInternalCitations(section.content);
    const labels = citationLabels(section.citations);
    const contentBlocks = parseReviewMarkdownBlocks(rawContent, { expectedHeading: section.heading });
    const content = stripReviewFigureAnchors(reviewBlocksToPlainText(contentBlocks));
    const missingCitationText = labels.filter((label) => !content.includes(label)).join(' ');
    const paragraphs = contentBlocks
      .map((block) => {
        const parsed = extractInlineReviewFigures(block.text, figureByAnchor, usedFigureNumbers, t.figureLabel);
        return {
          ...block,
          text: parsed.text,
          hasText: Boolean(parsed.text),
          citationText: '',
          suffixText: '',
          inlineFigures: parsed.inlineFigures,
          hasInlineFigures: parsed.inlineFigures.length > 0,
        };
      })
      .filter((paragraph) => paragraph.hasText || paragraph.hasInlineFigures);
    const lastTextParagraphIndex = paragraphs.reduce(
      (lastIndex, paragraph, index) => (paragraph.hasText ? index : lastIndex),
      -1,
    );

    if (lastTextParagraphIndex >= 0) {
      paragraphs[lastTextParagraphIndex].citationText = missingCitationText;
      paragraphs[lastTextParagraphIndex].suffixText = missingCitationText ? ` ${missingCitationText}` : '';
    }

    const placedFigureNumbers = new Set();
    for (const paragraph of paragraphs) {
      for (const figure of paragraph.inlineFigures) {
        placedFigureNumbers.add(cleanString(figure.number));
      }
    }

    const placementFigures = figures.filter((figure) => {
      const figureNumber = cleanString(figure.number);
      return (
        figureNumber &&
        !usedFigureNumbers.has(figureNumber) &&
        !placedFigureNumbers.has(figureNumber) &&
        figurePlacementMatchesSection(figure, section, sectionIndex)
      );
    });

    if (placementFigures.length > 0) {
      for (const figure of placementFigures) {
        usedFigureNumbers.add(cleanString(figure.number));
      }

      if (paragraphs.length > 0) {
        const targetIndex = paragraphs.reduce(
          (lastIndex, paragraph, index) => (paragraph.hasText ? index : lastIndex),
          paragraphs.length - 1,
        );
        paragraphs[targetIndex].inlineFigures.push(...placementFigures);
        paragraphs[targetIndex].hasInlineFigures = true;
      } else {
        paragraphs.push({
          ...reviewMarkdownBlock('paragraph', ''),
          text: '',
          hasText: false,
          citationText: '',
          suffixText: '',
          inlineFigures: placementFigures,
          hasInlineFigures: true,
        });
      }
    }

    return {
      ...section,
      content,
      citationLabels: labels,
      citationText: missingCitationText,
      paragraphs,
    };
  });
  const remainingFigures = figures.filter((figure) => !usedFigureNumbers.has(cleanString(figure.number)));
  const preparedField = (value) => {
    const paragraphs = reviewTextParagraphs(replaceInternalCitations(value), { stripFigureAnchors: true });
    return {
      text: reviewBlocksToPlainText(paragraphs),
      paragraphs,
    };
  };
  const abstractField = preparedField(draft.abstract);
  const intentField = preparedField(draft.intentSummary);
  const thesisField = preparedField(draft.thesis);
  const introductionField = preparedField(draft.introduction);
  const conclusionField = preparedField(draft.conclusion);
  const asReviewListBlock = (block) => block.isList
    ? block
    : {
        ...block,
        kind: 'bullet',
        marker: '• ',
        isParagraph: false,
        isList: true,
        isHeading: false,
        isQuote: false,
        isEquation: false,
      };
  const researchGapBlocks = draft.researchGaps.flatMap((item) =>
    reviewTextParagraphs(replaceInternalCitations(item), { stripFigureAnchors: true }).map(asReviewListBlock),
  );
  const futureDirectionBlocks = draft.futureDirections.flatMap((item) =>
    reviewTextParagraphs(replaceInternalCitations(item), { stripFigureAnchors: true }).map(asReviewListBlock),
  );

  return {
    ...draft,
    abstract: abstractField.text,
    abstractParagraphs: abstractField.paragraphs,
    intentSummary: intentField.text,
    intentSummaryParagraphs: intentField.paragraphs,
    thesis: thesisField.text,
    thesisParagraphs: thesisField.paragraphs,
    introduction: introductionField.text,
    introductionParagraphs: introductionField.paragraphs,
    sections,
    comparisonTable: draft.comparisonTable.map((row) => {
      const conclusion = preparedField(row.conclusion).text;
      const labels = citationLabels(row.papers);
      return {
        ...row,
        conclusion,
        paperLabels: labels,
        paperLabelsText: labels.filter((label) => !conclusion.includes(label)).join(' '),
      };
    }),
    researchGaps: draft.researchGaps.map((item) => preparedField(item).text),
    researchGapBlocks,
    futureDirections: draft.futureDirections.map((item) => preparedField(item).text),
    futureDirectionBlocks,
    conclusion: conclusionField.text,
    conclusionParagraphs: conclusionField.paragraphs,
    references,
    hasFigures: remainingFigures.length > 0,
    hasRemainingFigures: remainingFigures.length > 0,
    figures,
    remainingFigures,
    sources: draft.sources.map((source) => {
      const id = normalizeReferenceId(source.id);
      const label = citationLabelById.get(id) || '';
      return {
        ...source,
        id,
        label,
        number: label.replace(/[\[\]]/g, ''),
      };
    }),
  };
}

function reviewBlockToMarkdown(block) {
  const text = cleanString(block?.text);
  if (!text) return '';

  if (block.isHeading) return `#### ${text}`;
  if (block.isList) {
    const marker = block.kind === 'ordered' ? cleanString(block.marker) || '1. ' : '- ';
    return `${marker}${text}`;
  }
  if (block.isQuote) return `> ${text}`;
  return text;
}

function reviewFigureToMarkdown(figure) {
  const caption = cleanString(figure?.captionText || figure?.caption || figure?.title)
    .replace(/]/g, '\\]');
  const target = cleanString(figure?.path).replace(/\\/g, '/').replace(/[<>]/g, '');

  if (!target) {
    return `> [${caption || cleanString(figure?.id) || 'Figure'}]`;
  }

  return `![${caption || cleanString(figure?.id) || 'Figure'}](<${target}>)`;
}

function renderPreparedReviewMarkdown(data, outputLanguage = '') {
  const t = reviewSectionTitles(outputLanguage);
  const lines = [];
  const addSection = (heading, blocks) => {
    const content = (blocks || []).map(reviewBlockToMarkdown).filter(Boolean);
    if (content.length === 0) return;
    lines.push(`## ${heading}`, '', content.join('\n\n'), '');
  };

  lines.push(`# ${cleanString(data.title) || 'Literature Review'}`, '');
  addSection(t.abstract, data.abstractParagraphs);

  if (Array.isArray(data.keywords) && data.keywords.length > 0) {
    lines.push(`**${t.keywordsLabel.trim()}** ${data.keywords.join('; ')}`, '');
  }

  addSection(t.intent, data.intentSummaryParagraphs);
  addSection(t.thesis, data.thesisParagraphs);
  addSection(t.introduction, data.introductionParagraphs);

  if (Array.isArray(data.sections) && data.sections.length > 0) {
    lines.push(`## ${t.body}`, '');
    for (const section of data.sections) {
      lines.push(`### ${cleanString(section.heading)}`, '');
      for (const paragraph of section.paragraphs || []) {
        const blockText = reviewBlockToMarkdown(paragraph);
        if (blockText) lines.push(blockText, '');
        for (const figure of paragraph.inlineFigures || []) {
          lines.push(reviewFigureToMarkdown(figure), '');
        }
      }
    }
  }

  if (Array.isArray(data.remainingFigures) && data.remainingFigures.length > 0) {
    lines.push(`## ${t.figures}`, '');
    for (const figure of data.remainingFigures) {
      lines.push(reviewFigureToMarkdown(figure), '');
    }
  }

  if (Array.isArray(data.comparisonTable) && data.comparisonTable.length > 0) {
    lines.push(`## ${t.comparison}`, '');
    for (const row of data.comparisonTable) {
      lines.push(`- **${cleanString(row.theme)}:** ${cleanString(row.conclusion)}${row.paperLabelsText ? ` ${row.paperLabelsText}` : ''}`.trim(), '');
    }
  }

  addSection(t.gaps, data.researchGapBlocks);
  addSection(t.future, data.futureDirectionBlocks);
  addSection(t.conclusion, data.conclusionParagraphs);

  if (Array.isArray(data.references) && data.references.length > 0) {
    lines.push(`## ${t.references}`, '');
    for (const reference of data.references) {
      lines.push(`${reference.label} ${reference.formattedText}`, '');
    }
  }

  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function reviewDraftToMarkdown(value, outputLanguage = '') {
  const language = cleanString(outputLanguage || value?.outputLanguage);
  return renderPreparedReviewMarkdown(prepareReviewDocxData(value, language), language);
}

function xmlEscape(value) {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function xmlUnescape(value) {
  return String(value)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function regexEscape(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function wordText(text, options = {}) {
  const runProperties = [];

  if (options.bold) {
    runProperties.push('<w:b/>');
  }

  if (options.italic) {
    runProperties.push('<w:i/>');
  }

  if (options.size) {
    runProperties.push(`<w:sz w:val="${options.size}"/>`);
  }

  const properties = runProperties.length > 0 ? `<w:rPr>${runProperties.join('')}</w:rPr>` : '';
  return `<w:r>${properties}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
}

function wordParagraph(text, options = {}) {
  const properties = [];

  if (options.style) {
    properties.push(`<w:pStyle w:val="${options.style}"/>`);
  }

  if (options.align) {
    properties.push(`<w:jc w:val="${options.align}"/>`);
  }

  const indentAttributes = [];
  if (options.firstLine) {
    indentAttributes.push(`w:firstLine="${options.firstLine}"`);
  }
  if (options.leftIndent) {
    indentAttributes.push(`w:left="${options.leftIndent}"`);
  }
  if (options.hangingIndent) {
    indentAttributes.push(`w:hanging="${options.hangingIndent}"`);
  }
  if (indentAttributes.length > 0) {
    properties.push(`<w:ind ${indentAttributes.join(' ')}/>`);
  }

  if (options.spacing) {
    properties.push(`<w:spacing w:before="${options.spacing.before ?? 0}" w:after="${options.spacing.after ?? 120}" w:line="${options.spacing.line ?? 360}" w:lineRule="auto"/>`);
  }

  const paragraphProperties = properties.length > 0 ? `<w:pPr>${properties.join('')}</w:pPr>` : '';
  return `<w:p>${paragraphProperties}${wordText(text, options)}</w:p>`;
}

function latexToOmml(latex, displayMode = false) {
  try {
    const value = cleanString(latex);
    if (!value) return null;

    const mathml = temml.renderToString(value, {
      displayMode,
      throwOnError: false,
    });
    const omml = mathml2omml.mml2omml(mathml);

    return cleanString(omml).startsWith('<m:oMath') ? omml : null;
  } catch (error) {
    warn(`[PaperQuay] Failed to convert LaTeX to OMML: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function ensureDocxMathNamespace(documentXml) {
  if (/<w:document\b[^>]*\sxmlns:m=/.test(documentXml)) {
    return documentXml;
  }

  return documentXml.replace(
    /<w:document\b([^>]*)>/,
    '<w:document$1 xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">',
  );
}

function wordRunWithText(text, runProperties = '') {
  if (!text) return '';
  return `<w:r>${runProperties}<w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r>`;
}

function splitParagraphTextSegments(paragraphBody) {
  const segments = [''];
  const tokenPattern = /<w:t\b[^>]*>([\s\S]*?)<\/w:t>|<w:tab\b[^>]*(?:\/>|><\/w:tab>)|<w:br\b[^>]*(?:\/>|><\/w:br>)/g;
  let match = tokenPattern.exec(paragraphBody);

  while (match) {
    const token = match[0];
    if (token.startsWith('<w:t')) {
      segments[segments.length - 1] += xmlUnescape(match[1] || '');
    } else if (token.startsWith('<w:tab')) {
      segments[segments.length - 1] += '\t';
    } else {
      segments.push('');
    }

    match = tokenPattern.exec(paragraphBody);
  }

  return segments;
}

function inlineOmmlRunsFromText(text, runProperties = '') {
  const formulaPattern = /\$\$([^$\n]+)\$\$|\$([^$\n]+)\$/g;
  let cursor = 0;
  let changed = false;
  let xml = '';
  let match = formulaPattern.exec(text);

  while (match) {
    if (match.index > cursor) {
      xml += wordRunWithText(text.slice(cursor, match.index), runProperties);
    }

    const latex = match[1] || match[2] || '';
    const omml = latexToOmml(latex, Boolean(match[1]));
    if (omml) {
      xml += omml;
      changed = true;
    } else {
      xml += wordRunWithText(match[0], runProperties);
    }

    cursor = match.index + match[0].length;
    match = formulaPattern.exec(text);
  }

  if (cursor < text.length) {
    xml += wordRunWithText(text.slice(cursor), runProperties);
  }

  return { changed, xml };
}

function injectOmmlIntoParagraph(paragraphXml) {
  if (!paragraphXml.includes('$')) {
    return paragraphXml;
  }

  const openMatch = paragraphXml.match(/^<w:p\b[^>]*>/);
  if (!openMatch) {
    return paragraphXml;
  }

  const openTag = openMatch[0];
  const closeTag = '</w:p>';
  const inner = paragraphXml.slice(openTag.length, paragraphXml.length - closeTag.length);
  const paragraphPropertiesMatch = inner.match(/^\s*(<w:pPr\b[\s\S]*?<\/w:pPr>)/);
  const paragraphProperties = paragraphPropertiesMatch?.[1] || '';
  const body = paragraphProperties ? inner.slice(paragraphPropertiesMatch[0].length) : inner;
  const runProperties = body.match(/<w:rPr\b[\s\S]*?<\/w:rPr>/)?.[0] || '';
  const segments = splitParagraphTextSegments(body);

  if (!segments.some((segment) => segment.includes('$'))) {
    return paragraphXml;
  }

  if (segments.length === 1) {
    const blockMatch = segments[0].trim().match(/^\$\$([\s\S]+)\$\$$/);
    if (blockMatch) {
      const omml = latexToOmml(blockMatch[1], true);
      return omml
        ? `${openTag}${paragraphProperties}<m:oMathPara>${omml}</m:oMathPara>${closeTag}`
        : paragraphXml;
    }
  }

  let changed = false;
  const nextBody = segments.map((segment, index) => {
    const converted = inlineOmmlRunsFromText(segment, runProperties);
    changed = changed || converted.changed;
    const lineBreak = index < segments.length - 1 ? `<w:r>${runProperties}<w:br/></w:r>` : '';
    return `${converted.xml}${lineBreak}`;
  }).join('');

  return changed ? `${openTag}${paragraphProperties}${nextBody}${closeTag}` : paragraphXml;
}

function injectOmmlInDocx(zip) {
  const documentFile = zip.file('word/document.xml');
  if (!documentFile) {
    return { convertedParagraphs: 0 };
  }

  const originalXml = documentFile.asText();
  if (!originalXml.includes('$')) {
    return { convertedParagraphs: 0 };
  }

  let convertedParagraphs = 0;
  const nextXml = ensureDocxMathNamespace(originalXml).replace(/<w:p\b[^>]*>[\s\S]*?<\/w:p>/g, (paragraphXml) => {
    const nextParagraphXml = injectOmmlIntoParagraph(paragraphXml);
    if (nextParagraphXml !== paragraphXml) {
      convertedParagraphs += 1;
    }
    return nextParagraphXml;
  });

  if (nextXml !== originalXml) {
    zip.file('word/document.xml', nextXml);
  }

  return { convertedParagraphs };
}

function parseReviewDocxXml(xml, partName, errors) {
  const parserMessages = [];
  const collect = (_level, message) => parserMessages.push(cleanString(message));
  const document = new DOMParser({
    onError: collect,
  }).parseFromString(xml, 'application/xml');

  if (!document?.documentElement) {
    errors.push(`${partName} has no XML document element.`);
    return null;
  }

  for (const message of parserMessages) {
    errors.push(`${partName}: ${message.replace(/\s+/g, ' ')}`);
  }

  return document;
}

function xmlTextFromNodes(nodes) {
  let text = '';
  for (let index = 0; index < nodes.length; index += 1) {
    text += nodes[index]?.textContent || '';
  }
  return text;
}

function validateReviewDocxBuffer(buffer, options = {}) {
  const errors = [];
  const warnings = [];
  const baseReport = {
    status: 'error',
    errors,
    warnings,
    paragraphCount: 0,
    imageCount: 0,
    formulaCount: 0,
    markdownCharacterCount: cleanString(options.markdown).length,
  };
  let zip;

  try {
    zip = new PizZip(buffer);
  } catch (error) {
    errors.push(`The generated file is not a readable DOCX package: ${error instanceof Error ? error.message : String(error)}`);
    return baseReport;
  }

  const requiredParts = ['[Content_Types].xml', '_rels/.rels', 'word/document.xml'];
  for (const partName of requiredParts) {
    if (!zip.file(partName)) {
      errors.push(`Missing required DOCX part: ${partName}`);
    }
  }

  const xmlDocuments = new Map();
  for (const partName of Object.keys(zip.files).filter((name) => /(?:\.xml|\.rels)$/i.test(name))) {
    const file = zip.file(partName);
    if (!file) continue;
    const xml = file.asText();
    const parsed = parseReviewDocxXml(xml, partName, errors);
    if (parsed) xmlDocuments.set(partName, parsed);
  }

  const documentFile = zip.file('word/document.xml');
  const documentXml = documentFile?.asText() || '';
  const document = xmlDocuments.get('word/document.xml');
  if (!document || !documentXml) {
    return baseReport;
  }

  const paragraphNodes = document.getElementsByTagName('w:p');
  const textNodes = document.getElementsByTagName('w:t');
  const documentText = xmlTextFromNodes(textNodes);
  const paragraphTexts = [];
  for (let index = 0; index < paragraphNodes.length; index += 1) {
    paragraphTexts.push(xmlTextFromNodes(paragraphNodes[index].getElementsByTagName('w:t')));
  }

  baseReport.paragraphCount = paragraphNodes.length;
  baseReport.formulaCount = document.getElementsByTagName('m:oMath').length;

  if (paragraphNodes.length === 0 || !documentText.trim()) {
    errors.push('The generated Word document does not contain readable paragraphs.');
  }

  const unresolvedTemplatePattern = /__PAPERQUAY_REVIEW_FIGURE_|\{(?:[#/][A-Za-z][^{}]*|title|abstract|content|heading|marker|captionText|formattedText)\}/;
  if (unresolvedTemplatePattern.test(documentXml)) {
    errors.push('The generated Word document still contains unresolved template placeholders.');
  }

  const relationships = new Map();
  const relationshipsDocument = xmlDocuments.get('word/_rels/document.xml.rels');
  if (relationshipsDocument) {
    const relationshipNodes = relationshipsDocument.getElementsByTagName('Relationship');
    for (let index = 0; index < relationshipNodes.length; index += 1) {
      const node = relationshipNodes[index];
      relationships.set(node.getAttribute('Id'), {
        target: cleanString(node.getAttribute('Target')),
        targetMode: cleanString(node.getAttribute('TargetMode')),
        type: cleanString(node.getAttribute('Type')),
      });
    }
  }

  const imageNodes = document.getElementsByTagName('a:blip');
  baseReport.imageCount = imageNodes.length;
  for (let index = 0; index < imageNodes.length; index += 1) {
    const relationshipId = cleanString(imageNodes[index].getAttribute('r:embed'));
    const relationship = relationships.get(relationshipId);
    if (!relationshipId || !relationship) {
      errors.push(`Image ${index + 1} has no valid document relationship.`);
      continue;
    }
    if (relationship.targetMode.toLowerCase() === 'external') continue;

    const targetPath = imageTargetPath(relationship.target);
    if (!zip.file(targetPath)) {
      errors.push(`Image relationship ${relationshipId} points to missing media: ${targetPath}`);
    }
  }

  if (options.strictContent) {
    const expectedTitle = cleanString(options.expectedTitle);
    if (expectedTitle && !documentText.includes(expectedTitle)) {
      warnings.push('The generated Word document does not contain the expected review title.');
    }

    const missingHeadings = (Array.isArray(options.expectedSectionHeadings) ? options.expectedSectionHeadings : [])
      .map(cleanString)
      .filter((heading) => heading && !documentText.includes(heading));
    if (missingHeadings.length > 0) {
      warnings.push(`${missingHeadings.length} expected section heading(s) were not found in the generated Word document.`);
    }
  }

  if (paragraphTexts.some((text) => /^\s*#{1,6}\s+/.test(text) || /^\s*[-+*]\s+/.test(text) || /\*\*[^*]+\*\*/.test(text))) {
    warnings.push('Some Markdown formatting markers remain in the generated Word document.');
  }

  if (/\$\$[\s\S]+?\$\$|\$[^$\n]+\$/.test(documentText)) {
    warnings.push('Some LaTeX formulas could not be converted to editable Word equations and were kept as text.');
  }

  if (/\[\s*(?:Image|Figure|Fig\.?)\s*(?::|#)\s*[A-Za-z0-9_-]+\s*]/i.test(documentText)) {
    warnings.push('Some figure anchors remain as text in the generated Word document.');
  }

  baseReport.status = errors.length > 0 ? 'error' : warnings.length > 0 ? 'warning' : 'passed';
  return baseReport;
}

function readImagePixelSize(buffer, extension) {
  if (extension === 'png' && buffer.length >= 24) {
    return {
      width: readU32BE(buffer,16),
      height: readU32BE(buffer,20),
    };
  }

  if (extension === 'gif' && buffer.length >= 10) {
    return {
      width: readU16LE(buffer,6),
      height: readU16LE(buffer,8),
    };
  }

  if (extension === 'jpeg') {
    let offset = 2;

    while (offset + 9 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }

      const marker = buffer[offset + 1];
      const segmentLength = readU16BE(buffer,offset + 2);

      if (marker >= 0xc0 && marker <= 0xc3 && offset + 8 < buffer.length) {
        return {
          height: readU16BE(buffer,offset + 5),
          width: readU16BE(buffer,offset + 7),
        };
      }

      if (!segmentLength || segmentLength < 2) {
        break;
      }

      offset += 2 + segmentLength;
    }
  }

  return { width: 1200, height: 720 };
}

function imageSizeEmu(buffer, extension) {
  const size = readImagePixelSize(buffer, extension);
  const maxWidth = Math.round(5.8 * WORD_EMU_PER_INCH);
  const maxHeight = Math.round(3.8 * WORD_EMU_PER_INCH);
  const width = Math.max(1, size.width) * WORD_EMU_PER_PIXEL;
  const height = Math.max(1, size.height) * WORD_EMU_PER_PIXEL;
  const scale = Math.min(maxWidth / width, maxHeight / height, 1);

  return {
    cx: Math.round(width * scale),
    cy: Math.round(height * scale),
  };
}

function wordImageParagraph({ relationshipId, docPrId, name, cx, cy }) {
  return `<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:before="120" w:after="80" w:line="320" w:lineRule="auto"/></w:pPr><w:r><w:drawing><wp:inline xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${cx}" cy="${cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${docPrId}" name="${xmlEscape(name)}"/><wp:cNvGraphicFramePr><a:graphicFrameLocks xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${docPrId}" name="${xmlEscape(name)}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${relationshipId}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r></w:p>`;
}

function ensureDocxImageContentTypes(zip) {
  const fileName = '[Content_Types].xml';
  const xml = zip.file(fileName)?.asText();

  if (!xml) {
    return;
  }

  let nextXml = xml;
  const defaults = [
    ['png', 'image/png'],
    ['jpeg', 'image/jpeg'],
    ['jpg', 'image/jpeg'],
    ['gif', 'image/gif'],
  ];

  for (const [extension, contentType] of defaults) {
    if (!new RegExp(`<Default\\s+Extension="${extension}"`, 'i').test(nextXml)) {
      nextXml = nextXml.replace(
        '</Types>',
        `  <Default Extension="${extension}" ContentType="${contentType}"/>\n</Types>`,
      );
    }
  }

  if (nextXml !== xml) {
    zip.file(fileName, nextXml);
  }
}

function documentRelationshipsXml(zip) {
  const fileName = 'word/_rels/document.xml.rels';
  const xml = zip.file(fileName)?.asText();

  return xml?.trim()
    ? xml
    : `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`;
}

async function embedReviewFiguresInDocx(zip, data, outputLanguage = '') {
  const figures = Array.isArray(data?.figures) ? data.figures : [];
  const documentFile = zip.file('word/document.xml');
  const skippedFigures = [];

  if (!documentFile || figures.length === 0) {
    return { skippedFigures };
  }

  ensureDocxImageContentTypes(zip);

  const t = reviewSectionTitles(outputLanguage);
  let documentXml = documentFile.asText();
  let relsXml = documentRelationshipsXml(zip);
  let changed = false;

  for (const [index, figure] of figures.entries()) {
    const marker = `${REVIEW_FIGURE_MARKER_PREFIX}${index + 1}__`;
    const markerParagraphPattern = new RegExp(`<w:p\\b(?:(?!<\\/w:p>)[\\s\\S])*?${regexEscape(marker)}(?:(?!<\\/w:p>)[\\s\\S])*?<\\/w:p>`, 'g');
    const matches = documentXml.match(markerParagraphPattern);
    const figureLabel = cleanString(figure.id) || `${t.figureLabel} ${index + 1}`;

    if (!matches || matches.length === 0) {
      skippedFigures.push({ index, id: figureLabel, reason: `Placeholder ${marker} not found in template.` });
      continue;
    }

    let replacement;
    try {
      const { imageBuffer, extension } = await readReviewFigureImageForDocx(figure, index);
      const mediaName = `paperquay-review-figure-${index + 1}.${extension === 'jpeg' ? 'jpg' : extension}`;
      const relationshipId = `rIdPaperQuayFigure${index + 1}`;
      const { cx, cy } = imageSizeEmu(imageBuffer, extension);

      zip.file(`word/media/${mediaName}`, imageBuffer);

      if (!relsXml.includes(`Id="${relationshipId}"`)) {
        relsXml = relsXml.replace(
          '</Relationships>',
          `  <Relationship Id="${relationshipId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${mediaName}"/>\n</Relationships>`,
        );
      }

      replacement = wordImageParagraph({
        relationshipId,
        docPrId: 1000 + index + 1,
        name: `PaperQuay Figure ${index + 1}`,
        cx,
        cy,
      });
    } catch (figureError) {
      // Skip the broken figure and keep exporting instead of failing the whole document.
      const reason = figureError instanceof Error ? figureError.message : String(figureError);
      skippedFigures.push({ index, id: figureLabel, reason });
      replacement = wordParagraph(`[${t.figureMissing}: ${figureLabel}]`, {
        size: 21,
        align: 'center',
        spacing: { before: 80, after: 80, line: 320 },
      });
      warn(`[PaperQuay] Review figure skipped during Word export: ${reason}`);
    }

    documentXml = documentXml.replace(markerParagraphPattern, replacement);
    changed = true;
  }

  if (changed) {
    zip.file('word/document.xml', documentXml);
    zip.file('word/_rels/document.xml.rels', relsXml);
  }

  return { skippedFigures };
}

function reviewBlockLoopTemplate(loopName, options = {}) {
  const bodySpacing = options.bodySpacing || { before: 0, after: 160, line: 360 };
  const rows = [
    wordParagraph(`{#${loopName}}`),
    wordParagraph('{#isParagraph}'),
    wordParagraph('{text}{suffixText}', { size: 24, firstLine: 480, spacing: bodySpacing }),
    wordParagraph('{/isParagraph}'),
    wordParagraph('{#isList}'),
    wordParagraph('{marker}{text}{suffixText}', { size: 24, leftIndent: 480, hangingIndent: 360, spacing: bodySpacing }),
    wordParagraph('{/isList}'),
    wordParagraph('{#isHeading}'),
    wordParagraph('{text}{suffixText}', { bold: true, size: 24, spacing: { before: 120, after: 80, line: 320 } }),
    wordParagraph('{/isHeading}'),
    wordParagraph('{#isQuote}'),
    wordParagraph('{text}{suffixText}', { italic: true, size: 23, leftIndent: 480, spacing: bodySpacing }),
    wordParagraph('{/isQuote}'),
    wordParagraph('{#isEquation}'),
    wordParagraph('{text}{suffixText}', { size: 24, align: 'center', spacing: bodySpacing }),
    wordParagraph('{/isEquation}'),
  ];

  if (options.includeFigures) {
    rows.push(
      wordParagraph('{#inlineFigures}'),
      wordParagraph('{marker}', { align: 'center', spacing: { before: 80, after: 80, line: 320 } }),
      wordParagraph('{captionText}', { size: 21, align: 'center', spacing: { before: 0, after: 160, line: 300 } }),
      wordParagraph('{/inlineFigures}'),
    );
  }

  rows.push(wordParagraph(`{/${loopName}}`));
  return rows;
}

function defaultReviewTemplateBuffer(outputLanguage = '') {
  const zip = new PizZip();
  const t = reviewSectionTitles(outputLanguage);
  const documentBody = [
    wordParagraph('{title}', { align: 'center', bold: true, size: 32, spacing: { before: 0, after: 240, line: 360 } }),
    wordParagraph(t.abstract, { bold: true, size: 28, spacing: { before: 240, after: 120, line: 320 } }),
    ...reviewBlockLoopTemplate('abstractParagraphs'),
    wordParagraph(`${t.keywordsLabel}{#keywords}{.}; {/keywords}`, { size: 24, spacing: { before: 0, after: 200, line: 320 } }),
    wordParagraph(t.intent, { bold: true, size: 28, spacing: { before: 240, after: 120, line: 320 } }),
    ...reviewBlockLoopTemplate('intentSummaryParagraphs'),
    wordParagraph(t.thesis, { bold: true, size: 28, spacing: { before: 240, after: 120, line: 320 } }),
    ...reviewBlockLoopTemplate('thesisParagraphs'),
    wordParagraph(t.introduction, { bold: true, size: 28, spacing: { before: 240, after: 120, line: 320 } }),
    ...reviewBlockLoopTemplate('introductionParagraphs'),
    wordParagraph(t.body, { bold: true, size: 28, spacing: { before: 240, after: 120, line: 320 } }),
    wordParagraph('{#sections}'),
    wordParagraph('{heading}', { bold: true, size: 26, spacing: { before: 160, after: 80, line: 320 } }),
    ...reviewBlockLoopTemplate('paragraphs', { includeFigures: true }),
    wordParagraph('{/sections}'),
    wordParagraph('{#hasRemainingFigures}'),
    wordParagraph(t.figures, { bold: true, size: 28, spacing: { before: 240, after: 120, line: 320 } }),
    wordParagraph('{#remainingFigures}'),
    wordParagraph(`${REVIEW_FIGURE_MARKER_PREFIX}{number}__`, { align: 'center', spacing: { before: 80, after: 80, line: 320 } }),
    wordParagraph('{captionText}', { size: 21, align: 'center', spacing: { before: 0, after: 160, line: 300 } }),
    wordParagraph('{/remainingFigures}'),
    wordParagraph('{/hasRemainingFigures}'),
    wordParagraph(t.comparison, { bold: true, size: 28, spacing: { before: 240, after: 120, line: 320 } }),
    wordParagraph('{#comparisonTable}'),
    wordParagraph('{theme}：{conclusion} {paperLabelsText}', { size: 24, firstLine: 480, spacing: { before: 0, after: 120, line: 360 } }),
    wordParagraph('{/comparisonTable}'),
    wordParagraph(t.gaps, { bold: true, size: 28, spacing: { before: 240, after: 120, line: 320 } }),
    ...reviewBlockLoopTemplate('researchGapBlocks', { bodySpacing: { before: 0, after: 120, line: 360 } }),
    wordParagraph(t.future, { bold: true, size: 28, spacing: { before: 240, after: 120, line: 320 } }),
    ...reviewBlockLoopTemplate('futureDirectionBlocks', { bodySpacing: { before: 0, after: 120, line: 360 } }),
    wordParagraph(t.conclusion, { bold: true, size: 28, spacing: { before: 240, after: 120, line: 320 } }),
    ...reviewBlockLoopTemplate('conclusionParagraphs'),
    wordParagraph(t.references, { bold: true, size: 28, spacing: { before: 240, after: 120, line: 320 } }),
    wordParagraph('{#references}'),
    wordParagraph('{label} {formattedText}', { size: 22, spacing: { before: 0, after: 120, line: 320 } }),
    wordParagraph('{/references}'),
  ].join('\n');

  zip.file('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Default Extension="png" ContentType="image/png"/>
  <Default Extension="jpg" ContentType="image/jpeg"/>
  <Default Extension="jpeg" ContentType="image/jpeg"/>
  <Default Extension="gif" ContentType="image/gif"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
</Types>`);
  zip.file('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`);
  zip.file('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
</Relationships>`);
  zip.file('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${documentBody}
    <w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
  </w:body>
</w:document>`);

  return zip.generate({
    type: binaryType,
    compression: 'DEFLATE',
  });
}
/** Input must already have passed the caller's source/citation/asset validation. */
async function renderReviewPackage({ data, templateBytes, strictContent = true }) {
 const outputLanguage=cleanString(data?.outputLanguage);
 const template=templateBytes || defaultReviewTemplateBuffer(outputLanguage);
 const zip=new PizZip(template),doc=new Docxtemplater(zip,{paragraphLoop:true,linebreaks:true});
 const docxData=prepareReviewDocxData(data,outputLanguage),markdown=renderPreparedReviewMarkdown(docxData,outputLanguage);
 doc.render(docxData);
 const {skippedFigures}=await embedReviewFiguresInDocx(doc.getZip(),docxData,outputLanguage);
 injectOmmlInDocx(doc.getZip());
 const bytes=doc.getZip().generate({type:binaryType,compression:'DEFLATE'});
 const validation=validateReviewDocxBuffer(bytes,{markdown,strictContent,expectedTitle:docxData.title,expectedSectionHeadings:docxData.sections.map(s=>s.heading)});
 if(validation.errors.length)throw new Error('Generated DOCX validation failed: '+validation.errors.join(' '));
 return{bytes,markdown,skippedFigures,validation};
}

return { normalizeReviewBlueprint, normalizeReviewContextItems, normalizeReviewFigures, normalizeReferenceId, normalizeOptionalNumber, defaultReviewEvidenceIds, normalizeBlueprintTask, normalizeEvidenceIds, stringArrayValue, normalizeReviewSectionHeading, normalizeSectionParagraphTasks, normalizeSelectedReviewFigures, collectReviewFiguresFromContext, defaultReviewFiguresFromContext, buildReviewBlueprintPrompt, reviewContextForPrompt, truncateReviewText, reviewFiguresForPrompt, buildReviewPartPrompt, contextItemsForTask, normalizeReviewGeneratedParts, emptyReviewGeneratedPartsForBlueprint, normalizeGeneratedReviewPartCheckpoint, countCompletedReviewGeneratedParts, composeReviewDraftFromGeneratedParts, mergeReferencesFromBlueprintAndContext, referenceFromContextItem, sourceFromContextItem, normalizeReviewJsonDraft, stripReviewImagePlaceholders, prepareReviewDocxData, reviewSectionTitles, isEnglishReviewOutput, collectInternalCitationIds, formatReferenceText, referencePart, buildReviewFigureAnchorMap, figureAnchorKeys, normalizeReviewFigureAnchorKey, parseReviewMarkdownBlocks, stripOuterReviewMarkdownFence, reviewMarkdownBlock, normalizeReviewMarkdownInline, reviewHeadingKey, stripReviewFigureAnchors, cleanReviewTextAfterFigureAnchorRemoval, reviewBlocksToPlainText, extractInlineReviewFigures, figurePlacementMatchesSection, reviewTextParagraphs, reviewDraftToMarkdown, renderPreparedReviewMarkdown, reviewBlockToMarkdown, reviewFigureToMarkdown, defaultReviewTemplateBuffer, wordParagraph, wordText, xmlEscape, reviewBlockLoopTemplate, injectOmmlInDocx, ensureDocxMathNamespace, injectOmmlIntoParagraph, splitParagraphTextSegments, xmlUnescape, latexToOmml, inlineOmmlRunsFromText, wordRunWithText, validateReviewDocxBuffer, parseReviewDocxXml, xmlTextFromNodes, embedReviewFiguresInDocx, ensureDocxImageContentTypes, documentRelationshipsXml, regexEscape, imageSizeEmu, readImagePixelSize, wordImageParagraph, normalizeGeneratedReviewPart, normalizeReviewWritingConcurrency, reviewWritingTaskCount, mergeGeneratedParagraphParts, REVIEW_MAX_FIGURES_PER_SOURCE, REVIEW_MAX_CONTEXT_PER_TASK, REVIEW_MAX_PARAGRAPHS_PER_SECTION, REVIEW_MAX_SECTION_COUNT, REVIEW_MAX_FIGURES_PER_REVIEW, REVIEW_CONTEXT_SUMMARY_CHAR_LIMIT, REVIEW_TASK_CONTEXT_CHAR_LIMIT, REVIEW_SECTION_TITLES, REVIEW_FIGURE_MARKER_PREFIX, REVIEW_FIGURE_ANCHOR_PATTERN, WORD_EMU_PER_INCH, WORD_EMU_PER_PIXEL, WORD_ASSUMED_IMAGE_DPI, REVIEW_WRITING_CONCURRENCY, REVIEW_MAX_WRITING_CONCURRENCY, renderReviewPackage };
}
module.exports = { createReviewCore };
