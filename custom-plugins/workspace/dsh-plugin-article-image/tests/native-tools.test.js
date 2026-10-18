/** Native Agents retrieve complete frozen plans, edit them and leave approval to the workbench. */
import { test, expect, vi } from 'vitest'
import { registerTools } from '../src/host/tools.js'

const id = '1'.repeat(32), sourceHash = '2'.repeat(64), inputHash = '3'.repeat(64), rulesHash = '4'.repeat(64)
function plan() {
  const coverage = { blockIds: ['b1'], assetIds: [] }
  const understanding = { articleType: 'Guide', audience: 'Parents', purpose: 'Plan travel', language: 'en', theme: 'Family travel', sections: [{ title: 'Planning', summary: 'Plan rest breaks', blockIds: ['b1'] }], entities: ['Families'], facts: [{ id: 'f1', claim: 'Families plan rest breaks.', kind: 'source', evidence: coverage }], limitations: [], questions: [], images: [], coverage }
  return { sourceHash, inputHash, rulesHash, model: { provider: 'fixture', model: 'analysis', maxTokens: 6000 }, coverage, understanding,
    brief: { theme: 'Family travel', facts: ['Rest breaks'], subjects: ['Family'], scenes: ['Park'] },
    shots: [{ purpose: 'cover', paragraphs: [1], blockIds: ['b1'], assetIds: [], afterBlockId: 'b1', rationale: 'Travel theme', informationGoal: 'Relaxed travel', visualMode: 'conceptual', subject: 'Family', action: 'resting', environment: 'Park', composition: 'Wide', lighting: 'Daylight', colors: 'Natural', style: 'Editorial', details: 'Plausible scene', avoid: 'No event claim', prompt: 'A family resting in a park.', ratio: '16:9' }],
    shortfall: { requested: 1, actual: 1, reason: '' }, checks: { structural: true, semanticReviewRequired: true } }
}
function fixture() {
  const tools = new Map(), value = plan()
  const service = { config: { toolResultBytes: 8000 }, requireTools: vi.fn(), fetchBatchLimit: () => 100,
    detail: vi.fn(async () => ({ id, revision: 3, state: 'review', url: 'https://example.com/a', article: { title: '旅行 🌿', hash: sourceHash, paragraphs: [{ id: 1, text: 'Family travel' }] }, plan: value, approval: null, error: null })),
    articleSource: () => ({ url: 'https://example.com/a', basis: 'web' }),
    planPage: vi.fn(async args => ({ id, revision: 3, sourceHash, inputHash, rulesHash, offset: args.offset, totalCharacters: 3, fragment: '中🌿文', nextOffset: null, encoding: 'json-code-points' })),
    savePlan: vi.fn(async args => ({ id, revision: 4, state: 'review', plan: args.plan })),
  }
  registerTools({ effect: factory => factory(), tools: { register: definition => { tools.set(definition.name, definition); return () => tools.delete(definition.name) } } }, service)
  const call = (name, args) => tools.get(name).execute(args, { signal: new AbortController().signal, agent: { id: 'native-agent' } })
  return { tools, service, call, value }
}

test('native catalogue exposes complete-plan retrieval without approval or image generation', () => {
  const { tools } = fixture()
  expect([...tools.keys()]).toEqual(['article_image_status', 'article_image_import', 'article_image_items', 'article_image_fetch', 'article_image_article', 'article_image_plan_page', 'article_image_save_plan', 'article_image_report'])
  expect([...tools.keys()].some(name => /approve|generate/.test(name))).toBe(false)
  const fields = tools.get('article_image_save_plan').parameters.properties
  expect(fields.plan.required).toEqual(expect.arrayContaining(['inputHash', 'rulesHash', 'understanding', 'coverage', 'model']))
  expect(fields.syncPromptShots.items).toMatchObject({ type: 'integer', minimum: 0 })
  expect(tools.get('article_image_plan_page').parameters.required).toEqual(expect.arrayContaining(['id', 'inputHash', 'revision']))
})

test('report returns the exact input, rules and model identities needed to read the current plan', async () => {
  const { call, value } = fixture()
  const report = await call('article_image_report', { id })
  expect(report).toMatchObject({ id, revision: 3, sourceHash, inputHash, rulesHash, model: value.model, state: 'review', approval: null, generationAvailable: false })
  expect(Buffer.byteLength(JSON.stringify(report))).toBeLessThanOrEqual(8000)
})

test('plan pages preserve Unicode fragments and validate exact input hash and offsets', async () => {
  const { call, service } = fixture()
  const page = await call('article_image_plan_page', { id, inputHash, revision: 3, offset: 0 })
  expect(service.planPage).toHaveBeenCalledWith({ id, inputHash, revision: 3, offset: 0 })
  expect(page).toMatchObject({ fragment: '中🌿文', totalCharacters: 3, encoding: 'json-code-points' })
  await expect(call('article_image_plan_page', { id, inputHash: 'invented', revision: 3, offset: 0 })).rejects.toThrow('invalid-request')
  await expect(call('article_image_plan_page', { id, inputHash, revision: 3, offset: -1 })).rejects.toThrow('invalid-request')
  await expect(call('article_image_plan_page', { id, inputHash, offset: 0 })).rejects.toThrow('invalid-request')
  await expect(call('article_image_plan_page', { id, inputHash, revision: 0, offset: 0 })).rejects.toThrow('invalid-request')
  expect(service.planPage).toHaveBeenCalledTimes(1)
})

test('saving a complete plan forwards explicit synchronization choices and rejects legacy-only drafts', async () => {
  const { call, service, value } = fixture()
  expect(await call('article_image_save_plan', { id, revision: 3, plan: value, syncPromptShots: [0] })).toMatchObject({ state: 'review', inputHash, rulesHash })
  expect(service.savePlan).toHaveBeenCalledWith({ id, revision: 3, plan: value, syncPromptShots: [0] })
  const legacy = { sourceHash, brief: value.brief, shots: value.shots.map(shot => Object.fromEntries(['purpose', 'paragraphs', 'rationale', 'subject', 'action', 'environment', 'composition', 'lighting', 'colors', 'style', 'details', 'avoid', 'prompt', 'ratio'].map(key => [key, shot[key]]))) }
  await expect(call('article_image_save_plan', { id, revision: 3, plan: legacy })).rejects.toThrow('invalid-request')
  expect(service.savePlan).toHaveBeenCalledTimes(1)
})

test('native adapters reject oversized pages or reports instead of leaking unbounded results', async () => {
  const { call, service } = fixture()
  service.planPage.mockResolvedValue({ fragment: '中文🌿'.repeat(4000) })
  await expect(call('article_image_plan_page', { id, inputHash, revision: 3 })).rejects.toThrow('response-size')
  const item = await service.detail()
  item.plan.brief.theme = '中'.repeat(10000)
  service.detail.mockResolvedValue(item)
  await expect(call('article_image_report', { id })).rejects.toThrow('response-size')
})
