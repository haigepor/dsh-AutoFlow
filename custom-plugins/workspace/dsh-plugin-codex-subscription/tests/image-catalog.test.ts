/** Publication, account permission and uncertain upstream routing remain separate. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import { parseOfficialImageModels, imageProbeVerdict } from '../src/host/image-catalog.ts'
import { imageProbeQuotaAllowed } from '../src/host/accounts/quota.ts'
import type { ImageTask } from '../src/host/images/types.ts'
import type { AccountUsage } from '../src/shared/accounts.ts'

test('official image discovery accepts model links only from the authoritative index', () => {
  const models = parseOfficialImageModels(`<a href="/api/docs/models/gpt-image-2.6-sunburst">Latest</a>
    <a href='https://developers.openai.com/api/docs/models/gpt-image-2.5-flare'>Flare</a>
    <a href="/api/docs/models/gpt-image-2.6-sunburst">Duplicate</a>
    <a href="https://developers.openai.com.example/api/docs/models/gpt-image-99">Foreign</a>
    <a href="/api/docs/models/gpt-image-2.6-flare-2026-11-01">Snapshot</a>
    <script>const id='gpt-image-88'</script>`)
  assert.deepEqual(models.map(model => model.id), ['gpt-image-2.6-sunburst', 'gpt-image-2.5-flare'])
  assert.throws(() => parseOfficialImageModels('<a href="https://example.com/gpt-image-2">Foreign</a>'), /OFFICIAL_IMAGE_CATALOG_INVALID/)
})

test('a successful invalid-model control and ignored dimensions never verify subscription access', () => {
  const attachmentId = AttachmentId('sha256:' + 'a'.repeat(64))
  const task: ImageTask = { id: 'probe', model: 'gpt-image-2.6-sunburst', prompt: 'Probe', owner: { kind: 'gateway', keyId: 'probe-owner' },
    state: 'succeeded', createdAt: 1, updatedAt: 2, deadlineAt: 100, assets: [{ id: 'asset', mimeType: 'image/png', original: { attachmentId, name: 'probe.png', bytes: 1 },
      preview: { attachmentId, mediaType: 'image/png', width: 1536, height: 1024, bytes: 1 } }] }
  assert.deepEqual(imageProbeVerdict(task, true), { state: 'indeterminate', errorCode: 'IMAGE_MODEL_PARAMETER_UNVERIFIED' })
  assert.deepEqual(imageProbeVerdict(task, false), { state: 'indeterminate', errorCode: 'IMAGE_PROBE_SIZE_MISMATCH' })
  task.assets[0]!.preview.width = 1024
  assert.deepEqual(imageProbeVerdict(task, false), { state: 'verified' })
  task.state = 'failed'; task.error = { code: 'codex-image-http-error', message: 'Rejected', status: 400 }; task.assets = []
  assert.deepEqual(imageProbeVerdict(task, true), { state: 'verified' })
  assert.equal(imageProbeVerdict(task, false).state, 'rejected')
  task.state = 'outcome-unknown'
  assert.equal(imageProbeVerdict(task, false).state, 'outcome-unknown')
})

test('automatic probes require fresh included capacity with paid credits disabled and absent', () => {
  const usage: AccountUsage = { status: 'ready', freshness: 'fresh', fetchedAt: 1, allowed: true, primary: { usedPercent: 0 }, secondary: { usedPercent: 0 }, credits: { hasCredits: false, unlimited: false } }
  assert.equal(imageProbeQuotaAllowed(usage, false, 50), true)
  assert.equal(imageProbeQuotaAllowed(usage, true, 50), false)
  assert.equal(imageProbeQuotaAllowed({ ...usage, primary: { usedPercent: 51 } }, false, 50), false)
  assert.equal(imageProbeQuotaAllowed({ ...usage, freshness: 'stale' }, false, 50), false)
  assert.equal(imageProbeQuotaAllowed({ ...usage, credits: { hasCredits: true } }, false, 50), false)
  assert.equal(imageProbeQuotaAllowed(undefined, false, 50), false)
})
