/** Synthetic reference histories derive their stored fields from a real keyless analysis. */
import { z } from 'zod'
import { serviceFixture } from './service-fixture.ts'
import { dataOf, specOf, toJson } from '../../src/host/runtime.ts'
import { draftSchema, feedbackSchema, feedbackThreadSchema, imageVersionSchema, observationSchema, referenceSchema, requestSchema, runSchema, styleSchema } from '../../src/shared/model.ts'
import { contentDigest } from '../../src/domain/repository.ts'

/** @param total Unique references. @param observed Previously observed positive images; the remainder are new negative references. @returns A real service over private synthetic records, without model or network work in measured reads. */
export async function analysisPlanFixture(total = 329, observed = 299) {
  const f = await serviceFixture()
  try {
    await f.service.initialize()
    const styleId = z.object({ id: z.string() }).parse(await f.action('style-create', { operationId: 'plan-style', name: 'Synthetic scope' })).id
    await f.action('reference-import', { operationId: 'plan-seed', styleId, expectedRevision: 1, files: [{ name: 'seed.png', mime: 'image/png', base64: f.http.image.toString('base64'), role: 'positive', intent: 'overall', dimensions: [] }] })
    await f.action('reference-analyze', { operationId: 'plan-observation', styleId, buildDataset: true }); await f.jobs.drain()
    const style = f.domain.require('style', styleId), draft = f.domain.require('draft', style.draftId), reference = f.repository.list('reference')[0]!, image = f.domain.require('imageVersion', reference.imageVersionId)
    const feedback = f.repository.list('feedback')[0]!, thread = f.domain.require('feedbackThread', feedback.threadId), observation = f.repository.list('observation')[0]!, run = f.repository.list('run')[0]!, spec = specOf(run), data = dataOf(run)
    const request = f.repository.list('request').find(item => z.object({ bundle: z.object({ requestId: z.string() }) }).safeParse(item.data).data?.bundle.requestId === observation.inferred[0]?.requestId)!
    const images = Array.from({ length: total }, (_, index) => imageVersionSchema.parse({ ...image, id: `plan-image-${index}` }))
    const feedbacks = images.map((image, index) => feedbackSchema.parse({ ...feedback, id: `plan-feedback-${index}`, threadId: `plan-thread-${index}`, subject: { kind: 'image', imageVersionId: image.id }, judgment: { kind: 'style-verdict', value: index < observed ? 'accept' : 'reject' }, viewEvidence: [{ imageVersionId: image.id, versionKind: image.versionKind }] }))
    const threads = feedbacks.map(feedback => feedbackThreadSchema.parse({ ...thread, id: feedback.threadId, headFeedbackId: feedback.id, identityDigest: contentDigest({ threadId: feedback.threadId }) }))
    const references = images.map((image, index) => referenceSchema.parse({ ...reference, id: `plan-reference-${index}`, imageVersionId: image.id, role: index < observed ? 'positive' : 'negative', feedbackThreadIds: [feedbacks[index]!.threadId] }))
    const observations = images.slice(0, observed).map((image, index) => observationSchema.parse({ ...observation, id: `plan-observation-${index}`, imageVersionId: image.id, inferred: observation.inferred.map(field => ({ ...field, imageVersionId: image.id, requestId: `model-request-${Math.floor(index / 4)}` })) }))
    const requests = Array.from({ length: Math.ceil(observed / 4) }, (_, index) => {
      const saved = z.object({ bundle: z.record(z.string(), z.json()) }).passthrough().parse(request.data)
      return requestSchema.parse({ ...request, id: `plan-request-${index}`, runId: 'plan-history', data: toJson({ ...saved, bundle: { ...saved.bundle, requestId: `model-request-${index}` }, trace: 'Synthetic request context. '.repeat(256) }) })
    })
    const originalDraft = draftSchema.parse({ ...draft, referenceIds: references.slice(0, observed).map(reference => reference.id), feedbackIds: [] })
    const historical = runSchema.parse({ ...run, id: 'plan-history', spec: toJson({ ...spec, fixed: { ...spec.fixed, draft: originalDraft, references: references.slice(0, observed), feedback: feedbacks.slice(0, observed) } }), data: toJson({ ...data, requestIds: requests.map(request => request.id), checkpoint: { ...data.checkpoint, analysisDoneImageIds: images.slice(0, observed).map(image => image.id), analysisResultIds: observations.map(observation => observation.id) } }) })
    const current = draftSchema.parse({ ...draft, revision: draft.revision + 1, referenceIds: references.map(reference => reference.id), feedbackIds: [] })
    const manifest = f.repository.manifest(`style:${styleId}`)!
    const records = [styleSchema.parse({ ...style, revision: style.revision + 1 }), current, ...images, ...references, ...feedbacks, ...threads, ...observations, ...requests, historical]
    await f.repository.commit({ aggregateId: manifest.aggregateId, expectedRevision: manifest.revision, operationId: 'synthetic-reference-history', request: {}, state: {}, records })
    return { ...f, styleId, images, references, feedbacks, historical, records, aggregateId: manifest.aggregateId }
  } catch (error) { await f.cleanup(); throw error }
}
