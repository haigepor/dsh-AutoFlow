import { randomUUID } from 'node:crypto'
import { buildCollectionPlans, isPrivateSelection, selectionDocIds } from '../vendor/auto-afp-img/afp-collection-run.mjs'
import { CATEGORY_PROFILES } from '../vendor/auto-afp-img/afp-photo-search.mjs'
import { chooseCategories, manifests } from './afp-refresh-workflow.js'
import { digest } from './afp-state-store.js'

/** Resolve exact private targets and snapshot every collection's document membership. */
async function snapshot(client, selected, signal) {
  const list = await client.listSelections()
  if (!Array.isArray(list)) throw new Error('Invalid AFP collection list')
  const targets = []
  for (const category of selected) {
    const name = CATEGORY_PROFILES.find(profile => profile.key === category).selectionName
    const matches = list.filter(item => item.name === name)
    if (matches.length > 1 || (matches.length === 1 && !isPrivateSelection(matches[0]))) throw new Error('Ambiguous or shared AFP target')
    if (matches[0] && (typeof matches[0].id !== 'string' || !matches[0].id)) throw new Error('AFP target has no id')
    targets.push({ category, name, id: matches[0]?.id ?? null })
  }
  const records = []
  for (const item of list) {
    signal.throwIfAborted()
    if (typeof item.id !== 'string' || !item.id) throw new Error('AFP collection has no id')
    records.push({ id: item.id, name: item.name, private: isPrivateSelection(item), docs: [...selectionDocIds(await client.getSelection(item.id))].sort() })
  }
  records.sort((a, b) => a.id.localeCompare(b.id))
  return { targets, records, hash: digest(JSON.stringify(records)), list }
}

function safeSummary(plan) {
  return { planId: plan.id, operation: plan.operation, expiresAt: plan.expiresAt,
    categories: plan.targets.map(target => ({ category: target.category, selectionName: target.name,
      existing: target.existing, remove: plan.operation === 'append' ? 0 : target.existing,
      add: target.docs.length, create: target.id === null && plan.operation !== 'clear' })),
    requiresApproval: true }
}

/** Dry-run plans are session-owned, expire, and are consumed before the first mutation. */
export class Changes {
  constructor({ store, config, connect }) { this.store = store; this.config = config; this.connect = connect }
  async plan(args, owner, signal) {
    if (!['append', 'replace', 'clear'].includes(args.operation)) throw new Error('operation must be append, replace or clear')
    const selected = chooseCategories(args.categories)
    const { client, account } = await this.connect(signal)
    return this.store.lock(`account:${account}`, async () => {
      const remote = await snapshot(client, selected, signal)
      let docsByCategory = new Map()
      let runHash = null
      if (args.operation !== 'clear') {
        const run = await this.store.readRun(args.runId)
        if (!['ready', 'paused'].includes(run.status) || run.pending) throw new Error('AFP run must have a settled dry-run report')
        if (run.account !== account) throw new Error('AFP account changed since refresh')
        if (selected.some(category => !run.categories.includes(category))) throw new Error('Category absent from AFP run')
        runHash = digest(JSON.stringify(run))
        const { candidateManifest, decisionManifest } = manifests(run, run.settings)
        candidateManifest.categories = candidateManifest.categories.filter(item => selected.includes(item.category))
        // Replacement excludes other targets and all non-target collections, but may reuse its own pictures.
        const targetIds = new Set(remote.targets.map(item => item.id).filter(Boolean))
        const reserved = new Set(remote.records.filter(item => args.operation === 'append' || !targetIds.has(item.id)).flatMap(item => item.docs))
        const plans = buildCollectionPlans({ candidateManifest, decisionManifest, selections: remote.list,
          reservedDocIds: reserved, limitPerCategory: run.settings.targetPerCategory })
        docsByCategory = new Map(plans.map(item => [item.category, item.docs]))
      }
      const plan = { schema: 1, id: randomUUID(), owner, operation: args.operation, account,
        runId: args.operation === 'clear' ? null : args.runId, runHash, remoteHash: remote.hash,
        createdAt: Date.now(), expiresAt: Date.now() + this.config.planTtlMs, state: 'planned', targets: remote.targets.map(target => ({
          ...target, existing: remote.records.find(item => item.id === target.id)?.docs.length ?? 0,
          docs: docsByCategory.get(target.category) ?? [],
        })) }
      if (args.operation === 'clear' && plan.targets.some(target => !target.id)) throw new Error('Cannot clear a missing AFP target')
      if (args.operation === 'replace' && plan.targets.some(target => target.docs.length === 0)) throw new Error('Refusing replacement with zero accepted pictures')
      signal.throwIfAborted()
      await this.store.savePlan(plan)
      return safeSummary(plan)
    })
  }
  async check(planId, owner) {
    const plan = await this.store.readPlan(planId)
    chooseCategories(plan.targets.map(item => item.category))
    if (plan.targets.some(target => target.name !== CATEGORY_PROFILES.find(profile => profile.key === target.category)?.selectionName)) throw new Error('Invalid AFP plan target')
    if (!owner || plan.owner !== owner) throw new Error('AFP plan owner mismatch')
    if (plan.state !== 'planned') throw new Error('AFP plan already used; create a new dry-run plan')
    if (plan.expiresAt <= Date.now()) throw new Error('AFP plan expired')
    return safeSummary(plan)
  }
  async execute(planId, owner, signal) {
    await this.check(planId, owner)
    const { client, account } = await this.connect(signal, true)
    return this.store.lock(`account:${account}`, async () => {
      await this.check(planId, owner)
      const plan = await this.store.readPlan(planId)
      if (plan.account !== account) throw new Error('AFP account changed')
      const remote = await snapshot(client, plan.targets.map(item => item.category), signal)
      if (remote.hash !== plan.remoteHash) throw new Error('AFP collections changed; create a new dry-run plan')
      if (plan.runId && digest(JSON.stringify(await this.store.readRun(plan.runId))) !== plan.runHash) throw new Error('AFP run changed; create a new dry-run plan')
      signal.throwIfAborted()
      plan.state = 'executing'
      plan.result = { status: 'running', categories: [] }
      await this.store.savePlan(plan)
      try {
        for (const target of plan.targets) {
          signal.throwIfAborted()
          const result = { category: target.category, removed: 0, added: 0, status: 'running' }
          plan.result.categories.push(result)
          let selectionId = target.id
          if (!selectionId) {
            const created = await client.createPrivateSelection(target.name)
            selectionId = created?.id ?? created?.selectionId ?? created?.data?.id ?? created?.data?.selectionId
            if (typeof selectionId !== 'string' || !selectionId) throw new Error('AFP create returned no id')
            // Re-list to detect concurrent creation before clearing/adding to the new target.
            const checked = await snapshot(client, [target.category], signal)
            if (checked.targets[0].id !== selectionId) throw new Error('AFP created target changed')
          }
          if (plan.operation !== 'append') {
            signal.throwIfAborted()
            await client.clearSelectionDocs(selectionId)
            result.removed = target.existing
            await this.store.savePlan(plan)
          }
          for (const doc of target.docs) {
            signal.throwIfAborted()
            // Mutations are never automatically retried: a timeout can follow a committed AFP write.
            await client.addSelectionDoc(selectionId, doc)
            result.added++
            await this.store.savePlan(plan)
          }
          const actual = selectionDocIds(await client.getSelection(selectionId))
          if (target.docs.some(doc => !actual.has(doc.id)) || (plan.operation !== 'append' && actual.size !== target.docs.length)) throw new Error('AFP post-write verification failed')
          result.status = 'completed'
          await this.store.savePlan(plan)
        }
        plan.state = 'completed'
        plan.result.status = 'completed'
      } catch (error) {
        plan.state = signal.aborted ? 'cancelled' : 'failed'
        plan.result.status = plan.state
        plan.result.error = 'Remote write may be partial; inspect collections and create a new dry-run plan. No automatic rollback or retry.'
      }
      await this.store.savePlan(plan)
      return plan.result
    })
  }
}
