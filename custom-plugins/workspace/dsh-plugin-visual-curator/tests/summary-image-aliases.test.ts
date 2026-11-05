/** The real serializer and strict decoder share one complete evidence dictionary. */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createHash } from 'node:crypto'
import { CompatibleVisionProvider, type VisionInput } from '../src/media/vision.ts'
import { encodeSummaryImages } from '../src/media/summary-image-aliases.ts'
import { styleSummarySchema } from '../src/shared/style-analysis.ts'
import { MediaError } from '../src/media/errors.ts'
import { z } from 'zod'

const dimensions = ['color', 'lighting', 'texture', 'subject', 'composition', 'density', 'depth'] as const
const canonicalIds = Array.from({ length: 24 }, (_, index) => `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`)
function summary(ids: string[]) {
  return styleSummarySchema.parse({ name: 'Vehicle portraits', summary: 'Vehicles remain the clear subjects.', matchingPrompt: 'Inspect the actual subject and environment.', searchHints: ['car forest road'], avoidTerms: [],
    dimensions: dimensions.map(dimension => ({ dimension, description: 'Supported visual trait.', consistency: 'mixed', supportImageVersionIds: ids.slice(0, 20), counterImageVersionIds: ids.slice(20) })),
    conflicts: [{ description: 'Different backgrounds.', imageVersionIds: ids }], negativeReasons: [],
    suggestedRules: dimensions.map(dimension => ({ dimension, statement: 'Prefer the supported visual trait.', strength: 'preferred', stage: 'final', supportImageVersionIds: ids.slice(0, 20), counterImageVersionIds: ids.slice(20), notApplicableImageVersionIds: [], condition: '', exceptions: [] })),
    organization: { groups: [{ groupId: 'environment', name: 'Natural surroundings', description: 'Supported alternative.', imageVersionIds: ids }], selections: dimensions.map((_, ruleIndex) => ({ ruleIndex, enabled: true, groupId: 'environment', reason: 'Supported evidence.' })) },
  })
}

async function fixture(foreign = false, mixed = false) {
  const bytes = Uint8Array.from(Buffer.from('isolated image bytes')), digest = createHash('sha256').update(bytes).digest('hex')
  const input: VisionInput = { requestId: 'summary', taskBrief: JSON.stringify({ instruction: 'Summarize all observations.', samples: canonicalIds.map(imageVersionId => ({ imageVersionId, role: 'positive', observation: { imageVersionId, dimensions: [{ dimension: 'subject', observation: 'The car is prominent.' }] } })) }),
    rules: [], images: canonicalIds.slice(0, 8).map(imageVersionId => ({ imageVersionId, digest, mime: 'image/png', role: 'positive', bytes })) }
  let modelOutput = '', labels: string[] = []
  const requestSchema = z.object({ messages: z.array(z.object({ role: z.string(), content: z.union([z.string(), z.array(z.object({ type: z.string(), text: z.string().optional() }).loose())]) })) })
  const inputSchema = z.object({ input: z.object({ taskBrief: z.string(), images: z.array(z.object({ imageVersionId: z.string() })) }) })
  const briefSchema = z.object({ imageAliases: z.record(z.string(), z.string()), samples: z.array(z.object({ imageVersionId: z.string(), observation: z.object({ imageVersionId: z.string() }) })) })
  const provider = new CompatibleVisionProvider({ endpoint: 'https://vision.example.test/chat', model: 'isolated-summary', supportsMultiImage: true, maxImages: 8, maxImageBytes: 100_000, maxRequestBytes: 1_000_000, maxOutputTokens: 16_000, temperature: 0 }, { request: async (_url, options) => {
    const request = requestSchema.parse(JSON.parse(Buffer.from(options.body ?? []).toString('utf8')))
    const content = request.messages.find(message => message.role === 'user')!.content
    assert.ok(Array.isArray(content))
    const wire = inputSchema.parse(JSON.parse(content[0]!.text!)).input, brief = briefSchema.parse(JSON.parse(wire.taskBrief))
    labels = brief.samples.map(sample => sample.imageVersionId)
    assert.deepEqual(labels.map(label => brief.imageAliases[label]), canonicalIds)
    assert.deepEqual(brief.samples.map(sample => sample.observation.imageVersionId), labels)
    assert.deepEqual(wire.images.map(image => image.imageVersionId), labels.slice(0, 8))
    assert.deepEqual(content.filter(part => part.type === 'text').slice(1).map(part => z.object({ imageVersionId: z.string() }).parse(JSON.parse(part.text!)).imageVersionId), labels.slice(0, 8))
    const output = summary(labels)
    if (foreign) output.dimensions[0]!.supportImageVersionIds.push('foreign-image')
    if (mixed) output.dimensions[0]!.supportImageVersionIds.push(canonicalIds[0]!)
    modelOutput = JSON.stringify(output)
    return { status: 200, headers: { 'content-type': 'application/json' }, bytes: Buffer.from(JSON.stringify({ choices: [{ message: { content: modelOutput }, finish_reason: 'stop' }] })) }
  } })
  const original = structuredClone(input)
  const encoded = provider.describeRequest(input, 'summarize')
  const packet = z.object({ outputSchema: z.json(), input: z.record(z.string(), z.json()) }).parse(JSON.parse(encoded.inputText))
  const canonicalPacket = { ...packet, input: { ...packet.input, taskBrief: input.taskBrief, images: encoded.images } }
  const beforePromptBytes = Buffer.byteLength(provider.describeRequest(input, 'analyze').instructions + JSON.stringify(canonicalPacket))
  const afterPromptBytes = Buffer.byteLength(encoded.instructions + encoded.inputText)
  const result = await provider.summarize(input, canonicalIds, { maxBytes: 1_000_000, timeoutMs: 1000, maxRedirects: 0 })
  assert.deepEqual(input, original)
  return { result, modelOutput, labels, beforePromptBytes, afterPromptBytes }
}

test('short labels restore all 24 canonical references, conflicts and group memberships', async t => {
  const { result, modelOutput, labels, beforePromptBytes, afterPromptBytes } = await fixture()
  assert.deepEqual(result, summary(canonicalIds))
  assert.equal(labels.length, 24)
  assert.ok(labels.every(label => /^r\d+$/u.test(label)))
  const before = Buffer.byteLength(JSON.stringify(summary(canonicalIds))), after = Buffer.byteLength(modelOutput)
  assert.ok(after < before * 0.6)
  t.diagnostic(JSON.stringify({ fixtureImages: 24, dimensions: 7, rules: 7, beforePromptBytes, afterPromptBytes, beforeOutputBytes: before, afterOutputBytes: after, reductionPercent: Math.round((1 - after / before) * 100) }))
})

test('a model cannot introduce evidence outside the summary dictionary', async () => {
  await assert.rejects(fixture(true), error => error instanceof MediaError && error.code === 'vision-invalid-output')
})

test('mixed canonical and short labels cannot count one image twice as evidence', async () => {
  assert.deepEqual((await fixture(false, true)).result, summary(canonicalIds))
})

test('short labels avoid canonical collisions and preserve freeform instructions', () => {
  const encoded = encodeSummaryImages('Keep a vehicle as the clear subject.', ['r1', 'r2', 'third'])
  assert.deepEqual(Object.values(encoded.imageAliases), ['r3', 'r4', 'r5'])
  assert.equal(z.object({ instruction: z.string() }).parse(JSON.parse(encoded.taskBrief)).instruction, 'Keep a vehicle as the clear subject.')
})
