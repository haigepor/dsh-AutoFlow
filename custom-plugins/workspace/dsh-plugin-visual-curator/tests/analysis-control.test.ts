/** Analysis controls acknowledge durable intent before a pending provider finishes cleanup. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers/promises'
import { z } from 'zod'
import { serviceFixture } from './helpers/service-fixture.ts'

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(accept => { resolve = accept })
  return { promise, resolve }
}

for (const command of ['pause', 'cancel'] as const) test(`${command} returns its accepted state while provider cleanup is still pending`, { timeout: 10_000 }, async () => {
  const fixture = await serviceFixture(), entered = deferred(), aborted = deferred(), release = deferred()
  const request = fixture.http.request.bind(fixture.http)
  fixture.http.request = async (url, input) => {
    if (url.startsWith('https://vision.example.test')) {
      input.signal?.addEventListener('abort', () => aborted.resolve(), { once: true })
      entered.resolve()
      // 上游收到中止后仍可能等待清理；控制回执不能与该等待绑定。
      await release.promise
    }
    return request(url, input)
  }
  let pending: Promise<unknown> | undefined
  try {
    await fixture.service.initialize()
    const style = z.object({ id: z.string() }).parse(await fixture.action('style-create', { operationId: 'control-style', name: 'Control fixture' }))
    await fixture.action('reference-import', { operationId: 'control-image', styleId: style.id, expectedRevision: 1, files: [{ name: 'control.png', mime: 'image/png', base64: fixture.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
    const run = z.object({ runId: z.string() }).parse(await fixture.action('reference-analyze', { operationId: 'control-analysis', styleId: style.id }))
    await entered.promise
    let acknowledged = false
    pending = fixture.action('run-control', { runId: run.runId, command, waitForCompletion: false }).then(value => { acknowledged = true; return value })
    await aborted.promise
    await setImmediate()
    assert.equal(acknowledged, true, 'Control must acknowledge before the blocked provider is released')
    const receipt = z.object({ status: z.string() }).parse(await pending)
    assert.equal(receipt.status, command === 'pause' ? 'pausing' : 'cancelling')
    if (command === 'cancel') {
      const later = z.object({ status: z.string() }).parse(await fixture.action('run-control', { runId: run.runId, command: 'pause', waitForCompletion: false }))
      assert.equal(later.status, 'cancelling', 'A late pause cannot weaken an accepted cancellation')
    }
    release.resolve()
    await fixture.jobs.drain()
    assert.equal(fixture.domain.require('run', run.runId).status, command === 'pause' ? 'paused' : 'cancelled')
    assert.equal(fixture.repository.list('observation').length, 0)
  } finally {
    release.resolve()
    await pending
    await fixture.cleanup()
  }
})
