import { renderPhotoResult, photoReadTools } from './afp-conversation-records.js'
import { categories, reviewedPhotoResults } from './afp-refresh-workflow.js'
import { agentError } from './afp-agent-errors.js'
import { selectFinalPhotos } from './afp-photo-selection.js'
const categorySchema = { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', enum: categories } }
const idSchema = { type: 'string', pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' }
const nullableIdSchema = { ...idSchema, type: ['string', 'null'] }
const resourceIdSchema = { type: 'string', minLength: 1, maxLength: 256, pattern: '^[^\\u0000-\\u001f\\u007f]+$' }
const querySchema = { type: 'string', minLength: 1, maxLength: 2000 }
function owner(exec) { if (!exec.agent?.id) throw new Error('AFP tools require a Session'); return exec.agent.id }

function valid(value, schema) {
  if (Array.isArray(schema.type)) return value === null ? schema.type.includes('null') : schema.type.filter(type => type !== 'null').some(type => valid(value, { ...schema, type }))
  if (schema.type === 'string' && (typeof value !== 'string' || !value.trim() || value.length < (schema.minLength ?? 0)
    || value.length > (schema.maxLength ?? Infinity) || (schema.pattern && !new RegExp(schema.pattern).test(value)))) return false
  if (schema.type === 'integer' && (!Number.isSafeInteger(value) || value < schema.minimum || value > schema.maximum)) return false
  if (schema.type === 'array' && (!Array.isArray(value) || value.length < schema.minItems || value.length > schema.maxItems
    || value.some(item => !valid(item, schema.items)))) return false
  return !schema.enum || schema.enum.includes(value)
}

// Agent 只提供同源认证预览入口；上游签名地址和凭据不能进入会话日志。
function photoMetadata(row) {
  return { id: row.id, guid: row.guid, title: row.title, caption: row.caption, keywords: row.keywords, provider: row.provider,
    previewPath: `api/afp/preview?photoId=${encodeURIComponent(row.id)}` }
}
function collectionMetadata(row) {
  return { id: row.id, name: row.name, isPrivate: row.isPrivate, readOnly: row.readOnly,
    writable: !row.readOnly && Boolean(row.name.trim()), count: row.count, category: row.category }
}

/** Register capability tools with bounded model JSON, saved results and safe failures.
 * @param {object} ctx Scoped Cordis context whose effects dispose tool registrations.
 * @param {object} service AFP profile service with existing authenticated read operations.
 * @param {string} feature Capability selected by the bundle.
 * @returns {void} Registrations are owned by ctx effects.
 */
export function registerAgentTools(ctx, service, feature) {
  function tool(name, description, properties, required, kind, run) {
    ctx.effect(() => ctx.tools.register({ name, description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
      output: { schema: { type: 'string' }, render: (_args, value) => renderPhotoResult(value, service.config.agentResultMaxBytes),
        presentationMeta: (_args, value) => ({ afp: { version: 1, complete: false, result: JSON.parse(value) } }) },
      presentCall: () => ({ card: 'generic', title: name, kind }),
      async execute(args, exec) {
        const started = performance.now()
        let progress = () => {}
        try {
          const previous = service.conversationRecords.previousFailure(exec)
          if (previous) throw Object.assign(new Error('AFP repeated non-retryable input'), { afpAgentError: { ...previous, repeated: true } })
          progress = service.conversationRecords.begin(exec)
          exec.signal.throwIfAborted()
          service.require(feature); owner(exec)
          // 已实测无效的占位游标在本地拒绝；不将它们静默转换为首屏。
          if (name === 'afp_photo_search' && ['0', '?'].includes(args?.cursor)) throw new Error('AFP cursor must come from a previous photo search')
          if (['afp_report', 'afp_refresh', 'afp_photo_selection'].includes(name) && [args?.id, args?.runId].includes('00000000-0000-0000-0000-000000000000')) throw new Error('AFP run ID is invalid')
          if (name === 'afp_report' && (args?.runId !== undefined || args?.planId !== undefined)) throw new Error('AFP report parameters conflict')
          if (!args || typeof args !== 'object' || Array.isArray(args)
            || Object.keys(args).some(key => !Object.hasOwn(properties, key) || !valid(args[key], properties[key]))
            || required.some(key => !Object.hasOwn(args, key))) throw new Error('Invalid AFP arguments')
          progress({ stage: name.includes('selection') ? 'selection' : name.includes('search') && name !== 'afp_search_plan' ? 'search' : 'connection' })
          let result = await run(args, exec, progress)
          exec.signal.throwIfAborted()
          // 错误和新工具可观测耗时；原工具的成功结果保持兼容。
          if (result?.meta) result.meta.durationMs = Math.round(performance.now() - started)
          if (photoReadTools.has(name) || ['afp_photo_selection', 'afp_report'].includes(name)) result = await service.conversationRecords.save(exec, result)
          const output = renderPhotoResult(JSON.stringify(result), service.config.agentResultMaxBytes)[0].text
          exec.signal.throwIfAborted()
          if (name !== 'afp_refresh') progress({ state: 'completed', stage: 'completed', count: result.items?.length, durationMs: Math.round(performance.now() - started) })
          return output
        } catch (error) {
          if (exec.signal.aborted) { progress({ state: 'stopped', stage: 'stopped' }); exec.signal.throwIfAborted() }
          const failure = error.afpAgentError ?? agentError(error, kind, Math.round(performance.now() - started))
          progress({ state: 'failed', stage: 'failed', errorCode: failure.code })
          service.conversationRecords.fail(exec, failure)
          throw new Error(JSON.stringify(failure))
        }
      },
    }), `AFP tool ${name}`)
  }
  if (feature === 'read') {
    tool('afp_status', 'Check credential presence and capabilities without returning values.', {}, [], 'read', () => service.status())
    tool('afp_search_plan', 'Plan a photo search offline; no remote mutation. Use afp_photo_search_start for actual first-page results.', { query: querySchema }, ['query'], 'search', args => service.search(args.query))
    const limitSchema = { type: 'integer', minimum: 1, maximum: service.config.pageSize }
    const languageSchema = { type: 'string', enum: ['en', 'fr', 'es', 'ar', 'de', 'pt'] }
    const read = (operation, args, exec, progress) => service.pageAction({ operation, args: JSON.stringify(args) }, exec.signal, progress)
    const search = async (args, exec, progress) => {
      const result = await read('photo-search', args, exec, progress)
      return { items: result.items.map(photoMetadata), cursor: result.cursor, hasMore: result.hasMore,
        ...(result.paginationStopped ? { paginationStopped: true } : {}),
        meta: { language: args.language ?? service.config.language, limit: args.limit ?? service.config.pageSize } }
    }
    // 首屏入口没有可填游标，所有参数显式必填，避免模型用占位字符串补可选字段。
    tool('afp_photo_search_start', 'Start a NEW actual AFP caption search from its first page. This tool has NO cursor field. Provide query, supported language and limit. Return photo metadata and a cursor for afp_photo_search if hasMore is true. Each previewPath is relative to the current DSH Web app and requires its login; the conversation photo card provides an Open preview link. It is not a public AFP URL or an original download. Does not translate or execute an offline plan. Never repeat unchanged non-retryable input.',
      { query: querySchema, language: languageSchema, limit: limitSchema }, ['query', 'language', 'limit'], 'search', search)
    tool('afp_photo_search', 'Continue an actual AFP caption search using only a cursor returned by a successful search with the same query and language; hasMore false ends paging. For NEW searches use afp_photo_search_start, which has no cursor field. Legacy first-page callers may omit cursor. Never invent 0 or ?. Each previewPath requires the current DSH Web login; direct users to the conversation card Open preview link, not an invented public URL. Does not translate or execute an offline plan. Never repeat unchanged non-retryable input.',
      { query: querySchema, language: languageSchema,
        // 模型接口不支持前瞻正则；占位值校验留在 Host execute，schema 仅提供长度和说明。
        cursor: { type: 'string', minLength: 1, maxLength: 8192,
          description: 'For the first page use afp_photo_search_start; legacy callers omit this field. For subsequent pages copy only a returned AFP cursor; never use 0, ?, null or an invented placeholder.' }, limit: limitSchema }, ['query'], 'search', search)
    tool('afp_photo_details', 'Read one AFP photo metadata record by ID. found false means AFP did not return it. The photo previewPath is relative to the current DSH Web app and requires its login. Its conversation card supplies an Open preview link. Do not invent the Web origin, a public AFP URL or an original download URL. No image bytes or signed media links.',
      { photoId: resourceIdSchema }, ['photoId'], 'read', async (args, exec) => {
        const result = await read('photo-details', args, exec)
        return { found: result !== null, photo: result ? photoMetadata(result) : null, meta: {} }
      })
    tool('afp_collection_list', 'List named account-visible AFP collections with permission metadata. Unnamed directory entries are excluded and counted in meta.excludedUnnamedCount. Unlike afp_collections this is not limited to fixed category targets.',
      {}, [], 'read', async (_args, exec) => {
        const result = await read('collection-list', {}, exec)
        const items = result.items.filter(row => row.name.trim())
        const excludedUnnamedCount = result.items.length - items.length
        return { items: items.map(collectionMetadata), meta: excludedUnnamedCount ? { excludedUnnamedCount } : {} }
      })
    tool('afp_collection_items', 'Read a page of photo metadata from an account-visible collection. Continue AFP member paging with collectionNextOffset while hasMore is true. offset/nextOffset describe local result paging through afp_result_page. Each previewPath requires the current DSH Web login; the conversation photo card supplies an Open preview link. Never changes membership.',
      { collectionId: resourceIdSchema, offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, limit: limitSchema }, ['collectionId'], 'read', async (args, exec) => {
        const result = await read('collection-items', args, exec)
        return { items: result.items.map(photoMetadata), collection: collectionMetadata(result.collection), collectionOffset: result.offset,
          total: result.total, hasMore: result.hasMore, collectionNextOffset: result.hasMore ? result.offset + result.items.length : null, meta: {} }
      })
    tool('afp_collections', 'Read exact private AFP target names and membership counts.', {}, [], 'read', (_args, exec, progress) => service.collections(exec.signal, progress))
    tool('afp_photo_selection', 'Record the FINAL selected photos for the conversation summary before answering. Copy complete canonical IDs exactly; never shorten them to provider suffixes. Do not claim a final list until this call succeeds. Pass photoIds in desired order (empty clears the final list) and criteria. With basis=metadata and runId=null, IDs must come from successful AFP reads in this Turn and the result is metadata selection, NOT visual acceptance. To label visual acceptance, first read afp_report with kind=run in this Turn, set basis=visual and provide its real runId; every ID must be kept in that saved visual run. This tool only reads local Session evidence and saved reports; no AFP requests, downloads, purchases or collection writes. Search candidates remain in the process; only this selection appears in the final gallery.',
      { photoIds: { type: 'array', minItems: 0, maxItems: service.config.pageSize, items: resourceIdSchema }, criteria: querySchema, basis: { type: 'string', enum: ['metadata', 'visual'] }, runId: nullableIdSchema }, ['photoIds', 'criteria', 'basis', 'runId'], 'read', async (args, exec) => {
        const result = await selectFinalPhotos(args, exec.agent.session, service)
        return { items: result.photos.map(photoMetadata), selection: result.selection, meta: {} }
      })
    tool('afp_result_page', 'Read the next local page of a saved AFP result. No AFP request. Use only resultRef returned by a successful AFP call in this Turn, and nextOffset from that result.',
      { resultRef: idSchema, offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, limit: limitSchema }, ['resultRef', 'offset', 'limit'], 'read', async (args, exec) => {
        const context = service.conversationRecords.context(exec)
        const saved = await service.conversationData('conversation-result', { sessionId: context.sessionId, turn: context.turn, resultRef: args.resultRef })
        const items = saved.items ?? (saved.found ? [saved.photo] : [])
        if (args.offset > items.length) throw new Error('Invalid AFP arguments')
        return { items, offset: args.offset, pageLimit: args.limit, totalItems: items.length, meta: {} }
      })
    tool('afp_report', 'Read one saved report. kind=run reads a visual run; kind=plan reads a write plan. Copy its real id from a successful tool; never invent a placeholder. Explain saved status and stage, pixelReviewed/kept/target counts and requestFailures to the user. Request failures are not visual rejections. A running connection or collections stage with zero reviewed photos is preparation, not proof of a stalled job. Do not repeatedly read an unchanged report; use bounded job_output waits. Final visual photos still require afp_photo_selection.',
      { kind: { type: 'string', enum: ['run', 'plan'] }, id: idSchema }, ['kind', 'id'], 'read', async args => {
        const report = await service.report(args.kind === 'run' ? { runId: args.id } : { planId: args.id })
        if (args.kind === 'plan') return report
        const run = await service.store.readRun(args.id), photos = new Map()
        for (const group of Object.values(run.groups)) for (const photo of group.candidates) photos.set(photo.id, photo)
        return { ...report, items: run.decisions.filter(item => item.keep && photos.has(item.id)).map(item => photoMetadata(photos.get(item.id))),
          reviewedPhotoIds: [...new Set(run.decisions.filter(item => item.reason !== 'preview or vision request failed' && photos.has(item.id)).map(item => item.id))],
          reviewedPhotos: reviewedPhotoResults(run), meta: {} }
      })
    tool('afp_plan_change', 'Prepare an expiring Session-owned dry-run for append, replace or clear. Present exact targets and counts before afp_apply; never writes AFP.',
      { operation: { type: 'string', enum: ['append', 'replace', 'clear'] }, categories: categorySchema, runId: idSchema }, ['operation', 'categories'], 'read', (args, exec) => service.changes.plan(args, owner(exec), exec.signal))
  } else if (feature === 'refresh') {
    tool('afp_refresh', 'Start or resume a background visual dry-run using configured category searches, not the previous free-text search photos. For start, pass mode=start, chosen categories and runId=null; set targetPerCategory to the user-requested number to retain, and minimumReviewedPerCategory only when the user requests a minimum number of actual photo judgments. For resume, pass mode=resume, categories=[] and the real runId returned earlier, omit both quantity overrides, and wait until its prior job ends. Never invent a runId or start concurrent resumes. Never writes AFP. A returned handle only acknowledges launch. Explain preparation and actual photo checks from job_output and afp_report(kind=run,id=runId); stop with job_kill. Do not restart merely because preparation has zero reviewed photos.',
      { mode: { type: 'string', enum: ['start', 'resume'] }, categories: { ...categorySchema, minItems: 0 }, runId: nullableIdSchema,
        targetPerCategory: { type: 'integer', minimum: 1, maximum: 1000 }, minimumReviewedPerCategory: { type: 'integer', minimum: 0, maximum: 1000 } }, ['mode', 'categories', 'runId'], 'execute', (args, exec, progress) => {
        if (args.mode === 'start' ? args.runId !== null || !args.categories.length : !args.runId || args.categories.length) throw new Error('AFP refresh mode conflicts with arguments')
        if (args.mode === 'resume' && (Object.hasOwn(args, 'targetPerCategory') || Object.hasOwn(args, 'minimumReviewedPerCategory'))) throw new Error('AFP refresh mode conflicts with arguments')
        return service.startRefresh(args.mode === 'start' ? { categories: args.categories,
          ...(Object.hasOwn(args, 'targetPerCategory') ? { targetPerCategory: args.targetPerCategory } : {}),
          ...(Object.hasOwn(args, 'minimumReviewedPerCategory') ? { minimumReviewedPerCategory: args.minimumReviewedPerCategory } : {}),
        } : { runId: args.runId }, owner(exec), exec.signal, progress)
      })
  } else if (feature === 'write') {
    ctx.on('tools/pre-execute', async (exec, next) => {
      const decision = await next()
      if (exec.name !== 'afp_apply' || decision.kind !== 'allow') return decision
      try {
        service.require('write')
        const report = await service.changes.check(exec.arguments?.planId, owner(exec))
        return { kind: 'ask', reason: `AFP remote write: ${JSON.stringify(report)}`,
          displayReason: { en: `Apply AFP ${report.operation}? ${JSON.stringify(report.categories)}`, zh: `执行 AFP ${report.operation}？${JSON.stringify(report.categories)}` } }
      } catch (error) { return { kind: 'deny', reason: 'Invalid, expired, used or foreign AFP plan. Create a new dry-run plan.' } }
    })
    tool('afp_apply', 'Apply a Session-owned plan after DSH human approval. Rechecks account and membership; no automatic retry or rollback. Inspect job_output and afp_report for partial writes.',
      { planId: idSchema }, ['planId'], 'edit', async (args, exec) => {
        await service.changes.check(args.planId, owner(exec))
        return { ...service.job('write', owner(exec), 'AFP approved write', signal => service.changes.execute(args.planId, owner(exec), signal)), planId: args.planId }
      })
  }
}
