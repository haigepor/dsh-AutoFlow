/** Analysis JSON validation, complete-input accounting, and editorial plan checks. */
import { createHash } from 'node:crypto'
import { z } from 'zod'

const text = z.string().trim().min(1).max(10000)
const hash = z.string().regex(/^[a-f0-9]{64}$/)
const blockId = z.string().regex(/^b[1-9]\d*$/)
const assetId = z.string().min(1).max(200)
const blocks = z.array(blockId).max(20000)
const assets = z.array(assetId).max(1000)
const evidence = z.object({ blockIds: blocks, assetIds: assets }).strict()

/** Understanding evidence and actual input coverage, never an internal reasoning transcript. */
export const understandingSchema = z.object({
  articleType: text, audience: text, purpose: text, language: text, theme: text,
  sections: z.array(z.object({ title: text, summary: text, blockIds: blocks.min(1) }).strict()).max(300),
  entities: z.array(text).max(300),
  facts: z.array(z.object({ id: z.string().min(1).max(100), claim: text, kind: z.enum(['source', 'visual', 'interpretation']), evidence }).strict()).min(1).max(300),
  limitations: z.array(text).max(100), questions: z.array(text).max(100),
  images: z.array(z.object({ assetId, observations: text, relationship: text, blockIds: blocks }).strict()).max(1000),
  coverage: evidence,
}).strict()

const shotSchema = z.object({
  purpose: z.enum(['cover', 'inline']), paragraphs: z.array(z.number().int().positive()).min(1).max(100),
  rationale: text, subject: text, action: text, environment: text, composition: text, lighting: text,
  colors: text, style: text, details: text, avoid: text, prompt: text,
  ratio: z.enum(['16:9', '4:3', '3:2', '1:1', '9:16']),
  blockIds: blocks.min(1), assetIds: assets, afterBlockId: blockId,
  informationGoal: text, visualMode: z.enum(['conceptual', 'source-grounded']),
  sceneHash: hash.optional(), promptSceneHash: hash.optional(),
}).strict()

/** The model submits editorial data; the host binds immutable source hashes separately. */
export const editorialPlanSchema = z.object({
  brief: z.object({ theme: text, facts: z.array(text).min(1).max(300), subjects: z.array(text).min(1).max(100), scenes: z.array(text).min(1).max(100) }).strict(),
  shots: z.array(shotSchema).min(1).max(12),
  shortfall: z.object({ requested: z.number().int().min(1).max(12), actual: z.number().int().min(1).max(12), reason: z.string().max(10000) }).strict(),
}).strict()

/** Saved plans preserve compatibility fields and bind every evidence input used in analysis. */
export const analysisPlanSchema = editorialPlanSchema.extend({
  sourceHash: hash, inputHash: hash, rulesHash: hash,
  model: z.object({ provider: text, model: text, maxTokens: z.number().int().positive(), reasoningEffort: text.optional() }).strict(),
  coverage: evidence, understanding: understandingSchema,
  checks: z.object({ structural: z.literal(true), semanticReviewRequired: z.literal(true) }).strict(),
}).strict()

const modelSchema = analysisPlanSchema.shape.model
const ruleSnapshotSchema = z.object({ version: z.literal(1), files: z.array(z.object({ id: text, hash, content: z.string().max(64000) }).strict()).min(1),
  policy: z.object({ explanationLanguage: text, promptLanguage: text, coverCount: z.literal(1), inlineCount: z.number().int().min(0).max(11), ratio: shotSchema.shape.ratio, style: text, audience: z.string().max(2000), brandConstraints: z.string().max(4000) }).strict(),
  templates: z.record(z.string(), z.string().max(64000)), rulesHash: hash }).strict()
const attachmentSchema = z.object({ attachmentId: text, mediaType: z.enum(['image/png', 'image/jpeg', 'image/webp', 'image/gif']), bytes: z.number().int().positive(), width: z.number().int().positive(), height: z.number().int().positive(), name: text.optional(), originalDimensions: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).strict().optional() }).strict()

/** Frozen model-visible inputs and exact input budgets stored with each run. */
export const analysisInputSchema = z.object({ schemaVersion: z.literal(1), articleId: text, snapshotId: text, sourceHash: hash,
  metadata: z.object({ category: z.string().max(2000), language: z.string().max(100), notes: z.string().max(10000) }).strict(),
  rules: ruleSnapshotSchema, model: modelSchema,
  budgets: z.object({ contextChars: z.number().int().positive(), maxInputChars: z.number().int().positive(), maxChunks: z.number().int().positive(), maxImagesPerChunk: z.number().int().positive(), maxImageBytes: z.number().int().positive(), maxTotalImageBytes: z.number().int().positive(), maxSteps: z.number().int().positive(), timeoutMs: z.number().int().positive() }).strict(),
  chunks: z.array(z.object({ id: text, blockIds: blocks, assetIds: assets }).strict()).min(1),
  images: z.array(z.object({ assetId, sourceHash: hash, sourceBytes: z.number().int().positive(), attachment: attachmentSchema }).strict()),
  inputId: z.string().regex(/^[a-f0-9]{32}$/), inputHash: hash,
}).strict().superRefine((value, ctx) => {
  const { inputId, inputHash, ...body } = value
  const { rulesHash, ...rules } = value.rules
  if (inputHash !== analysisHash(body) || inputId !== inputHash.slice(0, 32)) ctx.addIssue({ code: 'custom', message: 'analysis-input-hash-invalid' })
  if (rulesHash !== analysisHash(rules) || value.rules.files.some(file => file.hash !== analysisHash(file.content))) ctx.addIssue({ code: 'custom', message: 'analysis-rules-hash-invalid' })
})

/** Only validated, durably submitted stages can be used as recovery checkpoints. */
export const analysisCheckpointSchema = z.object({ inputHash: hash, stageId: text, sessionId: text, messageId: text, submissionSeq: z.number().int().nonnegative(), result: z.union([understandingSchema, analysisPlanSchema]) }).strict()

/** Completed analysis returned to the Host for atomic publication as a pending review. */
export const analysisResultSchema = z.object({ input: analysisInputSchema, understanding: understandingSchema, plan: analysisPlanSchema, sessionId: text, checkpoints: z.array(analysisCheckpointSchema).min(1) }).strict()

/** Stable content hash with sorted object keys and preserved array order. @param {unknown} value JSON data. @returns {string} SHA-256. */
export function analysisHash(value) {
  const canonical = input => Array.isArray(input) ? input.map(canonical) : input && typeof input === 'object'
    ? Object.fromEntries(Object.keys(input).sort().filter(key => input[key] !== undefined).map(key => [key, canonical(input[key])])) : input
  return createHash('sha256').update(typeof value === 'string' ? value : JSON.stringify(canonical(value))).digest('hex')
}

function fail(code) { throw Object.assign(new Error(code), { code }) }
function assertReferences(actual, expected) {
  if (new Set(actual).size !== actual.length || actual.some(id => !expected.includes(id))) fail('analysis-reference-invalid')
}
function assertCoverage(actual, expected) {
  assertReferences(actual, expected)
  if (actual.length !== expected.length) fail('analysis-coverage-incomplete')
}

/** Split at block boundaries without dropping blocks or images; oversized input rejects. @param {object} snapshot Saved source. @param {object} config Resolved budgets. @returns {object[]} Full ordered chunks. */
export function chunkSnapshot(snapshot, config) {
  if (JSON.stringify(snapshot.blocks).length > config.maxInputChars) fail('analysis-input-budget')
  const perChunk = Math.floor(config.contextChars / 2)
  const chunks = []
  let chunk = { id: 'chunk-1', blockIds: [], assetIds: [], blocks: [] }
  let chars = 0
  const append = () => { if (chunk.blockIds.length || chunk.assetIds.length) chunks.push(chunk); chunk = { id: `chunk-${chunks.length + 1}`, blockIds: [], assetIds: [], blocks: [] }; chars = 0 }
  for (const block of snapshot.blocks) {
    const size = JSON.stringify(block).length
    if (size > perChunk) fail('analysis-block-budget')
    const image = block.assetId
    if (chars + size > perChunk || image && chunk.assetIds.length === config.maxImagesPerChunk) append()
    chunk.blocks.push(block); chunk.blockIds.push(block.id); chars += size
    if (image && !chunks.some(item => item.assetIds.includes(image)) && !chunk.assetIds.includes(image)) chunk.assetIds.push(image)
  }
  for (const asset of snapshot.assets) {
    if (!chunks.some(item => item.assetIds.includes(asset.id)) && !chunk.assetIds.includes(asset.id)) {
      if (chunk.assetIds.length === config.maxImagesPerChunk) append()
      chunk.assetIds.push(asset.id)
    }
  }
  append()
  if (!chunks.length || chunks.length > config.maxChunks) fail('analysis-chunk-budget')
  return chunks
}

/** Freeze the adopted business fields, exact model controls, all rules and actual image receipts. @param {object} args Source and resolved inputs. @returns {object} Complete analysis input. */
export function createAnalysisInput({ articleId, snapshot, metadata = {}, rules, config, images, chunks = chunkSnapshot(snapshot, config) }) {
  const business = z.object({ category: z.string().max(2000), language: z.string().max(100), notes: z.string().max(10000) }).parse({ category: metadata.category ?? '', language: metadata.language ?? '', notes: metadata.notes ?? '' })
  const model = { provider: config.provider, model: config.model, maxTokens: config.maxTokens, ...config.reasoningEffort ? { reasoningEffort: config.reasoningEffort } : {} }
  const data = { schemaVersion: 1, articleId, snapshotId: snapshot.id, sourceHash: snapshot.sourceHash, metadata: business, rules: structuredClone(rules), model,
    budgets: { contextChars: config.contextChars, maxInputChars: config.maxInputChars, maxChunks: config.maxChunks, maxImagesPerChunk: config.maxImagesPerChunk, maxImageBytes: config.maxImageBytes, maxTotalImageBytes: config.maxTotalImageBytes, maxSteps: config.maxSteps, timeoutMs: config.timeoutMs },
    chunks: chunks.map(({ id, blockIds, assetIds }) => ({ id, blockIds, assetIds })), images: structuredClone(images) }
  const inputHash = analysisHash(data)
  return analysisInputSchema.parse({ ...data, inputId: inputHash.slice(0, 32), inputHash })
}

/** Validate structured understanding against assigned blocks and actual image inputs. @param {unknown} value Model JSON. @param {object} expected Assigned coverage. @returns {object} Validated result. */
export function validateUnderstanding(value, expected) {
  const result = understandingSchema.parse(value)
  assertCoverage(result.coverage.blockIds, expected.blockIds); assertCoverage(result.coverage.assetIds, expected.assetIds)
  for (const section of result.sections) assertReferences(section.blockIds, expected.blockIds)
  if (new Set(result.sections.flatMap(section => section.blockIds)).size !== expected.blockIds.length) fail('analysis-sections-incomplete')
  const facts = new Set()
  for (const fact of result.facts) {
    if (facts.has(fact.id) || !fact.evidence.blockIds.length && !fact.evidence.assetIds.length) fail('analysis-evidence-missing')
    facts.add(fact.id); assertReferences(fact.evidence.blockIds, expected.blockIds); assertReferences(fact.evidence.assetIds, expected.assetIds)
    if (fact.kind === 'visual' && !fact.evidence.assetIds.length) fail('analysis-visual-evidence-missing')
  }
  assertCoverage(result.images.map(image => image.assetId), expected.assetIds)
  for (const image of result.images) assertReferences(image.blockIds, expected.blockIds)
  return result
}

/** Hash editable scene fields independently of final prompt wording. @param {object} shot Scene and prompt fields. @returns {string} SHA-256. */
export function computeSceneHash(shot) {
  const keys = ['purpose', 'rationale', 'subject', 'action', 'environment', 'composition', 'lighting', 'colors', 'style', 'details', 'avoid', 'ratio', 'blockIds', 'assetIds', 'afterBlockId', 'informationGoal', 'visualMode']
  return analysisHash(Object.fromEntries(keys.filter(key => shot[key] !== undefined).map(key => [key, shot[key]])))
}

/** Reject stale inputs, incomplete coverage, unsupported evidence, duplicate scenes, or inaccurate quantity accounting. @param {unknown} value Saved candidate. @param {object} context Frozen source/input. @returns {object} Validated plan. */
export function validateAnalysisPlan(value, { snapshot, input, understanding }) {
  const plan = analysisPlanSchema.parse(value)
  if (plan.sourceHash !== snapshot.sourceHash || plan.inputHash !== input.inputHash || plan.rulesHash !== input.rules.rulesHash || analysisHash(plan.model) !== analysisHash(input.model)) fail('analysis-input-mismatch')
  const expected = { blockIds: snapshot.blocks.map(block => block.id), assetIds: snapshot.assets.map(asset => asset.id) }
  assertCoverage(input.images.map(image => image.assetId), expected.assetIds)
  assertCoverage(plan.coverage.blockIds, expected.blockIds); assertCoverage(plan.coverage.assetIds, expected.assetIds)
  validateUnderstanding(plan.understanding, expected)
  if (understanding && analysisHash(plan.understanding) !== analysisHash(understanding)) fail('analysis-understanding-mismatch')
  const policy = input.rules.policy
  const requested = policy.coverCount + policy.inlineCount
  if (plan.shots.filter(shot => shot.purpose === 'cover').length !== 1 || plan.shots.length > requested || plan.shortfall.requested !== requested || plan.shortfall.actual !== plan.shots.length
    || plan.shots.length < requested && !plan.shortfall.reason.trim()) fail('analysis-quantity-invalid')
  const scenes = new Set()
  for (const shot of plan.shots) {
    assertReferences(shot.blockIds, expected.blockIds); assertReferences(shot.assetIds, expected.assetIds)
    if (!expected.blockIds.includes(shot.afterBlockId) || shot.ratio !== policy.ratio || analysisHash([...shot.paragraphs].sort((a, b) => a - b)) !== analysisHash(shot.blockIds.map(id => Number(id.slice(1))).sort((a, b) => a - b))) fail('analysis-shot-invalid')
    const scene = analysisHash([shot.subject, shot.action, shot.environment, shot.informationGoal].map(text => text.toLowerCase().replace(/\s+/g, ' ').trim()))
    if (scenes.has(scene)) fail('analysis-shots-duplicate')
    scenes.add(scene)
  }
  return plan
}
