/** Role-specific observation instructions retain uncertainty and separate rejection from visual facts. */
import type { Reference } from '../shared/model.ts'
import { referenceSchema, draftSchema, feedbackSchema } from '../shared/model.ts'
import { referenceFeedbackRole } from '../shared/reference-semantics.ts'
import { analysisScopeSchema } from '../shared/datasets.ts'
import { z } from 'zod'
import type { ExecutionSpec, RunData } from './runtime.ts'

/** @param spec Frozen reference selection. @param data Saved observations and reused inputs. @returns Actual observed and total counts for the selected role; legacy tasks retain collection counts. */
export function analysisSelectionProgress(spec: ExecutionSpec, data: RunData) {
  const scope = analysisScopeSchema.parse(spec.input.analysisScope ?? 'all')
  if (scope === 'all') return { observed: data.counts.observed ?? 0, total: Array.isArray(spec.fixed.references) ? spec.fixed.references.length : 0 }
  const references = z.array(referenceSchema).parse(spec.fixed.references), rules = draftSchema.parse(spec.fixed.draft).rules, feedback = z.array(feedbackSchema).parse(spec.fixed.feedback)
  const selected = new Set(references.filter(reference => referenceFeedbackRole(rules, reference, feedback) === scope).map(reference => reference.imageVersionId))
  const done = new Set(z.array(z.string()).parse(data.checkpoint.analysisDoneImageIds ?? []))
  return { observed: [...selected].filter(id => done.has(id)).length, total: selected.size }
}

/** @param references All saved roles of one image. @returns One role or an explicit conflict; neither role wins implicitly. */
export function observationRole(references: readonly Pick<Reference, 'role'>[]): Reference['role'] | 'mixed' {
  const roles = new Set(references.map(reference => reference.role))
  return roles.size === 1 ? roles.values().next().value! : 'mixed'
}

/** @param role Frozen role of this homogeneous batch. @returns Distinct positive, counterexample or uncertain-reference instructions. */
export function referenceRoleInstruction(role: Reference['role'] | 'mixed'): string {
  switch (role) {
    case 'positive': return 'These are POSITIVE style references. Record desired, visible and transferable traits within the selected dimensions, including composition, subject prominence and style relationships. Distinguish recurring style from incidental objects or brands. Describe what to preserve in candidate photos; do not invent rejection criteria or treat every incidental feature as required.'
    case 'negative': return 'These are NEGATIVE counterexamples, not target-style examples. Record visible traits and any explicit human explanation of mismatch. Distinguish subject relevance, composition, dominant subject, lighting and texture. A negative role alone does not identify which feature caused rejection: retain uncertainty and do not declare every visible trait forbidden. Never recommend copying this image’s style; final induction compares these observations with positive evidence.'
    case 'undecided': return 'These references are UNDECIDED. Record visible facts and uncertainty without promoting them into desired traits or rejection rules. Human judgments, when present, retain their own explicit scope.'
    case 'mixed': return 'These images have CONFLICTING positive and negative roles. Preserve every saved role and judgment, describe visible facts, and report uncertainty. Neither role overrides the other; do not infer a shared preference or resolve the conflict yourself.'
  }
}

/** @param strictDimensions Whether the new protocol explicitly requires one combined entry per selected dimension. @returns Source-grounded context for small subjects and partial views; it does not change the selected preference dimensions. */
export function referenceDetailInstruction(strictDimensions = false): string {
  return 'Inspect the actual pixels rather than the filename or gallery title. Describe every clearly visible principal and secondary subject, its relative width/height and location, including tiny distant vehicles beside the main one. In subject/composition observations, include a normalized region around the complete visible main subject when it can be located reliably; this is image context, not a new subject preference for a color/lighting-only reference. Distinguish a small subject in an environmental scene from a dominant subject; report the relationship without forcing enlargement. Distinguish frame cut-off, natural occlusion and parts invisible from the camera angle: a top-down view does not establish missing wheels, while a car cut by the frame is not a complete car. State when badges, text, identity, edges or fine structure cannot be resolved; mark uncertain facts rather than inventing detail. Separate deliberate motion blur, depth-of-field and grain from subject softness or compression; a small thumbnail cannot establish original-resolution sharpness. Do not turn these factual observations into exclusions or hard style requirements without task or human evidence.' + (strictDimensions ? ' Output dimensions is keyed by its dimension value: return AT MOST ONE entry for each dimension, with no duplicates. Combine environment, subject, local variation and uncertain details into that one observation string; do not create separate color or lighting entries for subregions, uncertainty or extra detail. For a color-and-lighting-only reference return one color entry and one lighting entry, not multiple rows of either kind; localization context does not authorize extra preference dimensions. Overall references may cover up to seven distinct dimensions. A region is optional: use one relevant region rather than repeating a dimension for every region.' : '')
}
