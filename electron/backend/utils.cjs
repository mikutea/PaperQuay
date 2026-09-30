const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const crypto = require('node:crypto');
const { createParser } = require('eventsource-parser');

const QA_STREAM_EVENT = 'paperquay://qa-stream';
const AGENT_STREAM_EVENT = 'paperquay://agent-stream';
const MINERU_API_BASE = 'https://mineru.net/api/v4';

function now() {
  return Date.now();
}

function id(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`;
}

function toError(error) {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string') return error;
  return String(error ?? 'Unknown error');
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function safeFileName(name, fallback = 'paper.pdf') {
  const cleaned = cleanString(name) || fallback;
  return cleaned.replace(/[\\/:*?"<>|]+/g, '_');
}

function fileNameFromPath(filePath) {
  return path.basename(String(filePath || '')) || 'paper.pdf';
}

function isPdf(filePath) {
  return String(filePath || '').trim().toLowerCase().endsWith('.pdf');
}

function readJson(filePath, fallback) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return fallback;
  }
}

async function writeJson(filePath, value) {
  await fsp.mkdir(path.dirname(filePath), { recursive: true });
  await fsp.writeFile(filePath, JSON.stringify(value, null, 2), 'utf8');
}

function writeJsonSync(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2), 'utf8');
}

async function pathExists(filePath) {
  try {
    const stat = await fsp.stat(filePath);
    return stat.isFile() && stat.size > 0;
  } catch {
    return false;
  }
}

async function ensureFile(filePath) {
  const stat = await fsp.stat(filePath);
  if (!stat.isFile()) {
    throw new Error(`Path is not a file: ${filePath}`);
  }
}

function hashBytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

async function hashFile(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);

    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

function normalizeBaseUrl(baseUrl) {
  const trimmed = cleanString(baseUrl).replace(/\/+$/, '');
  if (!trimmed) return '';
  if (/\/v\d+$/i.test(trimmed)) return trimmed;
  if (/\/(chat\/completions|embeddings|models|responses?)$/i.test(trimmed)) {
    return trimmed.replace(/\/(chat\/completions|embeddings|models|responses?)$/i, '');
  }
  return `${trimmed}/v1`;
}

function normalizeApiMode(apiMode) {
  return apiMode === 'responses' ? 'responses' : 'chat_completions';
}

function chatEndpoint(baseUrl) {
  const trimmed = cleanString(baseUrl).replace(/\/+$/, '');
  if (/\/chat\/completions$/i.test(trimmed)) return trimmed;
  return `${normalizeBaseUrl(trimmed)}/chat/completions`;
}

function responsesEndpoint(baseUrl) {
  const trimmed = cleanString(baseUrl).replace(/\/+$/, '');
  if (/\/responses?$/i.test(trimmed)) {
    return trimmed.replace(/\/response$/i, '/responses');
  }
  return `${normalizeBaseUrl(trimmed)}/responses`;
}

function completionEndpoint(options) {
  return normalizeApiMode(options?.apiMode) === 'responses'
    ? responsesEndpoint(options?.baseUrl)
    : chatEndpoint(options?.baseUrl);
}

function embeddingsEndpoint(baseUrl) {
  const trimmed = cleanString(baseUrl).replace(/\/+$/, '');
  if (/\/embeddings$/i.test(trimmed)) return trimmed;
  return `${normalizeBaseUrl(trimmed)}/embeddings`;
}

function modelsEndpoint(baseUrl) {
  const trimmed = cleanString(baseUrl).replace(/\/+$/, '');
  if (/\/models$/i.test(trimmed)) return trimmed;
  return `${normalizeBaseUrl(trimmed)}/models`;
}

async function readRequestJson(response, label) {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`${label} HTTP ${response.status}: ${text}`);
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    if (isLikelySseResponse(response, text)) {
      return parseSseJsonResponse(text, label);
    }

    throw new Error(`${label} returned invalid JSON: ${toError(error)}`);
  }
}

function isLikelySseResponse(response, text) {
  const contentType = cleanString(response.headers.get('content-type')).toLowerCase();
  return contentType.includes('text/event-stream') || /^\s*(event:|data:)/i.test(text);
}

function mergeChatCompletionChunks(chunks) {
  let base = null;
  const roleByChoice = new Map();
  const contentByChoice = new Map();
  const reasoningByChoice = new Map();
  const toolCallsByChoice = new Map();

  for (const chunk of chunks) {
    if (!base) {
      base = {
        id: chunk.id,
        object: chunk.object || 'chat.completion',
        created: chunk.created,
        model: chunk.model,
        choices: [],
      };
    }

    for (const choice of Array.isArray(chunk.choices) ? chunk.choices : []) {
      const index = Number.isFinite(choice.index) ? choice.index : 0;
      const delta = choice.delta ?? {};
      const previous = contentByChoice.get(index) ?? '';
      const nextContent = previous + (typeof delta.content === 'string' ? delta.content : '');
      contentByChoice.set(index, nextContent);

      const reasoningDelta = [
        delta.reasoning_content,
        delta.reasoningContent,
        delta.thinking,
      ].filter((item) => typeof item === 'string').join('');

      if (reasoningDelta) {
        reasoningByChoice.set(index, (reasoningByChoice.get(index) ?? '') + reasoningDelta);
      }

      if (delta.role) {
        roleByChoice.set(index, delta.role);
      }

      if (Array.isArray(delta.tool_calls)) {
        const toolCalls = toolCallsByChoice.get(index) ?? [];

        for (const toolCallDelta of delta.tool_calls) {
          const toolIndex = Number.isFinite(toolCallDelta.index) ? toolCallDelta.index : toolCalls.length;
          const currentToolCall = toolCalls[toolIndex] ?? {
            id: '',
            type: 'function',
            function: { name: '', arguments: '' },
          };
          const currentFunction = currentToolCall.function ?? { name: '', arguments: '' };
          const nextFunction = {
            ...currentFunction,
            name: currentFunction.name || cleanString(toolCallDelta.function?.name),
            arguments: `${currentFunction.arguments ?? ''}${typeof toolCallDelta.function?.arguments === 'string' ? toolCallDelta.function.arguments : ''}`,
          };

          toolCalls[toolIndex] = {
            ...currentToolCall,
            id: currentToolCall.id || cleanString(toolCallDelta.id),
            type: currentToolCall.type || cleanString(toolCallDelta.type) || 'function',
            function: nextFunction,
          };
        }

        toolCallsByChoice.set(index, toolCalls);
      }

      base.choices[index] = {
        index,
        message: {
          role: roleByChoice.get(index) ?? 'assistant',
          content: nextContent,
          reasoning_content: reasoningByChoice.get(index) || undefined,
          tool_calls: toolCallsByChoice.get(index)?.filter((toolCall) => toolCall?.function?.name) || undefined,
        },
        finish_reason: choice.finish_reason ?? base.choices[index]?.finish_reason ?? null,
      };
    }
  }

  return base;
}

function mergeResponsesChunks(chunks) {
  const outputParts = [];
  const reasoningSummaryParts = [];
  let base = null;

  for (const chunk of chunks) {
    if (!base) {
      base = {
        id: chunk.response?.id ?? chunk.id,
        object: 'response',
        output: [{ type: 'message', content: [{ type: 'output_text', text: '' }] }],
      };
    }

    const eventType = cleanString(chunk.type).toLowerCase();

    if (
      eventType === 'response.output_text.delta' ||
      eventType === 'response.text.delta' ||
      (!eventType && typeof chunk.delta === 'string')
    ) {
      outputParts.push(chunk.delta);
    } else if (
      eventType === 'response.reasoning_summary_text.delta' ||
      eventType === 'response.reasoning_summary.delta'
    ) {
      reasoningSummaryParts.push(chunk.delta);
    } else if (typeof chunk.output_text === 'string') {
      outputParts.push(chunk.output_text);
    } else if (typeof chunk.text === 'string' && !eventType.includes('reason')) {
      outputParts.push(chunk.text);
    }

    if ((chunk.type === 'response.completed' || chunk.type === 'response.done') && chunk.response) {
      base = chunk.response;
    }
  }

  const outputText = outputParts.join('');
  const reasoningSummaryText = reasoningSummaryParts.join('');

  if (Array.isArray(base?.output) && base.output.length > 0) {
    return {
      ...base,
      output_text: cleanString(base.output_text) || outputText,
    };
  }

  if (outputText || reasoningSummaryText) {
    const output = [];

    if (reasoningSummaryText) {
      output.push({
        type: 'reasoning',
        summary: [{ type: 'summary_text', text: reasoningSummaryText }],
      });
    }

    if (outputText) {
      output.push({ type: 'message', content: [{ type: 'output_text', text: outputText }] });
    }

    return {
      ...base,
      output_text: outputText,
      output,
    };
  }

  return base;
}

function parseSseJsonResponse(text, label) {
  const chunks = [];
  const parser = createParser({
    onEvent(event) {
      const data = cleanString(event.data);

      if (!data || data === '[DONE]') {
        return;
      }

      chunks.push(JSON.parse(data));
    },
  });

  try {
    parser.feed(text);
    parser.reset({ consume: true });
  } catch (error) {
    throw new Error(`${label} returned invalid SSE JSON: ${toError(error)}`);
  }

  if (chunks.length === 0) {
    throw new Error(`${label} returned empty SSE response`);
  }

  const last = chunks[chunks.length - 1];

  if (chunks.some((chunk) => Array.isArray(chunk?.choices))) {
    return mergeChatCompletionChunks(chunks);
  }

  if (chunks.some((chunk) => typeof chunk?.type === 'string' && chunk.type.startsWith('response.'))) {
    return mergeResponsesChunks(chunks);
  }

  return last;
}

function applyCommonGenerationOptions(body, options) {
  if (typeof options.temperature === 'number') {
    body.temperature = options.temperature;
  }

  Object.keys(body).forEach((key) => body[key] === undefined && delete body[key]);
  return body;
}

function buildChatRequestBody(options, messages, extra = {}) {
  const body = applyCommonGenerationOptions({
    model: options.model,
    messages: messagesToChatCompletionsMessages(messages),
    stream: extra.stream,
    response_format: extra.responseFormat,
    tools: extra.tools,
    tool_choice: extra.toolChoice,
  }, options);

  if (options.reasoningEffort && options.reasoningEffort !== 'auto') {
    body.reasoning_effort = options.reasoningEffort;
  }

  return body;
}

function attachmentToImageUrl(attachment) {
  if (!attachment || typeof attachment !== 'object') return null;
  const kind = cleanString(attachment.kind);
  const mimeType = cleanString(attachment.mimeType).toLowerCase();
  const dataUrl = cleanString(attachment.dataUrl);

  if (!dataUrl || (kind !== 'image' && kind !== 'screenshot' && !mimeType.startsWith('image/'))) {
    return null;
  }

  if (!/^data:image\/[a-z0-9.+-]+;base64,/i.test(dataUrl)) {
    return null;
  }

  return dataUrl;
}

function attachmentTextSummary(attachment) {
  if (!attachment || typeof attachment !== 'object') return '';
  return [
    cleanString(attachment.name),
    cleanString(attachment.summary),
    cleanString(attachment.textContent),
  ].filter(Boolean).join('\n');
}

function messagePlainTextWithAttachments(message) {
  const content = cleanString(message?.content);
  const attachmentText = (Array.isArray(message?.attachments) ? message.attachments : [])
    .map(attachmentTextSummary)
    .filter(Boolean)
    .join('\n\n');

  return [content, attachmentText ? `[Attachments]\n${attachmentText}` : '']
    .filter(Boolean)
    .join('\n\n');
}

function messagesToChatCompletionsMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map((message) => {
    const role = message?.role === 'assistant' ? 'assistant' : message?.role === 'system' ? 'system' : 'user';
    const text = messagePlainTextWithAttachments(message);
    const imageParts = (Array.isArray(message?.attachments) ? message.attachments : [])
      .map(attachmentToImageUrl)
      .filter(Boolean)
      .map((url) => ({ type: 'image_url', image_url: { url } }));

    if (role === 'system' || imageParts.length === 0) {
      return { role, content: text };
    }

    return {
      role,
      content: [
        { type: 'text', text: text || 'Please inspect the attached image.' },
        ...imageParts,
      ],
    };
  });
}

function responseToolFromChatTool(tool) {
  if (!tool || typeof tool !== 'object') return tool;
  if (tool.type === 'function' && tool.function && typeof tool.function === 'object') {
    return {
      type: 'function',
      name: tool.function.name,
      description: tool.function.description,
      parameters: tool.function.parameters,
      strict: tool.function.strict,
    };
  }
  return tool;
}

function responseToolChoiceFromChatToolChoice(toolChoice) {
  if (!toolChoice || typeof toolChoice === 'string') return toolChoice;
  if (toolChoice.type === 'function' && toolChoice.function?.name) {
    return {
      type: 'function',
      name: toolChoice.function.name,
    };
  }
  return toolChoice;
}

function messagesToResponseInput(messages) {
  const instructions = [];
  const inputItems = [];

  for (const message of messages ?? []) {
    const role = message?.role === 'assistant' ? 'assistant' : message?.role === 'system' ? 'system' : 'user';
    const content = messagePlainTextWithAttachments(message);

    if (role === 'system') {
      if (content) instructions.push(content);
    } else {
      const parts = [];
      if (content) {
        parts.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text: content });
      }

      for (const attachment of Array.isArray(message?.attachments) ? message.attachments : []) {
        const imageUrl = attachmentToImageUrl(attachment);
        if (imageUrl && role === 'user') {
          parts.push({ type: 'input_image', image_url: imageUrl });
        }
      }

      if (parts.length > 0) {
        inputItems.push({ role, content: parts });
      }
    }
  }

  return {
    instructions: instructions.join('\n\n'),
    input: inputItems.length > 0 ? inputItems : '',
  };
}

function buildResponsesRequestBody(options, messages, extra = {}) {
  const responseInput = messagesToResponseInput(messages);
  const requiresJsonObject = extra.responseFormat?.type === 'json_object';
  const hasStructuredInput = Array.isArray(responseInput.input);
  const inputText = hasStructuredInput
    ? ''
    : responseInput.input;
  const input = requiresJsonObject && !hasStructuredInput && !/\bjson\b/i.test(inputText)
    ? `Return valid JSON only.\n\n${inputText}`
    : responseInput.input;
  const tools = Array.isArray(extra.tools) && extra.tools.length > 0
    ? extra.tools.map(responseToolFromChatTool)
    : undefined;
  const body = applyCommonGenerationOptions({
    model: options.model,
    input,
    instructions: responseInput.instructions || undefined,
    stream: extra.stream,
    text: extra.responseFormat ? { format: extra.responseFormat } : undefined,
    tools,
    tool_choice: responseToolChoiceFromChatToolChoice(extra.toolChoice),
  }, options);

  const reasoning = {};

  if (options.reasoningEffort && options.reasoningEffort !== 'auto') {
    reasoning.effort = options.reasoningEffort;
  }

  if (['auto', 'concise', 'detailed'].includes(extra.reasoningSummary)) {
    reasoning.summary = extra.reasoningSummary;
  }

  if (Object.keys(reasoning).length > 0) {
    body.reasoning = reasoning;
  }

  return body;
}

async function openAiChat(options, messages, extra = {}) {
  const apiMode = normalizeApiMode(options?.apiMode);
  const body = apiMode === 'responses'
    ? buildResponsesRequestBody(options, messages, extra)
    : buildChatRequestBody(options, messages, extra);
  const timeoutMs = Number.isFinite(extra.timeoutMs) ? Math.max(1, Math.trunc(extra.timeoutMs)) : 0;

  const response = await fetch(completionEndpoint(options), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined,
  });

  if (extra.stream) return response;
  return readRequestJson(
    response,
    apiMode === 'responses' ? 'OpenAI-compatible responses' : 'OpenAI-compatible chat',
  );
}

async function listOpenAiModels(options) {
  const endpoint = modelsEndpoint(options.baseUrl);
  const headers = {};
  const apiKey = cleanString(options.apiKey);

  if (apiKey) {
    headers.Authorization = `Bearer ${apiKey}`;
  }

  const response = await fetch(endpoint, {
    method: 'GET',
    headers,
  });
  const data = await readRequestJson(response, 'OpenAI-compatible models');
  const models = (Array.isArray(data?.data) ? data.data : [])
    .map((item) => ({
      id: cleanString(typeof item === 'string' ? item : item?.id),
      ownedBy: cleanString(item?.owned_by || item?.ownedBy) || undefined,
      created: typeof item?.created === 'number' && Number.isFinite(item.created)
        ? item.created
        : undefined,
    }))
    .filter((item) => item.id)
    .sort((left, right) => left.id.localeCompare(right.id));

  return {
    endpoint,
    models,
  };
}

function stripThinkBlocksFromText(text) {
  const source = String(text ?? '');
  const withoutClosedBlocks = source.replace(/<think\b[^>]*>[\s\S]*?<\/think>/gi, '').trim();
  const openThinkMatch = withoutClosedBlocks.match(/<think\b[^>]*>/i);

  if (!openThinkMatch || openThinkMatch.index === undefined) {
    return withoutClosedBlocks;
  }

  return withoutClosedBlocks.slice(0, openThinkMatch.index).trim();
}

function pickChatText(data) {
  const outputText = stripThinkBlocksFromText(data?.output_text);
  if (outputText) return outputText;

  const chatText = stripThinkBlocksFromText(data?.choices?.[0]?.message?.content);
  if (chatText) return chatText;

  const responseParts = [];

  for (const outputItem of Array.isArray(data?.output) ? data.output : []) {
    if (cleanString(outputItem?.type).toLowerCase().includes('reason')) {
      continue;
    }

    for (const contentItem of Array.isArray(outputItem?.content) ? outputItem.content : []) {
      if (cleanString(contentItem?.type).toLowerCase().includes('reason')) {
        continue;
      }

      const text = cleanString(contentItem?.text || contentItem?.content);
      if (text) responseParts.push(text);
    }
  }

  return stripThinkBlocksFromText(responseParts.join('\n'));
}

function parseToolArguments(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;

  const raw = cleanString(value);
  if (!raw) return {};

  try {
    return JSON.parse(raw);
  } catch {
    try {
      return parseJsonObject(raw);
    } catch {
      return {};
    }
  }
}

function pickToolCalls(data) {
  const calls = [];
  const message = data?.choices?.[0]?.message;

  for (const toolCall of Array.isArray(message?.tool_calls) ? message.tool_calls : []) {
    const fn = toolCall?.function || toolCall?.custom;
    const name = cleanString(fn?.name);
    const rawArguments = fn?.arguments ?? fn?.input;

    if (!name) continue;

    calls.push({
      id: cleanString(toolCall?.id),
      type: cleanString(toolCall?.type) || 'function',
      name,
      arguments: parseToolArguments(rawArguments),
      rawArguments,
    });
  }

  if (message?.function_call) {
    const name = cleanString(message.function_call.name);

    if (name) {
      calls.push({
        id: '',
        type: 'function',
        name,
        arguments: parseToolArguments(message.function_call.arguments),
        rawArguments: message.function_call.arguments,
      });
    }
  }

  for (const outputItem of Array.isArray(data?.output) ? data.output : []) {
    const type = cleanString(outputItem?.type);
    const name = cleanString(outputItem?.name || outputItem?.function?.name);
    const rawArguments = outputItem?.arguments ?? outputItem?.function?.arguments;

    if (type === 'function_call' && name) {
      calls.push({
        id: cleanString(outputItem?.id || outputItem?.call_id),
        type,
        name,
        arguments: parseToolArguments(rawArguments),
        rawArguments,
      });
    }

    for (const contentItem of Array.isArray(outputItem?.content) ? outputItem.content : []) {
      const contentType = cleanString(contentItem?.type);
      const contentName = cleanString(contentItem?.name || contentItem?.function?.name);
      const contentRawArguments = contentItem?.arguments ?? contentItem?.function?.arguments;

      if (contentType === 'function_call' && contentName) {
        calls.push({
          id: cleanString(contentItem?.id || contentItem?.call_id),
          type: contentType,
          name: contentName,
          arguments: parseToolArguments(contentRawArguments),
          rawArguments: contentRawArguments,
        });
      }
    }
  }

  return calls;
}

function collectTextValues(value, depth = 0) {
  if (depth > 4 || value == null) return [];
  if (typeof value === 'string') return [cleanString(value)].filter(Boolean);
  if (Array.isArray(value)) return value.flatMap((item) => collectTextValues(item, depth + 1));
  if (typeof value !== 'object') return [];

  return [
    value.text,
    value.content,
    value.summary,
    value.reasoning,
    value.thinking,
    value.reasoning_content,
    value.reasoningContent,
  ].flatMap((item) => collectTextValues(item, depth + 1));
}

function collectReasoningSummaryValues(value, depth = 0) {
  if (depth > 5 || value == null) return [];
  if (typeof value === 'string') return [cleanString(value)].filter(Boolean);
  if (Array.isArray(value)) return value.flatMap((item) => collectReasoningSummaryValues(item, depth + 1));
  if (typeof value !== 'object') return [];

  const type = cleanString(value.type).toLowerCase();
  const parts = [];

  if (
    type === 'summary_text' ||
    type === 'reasoning_summary_text' ||
    type.includes('reasoning_summary')
  ) {
    parts.push(...collectTextValues(value.text || value.content));
  }

  if (value.summary !== undefined) {
    parts.push(...collectReasoningSummaryValues(value.summary, depth + 1));
  }

  return parts;
}

function extractThinkBlocks(text) {
  const source = String(text ?? '');
  const blocks = [];
  const closedPattern = /<think\b[^>]*>([\s\S]*?)<\/think>/gi;
  let match;

  while ((match = closedPattern.exec(source)) !== null) {
    const value = cleanString(match[1]);
    if (value) blocks.push(value);
  }

  return blocks;
}

function pickChatThinking(data) {
  const parts = [];
  const message = data?.choices?.[0]?.message;

  if (message) {
    parts.push(
      ...collectTextValues(message.reasoning_content),
      ...collectTextValues(message.reasoningContent),
      ...collectReasoningSummaryValues(message.reasoning),
      ...(typeof message.reasoning === 'string' ? collectTextValues(message.reasoning) : []),
      ...collectTextValues(message.thinking),
      ...extractThinkBlocks(message.content),
    );
  }

  for (const outputItem of Array.isArray(data?.output) ? data.output : []) {
    const outputType = cleanString(outputItem?.type).toLowerCase();

    if (outputType.includes('reason')) {
      parts.push(...collectReasoningSummaryValues(outputItem));
    }

    for (const contentItem of Array.isArray(outputItem?.content) ? outputItem.content : []) {
      const contentType = cleanString(contentItem?.type).toLowerCase();

      if (contentType.includes('summary')) {
        parts.push(...collectReasoningSummaryValues(contentItem));
      }
    }
  }

  parts.push(...extractThinkBlocks(data?.output_text));

  const seen = new Set();
  return parts
    .map((part) => cleanString(part).replace(/<\/?think\b[^>]*>/gi, '').trim())
    .filter((part) => part && !seen.has(part) && seen.add(part))
    .join('\n\n')
    .trim();
}

function pickStreamTextDelta(data, apiMode) {
  const rawText = (value) => (typeof value === 'string' ? value : '');

  if (normalizeApiMode(apiMode) === 'responses') {
    const eventType = cleanString(data?.type).toLowerCase();

    if (eventType.includes('reason')) {
      return '';
    }

    if (data?.type === 'response.output_text.delta' || data?.type === 'response.text.delta') {
      return rawText(data?.delta);
    }

    if (eventType && eventType !== 'response.output_text.done') {
      return '';
    }

    return rawText(data?.delta?.text);
  }

  return rawText(data?.choices?.[0]?.delta?.content);
}

function pickStreamThinkingDelta(data, apiMode) {
  const rawText = (value) => (typeof value === 'string' ? value : '');

  if (normalizeApiMode(apiMode) === 'responses') {
    const eventType = cleanString(data?.type).toLowerCase();

    if (
      eventType === 'response.reasoning_summary_text.delta' ||
      eventType === 'response.reasoning_summary.delta' ||
      eventType.includes('reasoning_summary')
    ) {
      return rawText(data?.delta) || rawText(data?.text) || rawText(data?.summary?.text);
    }

    return '';
  }

  const delta = data?.choices?.[0]?.delta ?? {};

  return [
    delta.reasoning_content,
    delta.reasoningContent,
    delta.thinking,
  ].filter((item) => typeof item === 'string').join('');
}

function mergeOpenAiStreamChunks(chunks, apiMode) {
  return normalizeApiMode(apiMode) === 'responses'
    ? mergeResponsesChunks(chunks)
    : mergeChatCompletionChunks(chunks);
}

async function readOpenAiStreamResponse(response, options = {}, handlers = {}) {
  if (!response?.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`OpenAI-compatible stream HTTP ${response?.status ?? 'unknown'}: ${text}`);
  }

  if (!response.body) {
    throw new Error('OpenAI-compatible stream returned no readable body');
  }

  const apiMode = normalizeApiMode(options?.apiMode);
  const chunks = [];
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parser = createParser({
    onEvent(event) {
      const data = cleanString(event.data);

      if (!data || data === '[DONE]') {
        return;
      }

      const chunk = JSON.parse(data);

      if (chunk?.type === 'error' || chunk?.error) {
        throw new Error(chunk?.error?.message || chunk?.message || 'OpenAI-compatible stream failed');
      }

      chunks.push(chunk);
      handlers.onEvent?.(chunk);

      const textDelta = pickStreamTextDelta(chunk, apiMode);
      if (textDelta) {
        handlers.onTextDelta?.(textDelta, chunk);
      }

      const thinkingDelta = pickStreamThinkingDelta(chunk, apiMode);
      if (thinkingDelta) {
        handlers.onThinkingDelta?.(thinkingDelta, chunk);
      }
    },
  });

  try {
    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      parser.feed(decoder.decode(value, { stream: true }));
    }

    const tail = decoder.decode();
    if (tail) {
      parser.feed(tail);
    }

    // Flush compatible providers that omit the final blank event separator.
    parser.feed('\n\n');
    parser.reset({ consume: true });
  } catch (error) {
    throw new Error(`OpenAI-compatible stream returned invalid SSE JSON: ${toError(error)}`);
  }

  if (chunks.length === 0) {
    throw new Error('OpenAI-compatible stream returned empty SSE response');
  }

  return mergeOpenAiStreamChunks(chunks, apiMode);
}

function parseJsonObject(text) {
  const raw = cleanString(text);
  if (!raw) throw new Error('Model returned empty content');

  try {
    return JSON.parse(raw);
  } catch {
    const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/i) || raw.match(/(\{[\s\S]*\}|\[[\s\S]*\])/);
    if (match) return JSON.parse(match[1]);
    throw new Error(`Model returned non-JSON content: ${raw.slice(0, 240)}`);
  }
}

function toWellFormedEmbeddingText(value) {
  if (typeof value !== 'string' || !/[\uD800-\uDFFF]/.test(value)) return value;
  if (typeof value.toWellFormed === 'function') return value.toWellFormed();

  let output = '';
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        output += value[index] + value[++index];
      } else {
        output += '\uFFFD';
      }
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      output += '\uFFFD';
    } else {
      output += value[index];
    }
  }
  return output;
}

async function embedTexts(texts, embedding) {
  const body = {
    model: embedding.model,
    input: texts.map(toWellFormedEmbeddingText),
  };

  if (embedding.dimensions) {
    body.dimensions = embedding.dimensions;
  }

  const response = await fetch(embeddingsEndpoint(embedding.baseUrl), {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${embedding.apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(Math.max(10, embedding.timeoutSeconds ?? 180) * 1000),
  });
  const data = await readRequestJson(response, 'Embedding');

  return (data.data ?? [])
    .sort((left, right) => (left.index ?? 0) - (right.index ?? 0))
    .map((item) => item.embedding);
}

// MinerU writes entries itself, so adm-zip's extractAllTo symlink guard does not run here.
async function assertMineruZipOutputPathSafe(extractDir, outputPath, entryName) {
  const root = path.resolve(extractDir);
  const relative = path.relative(root, path.resolve(outputPath));
  if (!relative || relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new Error(`Illegal MinerU zip entry path: ${entryName}`);
  }

  let current = root;
  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);
    let stat;
    try {
      stat = await fsp.lstat(current);
    } catch (error) {
      if (error.code === 'ENOENT') break;
      throw error;
    }
    if (stat.isSymbolicLink()) {
      throw new Error(`Illegal MinerU zip entry path: ${entryName}`);
    }
  }
}

async function readZipWithAdm(zipBytes, extractDir) {
  const AdmZip = require('adm-zip');
  const zip = new AdmZip(Buffer.from(zipBytes));
  const entries = zip.getEntries().filter((entry) => !entry.isDirectory);
  const zipEntries = entries.map((entry) => entry.entryName.replace(/\\/g, '/'));
  let contentJsonText = null;
  let middleJsonText = null;
  let markdownText = null;
  let contentJsonPath = null;
  let middleJsonPath = null;
  let markdownPath = null;

  await fsp.mkdir(extractDir, { recursive: true });

  for (const entry of entries) {
    const normalized = entry.entryName.replace(/\\/g, '/');
    if (normalized.includes('..') || path.isAbsolute(normalized)) {
      throw new Error(`Illegal MinerU zip entry path: ${normalized}`);
    }

    const outputPath = path.join(extractDir, normalized);
    await assertMineruZipOutputPathSafe(extractDir, outputPath, normalized);
    await fsp.mkdir(path.dirname(outputPath), { recursive: true });
    const data = entry.getData();
    // Recheck after decompression, immediately before the destination is opened.
    await assertMineruZipOutputPathSafe(extractDir, outputPath, normalized);
    await fsp.writeFile(outputPath, data);

    const lower = normalized.toLowerCase();
    const text = data.toString('utf8');

    if (lower.endsWith('content_list_v2.json') || (!contentJsonText && lower.includes('content_list') && lower.endsWith('.json'))) {
      contentJsonText = text;
      contentJsonPath = outputPath;
    }

    if (lower.endsWith('middle.json') || (!middleJsonText && lower.includes('middle') && lower.endsWith('.json'))) {
      middleJsonText = text;
      middleJsonPath = outputPath;
    }

    if (lower.endsWith('full.md') || (!markdownText && lower.endsWith('.md'))) {
      markdownText = text;
      markdownPath = outputPath;
    }
  }

  return {
    contentJsonText,
    middleJsonText,
    markdownText,
    assetRootDir: extractDir,
    contentJsonPath,
    middleJsonPath,
    markdownPath,
    zipEntries,
  };
}

module.exports = {
  AGENT_STREAM_EVENT,
  MINERU_API_BASE,
  QA_STREAM_EVENT,
  chatEndpoint,
  cleanString,
  completionEndpoint,
  embedTexts,
  ensureFile,
  fileNameFromPath,
  hashBytes,
  hashFile,
  id,
  isPdf,
  listOpenAiModels,
  mergeOpenAiStreamChunks,
  modelsEndpoint,
  normalizeApiMode,
  now,
  openAiChat,
  parseJsonObject,
  pathExists,
  pickChatThinking,
  pickChatText,
  pickStreamThinkingDelta,
  pickToolCalls,
  pickStreamTextDelta,
  readOpenAiStreamResponse,
  readJson,
  readRequestJson,
  readZipWithAdm,
  safeFileName,
  toError,
  writeJson,
  writeJsonSync,
};
