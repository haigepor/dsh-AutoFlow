/** Preserve the shipped plugin, Jobs, DSH runner and persistence; replace public-source I/O and random task IDs. */
import assert from 'node:assert/strict'
import { registerHooks } from 'node:module'

export const name = 'article-image-understanding-fixture'
export const inject = ['agents', 'tools', 'systemPrompt', 'jobs', 'profileContext', 'pluginManager', 'web', 'sessionPersistence']

export async function apply(ctx) {
  const fixedCrypto = new URL('./fixture-crypto.mjs', import.meta.url).href
  ctx.effect(() => {
    const hooks = registerHooks({ resolve(specifier, context, nextResolve) {
      const articleModule = /\/dsh-plugin-article-image\/src\/host\/(analysis-runner|workflow-service)\.js$/.test(context.parentURL ?? '')
      return specifier === 'node:crypto' && articleModule ? { url: fixedCrypto, shortCircuit: true } : nextResolve(specifier, context)
    } })
    return () => hooks.deregister()
  }, 'Article fixture identities')
  const plugin = await import('../../../custom-plugins/workspace/dsh-plugin-article-image/index.js')
  const execute = await import('../../../custom-plugins/workspace/dsh-plugin-article-image/execute.js')
  const { hashSnapshot } = await import('../../../custom-plugins/workspace/dsh-plugin-article-image/article-image-toolkit/src/capture-contracts.js')
  const { createAnalysisRunner } = await import('../../../custom-plugins/workspace/dsh-plugin-article-image/src/host/analysis-runner.js')
  await ctx.plugin(plugin, { analysis: { provider: 'article-fixture', model: 'analysis' } })
  await ctx.plugin(execute, { feature: 'tools' })
  const service = ctx.get('articleImage')
  // 本场景的 cwd 是 harness 创建的独立空目录；保留真实分析器并固定可归一化的任务位置。
  service.analysis = createAnalysisRunner(service.ctx, service.config.analysis, { cwd: process.cwd() })
  const source = { schemaVersion: 2, id: '11111111111111111111111111111111', title: 'Planning family travel',
    requestedUrl: 'https://example.com/family-travel', url: 'https://example.com/family-travel', language: 'en',
    capturedAt: '2026-10-17T00:00:00.000Z', extractorVersion: 'article-fixture-1',
    blocks: [{ id: 'b1', type: 'paragraph', inline: [{ text: 'Families plan outdoor activities and rest breaks during a relaxed trip.' }] }],
    assets: [], quality: { status: 'passed', reasons: [] } }
  source.sourceHash = hashSnapshot(source)
  service.download = async () => 'Links,Category,语言,备注\nhttps://example.com/family-travel,Travel,en,Family readers\nhttps://example.com/failed-analysis,Travel,en,Failure case\nhttps://example.com/cancelled-analysis,Travel,en,Cancellation case\n'
  service.capture = { readiness: async () => ({ available: true }), capture: async url => {
    const article = structuredClone(source)
    article.url = url; article.requestedUrl = url
    if (url.endsWith('/failed-analysis')) { article.id = '22222222222222222222222222222222'; article.title = 'Failed article' }
    if (url.endsWith('/cancelled-analysis')) { article.id = '33333333333333333333333333333333'; article.title = 'Cancelled article' }
    article.sourceHash = hashSnapshot(article)
    return { snapshot: article, assets: [] }
  }, dispose: async () => {} }
  await service.importSource({ url: 'https://docs.google.com/spreadsheets/d/article-fixture/edit#gid=0' })
  const items = (await service.list()).items
  const id = items.find(item => item.url.endsWith('/family-travel')).id
  const failedId = items.find(item => item.url.endsWith('/failed-analysis')).id
  const cancelledId = items.find(item => item.url.endsWith('/cancelled-analysis')).id
  const cancelEntered = Promise.withResolvers()
  ctx.systemPrompt.section({ name: 'article-image-fixture', order: 9000, text: `Article fixture id: ${id}. Failed article id: ${failedId}. Cancelled article id: ${cancelledId}. Process the first two sequentially, collect each job and report; read the first article's complete plan with its reported inputHash and revision. Then start and kill the cancellation job, collect its output and report. Reply ARTICLE_IMAGE_REVIEW_READY. Do not approve or generate images.` })
  ctx.on('agent/created', ({ agent }) => {
    if (agent.id.startsWith('a1000000-')) return
    agent.ctx.tools.restrict({ allow: ['article_image_fetch', 'job_output', 'job_kill', 'article_image_report', 'article_image_plan_page'] })
    agent.ctx.on('agent/request', async (_payload, next) => ({ ...await next(), maxTokens: 6000 }))
  })
  // 取消发生在已持久接收输入的分析会话中，避免主会话 kill 与创建子会话之间的调度竞态。
  ctx.on('agent/pre-step', async ({ agent, messages, signal }, next) => {
    const cancellation = agent.id.startsWith('a1000000-') && messages.some(message => message.content.some(block => block.type === 'text' && block.text.includes('"title":"Cancelled article"')))
    if (!cancellation) return next()
    cancelEntered.resolve()
    await new Promise(resolve => { if (signal.aborted) resolve(); else signal.addEventListener('abort', resolve, { once: true }) })
    return { kind: 'reject' }
  })
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name === 'job_kill') await cancelEntered.promise
    return next()
  })
  ctx.on('agent/turn-stopping', async ({ agent }) => {
    if (agent.id.startsWith('a1000000-')) return
    const item = await service.detail(id)
    assert.equal(item.state, 'review', JSON.stringify({ error: item.error, stage: item.run?.stage }))
    assert.equal(item.approval, null)
    assert.equal(item.plan.inputHash, item.analysis.input.inputHash)
    assert.deepEqual(item.plan.coverage, { blockIds: ['b1'], assetIds: [] })
    assert.equal(item.analysis.checkpoints.length, 2)
    const pageEvent = agent.session.snapshotEvents(0).find(event => event.type === 'tool/result' && event.data.message.source.callId === 'plan-page-1')
    assert.ok(pageEvent); assert.equal(pageEvent.data.message.isError, false)
    const page = JSON.parse(pageEvent.data.message.content[0].text)
    assert.equal(page.inputHash, item.plan.inputHash); assert.equal(page.revision, item.revision); assert.equal(page.nextOffset, null)
    assert.equal(page.encoding, 'json-code-points'); assert.equal(page.totalCharacters, Array.from(page.fragment).length)
    assert.deepEqual(JSON.parse(page.fragment), item.plan)
    assert.ok(Buffer.byteLength(JSON.stringify(page)) <= service.config.toolResultBytes)
    const failed = await service.detail(failedId), cancelled = await service.detail(cancelledId)
    assert.equal(failed.state, 'failed'); assert.equal(failed.error, 'analysis-submission-missing'); assert.equal(failed.plan, null)
    assert.equal(cancelled.state, 'cancelled'); assert.equal(cancelled.plan, null)
    assert.equal(failed.approval, null); assert.equal(cancelled.approval, null)
    assert.equal((await service.status()).generation.available, false)
  })
}
