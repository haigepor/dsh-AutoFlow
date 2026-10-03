import { categories } from './afp-refresh-workflow.js'
import { agentError } from './afp-agent-errors.js'
const categorySchema = { type: 'array', minItems: 1, maxItems: 5, items: { type: 'string', enum: categories } }
const idSchema = { type: 'string', pattern: '^[a-f0-9-]{36}$' }
const resourceIdSchema = { type: 'string', minLength: 1, maxLength: 256, pattern: '^[^\\u0000-\\u001f\\u007f]+$' }
const querySchema = { type: 'string', minLength: 1, maxLength: 2000 }
function owner(exec) { if (!exec.agent?.id) throw new Error('AFP tools require a Session'); return exec.agent.id }

function valid(value, schema) {
  if (schema.type === 'string' && (typeof value !== 'string' || !value.trim() || value.length < (schema.minLength ?? 0)
    || value.length > (schema.maxLength ?? Infinity) || (schema.pattern && !new RegExp(schema.pattern).test(value)))) return false
  if (schema.type === 'integer' && (!Number.isSafeInteger(value) || value < schema.minimum || value > schema.maximum)) return false
  if (schema.type === 'array' && (!Array.isArray(value) || value.length < schema.minItems || value.length > schema.maxItems
    || value.some(item => !valid(item, schema.items)))) return false
  return !schema.enum || schema.enum.includes(value)
}

// Agent 元数据显式选取字段；页面新增媒体字段不能意外进入模型输出。
function photoMetadata(row) {
  return { id: row.id, guid: row.guid, title: row.title, caption: row.caption, keywords: row.keywords, provider: row.provider }
}
function collectionMetadata(row) {
  return { id: row.id, name: row.name, isPrivate: row.isPrivate, readOnly: row.readOnly,
    writable: !row.readOnly && Boolean(row.name.trim()), count: row.count, category: row.category }
}

/** Register capability tools; legacy success output stays stable and failures use safe JSON fields.
 * @param {object} ctx Scoped Cordis context whose effects dispose tool registrations.
 * @param {object} service AFP profile service with existing authenticated read operations.
 * @param {string} feature Capability selected by the bundle.
 * @returns {void} Registrations are owned by ctx effects.
 */
export function registerAgentTools(ctx, service, feature) {
  function tool(name, description, properties, required, kind, run) {
    ctx.effect(() => ctx.tools.register({ name, description,
      parameters: { type: 'object', properties, required, additionalProperties: false },
      output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
      presentCall: () => ({ card: 'generic', title: name, kind }),
      async execute(args, exec) {
        const started = performance.now()
        try {
          exec.signal.throwIfAborted()
          service.require(feature); owner(exec)
          // 已实测无效的占位游标在本地拒绝；不将它们静默转换为首屏。
          if (name === 'afp_photo_search' && ['0', '?'].includes(args?.cursor)) throw new Error('AFP cursor must come from a previous photo search')
          if (!args || typeof args !== 'object' || Array.isArray(args)
            || Object.keys(args).some(key => !Object.hasOwn(properties, key) || !valid(args[key], properties[key]))
            || required.some(key => !Object.hasOwn(args, key))
            || (name === 'afp_report' && Boolean(args.runId) === Boolean(args.planId))) throw new Error('Invalid AFP arguments')
          const result = await run(args, exec)
          exec.signal.throwIfAborted()
          // 错误和新工具可观测耗时；原工具的成功结果保持兼容。
          if (result?.meta) result.meta.durationMs = Math.round(performance.now() - started)
          return JSON.stringify(result)
        } catch (error) { exec.signal.throwIfAborted(); throw new Error(JSON.stringify(agentError(error, kind, Math.round(performance.now() - started)))) }
      },
    }), `AFP tool ${name}`)
  }
  if (feature === 'read') {
    tool('afp_status', 'Check credential presence and capabilities without returning values.', {}, [], 'read', () => service.status())
    tool('afp_search_plan', 'Plan a photo search offline; no remote mutation. Use afp_photo_search_start for actual first-page results.', { query: querySchema }, ['query'], 'search', args => service.search(args.query))
    const limitSchema = { type: 'integer', minimum: 1, maximum: service.config.pageSize }
    const languageSchema = { type: 'string', enum: ['en', 'fr', 'es', 'ar', 'de', 'pt'] }
    const read = (operation, args, exec) => service.pageAction({ operation, args: JSON.stringify(args) }, exec.signal)
    const search = async (args, exec) => {
      const result = await read('photo-search', args, exec)
      return { items: result.items.map(photoMetadata), cursor: result.cursor, hasMore: result.hasMore,
        ...(result.paginationStopped ? { paginationStopped: true } : {}),
        meta: { language: args.language ?? service.config.language, limit: args.limit ?? service.config.pageSize } }
    }
    // 首屏入口没有可填游标，所有参数显式必填，避免模型用占位字符串补可选字段。
    tool('afp_photo_search_start', 'Start a NEW actual AFP caption search from its first page. This tool has NO cursor field. Provide query, supported language and limit. Return photo metadata and a cursor for afp_photo_search if hasMore is true. Does not translate or execute an offline plan. Never repeat unchanged non-retryable input.',
      { query: querySchema, language: languageSchema, limit: limitSchema }, ['query', 'language', 'limit'], 'search', search)
    tool('afp_photo_search', 'Continue an actual AFP caption search using only a cursor returned by a successful search with the same query and language; hasMore false ends paging. For NEW searches use afp_photo_search_start, which has no cursor field. Legacy first-page callers may omit cursor. Never invent 0 or ?. Does not translate or execute an offline plan. Never repeat unchanged non-retryable input.',
      { query: querySchema, language: languageSchema,
        // 模型接口不支持前瞻正则；占位值校验留在 Host execute，schema 仅提供长度和说明。
        cursor: { type: 'string', minLength: 1, maxLength: 8192,
          description: 'For the first page use afp_photo_search_start; legacy callers omit this field. For subsequent pages copy only a returned AFP cursor; never use 0, ?, null or an invented placeholder.' }, limit: limitSchema }, ['query'], 'search', search)
    tool('afp_photo_details', 'Read one AFP photo metadata record by ID. found false means AFP did not return it. No image bytes or signed media links.',
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
    tool('afp_collection_items', 'Read a page of photo metadata from an account-visible collection. Continue with nextOffset while hasMore is true. Never changes membership.',
      { collectionId: resourceIdSchema, offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER }, limit: limitSchema }, ['collectionId'], 'read', async (args, exec) => {
        const result = await read('collection-items', args, exec)
        return { items: result.items.map(photoMetadata), collection: collectionMetadata(result.collection), offset: result.offset,
          total: result.total, hasMore: result.hasMore, nextOffset: result.hasMore ? result.offset + result.items.length : null, meta: {} }
      })
    tool('afp_collections', 'Read exact private AFP target names and membership counts.', {}, [], 'read', (_args, exec) => service.collections(exec.signal))
    tool('afp_report', 'Read a saved visual dry-run or write report.', { runId: idSchema, planId: idSchema }, [], 'read', args => service.report(args))
    tool('afp_plan_change', 'Prepare an expiring Session-owned dry-run for append, replace or clear. Present exact targets and counts before afp_apply; never writes AFP.',
      { operation: { type: 'string', enum: ['append', 'replace', 'clear'] }, categories: categorySchema, runId: idSchema }, ['operation', 'categories'], 'read', (args, exec) => service.changes.plan(args, owner(exec), exec.signal))
  } else if (feature === 'refresh') {
    tool('afp_refresh', 'Start or resume a background visual dry-run. Never writes AFP. Use job_output and afp_report; stop with job_kill.', { categories: categorySchema, runId: idSchema }, [], 'execute', (args, exec) => service.startRefresh(args, owner(exec), exec.signal))
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
