/** Shared desktop plan algorithms. No file, network, storage or model imports. */
function createAgentPlanCore(adapters={}){
const now=adapters.now??(()=>Date.now()),random=adapters.random??(()=>Math.random());if(typeof now!=='function'||typeof random!=='function')throw new TypeError('Invalid plan clock/entropy adapters');
const AUTO_CLASSIFY_PARENT_NAME = 'Agent 自动归类';
const GENERIC_COLLECTION_NAMES = new Set([
    'A',
    'An',
    'And',
    'Are',
    'As',
    'Based',
    'By',
    'For',
    'From',
    'In',
    'Into',
    'Is',
    'Method',
    'Methods',
    'Model',
    'Models',
    'New',
    'Of',
    'On',
    'Paper',
    'Problem',
    'Research',
    'Study',
    'The',
    'This',
    'To',
    'Using',
    'With',
    '方法',
    '模型',
    '研究',
    '论文',
    '问题',
    '系统',
    '一种',
    '一个',
    '基于',
]);
const tagAliases = new Map([
    ['ai', 'AI'],
    ['artificial intelligence', 'AI'],
    ['人工智能', 'AI'],
    ['ml', 'Machine Learning'],
    ['machine learning', 'Machine Learning'],
    ['机器学习', 'Machine Learning'],
    ['dl', 'Deep Learning'],
    ['deep learning', 'Deep Learning'],
    ['深度学习', 'Deep Learning'],
    ['llm', 'LLM'],
    ['llms', 'LLM'],
    ['large language model', 'LLM'],
    ['large language models', 'LLM'],
    ['大语言模型', 'LLM'],
    ['nlp', 'NLP'],
    ['natural language processing', 'NLP'],
    ['自然语言处理', 'NLP'],
    ['cv', 'Computer Vision'],
    ['computer vision', 'Computer Vision'],
    ['计算机视觉', 'Computer Vision'],
    ['rl', 'Reinforcement Learning'],
    ['reinforcement learning', 'Reinforcement Learning'],
    ['强化学习', 'Reinforcement Learning'],
    ['uav', 'UAV'],
    ['uavs', 'UAV'],
    ['drone', 'UAV'],
    ['drones', 'UAV'],
    ['unmanned aerial vehicle', 'UAV'],
    ['unmanned aerial vehicles', 'UAV'],
    ['无人机', 'UAV'],
    ['robot', 'Robotics'],
    ['robots', 'Robotics'],
    ['robotics', 'Robotics'],
    ['机器人', 'Robotics'],
    ['optimization', 'Optimization'],
    ['optimisation', 'Optimization'],
    ['优化', 'Optimization'],
    ['survey', 'Survey'],
    ['review', 'Survey'],
    ['综述', 'Survey'],
]);
const tagRules = [
    { tag: 'UAV', pattern: /\b(uav|uavs|drone|drones|unmanned aerial)\b|无人机/i },
    { tag: 'LLM', pattern: /\b(llm|llms|large language model|transformer)\b|大语言模型|语言模型/i },
    { tag: 'Machine Learning', pattern: /\b(machine learning|ml)\b|机器学习/i },
    { tag: 'Deep Learning', pattern: /\b(deep learning|neural network|deep belief)\b|深度学习|神经网络/i },
    { tag: 'Reinforcement Learning', pattern: /\b(reinforcement learning|rl|markov decision|mdp)\b|强化学习/i },
    { tag: 'Optimization', pattern: /\b(optimization|optimisation|scheduling|allocation)\b|优化|调度|分配/i },
    { tag: 'Robotics', pattern: /\b(robot|robotics|manipulator)\b|机器人/i },
    { tag: 'Computer Vision', pattern: /\b(computer vision|image|segmentation|detection)\b|计算机视觉|图像|检测/i },
    { tag: 'NLP', pattern: /\b(nlp|natural language processing|language model)\b|自然语言处理/i },
    { tag: 'Survey', pattern: /\b(survey|review|overview)\b|综述|回顾/i },
];
function newPlanId(tool) {
    return `agent-plan:${tool}:${now()}:${random().toString(36).slice(2, 8)}`;
}
function normalizeComparable(value) {
    return value
        .trim()
        .replace(/[，、；;]+/g, ' ')
        .replace(/\s+/g, ' ')
        .toLocaleLowerCase();
}
const READ_PREFIXES = ['已读', '[已读]', '【已读】', '(已读)', '（已读）', 'read:', 'read '];
function startsWithComparablePrefix(value, prefix) {
    return normalizeComparable(value).startsWith(normalizeComparable(prefix));
}
function stripKnownReadPrefix(title) {
    let nextTitle = title.trimStart();
    for (const prefix of READ_PREFIXES) {
        if (!startsWithComparablePrefix(nextTitle, prefix)) {
            continue;
        }
        nextTitle = nextTitle.slice(prefix.length).trimStart();
        break;
    }
    return nextTitle;
}
function titleCaseEnglish(value) {
    if (!/^[a-z][a-z0-9 -]+$/i.test(value)) {
        return value;
    }
    const minorWords = new Set(['and', 'or', 'of', 'for', 'the', 'in', 'on', 'to', 'with']);
    return value
        .split(/\s+/)
        .map((part, index) => {
        if (index > 0 && minorWords.has(part.toLocaleLowerCase())) {
            return part.toLocaleLowerCase();
        }
        return part.charAt(0).toLocaleUpperCase() + part.slice(1).toLocaleLowerCase();
    })
        .join(' ');
}
function normalizeAgentTagName(rawName) {
    const normalized = rawName
        .trim()
        .replace(/^#+/, '')
        .replace(/[，、；;]+/g, ' ')
        .replace(/[_-]+/g, ' ')
        .replace(/\s+/g, ' ');
    if (!normalized) {
        return '';
    }
    const comparable = normalizeComparable(normalized);
    const alias = tagAliases.get(comparable);
    return alias ?? titleCaseEnglish(normalized);
}
function uniqueTags(tags) {
    const output = [];
    const seen = new Set();
    for (const tag of tags) {
        const normalized = normalizeAgentTagName(tag);
        const key = normalizeComparable(normalized);
        if (!normalized || seen.has(key)) {
            continue;
        }
        seen.add(key);
        output.push(normalized);
    }
    return output;
}
function paperAuthors(paper) {
    return paper.authors.map((author) => author.name.trim()).filter(Boolean);
}
function metadataUpdateForPaper(paper, metadata) {
    const request = { paperId: paper.id };
    let changed = false;
    const assignString = (key, currentValue, nextValue) => {
        const normalized = nextValue?.trim();
        if (!normalized || normalized === currentValue?.trim()) {
            return;
        }
        request[key] = normalized;
        changed = true;
    };
    assignString('title', paper.title, metadata.title);
    assignString('year', paper.year, metadata.year);
    assignString('publication', paper.publication, metadata.publication);
    assignString('doi', paper.doi, metadata.doi);
    assignString('url', paper.url, metadata.url);
    assignString('abstractText', paper.abstractText, metadata.abstractText);
    const nextAuthors = metadata.authors.map((author) => author.trim()).filter(Boolean);
    if (nextAuthors.length > 0) {
        const currentAuthors = paperAuthors(paper);
        if (nextAuthors.join('\n').toLocaleLowerCase() !== currentAuthors.join('\n').toLocaleLowerCase()) {
            request.authors = nextAuthors;
            changed = true;
        }
    }
    return changed ? request : null;
}
function parseRenameCommand(command) {
    const normalized = command.trim();
    if (!normalized) {
        return null;
    }
    const replaceMatch = normalized.match(/把\s*(.+?)\s*(?:替换成|改成|换成)\s*(.+)$/);
    if (replaceMatch) {
        return {
            mode: 'replace',
            from: replaceMatch[1].trim(),
            to: replaceMatch[2].trim(),
        };
    }
    const prefixMatch = normalized.match(/(?:前面|开头|标题前|名字前)\s*(?:加上|添加|加)\s*(.+)$/);
    if (prefixMatch) {
        return { mode: 'prefix', value: prefixMatch[1].trim() };
    }
    const suffixMatch = normalized.match(/(?:后面|末尾|结尾|标题后|名字后)?\s*(?:加上|添加|加)\s*(.+)$/);
    if (suffixMatch) {
        return { mode: 'suffix', value: suffixMatch[1].trim() };
    }
    return { mode: 'suffix', value: normalized };
}
function renameTitle(title, operation) {
    if (operation.mode === 'prefix') {
        return `${operation.value}${title}`;
    }
    if (operation.mode === 'suffix') {
        return `${title}${operation.value}`;
    }
    return title.split(operation.from).join(operation.to);
}
function buildRenamePlan(papers, operation) {
    const items = papers
        .map((paper) => {
        const nextTitle = operation.mode === 'replace' &&
            normalizeComparable(operation.to) === '' &&
            ['已读', '[已读]', '【已读】', '(已读)', '（已读）'].some((prefix) => startsWithComparablePrefix(operation.from, prefix))
            ? stripKnownReadPrefix(paper.title).trim()
            : renameTitle(paper.title, operation).trim();
        if (!nextTitle || nextTitle === paper.title) {
            return null;
        }
        return {
            id: `${paper.id}:rename`,
            tool: 'rename',
            paperId: paper.id,
            paperTitle: paper.title,
            title: '重命名论文标题',
            description: `${paper.title} -> ${nextTitle}`,
            before: paper.title,
            after: nextTitle,
            updateRequest: {
                paperId: paper.id,
                title: nextTitle,
            },
        };
    })
        .filter((item) => item !== null);
    return {
        id: newPlanId('rename'),
        tool: 'rename',
        title: '批量重命名论文',
        description: `准备更新 ${items.length} 篇文献标题。`,
        items,
        createdAt: now(),
    };
}
function inferSmartTagsForPaper(paper) {
    const sourceText = [
        paper.title,
        paper.publication,
        paper.abstractText,
        paper.keywords.join(' '),
        paper.tags.map((tag) => tag.name).join(' '),
    ]
        .filter(Boolean)
        .join('\n');
    const inferred = tagRules
        .filter((rule) => rule.pattern.test(sourceText))
        .map((rule) => rule.tag);
    return uniqueTags([
        ...paper.tags.map((tag) => tag.name),
        ...paper.keywords,
        ...inferred,
    ]).slice(0, 8);
}
function collectionCandidateText(paper) {
    return [
        paper.title,
        paper.publication,
        paper.abstractText,
        paper.keywords.join(' '),
        paper.tags.map((tag) => tag.name).join(' '),
    ]
        .filter(Boolean)
        .join('\n');
}
function extractEnglishPhrases(value) {
    const phrases = [];
    const matches = value.matchAll(/\b[A-Z][A-Za-z0-9]*(?:[- ][A-Z]?[A-Za-z0-9]+){0,4}\b/g);
    for (const match of matches) {
        const phrase = titleCaseEnglish(match[0].replace(/\s+/g, ' ').trim());
        const words = phrase.split(/\s+/);
        if (phrase.length < 3 || phrase.length > 52) {
            continue;
        }
        if (words.length === 1 && GENERIC_COLLECTION_NAMES.has(phrase)) {
            continue;
        }
        if (words.every((word) => GENERIC_COLLECTION_NAMES.has(word))) {
            continue;
        }
        phrases.push(phrase);
    }
    return phrases;
}
function extractChinesePhrases(value) {
    const phrases = [];
    const matches = value.matchAll(/[\u4e00-\u9fa5]{2,12}/g);
    for (const match of matches) {
        const phrase = match[0].trim();
        if (GENERIC_COLLECTION_NAMES.has(phrase)) {
            continue;
        }
        phrases.push(phrase);
    }
    return phrases;
}
function scoreCollectionCandidate(candidate, sourceText) {
    const comparable = normalizeComparable(candidate);
    const lowerText = sourceText.toLocaleLowerCase();
    const occurrenceCount = lowerText.split(comparable).length - 1;
    const wordCount = candidate.split(/\s+/).length;
    const isKnownAlias = tagAliases.has(comparable);
    return occurrenceCount * 3 + Math.min(wordCount, 4) + (isKnownAlias ? 5 : 0);
}
function inferCollectionNameForPaper(paper) {
    const sourceText = collectionCandidateText(paper);
    const candidates = [
        ...inferSmartTagsForPaper(paper),
        ...paper.keywords,
        ...paper.tags.map((tag) => tag.name),
        ...extractEnglishPhrases(sourceText),
        ...extractChinesePhrases(sourceText),
    ]
        .map(normalizeAgentTagName)
        .filter(Boolean)
        .filter((candidate) => !GENERIC_COLLECTION_NAMES.has(candidate));
    const ranked = new Map();
    for (const candidate of candidates) {
        const key = normalizeComparable(candidate);
        const previous = ranked.get(key);
        const score = scoreCollectionCandidate(candidate, sourceText);
        if (!previous || score > previous.score) {
            ranked.set(key, { label: candidate, score });
        }
    }
    return [...ranked.values()].sort((left, right) => right.score - left.score)[0]?.label ?? '未命名主题';
}
function buildSmartTagPlan(papers) {
    const items = papers
        .map((paper) => {
        const currentTags = uniqueTags(paper.tags.map((tag) => tag.name));
        const nextTags = inferSmartTagsForPaper(paper);
        if (nextTags.length === currentTags.length &&
            nextTags.every((tag, index) => normalizeComparable(tag) === normalizeComparable(currentTags[index]))) {
            return null;
        }
        return {
            id: `${paper.id}:smart-tags`,
            tool: 'smart-tags',
            paperId: paper.id,
            paperTitle: paper.title,
            title: '智能标签建议',
            description: `建议标签：${nextTags.join('、') || '无'}`,
            before: currentTags.join('、') || '无标签',
            after: nextTags.join('、') || '无标签',
            updateRequest: {
                paperId: paper.id,
                tags: nextTags,
            },
        };
    })
        .filter((item) => item !== null);
    return {
        id: newPlanId('smart-tags'),
        tool: 'smart-tags',
        title: '智能标签',
        description: `准备为 ${items.length} 篇文献更新标签。`,
        items,
        createdAt: now(),
    };
}
function buildCleanTagsPlan(papers) {
    const items = papers
        .map((paper) => {
        const currentTags = paper.tags.map((tag) => tag.name.trim()).filter(Boolean);
        const nextTags = uniqueTags(currentTags);
        if (nextTags.length === currentTags.length &&
            nextTags.every((tag, index) => tag === currentTags[index])) {
            return null;
        }
        return {
            id: `${paper.id}:clean-tags`,
            tool: 'clean-tags',
            paperId: paper.id,
            paperTitle: paper.title,
            title: '标签清洗 / 合并',
            description: '合并大小写、同义词和重复标签。',
            before: currentTags.join('、') || '无标签',
            after: nextTags.join('、') || '无标签',
            updateRequest: {
                paperId: paper.id,
                tags: nextTags,
            },
        };
    })
        .filter((item) => item !== null);
    return {
        id: newPlanId('clean-tags'),
        tool: 'clean-tags',
        title: '标签清洗 / 合并',
        description: `准备清洗 ${items.length} 篇文献的标签。`,
        items,
        createdAt: now(),
    };
}
function buildAutoClassifyPlan(papers) {
    const items = papers.map((paper) => {
        const categoryName = inferCollectionNameForPaper(paper);
        return {
            id: `${paper.id}:classify:${categoryName}`,
            tool: 'classify',
            paperId: paper.id,
            paperTitle: paper.title,
            title: '自动归类 Collection',
            description: `加入 ${AUTO_CLASSIFY_PARENT_NAME} / ${categoryName}`,
            before: paper.categoryIds.length > 0 ? `${paper.categoryIds.length} 个已有分类` : '未分类',
            after: `${AUTO_CLASSIFY_PARENT_NAME} / ${categoryName}`,
            targetCategoryName: categoryName,
            targetCategoryParentName: AUTO_CLASSIFY_PARENT_NAME,
        };
    });
    return {
        id: newPlanId('classify'),
        tool: 'classify',
        title: '自动归类 Collection',
        description: `准备为 ${items.length} 篇文献加入自动分类。`,
        items,
        createdAt: now(),
    };
}

return{newPlanId,normalizeComparable,stripKnownReadPrefix,normalizeAgentTagName,uniqueTags,paperAuthors,metadataUpdateForPaper,parseRenameCommand,buildRenamePlan,inferSmartTagsForPaper,inferCollectionNameForPaper,buildSmartTagPlan,buildCleanTagsPlan,buildAutoClassifyPlan};
}
export {createAgentPlanCore};
