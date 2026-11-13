/** Actual glyph backgrounds reject false readability passes without replacing independent image review. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import sharp from 'sharp'
import { wallpaperClockContrast, wallpaperClockSvg } from '../src/media/wallpaper-clock.ts'
import { wallpaperClockContrastPolicySchema, resolveWallpaperProcessing } from '../src/shared/wallpaper-policy.ts'
import { wallpaperSettingsSchema, wallpaperPlanSchema, wallpaperReviewKeys, wallpaperStoredSourceReviewV4Schema, wallpaperVerdict } from '../src/shared/wallpaper.ts'
import { applyWallpaperClockContrast, applyWallpaperNoClockRequirement } from '../src/host/wallpaper-review.ts'
import { renderWallpaper } from '../src/media/wallpaper-render.ts'
import { serviceFixture } from './helpers/service-fixture.ts'
import { dataOf } from '../src/host/runtime.ts'
import { wallpaperStateSchema } from '../src/shared/wallpaper.ts'
import { contentDigest } from '../src/domain/repository.ts'
import { writeFile, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'

test('white clock glyphs require actual background contrast, including when the model said readable', async () => {
  const settings = wallpaperSettingsSchema.parse({}), policy = wallpaperClockContrastPolicySchema.parse({})
  const solid = (background: string) => sharp({ create: { width: settings.width, height: settings.height, channels: 3, background } }).png().toBuffer()
  const dark = await wallpaperClockContrast(await solid('#000000'), 'dark', settings, policy)
  const bright = await wallpaperClockContrast(await solid('#ffffff'), 'bright', settings, policy)
  assert.equal(dark.readableFraction, 1); assert.equal(dark.minimumMeasuredRatio, 21)
  assert.equal(bright.readableFraction, 0); assert.equal(bright.minimumMeasuredRatio, 1)
  const glyphBackground = await sharp(await solid('#ffffff')).composite([{ input: Buffer.from(wallpaperClockSvg(settings, false).toString('utf8').replaceAll('fill="white"', 'fill="black"')) }]).png().toBuffer()
  assert.equal((await wallpaperClockContrast(glyphBackground, 'glyph-background', settings, policy)).readableFraction, 1, 'Bright pixels outside the actual glyphs do not fail this pixel gate')
  const review = wallpaperStoredSourceReviewV4Schema.parse({ reviewVersion: 'wallpaper-review-source-v4', subject: 'Complete subject', checks: Object.fromEntries([...wallpaperReviewKeys, 'clarity'].map(key => [key, { result: 'satisfied', reason: 'Independent visual response' }])), issues: [], styleResults: [], sourceRepair: { result: 'satisfied', reason: 'Complete' }, sourceCorrespondence: { result: 'satisfied', reason: 'Same objects' }, actualLayout: { imageVersionId: 'bright', regions: [{ name: 'Subject', role: 'subject', scope: 'core', rect: { x: 0.3, y: 0.4, width: 0.4, height: 0.2 } }] }, subjectIntegrity: { mode: 'single', source: { extent: 'complete', imageVersionId: 'source', reason: 'Complete' }, output: { extent: 'complete', imageVersionId: 'bright', reason: 'Complete' }, task: { result: 'satisfied', reason: 'Same subject' } }, layoutChecks: [], layoutWarnings: [], modelProtectionCheck: { result: 'satisfied', reason: 'Inside bounds' }, modelIssues: [] })
  const failed = applyWallpaperClockContrast(review, bright)
  assert.equal(failed.checks.readability.result, 'violated'); assert.equal(failed.modelReadabilityCheck?.result, 'satisfied')
  assert.equal(failed.issues.at(-1)?.kind, 'readability'); assert.equal(failed.clockContrast?.imageVersionId, 'bright')
  assert.deepEqual(applyWallpaperClockContrast(failed, bright), failed, 'Applying saved pixel evidence is idempotent')
  const unknown = structuredClone(review); unknown.checks.readability.result = 'unknown'
  assert.equal(applyWallpaperClockContrast(unknown, dark).checks.readability.result, 'unknown', 'Pixel contrast cannot qualify an independent unknown')
  assert.equal(resolveWallpaperProcessing({ reasoningEffort: 'medium', clockContrast: { minimumRatio: 4, minimumReadableFraction: 0.95 } }).clockContrast?.minimumRatio, 4)
  assert.equal(resolveWallpaperProcessing().clockContrast, undefined, 'New direct-crop tasks do not require clock background contrast')
  const noClock = applyWallpaperNoClockRequirement(failed)
  assert.equal(noClock.checks.clock.result, 'satisfied')
  assert.equal(noClock.checks.readability.result, 'satisfied')
  assert.equal(noClock.issues.length, 0)
  assert.equal(wallpaperVerdict(noClock), 'pass')
})

test('a full-size source consumes the edited complete canvas even when source geometry needs no outpainting', async () => {
  const settings = wallpaperSettingsSchema.parse({ backgroundTransitionPixels: 0 })
  const source = await sharp({ create: { width: settings.width, height: settings.height, channels: 3, background: '#ff0000' } }).png().toBuffer()
  const edited = await sharp({ create: { width: settings.width, height: settings.height, channels: 3, background: '#000000' } }).png().toBuffer()
  const plan = wallpaperPlanSchema.parse({ version: 1, imageVersionId: 'source', mode: 'single', subject: 'Complete subject', evidence: 'Saved pixels', priorities: [], anchors: [], truncations: [], uncertainties: [], regions: [{ name: 'Subject', role: 'subject', rect: { x: 0.3, y: 0.4, width: 0.4, height: 0.2 } }, { name: 'Core', role: 'critical', rect: { x: 0.4, y: 0.45, width: 0.2, height: 0.1 } }], placement: { scale: 1, left: 0, top: 0 }, reason: 'Only clock background requires editing' })
  const result = await renderWallpaper(source, plan, settings, edited, 'generated-canvas-v1')
  assert.equal(result.geometry.needsOutpaint, false)
  assert.ok((await sharp(result.image).stats()).channels.slice(0, 3).every(channel => channel.mean === 0), 'The actual edited pixels reach final review')
  const unchanged = await renderWallpaper(source, plan, settings)
  assert.equal((await sharp(unchanged.image).stats()).channels[0]!.mean, 255, 'No background request leaves the source crop unchanged')
})

for (const bright of [false, true]) test(`current clock policy ${bright ? 'rejects newly unreadable' : 'retains qualified'} inherited pixels without another model or image request`, async () => {
  const f = await serviceFixture(), paths: string[] = []
  let calls = 0
  f.service.config.wallpaper.repairPolicy = { version: 'subject-repair-v1', mode: 'repair-when-needed', maxRepeatedDefects: 2 }
  f.service.config.wallpaper.imageModel = 'isolated-unused-image-model'
  f.service.config.wallpaper.processing = resolveWallpaperProcessing({ clockContrast: { minimumRatio: bright ? 1 : 3 } })
  const send = f.http.request.bind(f.http)
  f.http.request = async (url, request) => {
    if (!url.startsWith('https://vision.example.test')) return send(url, request)
    calls++
    const messages = z.object({ messages: z.array(z.object({ role: z.string(), content: z.unknown() })) }).parse(JSON.parse(Buffer.from(request.body!).toString('utf8'))).messages
    const text = z.array(z.object({ text: z.string().optional() }).passthrough()).parse(messages.find(row => row.role === 'user')!.content)[0]!.text!
    const input = z.object({ input: z.object({ operation: z.string(), images: z.array(z.object({ imageVersionId: z.string(), role: z.string() })) }) }).parse(JSON.parse(text)).input
    const source = input.images.find(image => image.role === 'wallpaper-original')!, output = input.images.find(image => image.role === 'actual-wallpaper')
    const subject = { x: 0.3, y: 0.4, width: 0.4, height: 0.2 }, core = { x: 0.4, y: 0.45, width: 0.2, height: 0.1 }
    const regions = [{ name: 'Scripted subject', entityId: 'subject', role: 'subject', rect: subject }, { name: 'Core', entityId: 'core', role: 'critical', rect: core }]
    const objectRoles = [{ entityId: 'subject', name: 'Scripted subject', role: 'primary', evidence: 'The visible focal motif.', rect: subject, sourceEdges: [] }, { entityId: 'core', name: 'Core', role: 'critical-part', evidence: 'The indispensable inner motif.', rect: core, sourceEdges: [] }]
    const result = input.operation === 'wallpaper-plan' ? { version: 1, imageVersionId: source.imageVersionId, mode: 'abstract', subject: 'Isolated qualification fixture', evidence: 'Scripted geometry', priorities: [], anchors: [], truncations: [], uncertainties: [], regions, objectRoles, editPrompt: 'Retain the existing complete canvas.', reason: 'Already fits the frozen canvas' } : { reviewVersion: 'wallpaper-review-source-v4', subject: 'Isolated qualification fixture', checks: Object.fromEntries([...wallpaperReviewKeys, 'clarity'].map(key => [key, { result: 'satisfied', reason: 'Scripted independent response' }])), issues: [], styleResults: [], sourceRepair: { result: 'satisfied', reason: 'Complete' }, sourceCorrespondence: { result: 'satisfied', reason: 'Same source' }, actualLayout: { imageVersionId: output!.imageVersionId, regions: regions.map(region => ({ ...region, scope: 'core' })) }, subjectIntegrity: { mode: 'abstract', source: { extent: 'complete', imageVersionId: source.imageVersionId, reason: 'Complete' }, output: { extent: 'complete', imageVersionId: output!.imageVersionId, reason: 'Complete' }, task: { result: 'satisfied', reason: 'Same content' } } }
    return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: JSON.stringify(result) }, finish_reason: 'stop' }] })) }
  }
  try {
    await f.service.initialize()
    for (let i = 0; i < 2; i++) {
      const path = join(f.root, `native-${i}.png`); paths.push(path)
      await writeFile(path, await sharp({ create: { width: 1845, height: 3280, channels: 3, background: i === 1 && bright ? '#ffffff' : i === 1 ? '#203628' : '#223344' } }).png().toBuffer())
    }
    const initial = z.object({ runId: z.string() }).parse(await f.action('direct-crop-start', { operationId: 'qualification-clock', name: 'Isolated native qualification', source: { kind: 'local', files: paths.map(path => ({ path, name: path.split(/[\\/]/).at(-1)! })) } }))
    await f.jobs.drain()
    const parent = f.domain.require('run', initial.runId), state = wallpaperStateSchema.parse(dataOf(parent).checkpoint.wallpaper), digest = contentDigest(parent)
    assert.deepEqual(state.items.map(item => item.status), ['passed', 'passed']); assert.equal(calls, 4)
    f.service.config.wallpaper.processing = resolveWallpaperProcessing({ clockContrast: { minimumRatio: bright ? 3 : 4.5 } })
    const current = z.object({ runId: z.string() }).parse(await f.action('wallpaper-continue', { runId: parent.id, operationId: 'current-qualification-clock', review: { outputId: state.items[0]!.attempts.at(-1)!.outputId! } }))
    await f.jobs.drain()
    const child = wallpaperStateSchema.parse(dataOf(f.domain.require('run', current.runId)).checkpoint.wallpaper), inherited = child.items[1]!
    assert.equal(calls, 5, 'Only the explicitly selected image requests another independent review')
    assert.equal(inherited.status, bright ? 'rejected' : 'passed', inherited.reason)
    assert.equal(inherited.edits, 0); assert.equal(inherited.attempts.at(-1)!.outputId, state.items[1]!.attempts.at(-1)!.outputId)
    const checked = wallpaperStoredSourceReviewV4Schema.parse(inherited.attempts.at(-1)!.review)
    assert.equal(checked.clockContrast!.minimumRatio, bright ? 3 : 4.5)
    assert.equal(checked.clockContrast!.readableFraction, bright ? 0 : 1)
    assert.equal(f.repository.list('selection').filter(row => row.runId === current.runId).length, bright ? 1 : 2)
    const recorded = z.array(z.object({ bright: z.boolean(), statuses: z.array(z.enum(['passed', 'rejected'])), modelRequests: z.number(), edits: z.array(z.number()), inheritedOutputUnchanged: z.boolean(), qualified: z.number() })).parse(JSON.parse(await readFile(new URL('./fixtures/wallpaper-clock-qualification.expected.json', import.meta.url), 'utf8')))
    assert.deepEqual({ bright, statuses: child.items.map(item => item.status), modelRequests: calls, edits: child.items.map(item => item.edits), inheritedOutputUnchanged: inherited.attempts.at(-1)!.outputId === state.items[1]!.attempts.at(-1)!.outputId, qualified: f.repository.list('selection').filter(row => row.runId === current.runId).length }, recorded.find(row => row.bright === bright))
    assert.equal(contentDigest(f.domain.require('run', parent.id)), digest)
  } finally { await f.cleanup() }
})
