/** Complete synthetic profiles extend one real keyless analysis; measured reads perform no model or media work. */
import { z } from 'zod'
import { serviceFixture } from './service-fixture.ts'
import { contentDigest } from '../../src/domain/repository.ts'
import { analysisReferenceDigest } from '../../src/domain/style-analysis.ts'
import { dataOf, specOf, toJson } from '../../src/host/runtime.ts'
import { draftSchema, imageVersionSchema, modelProfileSchema, observationSchema, referenceSchema, runSchema, styleSchema } from '../../src/shared/model.ts'
import { styleAnalysisOf, styleAnalysisSchema } from '../../src/shared/style-analysis.ts'

/** @param total References per collection. @param collections Independent completed profiles. @returns An isolated service with complete positive and negative evidence and deterministic cleanup. */
export async function profileProjectionFixture(total = 329, collections = 1) {
  const f = await serviceFixture()
  try {
    await f.service.initialize()
    const seedId = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'projection-seed', name: 'Projection seed' })).id
    await f.action('reference-import', { operationId: 'projection-import', styleId: seedId, expectedRevision: 1, files: [{ name: 'seed.png', mime: 'image/png', base64: f.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
    await f.action('reference-analyze', { operationId: 'projection-analysis', styleId: seedId, buildDataset: true }); await f.jobs.drain()
    const seed = f.domain.require('style', seedId), draft = f.domain.require('draft', seed.draftId)
    const reference = f.repository.list('reference')[0]!, image = f.domain.require('imageVersion', reference.imageVersionId)
    const observation = f.repository.list('observation')[0]!, profile = f.repository.list('modelProfile')[0]!, run = f.domain.require('run', profile.analysisRunId)
    const spec = specOf(run), data = dataOf(run), analysis = styleAnalysisOf(run)!
    const styleIds: string[] = []
    for (let group = 0; group < collections; group++) {
      const styleId = `projection-style-${group}`, draftId = `projection-draft-${group}`, runId = `projection-run-${group}`
      const images = Array.from({ length: total }, (_, index) => imageVersionSchema.parse({ ...image, id: `projection-image-${group}-${index}` }))
      const references = images.map((image, index) => referenceSchema.parse({ ...reference, id: `projection-reference-${group}-${index}`, styleId, imageVersionId: image.id, role: index % 10 === 0 ? 'negative' : 'positive', feedbackThreadIds: [] }))
      const observations = images.map((image, index) => observationSchema.parse({ ...observation, id: `projection-observation-${group}-${index}`, imageVersionId: image.id,
        inferred: observation.inferred.map(field => ({ ...field, imageVersionId: image.id, value: `Reference ${index}. ${'A readable subject occupies the lower middle of the composition. '.repeat(8)}` })) }))
      const current = draftSchema.parse({ ...draft, id: draftId, styleId, revision: 1, referenceIds: references.map(reference => reference.id), feedbackIds: [] })
      const result = styleAnalysisSchema.parse({ ...analysis, runId, styleId, draftId, draftRevision: 1, referenceDigest: analysisReferenceDigest(references, []), feedbackIds: [],
        samples: references.map((reference, index) => ({ reference, imageDigest: image.blob.digest, observationId: observations[index]!.id, feedbackIds: [] })) })
      const historical = runSchema.parse({ ...run, id: runId, spec: toJson({ ...spec, input: { ...spec.input, styleId }, fixed: { ...spec.fixed, draft: current, references, feedback: [] } }),
        data: toJson({ ...data, counts: { ...data.counts, observed: total }, checkpoint: { ...data.checkpoint, styleAnalysis: result } }) })
      const selected = modelProfileSchema.parse({ ...profile, id: `projection-profile-${group}`, styleId, draftId, draftRevision: 1, analysisRunId: runId,
        referenceDigest: result.referenceDigest, references: references.map(reference => ({ ...profile.references[0]!, reference, imageDigest: image.blob.digest, feedbackIds: [], judgments: [] })), contentDigest: contentDigest(result) })
      await f.repository.commit({ aggregateId: `style:${styleId}`, expectedRevision: 0, operationId: `projection-records-${group}`, request: {}, state: {},
        records: [styleSchema.parse({ ...seed, id: styleId, draftId, revision: 1 }), current, ...images, ...references, ...observations, historical] })
      await f.repository.commit({ aggregateId: `model-profiles:${styleId}`, expectedRevision: 0, operationId: `projection-selection-${group}`, request: {}, state: { profileId: selected.id }, records: [selected] })
      styleIds.push(styleId)
    }
    return { ...f, styleIds }
  } catch (error) { await f.cleanup(); throw error }
}
