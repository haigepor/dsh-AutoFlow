import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { wallpaperStage } from '../src/client/workflow-node-state.ts'
import { wallpaperProgress, wallpaperStateSchema, wallpaperSourceRestricted } from '../src/shared/wallpaper.ts'

test('eight saved originals and two restricted sources are partial completion rather than a wholly failed download step', async () => {
  const state = wallpaperStateSchema.parse({ version: 1, sourceRunId: 'search', skillVersion: 'skill', items: Array.from({ length: 10 }, (_, i) => ({ imageVersionId: `image-${i}`, familyId: `family-${i}`, ...(i < 8 ? { originalId: `original-${i}`, status: 'queued' } : { status: 'technical-failed', failedStep: 'downloading', errorCode: 'original-source-restricted' }) })) })
  const counts = wallpaperProgress(state)
  assert.equal(counts.downloaded, 8); assert.equal(counts.downloadingRestricted, 2)
  assert.equal(wallpaperStage('downloading', 'running', 10, counts).phase, 'attention')
  assert.equal(wallpaperStage('downloading', 'completed', 10, counts).phase, 'attention')
  assert.deepEqual({ phase: wallpaperStage('downloading', 'running', 10, counts).phase, downloaded: counts.downloaded, restricted: counts.downloadingRestricted, transportFailed: counts.downloadingFailed! - counts.downloadingRestricted!, pending: 10 - counts.downloaded! - counts.downloadingFailed!, savedImagesRemainQueuedForProcessing: counts.queued }, JSON.parse(await readFile(new URL('./fixtures/wallpaper-source-recovery.expected.json', import.meta.url), 'utf8')))
  assert.equal(wallpaperStage('downloading', 'running', 2, { downloadingFailed: 2 }).phase, 'failed')
  assert.equal(wallpaperSourceRestricted({ ...state.items[9]!, errorCode: 'original-download-http-503' }), false)
})
