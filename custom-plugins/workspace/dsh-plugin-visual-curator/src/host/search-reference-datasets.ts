/** Current negative observations and their completed package sources, without historical rule adoption. */
import type { CuratorDomain } from '../domain/curator.ts'
import { fileChecksum } from '../domain/repository.ts'
import { CuratorError } from '../shared/errors.ts'
import type { DomainActor, ModelProfile } from '../shared/model.ts'
import { styleAnalysisOf } from '../shared/style-analysis.ts'
import { searchNegativeReferencesSchema, type SearchNegativeReferences } from '../shared/search-reference-datasets.ts'
import { readDatasetDirectory, type DatasetDirectory } from './datasets.ts'
import { effectiveReviewReferenceRole } from './review-references.ts'

function currentReferences(profile: ModelProfile) {
  const images = new Map<string, ModelProfile['references'][number]>()
  const conflicting = new Set<string>()
  for (const reference of profile.references) {
    const id = reference.reference.imageVersionId
    if (effectiveReviewReferenceRole(profile, reference) !== 'negative') { conflicting.add(id); images.delete(id) }
    else if (!conflicting.has(id) && !images.has(id)) images.set(id, reference)
  }
  return images
}

function sourcePackages(domain: CuratorDomain, profile: ModelProfile, directory?: DatasetDirectory) {
  const current = currentReferences(profile)
  if (!current.size) return []
  const records = directory ?? readDatasetDirectory(domain)
  const sources = new Map<string, ModelProfile>(records.profiles.filter(source => source.styleId === profile.styleId).map(source => [source.id, source]))
  return records.artifacts.filter(dataset => dataset.sampleScope === 'negative' && sources.has(dataset.modelProfileId)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)).flatMap(dataset => {
    const source = sources.get(dataset.modelProfileId)!, resources = new Set(dataset.resources.map(resource => resource.imageVersionId))
    const references = [...currentReferences(source).values()].filter(ref => resources.has(ref.reference.imageVersionId) && current.get(ref.reference.imageVersionId)?.imageDigest === ref.imageDigest)
    if (!references.length) return []
    if (dataset.files.some(file => fileChecksum(file.content) !== file.checksum)) throw new CuratorError('reference-unavailable', 'search-launch-negatives', 'A negative reference package failed checksum verification. Regenerate that package before starting.')
    return [{ exportId: dataset.id, imageVersionIds: [...new Set(references.map(ref => ref.reference.imageVersionId))] }]
  })
}

/** @param domain Authorized collection records. @param profile Current frozen profile. @param directory Optional package records from the current synchronous read. @returns Eligible completed package and unique current-negative counts. */
export function searchNegativeSummary(domain: CuratorDomain, profile: ModelProfile, directory?: DatasetDirectory) {
  return { datasets: sourcePackages(domain, profile, directory).length, references: currentReferences(profile).size }
}

/** @param domain Authorized saved observations. @param profile Exact profile accepted by this launch. @param actor Current native Session owner. @param directory Optional package records from the current synchronous read. @returns A deduplicated snapshot; removed or reclassified historical references never enter it. */
export function freezeSearchNegatives(domain: CuratorDomain, profile: ModelProfile, actor: DomainActor, directory?: DatasetDirectory): SearchNegativeReferences {
  const analysis = styleAnalysisOf(domain.require('run', profile.analysisRunId))
  if (!analysis) throw new CuratorError('reference-unavailable', 'search-launch-negatives', 'The current negative observations are unavailable. Analyze this collection again.')
  const samples = [...currentReferences(profile).values()].map(ref => {
    domain.authorizedImage(ref.reference.imageVersionId, actor)
    const sample = analysis.samples.find(sample => sample.reference.id === ref.reference.id)
    if (!sample) throw new CuratorError('reference-unavailable', 'search-launch-negatives', 'A current negative reference has no saved observation.')
    const observation = domain.require('observation', sample.observationId)
    if (observation.imageVersionId !== ref.reference.imageVersionId) throw new CuratorError('reference-unavailable', 'search-launch-negatives', 'A negative observation describes a different image.')
    return { reference: { ...ref.reference, role: 'negative' as const }, imageDigest: ref.imageDigest, feedbackIds: ref.feedbackIds, judgments: ref.judgments ?? [], measured: observation.measured, inferred: observation.inferred }
  })
  return searchNegativeReferencesSchema.parse({ version: 1, datasets: sourcePackages(domain, profile, directory), samples })
}
