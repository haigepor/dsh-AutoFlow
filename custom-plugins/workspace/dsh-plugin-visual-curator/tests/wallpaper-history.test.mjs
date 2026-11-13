/** Saved image history follows the actual review order and never invents legacy timestamps. */
import assert from 'node:assert/strict'
import test from 'node:test'
import Module from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = fileURLToPath(new URL('../', import.meta.url))
const compiled = await build({ entryPoints: [resolve(root, 'src/client/wallpaper-history.ts')], bundle: true, write: false, packages: 'external', platform: 'node', format: 'cjs', logLevel: 'silent' })
const filename = resolve(root, 'tests/wallpaper-history-memory.cjs'), capsule = new Module(filename)
capsule.filename = filename; capsule.paths = Module._nodeModulePaths(dirname(filename)); capsule._compile(compiled.outputFiles[0].text, filename)
const { wallpaperImageHistory, wallpaperReviewReasons } = capsule.exports

const checks = Object.fromEntries(['subject', 'protection', 'clock', 'readability', 'composition', 'background', 'style'].map(key => [key, { result: 'satisfied', reason: '' }]))

test('review explanations identify estimated overflow and retain failed checks without issue rows', () => {
  const text = { wallpaperBoundaryEstimate: '{name}: estimated overflow · {edges}', wallpaperBoundaryRight: 'Right' }
  const review = { checks: { ...checks, protection: { result: 'violated', reason: 'critical-outside:Vase' }, clarity: { result: 'unknown', reason: 'Fine edges could not be confirmed.' } }, issues: [{ reason: 'critical-outside:Vase' }], actualLayout: { regions: [{ name: 'Vase', rect: { x: 0.8, y: 0.4, width: 0.1, height: 0.2 } }] } }
  const settings = { width: 1845, height: 3280, safe: { left: 258, top: 1032, width: 1329, height: 1686 }, sideOverflow: 66, bottomOverflow: 84, topBuffer: 32 }
  assert.deepEqual(wallpaperReviewReasons(review, settings, key => text[key] ?? key), ['Vase: estimated overflow · Right 74 px', 'Fine edges could not be confirmed.'])
})

test('new generated revisions show native review before optional resolution with saved times and final output', () => {
  const item = { originalId: 'original', status: 'passed', download: { savedAt: '2026-11-12T01:00:00.000Z' }, attempts: [{
    revision: 2, createdAt: '2026-11-12T01:01:00.000Z', plan: { subject: 'Fox in a forest' }, generationBrief: { status: 'saved' }, generation: { model: 'image-model' }, generatedImageId: 'native',
    preResolutionReview: { nativeId: 'native' }, review: { checks, issues: [] }, reviewedAt: '2026-11-12T01:03:00.000Z', backgroundResolution: { enhancedId: 'enhanced' }, outputId: 'final',
  }] }
  const entries = wallpaperImageHistory(item, { native: '2026-11-12T01:02:00.000Z', enhanced: '2026-11-12T01:04:00.000Z', final: '2026-11-12T01:05:00.000Z' })
  assert.deepEqual(entries.map(entry => entry.kind), ['original', 'plan', 'image', 'review', 'resolution', 'final'])
  assert.deepEqual(entries.map(entry => entry.time), ['2026-11-12T01:00:00.000Z', '2026-11-12T01:01:00.000Z', '2026-11-12T01:02:00.000Z', '2026-11-12T01:03:00.000Z', '2026-11-12T01:04:00.000Z', '2026-11-12T01:05:00.000Z'])
  assert.equal(entries.find(entry => entry.kind === 'resolution').imageId, 'enhanced')
  assert.equal(entries.find(entry => entry.kind === 'review').verdict, 'pass')
  assert.equal(entries.find(entry => entry.kind === 'image').model, 'image-model')
})

test('older revisions keep resolution before review and show unknown event times', () => {
  const item = { originalId: 'original', status: 'needs-review', attempts: [{ revision: 1, plan: { subject: 'Landscape' }, outputId: 'output', clarity: { originalOutputId: 'base', enhancedOutputId: 'output' }, review: { checks, issues: [] } }] }
  const entries = wallpaperImageHistory(item, { base: '2026-10-01T00:59:00.000Z', output: '2026-10-01T01:00:00.000Z' })
  assert.deepEqual(entries.map(entry => entry.kind), ['original', 'plan', 'image', 'resolution', 'review'])
  assert.equal(entries.find(entry => entry.kind === 'image').imageId, 'base')
  assert.equal(entries.find(entry => entry.kind === 'plan').time, undefined)
  assert.equal(entries.find(entry => entry.kind === 'review').time, undefined)
  assert.equal(entries.some(entry => entry.kind === 'final'), false)
})
