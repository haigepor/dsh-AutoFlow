/**
 * 面向“画面主体是什么”的 AFP 搜索规划器。
 *
 * AFP 返回的检索卡片没有可靠的机器视觉标签；本模块仅使用 caption/title 的
 * 可见文本证据，先缩小服务端召回，再把“主体证据”和“语境提及”分开呈现。
 */

function normalize(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

function escaped(value) {
  return String(value).replace(/["\\]/g, '\\$&');
}

function escapedRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** 普通单词保持可读，包含查询语法字符的主体词强制按字面量发送。 */
function criteriaLiteral(value) {
  const normalized = normalize(value);
  return /^[a-z0-9_-]+$/i.test(normalized) && !/^(?:and|or|not)$/i.test(normalized)
    ? normalized
    : `"${escaped(normalized)}"`;
}

function unique(values) {
  return [...new Set(values.map((value) => normalize(value)).filter(Boolean))];
}

/**
 * 构造“主体”检索阶梯；由调用方把 `criteria` 交给 AFP 搜索框或 FAR/HUB 调用。
 * `balanced` 是默认入口，`crossCheck` 用标题和说明的交集降低宽泛召回。
 */
export function planSubjectSearch({ subject, aliases = [], excludedPhrases = [] } = {}) {
  const terms = unique([subject, ...aliases]);
  if (!terms.length) throw new Error('subject is required');

  const primary = terms[0];
  const criteriaTerms = terms.map(criteriaLiteral);
  const alternatives = criteriaTerms.length === 1 ? criteriaTerms[0] : `(${criteriaTerms.join(' OR ')})`;
  const exclusions = unique(excludedPhrases).map((phrase) => `NOT "${escaped(phrase)}"`).join(' ');
  const withExclusions = (criteria) => [criteria, exclusions].filter(Boolean).join(' ');

  return {
    subject: primary,
    aliases: terms.slice(1),
    queries: {
      // 最宽泛：用于发现同义词、地点、人物和可用 Facet，不应用于直接挑图。
      recall: withExclusions(alternatives),
      // 对“图里要有主体”的默认策略：caption 比裸词更接近图片说明。
      balanced: withExclusions(`caption=${alternatives}`),
      // 说明和标题都出现主体词，适合高精度候选池；仍不等同于图像识别。
      crossCheck: withExclusions(`title=${criteriaLiteral(primary)} AND caption=${alternatives}`),
    },
    workflow: [
      '用 recall 调用 Hub getNature，记录规模和可用 Facet。',
      '用 balanced 调用 FAR getPhotos；仅从 caption/title/关键词生成解释证据。',
      '数量仍过大时，以 FCT 返回的 value 加入时间、地点、来源等 Facet。',
      '需要更高精度时使用 crossCheck，并保留 AFP 原始结果入口以避免漏召回。',
    ],
  };
}

/**
 * 给一个已返回的卡片标出“主体文本证据”或“只是上下文提及”。
 * 该分数是排序/分组工具，不宣称能验证像素级主体。
 */
export function scoreSubjectCard(card, plan) {
  const subjectTerms = unique([plan.subject, ...(plan.aliases ?? [])]);
  const title = normalize(card?.title);
  const caption = normalize(Array.isArray(card?.caption) ? card.caption.join(' ') : card?.caption);
  const keywords = normalize(Array.isArray(card?.afpEntityKeyword)
    ? card.afpEntityKeyword.map((item) => item?.keyword).join(' ')
    : card?.afpEntityKeyword);
  const hits = (text) => subjectTerms.filter((term) => text.includes(term));
  const titleHits = hits(title);
  const captionHits = hits(caption);
  const keywordHits = hits(keywords);
  const subjectPattern = subjectTerms.some((term) => {
    const pluralSuffix = term.endsWith('s') ? '' : 's?';
    const pattern = `(?:^|[\\s\\p{P}])(?:a |an |two |three |several |pet )?${escapedRegExp(term)}${pluralSuffix}(?=$|[\\s\\p{P}])`;
    return new RegExp(pattern, 'iu').test(caption);
  });
  const contextOnly = !subjectPattern && captionHits.length > 0;
  const score = captionHits.length * 5 + titleHits.length * 3 + keywordHits.length * 2 + (subjectPattern ? 3 : 0) - (contextOnly ? 1 : 0);
  const tier = score >= 8 ? 'high-confidence' : score >= 4 ? 'extended-match' : 'manual-review';
  return {
    score,
    tier,
    evidence: {
      titleHits,
      captionHits,
      keywordHits,
      subjectPattern,
      visualEvidence: 'unavailable',
    },
  };
}

export function groupSubjectCards(cards, plan) {
  return cards
    .map((card, originalIndex) => ({ card, originalIndex, relevance: scoreSubjectCard(card, plan) }))
    .sort((a, b) => b.relevance.score - a.relevance.score || a.originalIndex - b.originalIndex)
    .reduce((groups, item) => {
      groups[item.relevance.tier].push(item);
      return groups;
    }, { 'high-confidence': [], 'extended-match': [], 'manual-review': [] });
}
