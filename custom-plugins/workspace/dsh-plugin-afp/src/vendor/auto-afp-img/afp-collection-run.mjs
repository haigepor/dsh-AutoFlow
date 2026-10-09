import { createAfpApiClient } from './afp-api-client.mjs';
import { CATEGORY_PROFILES, DEFAULT_MAX_PAGES, collectPhotoCandidates, selectCategoryProfiles } from './afp-photo-search.mjs';

export const TARGET_SELECTION_NAMES = Object.freeze(CATEGORY_PROFILES.map(({ selectionName }) => selectionName));
export const LEGACY_SPACE_SELECTION_NAME = 'AutoFlow_宇宙星空';
export const CELESTIAL_WALLPAPER_SELECTION_NAME = 'AutoFlow_宇宙恒星球体';
export const CATEGORY_COLLECTION_MIN_CONFIDENCE = Object.freeze({
  animals: 0.82,
  food: 0.85,
  landscape: 0.82,
  'movie-poster': 0.90,
  'celestial-body-wallpaper': 0.92,
});

const FAILURE_ACTIONS = new Set(['ambiguous', 'validation-failed', 'failed', 'conflict']);

/** 判断报告是否包含必须让 CLI 以非零状态结束的写入/目标解析失败。 */
export function reportHasFailures(report) {
  if (!report) return false;
  if (FAILURE_ACTIONS.has(report.action) || Number(report.failedCount) > 0) return true;
  return (report.categories ?? []).some((item) => (
    FAILURE_ACTIONS.has(item?.action) || Number(item?.failedCount) > 0
  ));
}

function asId(value) {
  const id = String(value ?? '').trim();
  return id || null;
}

/**
 * 兼容 AFP Selection 的两种私有标记：当前接口以 isPrivate=true 为准，旧响应才回退 type=PRIVATE。
 * 显式 isPrivate=false 时绝不因旧 type 字段误判为私有，避免将图片写入共享收藏夹。
 */
export function isPrivateSelection(selection) {
  if (typeof selection?.isPrivate === 'boolean') return selection.isPrivate;
  return String(selection?.type ?? '').toUpperCase() === 'PRIVATE';
}

/** 解析固定目标；只接受精确名称和私有标记，前缀相似项不会进入结果。 */
export function resolveTargetSelections(selections, targetNames = TARGET_SELECTION_NAMES) {
  return targetNames.map((name) => {
    const matches = (Array.isArray(selections) ? selections : []).filter((selection) => (
      selection?.name === name && isPrivateSelection(selection)
    ));
    if (matches.length === 0) return { name, status: 'missing', selection: null };
    if (matches.length > 1) return { name, status: 'ambiguous', selection: null, matches: matches.length };
    return { name, status: 'clear', selection: matches[0] };
  });
}

/**
 * 仅迁移旧的宇宙星空私有收藏夹。若新旧名称同时存在或任一名称重复，则拒绝写入，
 * 防止把非目标收藏夹误改名或覆盖已有的宇宙恒星球体收藏夹。
 */
export async function migrateLegacySpaceSelection({
  client,
  selections,
  legacyName = LEGACY_SPACE_SELECTION_NAME,
  targetName = CELESTIAL_WALLPAPER_SELECTION_NAME,
  apply = false,
} = {}) {
  const matches = (name) => (Array.isArray(selections) ? selections : [])
    .filter((selection) => selection?.name === name && isPrivateSelection(selection));
  const legacy = matches(legacyName);
  const target = matches(targetName);
  const summary = { legacyName, targetName };
  if (legacy.length > 1 || target.length > 1) return { action: 'ambiguous', ...summary };
  if (legacy.length === 0 && target.length === 1) return { action: 'already-migrated', ...summary };
  if (legacy.length === 0) return { action: 'missing', ...summary };
  if (target.length === 1) return { action: 'conflict', ...summary };
  const selectionId = asId(legacy[0]?.id);
  if (!selectionId || legacy[0].name !== legacyName || !isPrivateSelection(legacy[0])) {
    return { action: 'validation-failed', ...summary };
  }
  if (!apply) return { action: 'would-rename', ...summary };
  await client.renameSelection(selectionId, targetName);
  return { action: 'renamed', ...summary };
}

/**
 * 控制 Selection 详情读取并发，避免收藏夹较多时同时发起大量 AFP 请求而导致超时或限流。
 */
async function mapWithConcurrency(items, concurrency, worker) {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error('detailConcurrency must be a positive integer');
  }
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await worker(items[currentIndex]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 汇总所有非目标收藏夹中的文档 ID，供搜索结果做跨收藏夹排重。
 * 详情读取使用受控并发与有限重试，避免一次读取全部收藏夹时压垮 AFP 接口。
 */
export async function collectExistingSelectionDocIds({
  client,
  selections,
  excludeSelectionIds = new Set(),
  detailConcurrency = 4,
  detailRetries = 2,
} = {}) {
  if (!Number.isInteger(detailRetries) || detailRetries < 0) {
    throw new Error('detailRetries must be a non-negative integer');
  }
  const excludedIds = new Set([...excludeSelectionIds].map(asId).filter(Boolean));
  const targets = (Array.isArray(selections) ? selections : []).filter((selection) => (
    asId(selection?.id) && selection?.name && !excludedIds.has(asId(selection.id))
  ));
  const details = await mapWithConcurrency(
    targets,
    detailConcurrency,
    (selection) => withRetries(() => client.getSelection(selection.id), detailRetries),
  );
  const ids = new Set();
  for (const detail of details) {
    for (const id of selectionDocIds(detail)) ids.add(id);
  }
  return ids;
}

/** 只清空五个固定 AutoFlow Selection；默认 dry-run，--apply 才调用 delete-selection-docs。 */
export async function clearTargetSelections({ client, selections, targetNames = TARGET_SELECTION_NAMES, apply = false } = {}) {
  const resolved = resolveTargetSelections(selections, targetNames);
  const report = { version: 1, mode: apply ? 'apply' : 'dry-run', categories: [] };
  for (const target of resolved) {
    const item = { name: target.name, action: target.status, existingCount: 0, clearedCount: 0, failedCount: 0 };
    if (target.status === 'ambiguous' || target.status === 'missing') {
      report.categories.push(item);
      continue;
    }
    const selectionId = asId(target.selection.id);
    if (!selectionId || target.selection.name !== target.name || !isPrivateSelection(target.selection)) {
      item.action = 'validation-failed';
      item.failedCount = 1;
      report.categories.push(item);
      continue;
    }
    try {
      const detail = await client.getSelection(selectionId);
      item.existingCount = selectionDocIds(detail).size;
      if (apply) {
        await client.clearSelectionDocs(selectionId);
        item.action = 'cleared';
        item.clearedCount = item.existingCount;
      } else {
        item.action = 'would-clear';
      }
    } catch {
      item.action = 'failed';
      item.failedCount = 1;
    }
    report.categories.push(item);
  }
  return report;
}

/** 仅清空一个已知类别的精确私有收藏夹，供专项策展流程避免误触其他 AutoFlow 目标。 */
export async function clearCategorySelection({
  client,
  selections,
  category,
  profiles = CATEGORY_PROFILES,
  apply = false,
} = {}) {
  const [profile] = selectCategoryProfiles(category, profiles);
  return clearTargetSelections({
    client,
    selections,
    targetNames: [profile.selectionName],
    apply,
  });
}

/** 只接受同名的私有收藏夹；同名多项必须人工处理，避免写入错误目标。 */
export function findExactPrivateSelection(selections, name) {
  const matches = (Array.isArray(selections) ? selections : []).filter((selection) => (
    selection?.name === name && isPrivateSelection(selection)
  ));
  if (matches.length === 0) return { status: 'create', selection: null };
  if (matches.length === 1) return { status: 'reuse', selection: matches[0] };
  return { status: 'ambiguous', selection: null, matches: matches.length };
}

/** 接受 Selection 的 docs/content/documents 容器及字符串/对象成员；缺失或无效成员拒绝去重和写入。 */
export function selectionDocIds(selectionDetail) {
  const docs = Array.isArray(selectionDetail)
    ? selectionDetail
    : (selectionDetail?.docs ?? selectionDetail?.content ?? selectionDetail?.documents);
  if (!Array.isArray(docs)) throw new Error('Invalid AFP collection contents');
  return new Set(docs.map(doc => {
    const value = typeof doc === 'string' ? doc : doc?.id ?? doc?.uno;
    if (typeof value !== 'string' || !value.trim()) throw new Error('Invalid AFP collection member');
    return value.trim();
  }));
}

function keptDecisions(decisionManifest, category) {
  const categoryFloor = CATEGORY_COLLECTION_MIN_CONFIDENCE[category] ?? 0.8;
  return (decisionManifest?.decisions ?? []).filter((decision) => (
    decision?.category === category
      && decision.keep === true
      && Number(decision.confidence) >= Math.max(
        categoryFloor,
        Number.isFinite(Number(decision.appliedThreshold)) ? Number(decision.appliedThreshold) : 0,
      )
  ));
}

/**
 * 合并候选和视觉决策，形成不含写操作的收藏夹计划。
 * 并列置信度沿用 AFP 原始排序，每个类别最多保留二十张。
 */
export function buildCollectionPlans({ candidateManifest, decisionManifest, selections, reservedDocIds = new Set(), limitPerCategory = 100 } = {}) {
  if (!Array.isArray(candidateManifest?.categories)) throw new Error('candidate manifest categories are required');
  const usedIds = new Set();
  return candidateManifest.categories.map((category) => {
    const candidatesById = new Map((category.candidates ?? []).map((candidate) => [candidate.id, candidate]));
    const categoryIds = new Set();
    let globallyExcludedCount = 0;
    const sortedCandidates = keptDecisions(decisionManifest, category.category)
      .map((decision) => ({ decision, candidate: candidatesById.get(decision.id) }))
      .filter(({ candidate }) => Boolean(candidate))
      .sort((left, right) => (
        Number(right.decision.confidence) - Number(left.decision.confidence)
        || Number(left.candidate.originalIndex) - Number(right.candidate.originalIndex)
      ))
      .map(({ candidate }) => candidate);
    const docs = [];
    for (const candidate of sortedCandidates) {
      if (docs.length >= limitPerCategory) break;
      if (reservedDocIds.has(candidate.id)) {
        globallyExcludedCount += 1;
        continue;
      }
      if (usedIds.has(candidate.id) || categoryIds.has(candidate.id)) continue;
      categoryIds.add(candidate.id);
      usedIds.add(candidate.id);
      docs.push({
        id: candidate.id,
        guid: candidate.guid,
        title: candidate.title,
        docClass: 'picture',
        provider: candidate.provider,
      });
    }

    return {
      category: category.category,
      selectionName: category.selectionName,
      resolution: findExactPrivateSelection(selections, category.selectionName),
      candidateCount: (category.candidates ?? []).length,
      visualKeptCount: docs.length,
      globallyExcludedCount,
      docs,
    };
  });
}

async function withRetries(action, retries) {
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await action();
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function createdSelectionId(payload) {
  return asId(payload?.id ?? payload?.selectionId ?? payload?.data?.id ?? payload?.data?.selectionId);
}

/**
 * 按计划执行只读预览或显式 apply 写入；新增图片严格串行，局部失败只影响当前图片。
 */
export async function executeCollectionPlans({ client, plans, apply = false, retries = 1 } = {}) {
  const report = { version: 1, mode: apply ? 'apply' : 'dry-run', categories: [] };
  for (const plan of plans ?? []) {
    const item = {
      category: plan.category,
      selectionName: plan.selectionName,
      action: plan.resolution.status,
      candidateCount: plan.candidateCount,
      visualKeptCount: plan.visualKeptCount,
      globallyExcludedCount: plan.globallyExcludedCount ?? 0,
      existingCount: 0,
      plannedAddCount: 0,
      addedCount: 0,
      failedCount: 0,
    };

    if (plan.resolution.status === 'ambiguous') {
      item.action = 'ambiguous';
      item.failedCount = 1;
      report.categories.push(item);
      continue;
    }

    let selectionId = plan.resolution.selection?.id;
    if (!selectionId && apply) {
      try {
        const created = await client.createPrivateSelection(plan.selectionName);
        selectionId = createdSelectionId(created);
        if (!selectionId) throw new Error(`create selection did not return an id for ${plan.selectionName}`);
        item.action = 'created';
      } catch {
        item.action = 'failed';
        item.failedCount = 1;
        report.categories.push(item);
        continue;
      }
    }

    let existing = new Set();
    if (selectionId) {
      try {
        const detail = await client.getSelection(selectionId);
        existing = selectionDocIds(detail);
      } catch {
        item.action = 'failed';
        item.failedCount = 1;
        report.categories.push(item);
        continue;
      }
    }
    item.existingCount = existing.size;
    const newDocs = plan.docs.filter((doc) => !existing.has(doc.id));
    item.plannedAddCount = newDocs.length;

    if (apply) {
      for (const doc of newDocs) {
        try {
          await withRetries(() => client.addSelectionDoc(selectionId, doc), retries);
          item.addedCount += 1;
        } catch {
          item.failedCount += 1;
        }
      }
    }
    report.categories.push(item);
  }
  return report;
}
