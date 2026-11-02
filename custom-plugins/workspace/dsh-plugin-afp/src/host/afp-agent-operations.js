import { randomUUID } from 'node:crypto'
import { createAgentToolRegistrar } from './afp-agent-tools.js'
import { AfpArgumentError } from './afp-agent-errors.js'
import { photoReadTools } from './afp-conversation-records.js'
import { currentPhotoEvidence } from './afp-photo-selection.js'
import { digest } from './afp-state-store.js'
import { categories } from './afp-refresh-workflow.js'
import { resolveCategoryBinding } from './afp-category-bindings.js'
import { downloadErrorCode } from './afp-downloads.js'
import { isPrivateSelection, selectionDocIds } from '../vendor/auto-afp-img/afp-collection-run.mjs'

const resourceId = { type: 'string', minLength: 1, maxLength: 256, pattern: '^[^\\u0000-\\u001f\\u007f]+$' }
const uuid = { type: 'string', pattern: '^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$' }
const nullableResource = { ...resourceId, type: ['string', 'null'] }
const ids = { type: 'array', minItems: 1, maxItems: 120, items: resourceId }
const owner = exec => exec.agent.id
function failure(code, message, action) {
  return Object.assign(new Error(message), { afpAgentError: { code, stage: 'validation', message, action, retryable: false } })
}
const changed = () => failure('operation-plan-changed', 'AFP state changed after the preview', 'Inspect the current account and collections, then create a new preview for approval.')
const invalidChoice = message => failure('operation-invalid-choice', message, 'Read the named AFP collections and their membership, correct the operation or target, then create a fresh preview.')

function fieldFailure({ field, value, expected, expectedType, guidance, code = 'operation-invalid-choice' }) {
  return new AfpArgumentError({ field, expected, expectedType, guidance, receivedType: value === null ? 'null' : typeof value }, code)
}

/** Session-owned confirmations for workbench operations exposed to the AFP Agent.
 * Quote credentials and directory paths remain inside the existing downloader.
 */
export class AfpAgentOperations {
  constructor(service) { this.service = service; this.plans = new Map() }
  dispose() { this.plans.clear() }
  remember(sessionId, kind, args, snapshot, report, secret) {
    const now = Date.now()
    for (const [id, plan] of this.plans) if (plan.expiresAt <= now) this.plans.delete(id)
    const planId = randomUUID(), expiresAt = Math.min(now + this.service.config.planTtlMs, report.expiresAt ?? Infinity)
    const summary = { ...report, planId, kind, expiresAt, requiresApproval: true }
    this.plans.set(planId, { sessionId, kind, args: structuredClone(args), snapshot, summary, secret, expiresAt,
      readEpoch: this.service.previewCacheScope, writeEpoch: this.service.writeEpoch, state: 'planned' })
    return summary
  }
  async evidence(exec, photoIds) {
    const evidence = await currentPhotoEvidence(exec.agent.session, this.service.conversationRecords)
    const missing = new Set(photoIds.filter(id => !evidence.photos.has(id)))
    if (!missing.size) return
    for (const runId of evidence.reports) {
      let run
      try { run = await this.service.store.readRun(runId) }
      catch (error) {
        // An archived report contributes no proof; other storage failures remain visible.
        if (error.code === 'ENOENT') continue
        throw error
      }
      for (const item of run.decisions) if (item.keep) missing.delete(item.id)
      if (!missing.size) return
    }
    throw failure('operation-evidence-missing', 'Selected AFP photos lack current Turn evidence', 'Read the exact photo IDs or their kept visual report in this Turn before preparing this operation.')
  }
  async collectionSnapshot(args, signal) {
    const { client, account } = await this.service.connection.open(signal)
    const catalog = await client.listSelections()
    const requested = [...new Set([...args.sourceCollectionIds, ...(args.targetCollectionId ? [args.targetCollectionId] : [])])]
    const rows = []
    for (const id of requested) {
      const row = catalog.find(item => item.id === id)
      if (!row?.name?.trim()) throw invalidChoice('AFP collection is missing or unnamed')
      if ((id === args.targetCollectionId || ['move', 'remove'].includes(args.action)) && (!isPrivateSelection(row) || row.readOnly === true)) {
        throw invalidChoice('Choose a private writable AFP collection')
      }
      rows.push({ id, name: row.name, docs: [...selectionDocIds(await client.getSelection(id))].sort() })
    }
    rows.sort((a, b) => a.id.localeCompare(b.id))
    return { account, rows, hash: digest(JSON.stringify({ account, rows })) }
  }
  async collectionPlan(args, exec) {
    await this.evidence(exec, args.photoIds)
    const photoIds = [...new Set(args.photoIds)], sourceCollectionIds = [...new Set(args.sourceCollectionIds)]
    if (args.action === 'remove' ? args.targetCollectionId !== null : !args.targetCollectionId) throw fieldFailure({
      field: 'targetCollectionId', value: args.targetCollectionId,
      expected: args.action === 'remove' ? 'JSON null (without quotes)' : 'an existing private writable target collection ID',
      expectedType: args.action === 'remove' ? 'null' : 'string',
      guidance: 'For removal use JSON null, not the string "null": {"action":"remove","targetCollectionId":null}. For add/copy/move copy a real target ID from afp_collection_list. Create a fresh preview after correcting this field.',
    })
    if (args.action === 'add' ? sourceCollectionIds.length : !sourceCollectionIds.length) throw invalidChoice('Choose source collections for copy, move or remove; use no sources for add')
    if (args.action === 'move' && sourceCollectionIds.includes(args.targetCollectionId)) throw invalidChoice('Choose a different target collection')
    const input = { ...args, photoIds, sourceCollectionIds }
    const snapshot = await this.collectionSnapshot(input, exec.signal)
    const sources = snapshot.rows.filter(row => sourceCollectionIds.includes(row.id))
    const photoSources = Object.fromEntries(photoIds.map(id => [id, sources.filter(row => row.docs.includes(id)).map(row => row.id)]))
    if (args.action !== 'add' && photoIds.some(id => !photoSources[id].length)) throw invalidChoice('A selected photo no longer belongs to its source collection')
    const target = snapshot.rows.find(row => row.id === args.targetCollectionId)
    return this.remember(owner(exec), 'collection', { ...input, photoSources }, snapshot, {
      operation: args.action, photoCount: photoIds.length, photoIds,
      sources: sources.map(({ id, name }) => ({ id, name })), target: target ? { id: target.id, name: target.name } : null,
      add: target ? photoIds.filter(id => !target.docs.includes(id)).length : 0,
      remove: ['move', 'remove'].includes(args.action) ? Object.values(photoSources).reduce((count, values) => count + values.length, 0) : 0,
    })
  }
  async bindingSnapshot(args, signal) {
    const { client, account } = await this.service.connection.open(signal)
    const catalog = await client.listSelections(), bindings = await this.service.store.readBindings(account)
    const resolved = resolveCategoryBinding(catalog, bindings.values, args.category, args.collectionId)
    if (resolved.kind !== 'valid') throw fieldFailure({
      field: 'collectionId', value: args.collectionId,
      expected: 'JSON null to unbind, or a uniquely named private writable collection not assigned to another category',
      guidance: resolved.kind === 'category-conflict'
        ? 'This collection is already used by another category, including default bindings. Choose a different target, or use {"collectionId":null} to unbind the requested category. Create a fresh preview.'
        : 'Choose one existing private writable collection with a unique valid name from afp_collection_list. Resolve duplicate names or IDs before binding. To unbind use JSON null without quotes: {"collectionId":null}. Create a fresh preview.',
    })
    const target = resolved.target
    return { hash: digest(JSON.stringify({ account, bindings: bindings.values, target })), target }
  }
  async bindingPlan(args, exec) {
    const snapshot = await this.bindingSnapshot(args, exec.signal)
    return this.remember(owner(exec), 'binding', args, snapshot.hash, { operation: 'category-binding', category: args.category,
      target: snapshot.target ? { id: snapshot.target.id, name: snapshot.target.name } : null })
  }
  async downloadPlan(args, exec) {
    await this.evidence(exec, args.items.map(item => item.photoId))
    const report = await this.service.downloads.prepare(args, exec.signal)
    if (report.changed) return report
    const { confirmation, planId: downloadPlanId, ...safe } = report
    return this.remember(owner(exec), 'download', args, null, safe, { confirmation, downloadPlanId })
  }
  checked(planId, sessionId) {
    const plan = this.plans.get(planId)
    if (!plan || plan.sessionId !== sessionId || plan.state !== 'planned' || plan.expiresAt <= Date.now()) throw failure('operation-plan-unavailable', 'AFP operation plan is expired, used or belongs to another conversation', 'Create a new preview in this conversation and request approval.')
    this.service.require('read')
    if (plan.readEpoch !== this.service.previewCacheScope) throw changed()
    if (plan.kind === 'collection' || plan.kind === 'download' && plan.summary.totalCost > 0) {
      this.service.require('write')
      if (plan.writeEpoch !== this.service.writeEpoch) throw changed()
    }
    return plan
  }
  check(planId, sessionId) { return this.checked(planId, sessionId).summary }
  async apply(planId, exec) {
    const plan = this.checked(planId, owner(exec))
    if (plan.kind === 'collection') {
      const current = await this.collectionSnapshot(plan.args, exec.signal)
      if (current.hash !== plan.snapshot.hash) throw changed()
    } else if (plan.kind === 'binding') {
      const current = await this.bindingSnapshot(plan.args, exec.signal)
      if (current.hash !== plan.snapshot) throw changed()
    }
    exec.signal.throwIfAborted()
    // Snapshot reads may overlap; only one caller may consume the approved plan.
    this.checked(planId, owner(exec))
    plan.state = 'used'
    if (plan.kind === 'download') {
      return this.service.downloads.confirm({ planId: plan.secret.downloadPlanId, confirmation: plan.secret.confirmation, confirmed: true }, exec.signal, owner(exec))
    }
    if (plan.kind === 'binding') return this.service.bindCategory(plan.args, exec.signal, plan.snapshot)
    return { ...this.service.job('write', owner(exec), 'AFP approved collection operation', async signal => {
      const result = await this.service.collectionOperation({ action: plan.args.action === 'add' ? 'copy' : plan.args.action,
        photoIds: plan.args.photoIds, photoSources: plan.args.photoSources, targetCollectionId: plan.args.targetCollectionId }, signal, plan.snapshot)
      return { ...result, status: result.partial || result.pending || result.failed ? 'failed' : 'completed' }
    }), planId }
  }
}

/** Expose existing workbench business operations only inside the AFP preset.
 * @param {object} ctx Preset-scoped Cordis context.
 * @param {object} service Shared AFP profile service.
 * @returns {void} Tools and approval listeners follow the preset lifetime.
 */
export function registerExtendedAgentTools(ctx, service) {
  const register = createAgentToolRegistrar(ctx, service, 'read')
  const tool = (name, description, properties, required, kind, run) => register(name, description, properties, required, kind, async (...args) => {
    let value
    const [input, exec] = args
    try { value = await service.workbench.track(exec.signal, true, signal => run(input, { ...exec, signal })) }
    catch (error) {
      const code = downloadErrorCode(error)
      if (!code) throw error
      throw failure(code, code, 'Check download options, account credit, destination and enabled capabilities; create a fresh preview. Never retry a purchase automatically.')
    }
    service.require('read')
    if (!photoReadTools.has(name) && Buffer.byteLength(JSON.stringify(value)) > service.config.agentResultMaxBytes) {
      throw Object.assign(new Error('AFP result exceeds its output budget'), { afpAgentError: {
        code: 'result-too-large', stage: 'read', action: 'Request fewer photos or a smaller limit.', retryable: false,
      } })
    }
    return { ...value, meta: value.meta ?? {} }
  })
  tool('afp_account', 'Read safe AFP account information and credit balance. Never returns credentials.', {}, [], 'read', (_args, exec) => service.workbench.accountProfile(exec.signal))
  tool('afp_history', 'Browse saved visual runs or collection plans. Copy the returned offset to continue; inspect a report before using it.', {
    kind: { type: 'string', enum: ['runs', 'plans'] }, offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    limit: { type: 'integer', minimum: 1, maximum: service.config.pageSize },
  }, ['kind', 'offset', 'limit'], 'read', (args, exec) => service.workbench.historyList(args, exec.signal))
  tool('afp_run_items', 'Read a page of kept, rejected or failed photos from a saved visual run, including decision reasons. If nextOffset is non-null, finish the compacted result through afp_result_page first. Then continue the run with runNextOffset; read afp_report before recording a final visual selection.', {
    runId: uuid, category: { type: 'string', enum: ['all', ...categories] },
    decision: { type: 'string', enum: ['all', 'kept', 'rejected', 'failed'] },
    offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
    limit: { type: 'integer', minimum: 1, maximum: service.config.pageSize },
  }, ['runId', 'category', 'decision', 'offset', 'limit'], 'read', async (args, exec) => {
    const { category, ...page } = args
    const { offset, ...result } = await service.workbench.runItems({ ...page, ...(category === 'all' ? {} : { category }) }, exec.signal)
    return { ...result, runOffset: offset, runNextOffset: result.hasMore ? offset + result.items.length : null }
  })
  tool('afp_diagnostics', 'Read saved, sanitized timing and failure diagnostics with a page of trace events. Continue with nextOffset; no model request.',
    { runId: uuid, offset: { type: 'integer', minimum: 0, maximum: Number.MAX_SAFE_INTEGER },
      limit: { type: 'integer', minimum: 1, maximum: service.config.pageSize } }, ['runId', 'offset', 'limit'], 'read', async args => {
      const value = await service.diagnostics.read(args.runId)
      if (value === null) return { runId: args.runId, diagnostics: null, events: [], nextOffset: null, total: 0 }
      const { events, errors, timings, ...summary } = value
      const end = args.offset + args.limit, total = Math.max(events.length, errors.length, timings.length)
      return { runId: args.runId, diagnostics: { ...summary, errors: errors.slice(args.offset, end), timings: timings.slice(args.offset, end) },
        events: events.slice(args.offset, end), eventTotal: events.length, errorTotal: errors.length, timingTotal: timings.length,
        nextOffset: end < total ? end : null }
    })
  tool('afp_run_control', 'Pause a running visual task or archive an inactive report. Pause preserves checkpoints. Archive keeps AFP collections unchanged.', {
    action: { type: 'string', enum: ['pause', 'archive'] }, runId: uuid,
  }, ['action', 'runId'], 'edit', (args, exec) => args.action === 'pause' ? service.pauseRun(args.runId, owner(exec)) : service.deleteRun(args.runId))
  tool('afp_collection_plan', 'Preview adding selected photos, or copying, moving or removing collection members. Uses exactly photoIds, unlike whole-run afp_plan_change. Read these photos or their visual report in this Turn first. Apply its planId through afp_operation_apply.', {
    action: { type: 'string', enum: ['add', 'copy', 'move', 'remove'] }, photoIds: ids,
    sourceCollectionIds: { ...ids, minItems: 0, description: 'Source collections for copy/move/remove; empty only for add.' },
    targetCollectionId: { ...nullableResource, description: 'For remove, required JSON null without quotes: {"action":"remove","targetCollectionId":null}. For add/copy/move copy a real target collection ID.' },
  }, ['action', 'photoIds', 'sourceCollectionIds', 'targetCollectionId'], 'read', (args, exec) => service.agentOperations.collectionPlan(args, exec))
  tool('afp_category_plan', 'Preview binding a built-in screening category to a private writable collection, or unbinding it. Requires confirmation through afp_operation_apply.', {
    category: { type: 'string', enum: categories }, collectionId: { ...nullableResource, description: 'Copy an existing private writable collection ID to bind. To unbind use JSON null without quotes, not the string "null": {"collectionId":null}.' },
  }, ['category', 'collectionId'], 'read', (args, exec) => service.agentOperations.bindingPlan(args, exec))
  tool('afp_download_options', 'Read available image renditions and credit quotes for photos read in this Turn. Does not purchase or download. Use returned rendition IDs in afp_download_plan.',
    { photoIds: ids }, ['photoIds'], 'read', async (args, exec) => {
      await service.agentOperations.evidence(exec, args.photoIds)
      return service.downloads.options(args, exec.signal)
    })
  tool('afp_download_directory', 'Browse or select a download destination through the Host directory picker. Selection returns an opaque directoryId; the download plan accepts that ID instead of a path. For a native picker, use select with path=null.', {
    action: { type: 'string', enum: ['browse', 'select'] }, path: { type: ['string', 'null'], minLength: 1, maxLength: 4096,
      description: 'For a native picker use JSON null without quotes: {"action":"select","path":null}. For browse backends use the actual path from a successful directory listing.' },
  }, ['action', 'path'], 'read', async (args, exec) => {
    if (args.action === 'select' && args.path !== null && service.ctx.directoryPicker?.capability?.()?.kind === 'native') {
      throw fieldFailure({ field: 'path', value: args.path, expected: 'JSON null for the native directory picker', expectedType: 'null', code: 'operation-failed',
        guidance: 'Open the native picker with JSON null without quotes: {"action":"select","path":null}. Do not substitute a string or invent a directory ID.' })
    }
    const input = args.path === null ? {} : { path: args.path }
    return args.action === 'browse' ? service.downloads.browseDirectory(input, exec.signal) : { directory: await service.downloads.pickDirectory(exec.signal, input) }
  })
  tool('afp_download_plan', 'Preview exact image renditions, destination and total credit cost. Quote changes return changed=true and require a new choice. Apply only the returned planId through afp_operation_apply after human approval.', {
    items: { type: 'array', minItems: 1, maxItems: 120, items: { type: 'object', additionalProperties: false,
      properties: { photoId: resourceId, renditionId: resourceId }, required: ['photoId', 'renditionId'] } },
    directoryId: resourceId, prefix: { type: 'string', minLength: 0, maxLength: 80 }, suffix: { type: 'string', minLength: 0, maxLength: 80 },
  }, ['items', 'directoryId', 'prefix', 'suffix'], 'read', (args, exec) => service.agentOperations.downloadPlan(args, exec))
  ctx.on('tools/pre-execute', async (exec, next) => {
    const decision = await next()
    if (exec.name !== 'afp_operation_apply' || decision.kind !== 'allow') return decision
    try {
      const report = await service.agentOperations.check(exec.arguments?.planId, owner(exec))
      return { kind: 'ask', reason: `AFP confirmed operation: ${JSON.stringify(report)}`,
        displayReason: { en: `Apply AFP operation? ${JSON.stringify(report)}`, zh: `执行 AFP 操作？${JSON.stringify(report)}` } }
    } catch (error) { return { kind: 'deny', reason: 'AFP operation plan is invalid or unavailable. Create a new preview.' } }
  })
  tool('afp_operation_apply', 'Apply a Session-owned collection, binding or download preview after DSH human approval. Rechecks the plan and relevant state. Never retry a partial or uncertain write automatically.',
    { planId: uuid }, ['planId'], 'edit', (args, exec) => service.agentOperations.apply(args.planId, exec))
}
