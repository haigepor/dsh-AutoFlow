/** Pure version-one dataset/Skill rendering; only the Host writes downloadable artifacts. */
import type { ExportSnapshot, HumanFeedback, ImageVersion, StyleRelease, SplitManifest, Observation } from '../shared/model.ts'
import type { StyleAnalysis } from '../shared/style-analysis.ts'
import { fileChecksum } from './repository.ts'

/** @param release Immutable release. @param resources Explicit accessible resource references. @returns A standalone guide without instruction activation. */
export function renderSkill(release: StyleRelease, resources: ExportSnapshot['resources']): string {
  return [
    '---', `name: visual-curator-${release.id}`, `description: Apply the fixed visual style release ${release.releaseNumber}.`, '---', '',
    `# ${release.styleId} / release ${release.releaseNumber}`, '', `Release: ${release.id}`, `Content digest: ${release.contentDigest}`, `Recipe: ${release.recipe.id}`, '',
    '## Fixed rules', '', ...release.rules.map(rule => `- [${rule.strength}; ${rule.stage}; ${rule.dimension}] ${rule.statement}`), '',
    '## Reference resources', '', ...resources.map(r => `- ${r.imageVersionId}: ${r.digest} (family ${r.familyId}, ${r.split})`), '',
    'Obtain authorized reference pixels before visual inspection. If resources are unavailable, report the missing resources and stop that inspection. Text descriptions cannot replace visual evidence.', '',
    '## Workflow', '',
    '1. Read the fixed release and select an explicit usage revision.',
    '2. Start visual_search_start or visual_crop_start using this release ID and the resolved usage; inspect progress with visual_run_get.',
    '3. Check required source and final rules independently. Preserve unknown and technical failures for review; preferred scores cannot override required failures.',
    '4. Keep candidate crop coordinates separate from the actual generated image. Review actual final pixels with the same release and recipe.',
    '5. Submit Agent observations as suggestions. Authenticated human confirmation and explicit publication are required to change future standards.', '',
    'This artifact contains workflow text and resource references. It does not contain trained model weights and does not activate itself in Home instructions or a Session.', '',
  ].join('\n')
}

/** @param feedback Effective human label. @param kind Requested dataset format. @returns Eligibility reason or absence when eligible. */
export function supervisionExclusion(feedback: HumanFeedback, kind: ExportSnapshot['exportKind']): string | undefined {
  if (feedback.scope !== 'style-candidate' || feedback.labelEligibility !== 'confirmed-candidate') return 'scope-or-confirmation'
  const judgment = feedback.judgment
  if (kind === 'classification') return (judgment.kind === 'style-verdict' || judgment.kind === 'dimension-verdict') && judgment.value !== 'unknown' ? undefined : 'not-classification'
  if (kind === 'preference') return judgment.kind === 'pairwise-preference' && judgment.value !== 'unknown' ? undefined : 'not-preference'
  if (kind === 'crop') return judgment.kind === 'crop-confirmation' && judgment.value === 'confirmed' && judgment.includeInLearning && feedback.subject.kind === 'crop' ? undefined : 'not-confirmed-crop'
  return undefined
}

/** @param input Fixed records chosen before export. @returns Immutable manifest and checksummed data files. */
export function renderExportFiles(input: { release: StyleRelease; split: SplitManifest; resources: ExportSnapshot['resources']; feedback: HumanFeedback[]; exportKind: ExportSnapshot['exportKind']; images: ImageVersion[]; analysis?: StyleAnalysis; observations?: Observation[] }): ExportSnapshot['files'] {
  const resourceMap = new Map(input.resources.map(resource => [resource.imageVersionId, resource]))
  const lines = input.feedback.map(feedback => {
    const subject = feedback.subject
    const imageId = subject.kind === 'pair' ? subject.leftImageVersionId : subject.imageVersionId
    const resource = resourceMap.get(imageId)
    return { schemaVersion: 1, familyId: resource?.familyId, split: resource?.split, feedbackId: feedback.id, styleId: feedback.context.styleId, releaseId: input.release.id, subject, context: feedback.context, judgment: feedback.judgment, imageDigests: input.resources.filter(r => subject.kind === 'pair' ? r.imageVersionId === subject.leftImageVersionId || r.imageVersionId === subject.rightImageVersionId : r.imageVersionId === subject.imageVersionId).map(r => ({ imageVersionId: r.imageVersionId, digest: r.digest })) }
  })
  const files: { name: string; content: string }[] = []
  if (input.exportKind === 'style') {
    files.push({ name: 'release.json', content: `${JSON.stringify(input.release, null, 2)}\n` })
  } else if (input.exportKind === 'skill') {
    files.push({ name: 'SKILL.md', content: renderSkill(input.release, input.resources) })
  } else {
    files.push({ name: `${input.exportKind}.jsonl`, content: lines.length ? `${lines.map(line => JSON.stringify(line)).join('\n')}\n` : '' })
  }
  if (input.analysis && input.observations) {
    const analysis = input.analysis
    const modelRequest = { analysisRunId: analysis.runId, recipeId: analysis.recipeId, model: analysis.model, declaredModelVersion: analysis.declaredModelVersion, observationPromptVersion: analysis.observationPromptVersion, summaryPromptVersion: analysis.summaryPromptVersion, summaryRequestId: analysis.summaryRequestId }
    files.push({ name: 'style-profile.json', content: `${JSON.stringify({ formatVersion: 1, purpose: 'api-style-reference', styleId: input.release.styleId, releaseId: input.release.id, contentDigest: input.release.contentDigest, ...modelRequest,
      confirmedRules: input.release.rules.filter(rule => rule.confirmation.status === 'confirmed'), modelSummary: { status: 'unconfirmed', ...analysis.summary }, validation: input.release.validation,
      matchingPolicy: 'Retrieve candidates with searchHints, then inspect actual candidate pixels together with authorized reference images. Apply confirmedRules before modelSummary. Report unknown and conflicting traits; do not treat model observations as human labels.',
      resourcePolicy: 'References contain identities and digests, not portable image bytes. Obtain separately authorized pixels before visual comparison. This package contains no model weights.',
    }, null, 2)}\n` })
    const samples = analysis.samples.filter(sample => resourceMap.has(sample.reference.imageVersionId)).map(sample => {
      const observation = input.observations!.find(row => row.id === sample.observationId)!
      const fixed = input.release.references.find(row => row.reference.id === sample.reference.id)!
      return { formatVersion: 1, source: 'vision-api-observation', ...modelRequest, referenceId: sample.reference.id, imageVersionId: sample.reference.imageVersionId, imageDigest: sample.imageDigest,
        importIntent: { role: sample.reference.role, intent: sample.reference.intent }, humanJudgments: fixed.judgments ?? [], humanFeedbackIds: sample.feedbackIds,
        measured: observation.measured, inferred: observation.inferred, correctionIds: observation.corrections, resource: resourceMap.get(sample.reference.imageVersionId) }
    })
    files.push({ name: 'samples.jsonl', content: `${samples.map(sample => JSON.stringify(sample)).join('\n')}\n` })
    files.push({ name: 'references.json', content: `${JSON.stringify({ formatVersion: 1, analysisRunId: analysis.runId, releaseId: input.release.id, resources: input.resources.map(resource => ({ ...resource, mime: input.images.find(image => image.id === resource.imageVersionId)?.blob.mime, access: 'requires-authorized-pixels' })) }, null, 2)}\n` })
    files.push({ name: 'SKILL.md', content: `${renderSkill(input.release, input.resources)}\n## API style matching dataset\n\nRead style-profile.json and samples.jsonl as reference data. Confirmed rules take precedence over the unconfirmed model summary and matching prompt. Search hints retrieve candidates; they do not establish visual matches. Fetch authorized reference and candidate pixels, check their saved digests, and submit actual images with the fixed rules to a vision API. Keep per-rule satisfied, violated and unknown results separate from aesthetic preference scores. Never invent access to a reference image or treat machine observations as confirmed human supervision.\n` })
  }
  files.push({ name: 'resources.json', content: `${JSON.stringify({ formatVersion: 1, releaseId: input.release.id, contentDigest: input.release.contentDigest, splitId: input.split.id, resources: input.resources }, null, 2)}\n` })
  const checksummed = files.map(file => ({ ...file, checksum: fileChecksum(file.content) }))
  const manifestContent = `${JSON.stringify({ formatVersion: 1, kind: input.exportKind, releaseId: input.release.id, splitId: input.split.id, ...(input.analysis ? { analysisRunId: input.analysis.runId, datasetFormatVersion: 1 } : {}), feedbackIds: input.feedback.map(f => f.id), files: checksummed.map(({ name, checksum }) => ({ name, checksum })) }, null, 2)}\n`
  return [...checksummed, { name: 'manifest.json', content: manifestContent, checksum: fileChecksum(manifestContent) }]
}
