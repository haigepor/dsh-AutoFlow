import { test } from 'node:test'
import assert from 'node:assert/strict'
import { serviceFixture } from './helpers/service-fixture.ts'

test('configuration reads and unchanged saves never build image projections or edit the profile', async () => {
  const fixture = await serviceFixture()
  try {
    await fixture.service.initialize()
    fixture.domain.snapshot = () => { throw new Error('A configuration operation must not project the image library') }
    fixture.host.configEditor.entries = () => { throw new Error('An unchanged save must not acquire the editor') }
    const config = await fixture.action('config-read')
    assert.ok(config && typeof config === 'object' && !Array.isArray(config) && typeof config.revision === 'string')
    const saved = await fixture.action('config-save', { revision: config.revision, vision: {}, source: {}, limits: {} })
    assert.ok(saved && typeof saved === 'object' && !Array.isArray(saved))
    assert.equal(saved.changed, false)
    assert.deepEqual(saved.configuration, config)
    assert.equal(fixture.jobs.hooks.length, 0)
    assert.equal(fixture.http.operations.length, 0)
  } finally { await fixture.cleanup() }
})
