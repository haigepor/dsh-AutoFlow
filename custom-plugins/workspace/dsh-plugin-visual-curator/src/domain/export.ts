/** Pure version-one dataset/Skill rendering; only the Host writes downloadable artifacts. */
import type { ExportSnapshot, HumanFeedback, ImageVersion, StyleRelease, SplitManifest } from '../shared/model.ts'
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
export function renderExportFiles(input: { release: StyleRelease; split: SplitManifest; resources: ExportSnapshot['resources']; feedback: HumanFeedback[]; exportKind: ExportSnapshot['exportKind']; images: ImageVersion[] }): ExportSnapshot['files'] {
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
  files.push({ name: 'resources.json', content: `${JSON.stringify({ formatVersion: 1, releaseId: input.release.id, contentDigest: input.release.contentDigest, splitId: input.split.id, resources: input.resources }, null, 2)}\n` })
  const checksummed = files.map(file => ({ ...file, checksum: fileChecksum(file.content) }))
  const manifestContent = `${JSON.stringify({ formatVersion: 1, kind: input.exportKind, releaseId: input.release.id, splitId: input.split.id, feedbackIds: input.feedback.map(f => f.id), files: checksummed.map(({ name, checksum }) => ({ name, checksum })) }, null, 2)}\n`
  return [...checksummed, { name: 'manifest.json', content: manifestContent, checksum: fileChecksum(manifestContent) }]
}
