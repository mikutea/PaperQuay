const fsp = require('node:fs/promises');
const path = require('node:path');
const { BrowserWindow, dialog, nativeImage, shell } = require('electron');
const { DOMParser } = require('@xmldom/xmldom');
const Docxtemplater = require('docxtemplater');
const temml = require('temml');
const mathml2omml = require('mathml2omml');
const PizZip = require('pizzip');
const {
  cleanString,
  openAiChat,
  parseJsonObject,
  pickChatText,
  safeFileName,
} = require('./utils.cjs');

// Pure review business/Word code is shared with mobile; all IO stays in this adapter.
const { normalizeReviewBlueprint, normalizeReviewContextItems, normalizeReviewFigures, normalizeReferenceId, normalizeOptionalNumber, defaultReviewEvidenceIds, normalizeBlueprintTask, normalizeEvidenceIds, stringArrayValue, normalizeReviewSectionHeading, normalizeSectionParagraphTasks, normalizeSelectedReviewFigures, collectReviewFiguresFromContext, defaultReviewFiguresFromContext, buildReviewBlueprintPrompt, reviewContextForPrompt, truncateReviewText, reviewFiguresForPrompt, buildReviewPartPrompt, contextItemsForTask, normalizeReviewGeneratedParts, emptyReviewGeneratedPartsForBlueprint, normalizeGeneratedReviewPartCheckpoint, countCompletedReviewGeneratedParts, composeReviewDraftFromGeneratedParts, mergeReferencesFromBlueprintAndContext, referenceFromContextItem, sourceFromContextItem, normalizeReviewJsonDraft, stripReviewImagePlaceholders, prepareReviewDocxData, reviewSectionTitles, isEnglishReviewOutput, collectInternalCitationIds, formatReferenceText, referencePart, buildReviewFigureAnchorMap, figureAnchorKeys, normalizeReviewFigureAnchorKey, parseReviewMarkdownBlocks, stripOuterReviewMarkdownFence, reviewMarkdownBlock, normalizeReviewMarkdownInline, reviewHeadingKey, stripReviewFigureAnchors, cleanReviewTextAfterFigureAnchorRemoval, reviewBlocksToPlainText, extractInlineReviewFigures, figurePlacementMatchesSection, reviewTextParagraphs, reviewDraftToMarkdown, renderPreparedReviewMarkdown, reviewBlockToMarkdown, reviewFigureToMarkdown, defaultReviewTemplateBuffer, wordParagraph, wordText, xmlEscape, reviewBlockLoopTemplate, injectOmmlInDocx, ensureDocxMathNamespace, injectOmmlIntoParagraph, splitParagraphTextSegments, xmlUnescape, latexToOmml, inlineOmmlRunsFromText, wordRunWithText, validateReviewDocxBuffer, parseReviewDocxXml, xmlTextFromNodes, embedReviewFiguresInDocx, ensureDocxImageContentTypes, documentRelationshipsXml, regexEscape, imageSizeEmu, readImagePixelSize, wordImageParagraph, normalizeGeneratedReviewPart, normalizeReviewWritingConcurrency, reviewWritingTaskCount, mergeGeneratedParagraphParts, REVIEW_MAX_FIGURES_PER_SOURCE, REVIEW_MAX_CONTEXT_PER_TASK, REVIEW_MAX_PARAGRAPHS_PER_SECTION, REVIEW_MAX_SECTION_COUNT, REVIEW_MAX_FIGURES_PER_REVIEW, REVIEW_CONTEXT_SUMMARY_CHAR_LIMIT, REVIEW_TASK_CONTEXT_CHAR_LIMIT, REVIEW_SECTION_TITLES, REVIEW_FIGURE_MARKER_PREFIX, REVIEW_FIGURE_ANCHOR_PATTERN, WORD_EMU_PER_INCH, WORD_EMU_PER_PIXEL, WORD_ASSUMED_IMAGE_DPI, REVIEW_WRITING_CONCURRENCY, REVIEW_MAX_WRITING_CONCURRENCY, renderReviewPackage } = require('../../packages/review-core/index.cjs').createReviewCore({
  PizZip, Docxtemplater, temml, mathml2omml, DOMParser, binaryType:'nodebuffer',
  readFigure:readReviewFigureImageForDocx,
  imageTargetPath:target=>path.posix.normalize(path.posix.join('word',target.replace(/\\/g,'/'))),
  warn:message=>console.warn(message),
});
const REVIEW_GENERATION_PROGRESS_EVENT = 'paperquay://review-generation-progress';

function isReviewPolicyBlockError(error) {
  const message = error instanceof Error && error.message ? error.message : String(error ?? 'Unknown error');
  const cause = error instanceof Error && error.cause
    ? error.cause instanceof Error
      ? error.cause.message
      : String(error.cause)
    : '';
  const combined = [message, cause].filter(Boolean).join(': ');

  return /HTTP\s+403|content_policy_violation|风控|禁止行为|policy/i.test(combined);
}

function extractReviewServiceError(error) {
  const message = error instanceof Error && error.message ? error.message : String(error ?? 'Unknown error');
  const statusMatch = message.match(/HTTP\s+(\d+)/i);
  const jsonStart = message.indexOf('{');
  let parsed = null;

  if (jsonStart >= 0) {
    try {
      parsed = JSON.parse(message.slice(jsonStart));
    } catch {
      parsed = null;
    }
  }

  return {
    status: statusMatch?.[1] || '',
    type: cleanString(parsed?.error?.type),
    code: cleanString(parsed?.error?.code),
    message: cleanString(parsed?.error?.message),
  };
}

function isLikelyMojibakeText(value) {
  const text = cleanString(value);
  return /妯″瀷|缁艰堪|璇锋眰|鎷掔粷|椋庢帶|鍐欎綔|妫€娴嬪埌|绂佹|鍙兘|鎻愰棶|鍘熷閿欒/.test(text);
}

function reviewErrorMessage(error) {
  const message = error instanceof Error && error.message ? error.message : String(error ?? 'Unknown error');
  const cause = error instanceof Error && error.cause
    ? error.cause instanceof Error
      ? error.cause.message
      : String(error.cause)
    : '';
  const combined = [message, cause].filter(Boolean).join(': ');

  if (/fetch failed|ECONNREFUSED|ENOTFOUND|ETIMEDOUT|ECONNRESET|network/i.test(combined)) {
    return [
      'REVIEW_NETWORK_ERROR: Failed to connect to the model service.',
      'Check the model Base URL, API key, network connection, or proxy settings, then try again.',
      cause ? `Cause: ${cause}` : '',
    ].filter(Boolean).join(' ');
  }

  if (isReviewPolicyBlockError(error)) {
    const serviceError = extractReviewServiceError(error);
    const serviceParts = [
      serviceError.status ? `HTTP ${serviceError.status}` : '',
      serviceError.type,
      serviceError.code,
    ].filter(Boolean).join(' / ');
    const readableServiceMessage =
      serviceError.message && !isLikelyMojibakeText(serviceError.message)
        ? serviceError.message
        : '';

    return [
      'REVIEW_POLICY_BLOCKED: The model provider blocked this literature-review request.',
      'This is usually provider-side moderation, the selected API mode, or one retrieved paper/note excerpt.',
      'Try Settings > Models > Review Writing: switch to a model suitable for long-form academic writing, or set this preset to Chat Completions.',
      serviceParts ? `服务返回：${serviceParts}` : '',
      readableServiceMessage ? `Service message: ${readableServiceMessage}` : '',
    ].filter(Boolean).join(' ');
  }

  return message;
}

function emitReviewGenerationProgress(sender, requestId, payload) {
  const id = cleanString(requestId);

  if (!sender || !id || typeof sender.send !== 'function') {
    return;
  }

  sender.send('paperquay:event', REVIEW_GENERATION_PROGRESS_EVENT, {
    requestId: id,
    updatedAt: Date.now(),
    ...payload,
  });
}

async function callReviewJsonModel(options, messages) {
  try {
    const data = await openAiChat(
      options,
      messages,
      { responseFormat: { type: 'json_object' } },
    );
    return parseJsonObject(pickChatText(data));
  } catch (error) {
    throw new Error(reviewErrorMessage(error));
  }
}

async function runReviewWritingTasks(tasks, concurrency = REVIEW_WRITING_CONCURRENCY) {
  const workerCount = Math.max(1, Math.min(normalizeReviewWritingConcurrency(concurrency), tasks.length));
  let nextIndex = 0;
  const errors = [];

  // Run every task to completion so already-finished parts are emitted and
  // checkpointed even when sibling tasks fail; aggregate errors afterwards.
  const workers = Array.from({ length: workerCount }, async () => {
    while (nextIndex < tasks.length) {
      const taskIndex = nextIndex;
      nextIndex += 1;

      try {
        await tasks[taskIndex]();
      } catch (error) {
        errors.push(error);
      }
    }
  });

  await Promise.all(workers);

  if (errors.length > 0) {
    const firstMessage = errors[0] instanceof Error ? errors[0].message : String(errors[0]);
    throw new Error(
      errors.length === 1
        ? firstMessage
        : `${errors.length} writing tasks failed (completed parts are kept for resume). First error: ${firstMessage}`,
    );
  }
}

async function generateReviewBlueprint(options, sender) {
  const contextItems = normalizeReviewContextItems(options.contextItems);
  const requestId = cleanString(options.requestId);
  const emitProgress = (payload) => emitReviewGenerationProgress(sender, requestId, payload);

  emitProgress({
    phase: 'blueprint',
    taskKind: 'blueprint',
    status: 'running',
    current: 0,
    total: 1,
  });

  const blueprintRaw = await callReviewJsonModel(options, buildReviewBlueprintPrompt(options));
  const blueprint = normalizeReviewBlueprint(blueprintRaw, { ...options, contextItems });
  const writingTaskCount = reviewWritingTaskCount(blueprint);
  const totalTasks = 1 + writingTaskCount + 1;

  emitProgress({
    phase: 'blueprint',
    taskKind: 'blueprint',
    status: 'done',
    current: 1,
    total: totalTasks,
    sectionTotal: blueprint.sections.length,
  });

  return blueprint;
}

async function generateReviewJsonDraftFromBlueprint(options, sender) {
  const contextItems = normalizeReviewContextItems(options.contextItems);
  const blueprint = normalizeReviewBlueprint(options.blueprint, { ...options, contextItems });
  const validIds = new Set(contextItems.map((item) => normalizeReferenceId(item.id)));
  const requestId = cleanString(options.requestId);
  const emitProgress = (payload) => emitReviewGenerationProgress(sender, requestId, payload);
  const writingTaskCount = reviewWritingTaskCount(blueprint);
  const totalTasks = 1 + writingTaskCount + 1;
  const generatedParts = normalizeReviewGeneratedParts(options.resumeParts, blueprint, validIds);
  let completedTasks = 1 + countCompletedReviewGeneratedParts(generatedParts);

  emitProgress({
    phase: 'writing',
    taskKind: 'abstract',
    status: 'running',
    current: completedTasks,
    total: totalTasks,
  });

  const generatePart = async (kind, heading, task) => normalizeGeneratedReviewPart(
    await callReviewJsonModel(
      options,
      buildReviewPartPrompt({ options, blueprint, kind, heading, task, contextItems }),
    ),
    task,
    validIds,
  );
  const generateProgressPart = async (taskKey, progress, kind, heading, task) => {
    emitProgress({
      phase: 'writing',
      taskKind: kind,
      status: 'running',
      taskKey,
      heading: cleanString(heading),
      current: completedTasks,
      total: totalTasks,
      ...progress,
    });

    const part = await generatePart(kind, heading, task);
    completedTasks += 1;

    emitProgress({
      phase: 'writing',
      taskKind: kind,
      status: 'done',
      taskKey,
      heading: cleanString(heading),
      current: completedTasks,
      total: totalTasks,
      generatedPart: part,
      ...progress,
    });

    return part;
  };
  const parts = {
    abstract: generatedParts.abstract,
    introduction: generatedParts.introduction,
    sections: [],
    comparisonTable: generatedParts.comparisonTable,
    researchGaps: generatedParts.researchGaps,
    futureDirections: generatedParts.futureDirections,
    conclusion: generatedParts.conclusion,
  };
  const writingTasks = [];
  const sectionParagraphResults = generatedParts.sectionParagraphs.map((section) => [...section]);

  const enqueueWritingTask = (existingPart, assign, taskKey, progress, kind, heading, task) => {
    if (existingPart) {
      return;
    }

    writingTasks.push(async () => {
      try {
        assign(await generateProgressPart(taskKey, progress, kind, heading, task));
      } catch (error) {
        emitProgress({
          phase: 'writing',
          taskKind: kind,
          status: 'error',
          taskKey,
          heading: cleanString(heading),
          current: completedTasks,
          total: totalTasks,
          message: error instanceof Error ? error.message : String(error),
          ...progress,
        });
        throw error;
      }
    });
  };

  enqueueWritingTask(
    parts.abstract,
    (part) => {
      parts.abstract = part;
    },
    'abstract',
    {},
    'abstract',
    'Abstract',
    blueprint.abstractTask,
  );
  enqueueWritingTask(
    parts.introduction,
    (part) => {
      parts.introduction = part;
    },
    'introduction',
    {},
    'introduction',
    'Introduction',
    blueprint.introductionTask,
  );

  for (const [sectionIndex, section] of blueprint.sections.entries()) {
    const paragraphTasks = section.paragraphTasks || [section];

    for (const [paragraphIndex, paragraphTask] of paragraphTasks.entries()) {
      enqueueWritingTask(
        sectionParagraphResults[sectionIndex][paragraphIndex],
        (part) => {
          sectionParagraphResults[sectionIndex][paragraphIndex] = part;
        },
        `section:${sectionIndex}:paragraph:${paragraphIndex}`,
        {
          sectionIndex: sectionIndex + 1,
          sectionTotal: blueprint.sections.length,
          paragraphIndex: paragraphIndex + 1,
          paragraphTotal: paragraphTasks.length,
        },
        'section_paragraph',
        section.heading,
        paragraphTask,
      );
    }
  }

  for (const [index, row] of blueprint.comparisonTable.entries()) {
    enqueueWritingTask(
      parts.comparisonTable[index],
      (part) => {
        parts.comparisonTable[index] = part;
      },
      `comparison:${index}`,
      {
        itemIndex: index + 1,
        itemTotal: blueprint.comparisonTable.length,
      },
      'comparison',
      row.theme,
      row,
    );
  }

  for (const [index, gap] of blueprint.researchGaps.entries()) {
    enqueueWritingTask(
      parts.researchGaps[index],
      (part) => {
        parts.researchGaps[index] = part;
      },
      `researchGap:${index}`,
      {
        itemIndex: index + 1,
        itemTotal: blueprint.researchGaps.length,
      },
      'research_gap',
      'Research Gap',
      gap,
    );
  }

  for (const [index, direction] of blueprint.futureDirections.entries()) {
    enqueueWritingTask(
      parts.futureDirections[index],
      (part) => {
        parts.futureDirections[index] = part;
      },
      `futureDirection:${index}`,
      {
        itemIndex: index + 1,
        itemTotal: blueprint.futureDirections.length,
      },
      'future_direction',
      'Future Direction',
      direction,
    );
  }

  enqueueWritingTask(
    parts.conclusion,
    (part) => {
      parts.conclusion = part;
    },
    'conclusion',
    {},
    'conclusion',
    'Conclusion',
    blueprint.conclusionTask,
  );

  if (writingTasks.length > 0) {
    await runReviewWritingTasks(writingTasks, options.writingConcurrency);
  }
  parts.sections = sectionParagraphResults.map((paragraphs) => mergeGeneratedParagraphParts(paragraphs));

  emitProgress({
    phase: 'merge',
    taskKind: 'merge',
    status: 'running',
    current: completedTasks,
    total: totalTasks,
  });

  const draft = composeReviewDraftFromGeneratedParts({ blueprint, contextItems, parts });

  emitProgress({
    phase: 'done',
    taskKind: 'done',
    status: 'done',
    current: totalTasks,
    total: totalTasks,
  });

  return draft;
}

async function generateReviewJsonDraftLayered(options, sender) {
  const blueprint = await generateReviewBlueprint(options, sender);
  return generateReviewJsonDraftFromBlueprint({ ...options, blueprint }, sender);
}

function splitReviewParagraphs(value) {
  return parseReviewMarkdownBlocks(value)
    .map((block) => `${block.marker || ''}${block.text || ''}`.trim())
    .filter(Boolean);
}

function formatDocxtemplaterError(error) {
  const properties = error?.properties;
  const errors = Array.isArray(properties?.errors)
    ? properties.errors.map((item) => item.properties?.explanation || item.message).filter(Boolean)
    : [];
  const message = error instanceof Error ? error.message : String(error);

  if (/corrupt|zip|end of data|central directory/i.test(message)) {
    return 'Selected template is not a valid .docx Word file. Choose an existing Word .docx template, or leave the template empty to use PaperQuay built-in template.';
  }

  return errors.length > 0
    ? errors.join('\n')
    : message;
}

function imageExtensionForDocx(filePath) {
  const extension = path.extname(cleanString(filePath)).replace(/^\./, '').toLowerCase();

  if (extension === 'jpg' || extension === 'jpeg') {
    return 'jpeg';
  }

  if (extension === 'png' || extension === 'gif') {
    return extension;
  }

  return '';
}

function imageExtensionFromBuffer(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 4) {
    return '';
  }

  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return 'png';
  }

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return 'jpeg';
  }

  if (buffer.subarray(0, 4).toString('ascii') === 'GIF8') {
    return 'gif';
  }

  return '';
}

function convertImageToPngForDocx(filePath) {
  if (!nativeImage || typeof nativeImage.createFromPath !== 'function') {
    return null;
  }

  const image = nativeImage.createFromPath(filePath);
  if (!image || image.isEmpty()) {
    return null;
  }

  const buffer = image.toPNG();
  return buffer?.length ? buffer : null;
}

async function readReviewFigureImageForDocx(figure, index) {
  const imagePath = cleanString(figure.path);
  const label = cleanString(figure.id) || `figure ${index + 1}`;

  if (!imagePath) {
    throw new Error(`Review figure ${label} has no local image path.`);
  }

  let stat = null;
  try {
    stat = await fsp.stat(imagePath);
  } catch (error) {
    throw new Error(`Review figure ${label} image file cannot be found: ${imagePath}. ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!stat.isFile()) {
    throw new Error(`Review figure ${label} image path is not a file: ${imagePath}`);
  }

  let fileBuffer;
  try {
    fileBuffer = await fsp.readFile(imagePath);
  } catch (error) {
    throw new Error(`Review figure ${label} image file cannot be read: ${imagePath}. ${error instanceof Error ? error.message : String(error)}`);
  }

  let extension = imageExtensionFromBuffer(fileBuffer);
  let imageBuffer = extension ? fileBuffer : null;

  if (!imageBuffer) {
    imageBuffer = convertImageToPngForDocx(imagePath);
    extension = imageBuffer ? 'png' : '';
  }

  if (!imageBuffer || !extension) {
    const pathExtension = path.extname(imagePath).replace(/^\./, '') || 'none';
    throw new Error(`Review figure ${label} image format is not supported by Word export: ${imagePath}. File extension: ${pathExtension}; bytes: ${fileBuffer.length}.`);
  }

  return { imageBuffer, extension, imagePath };
}

async function renderReviewDocxTemplate({ templatePath, outputPath, data }) {
 try {
  const template=cleanString(templatePath),templateBytes=template?await fsp.readFile(template):undefined;
  const {bytes,skippedFigures,validation}=await renderReviewPackage({data,templateBytes,strictContent:!template});
  await fsp.mkdir(path.dirname(outputPath),{recursive:true});await fsp.writeFile(outputPath,bytes);
  return{outputPath,byteSize:bytes.byteLength,skippedFigures,validation};
 }catch(error){throw new Error('Word template export failed: '+formatDocxtemplaterError(error));}
}

function createReviewCommands(context) {
  const { approvedWritePaths } = context;

  return {
    async review_select_docx_template(_args, event) {
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = await dialog.showOpenDialog(win, {
        title: 'Select Word review template',
        properties: ['openFile'],
        filters: [{ name: 'Word Template', extensions: ['docx'] }],
      });

      return result.canceled ? null : result.filePaths[0] ?? null;
    },

    async review_select_docx_output_path({ suggestedFileName }, event) {
      const win = BrowserWindow.fromWebContents(event.sender);
      const normalizedFileName = safeFileName(cleanString(suggestedFileName) || 'PaperQuay-literature-review.docx', 'PaperQuay-literature-review.docx')
        .replace(/\.(?!docx$)[^.]+$/i, '');
      const finalName = normalizedFileName.toLowerCase().endsWith('.docx')
        ? normalizedFileName
        : `${normalizedFileName}.docx`;
      const result = await dialog.showSaveDialog(win, {
        title: 'Export literature review',
        defaultPath: finalName,
        filters: [{ name: 'Word Document', extensions: ['docx'] }],
      });

      if (result.canceled || !result.filePath) {
        return null;
      }

      approvedWritePaths.add(path.resolve(result.filePath));
      return result.filePath;
    },

    async review_generate_structured_json_openai_compatible({ options }, event) {
      return generateReviewJsonDraftLayered(options, event?.sender);
    },

    async review_generate_blueprint_openai_compatible({ options }, event) {
      return generateReviewBlueprint(options, event?.sender);
    },

    async review_generate_structured_json_from_blueprint_openai_compatible({ options }, event) {
      return generateReviewJsonDraftFromBlueprint(options, event?.sender);
    },

    async review_export_docx({ templatePath, outputPath, data }) {
      const template = cleanString(templatePath);
      const output = cleanString(outputPath);

      if (template && !template.toLowerCase().endsWith('.docx')) {
        throw new Error('Template must be a .docx file');
      }

      if (!output.toLowerCase().endsWith('.docx')) {
        throw new Error('Output path must be a .docx file');
      }

      const resolvedOutput = path.resolve(output);
      if (!approvedWritePaths.has(resolvedOutput)) {
        throw new Error(`Writing to this path is not allowed until approved: ${output}`);
      }

      return renderReviewDocxTemplate({
        templatePath: template,
        outputPath: resolvedOutput,
        data,
      });
    },

    async review_open_output({ path: outputPath }) {
      const target = cleanString(outputPath);
      if (!target) return;
      await shell.openPath(target);
    },
  };
}

module.exports = {
  buildReviewBlueprintPrompt,
  buildReviewPartPrompt,
  composeReviewDraftFromGeneratedParts,
  createReviewCommands,
  defaultReviewTemplateBuffer,
  generateReviewBlueprint,
  generateReviewJsonDraftLayered,
  generateReviewJsonDraftFromBlueprint,
  injectOmmlInDocx,
  latexToOmml,
  countCompletedReviewGeneratedParts,
  normalizeReviewGeneratedParts,
  normalizeReviewJsonDraft,
  normalizeReviewBlueprint,
  parseReviewMarkdownBlocks,
  prepareReviewDocxData,
  renderReviewDocxTemplate,
  reviewDraftToMarkdown,
  validateReviewDocxBuffer,
};
