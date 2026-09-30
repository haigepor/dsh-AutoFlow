/**
 * AFP 搜索规划与结果解释层。
 *
 * 该模块不替换 AFP 的召回服务：它只生成可解释的 criteria/filters，
 * 并用卡片实际返回的可见字段做二次排序，避免把客户端推断冒充后端命中证据。
 */

const NATURES = new Set(['all', 'articles', 'photos', 'videos', 'graphics', 'packages', 'events']);
const FIELD_NAMES = new Set(['title', 'caption', 'keyword', 'person', 'location', 'country', 'provider', 'slug']);
const PHRASE_PATTERN = /"([^"\\]*(?:\\.[^"\\]*)*)"/g;
const FIELD_PATTERN = /\b([a-zA-Z]+)\s*=\s*("[^"]+"|[^\s()]+)/g;

function asText(value) {
  if (Array.isArray(value)) return value.map(asText).filter(Boolean).join(' ');
  if (value && typeof value === 'object') return value.keyword ?? value.name ?? '';
  return value == null ? '' : String(value);
}

function normalizeText(value) {
  return asText(value)
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

/** 移除字段表达式后再解析短语，避免 title="..." 被重复计入普通短语。 */
function withoutFieldExpressions(source) {
  return source.replace(FIELD_PATTERN, ' ');
}

/** 放宽普通精确短语，但保护字段值和布尔/括号结构不被改写。 */
function broadenPhrases(source) {
  const fields = [];
  const protectedSource = source.replace(FIELD_PATTERN, (fieldExpression) => {
    const index = fields.push(fieldExpression) - 1;
    return `\u0000FIELD_${index}\u0000`;
  });
  const broadened = protectedSource.replace(PHRASE_PATTERN, (_, phrase) => phrase);
  return broadened.replace(/\u0000FIELD_(\d+)\u0000/g, (_, index) => fields[Number(index)]);
}

/** 将用户输入拆成短语、普通词、显式排除词和字段条件。 */
export function parseSearchText(input) {
  const source = String(input ?? '').trim();
  const sourceWithoutFields = withoutFieldExpressions(source);
  const phrases = [...sourceWithoutFields.matchAll(PHRASE_PATTERN)].map((m) => m[1].trim()).filter(Boolean);
  const fieldMatches = [...source.matchAll(FIELD_PATTERN)]
    .map((m) => ({ field: m[1].toLocaleLowerCase(), value: m[2].replace(/^"|"$/g, '') }))
    .filter(({ field }) => FIELD_NAMES.has(field));
  const excluded = [];
  const includeSource = sourceWithoutFields.replace(/\bNOT\s+((?:"[^"]+")|[^\s()]+)/gi, (_, term) => {
    excluded.push(term.replace(/^"|"$/g, ''));
    return ' ';
  });
  // 解析审计字段时忽略引号内文本，避免短语中的 AND/OR/NOT 被误认作运算符。
  const sourceWithoutPhrases = sourceWithoutFields.replace(PHRASE_PATTERN, ' ');
  const operators = [...sourceWithoutPhrases.matchAll(/\b(AND|OR|NOT)\b/gi)].map((m) => m[1].toUpperCase());
  const terms = includeSource
    .replace(PHRASE_PATTERN, ' ')
    .replace(/\b(?:AND|OR|NOT)\b/gi, ' ')
    .replace(/[()]/g, ' ')
    .split(/\s+/)
    .map((term) => term.trim())
    .filter(Boolean);
  return {
    raw: source,
    broadRaw: broadenPhrases(source),
    phrases: unique(phrases),
    terms: unique(terms),
    excluded: unique(excluded),
    fields: fieldMatches,
    operators: unique(operators),
  };
}

function buildCriteria(parsed, { exact = true } = {}) {
  const hasExplicitStructure = parsed.operators.length > 0 || parsed.fields.length > 0 || /[()]/.test(parsed.raw);
  if (hasExplicitStructure) return exact ? parsed.raw : parsed.broadRaw;

  const parts = [
    ...(exact ? parsed.phrases.map((phrase) => `"${phrase}"`) : parsed.phrases),
    ...parsed.terms,
  ];
  return unique(parts).join(' AND ');
}

/**
 * 生成一次 AFP 搜索计划。默认优先精确短语、明确类型和稳定 Facet，
 * 同时保留 broad fallback，方便调用方在精确召回为空时逐级放宽。
 */
export function planAfpSearch({ query, nature = 'photos', language = 'en', dateRange = null, facets = [] } = {}) {
  if (!String(query ?? '').trim()) throw new Error('query is required');
  if (!NATURES.has(nature)) throw new Error(`unsupported nature: ${nature}`);
  const parsed = parseSearchText(query);
  const stableFacets = facets
    .filter((facet) => facet && typeof facet.value === 'string' && facet.value.trim())
    .map((facet) => ({ field: facet.field ?? 'unknown', value: facet.value.trim(), label: facet.label ?? null }));
  const criteria = buildCriteria(parsed);
  return {
    nature,
    language,
    dateRange,
    criteria,
    parsed,
    filters: stableFacets.reduce((acc, facet) => {
      (acc[facet.field] ??= []).push(facet.value);
      return acc;
    }, {}),
    steps: [
      '先调用 Hub getNature/getNaturesEvents 取得召回规模',
      '召回过大时调用 FCT 获取稳定 Facet value',
      '调用当前 nature 对应 FAR operation',
      '对可见字段做解释性评分，不静默删除原始结果',
    ],
    fallbacks: [
      criteria,
      buildCriteria(parsed, { exact: false }),
      parsed.fields.length ? parsed.fields.map(({ field, value }) => `${field}="${value}"`).join(' AND ') : criteria,
    ].filter(Boolean),
  };
}

function resultText(result) {
  return normalizeText([
    result.title,
    result.caption,
    result.slug,
    result.keywords,
    result.afpEntityKeyword?.map?.((item) => item.keyword),
    result.person,
    result.location,
    result.country,
    result.provider,
  ]);
}

/** 给单条卡片生成可审计的客户端证据。 */
export function scoreAfpResult(result, plan) {
  const text = resultText(result);
  const parsed = plan.parsed ?? parseSearchText(plan.criteria ?? '');
  const phraseHits = parsed.phrases.filter((phrase) => text.includes(normalizeText(phrase)));
  const termHits = parsed.terms.filter((term) => text.includes(normalizeText(term)));
  const negativeHits = parsed.excluded.filter((term) => text.includes(normalizeText(term)));
  const needles = unique([
    ...parsed.phrases,
    ...parsed.terms,
    ...parsed.fields.map(({ value }) => value),
  ].map(normalizeText));
  const visibleFields = {
    title: result.title,
    caption: result.caption,
    slug: result.slug,
    keywords: result.keywords,
    afpEntityKeyword: result.afpEntityKeyword?.map?.((item) => item?.keyword),
    person: result.person,
    location: result.location,
    country: result.country,
    provider: result.provider,
  };
  const matchedFields = [];
  for (const [field, value] of Object.entries(visibleFields)) {
    if (needles.some((needle) => needle && normalizeText(value).includes(needle))) matchedFields.push(field);
  }
  const freshnessBoost = result.contentCreated ? 0.25 : 0;
  const score = phraseHits.length * 5 + termHits.length * 3 + matchedFields.length + freshnessBoost - negativeHits.length * 3;
  return {
    score,
    matchedFields,
    phraseHits,
    termHits,
    negativeHits,
    visualEvidence: 'unavailable',
    explanation: matchedFields.length ? `可见字段命中：${matchedFields.join(', ')}` : '仅有服务端召回，当前响应未提供可见字段命中证据',
  };
}

export function rankAfpResults(results, plan) {
  return results
    .map((result, index) => ({ result, evidence: scoreAfpResult(result, plan), originalIndex: index }))
    .sort((a, b) => b.evidence.score - a.evidence.score || a.originalIndex - b.originalIndex);
}

export function buildAssistantPrompt() {
  return [
    '你是 AFP News 检索规划器。',
    '先拆解内容类型、实体、主题、时间、语言、包含词、排除词和用户要的精确度。',
    '精确短语保留双引号；排除词使用大写 NOT；需要 OR 时用括号明确优先级。',
    '先用 getNature 验证召回规模，再用 FCT 的 value 选择稳定 Facet，最后调用对应 FAR operation。',
    '不要把卡片标题未出现关键词解释成后端没有命中，也不要把文本召回解释成视觉识别。',
    '输出高置信匹配、扩展匹配、待人工确认三组，并列出每条结果的可见字段证据。',
    '保留查看全部 AFP 原始结果入口，不静默删除原始召回。',
  ].join('\n');
}
