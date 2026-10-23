/** Profile-scoped instructions registered through the native skill catalog, without Home writes. */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'
import { z } from 'zod'

const instructions = {
  'visual-style-reference': {
    description: 'Read Visual Curator reference styles and their immutable published versions.',
    content: 'Use visual_style_list and visual_style_get to inspect saved styles. Distinguish drafts, candidates and published releases. Record the exact release ID and rule dimensions. Never infer a confirmed composition or subject preference from a color-only reference. If no published standard exists, ask the human to establish it; do not invent IDs or publish on their behalf.',
  },
  'visual-style-calibration': {
    description: 'Explain visual rules, reference evidence and discrepancies before a human publishes a new style version.',
    content: 'Read the saved style with visual_style_get. Compare required, preferred and reference-only rules and their dimensions, exceptions and evidence. Keep conflicting evidence visible. Use visual_feedback_suggest for proposals only. Agent text cannot confirm a rule or publish a release. Later searches continue using their pinned version until a human explicitly publishes and selects another standard.',
  },
  'visual-image-search': {
    description: 'Search and visually screen images against a fixed Visual Curator release.',
    content: 'Read the selected published release first. Start visual_search_start only with real release, usage and source IDs and explicit budgets. Search requires configured source and vision services. Track its returned run ID using visual_run_get and bounded job waits. Report visual rejections separately from technical failures. Only saved pixel reviews establish qualified results; a successful launch is not a qualified image. Never weaken required rules to fill a quota.',
  },
  'visual-crop-composition': {
    description: 'Plan image crops with protected subjects and inspect the rendered result against a fixed style.',
    content: 'Use an authorized image version, a published release and an immutable usage revision. State protected subjects, text and composition requirements explicitly in visual_crop_start. The Host renders with sharp and reviews actual crop pixels. Inspect visual_run_get for final geometry and reviews. A source image passing style review does not establish that its crop passed. Do not claim that a human confirmed an automated crop.',
  },
  'visual-human-feedback': {
    description: 'Organize visual feedback while preserving human authorship, scope and style-version history.',
    content: 'Inspect the relevant run and saved style before proposing feedback. Use visual_feedback_suggest and preserve referenced feedback IDs and original context. Explain the dimension, reason and scope of each proposal. An Agent suggestion remains unconfirmed and cannot become a human label, crop confirmation or published rule automatically. Feedback affects later searches only after the human reviews it and publishes an explicitly selected release.',
  },
  'visual-dataset-export': {
    description: 'Export reviewed Visual Curator labels or a style guide with explicit versions, splits and image permissions.',
    content: 'Use existing confirmed human labels and saved release/split IDs with visual_export_start. Prefer references-only unless image-byte permission is already recorded. Keep related image families in their saved dataset split and keep holdout data out of training. Inspect visual_export_get for checksums, exclusions and authorized resources. A Skill export is a downloadable guide; it neither installs global instructions nor trains model weights. Never invent public download URLs.',
  },
} as const

export const name = 'visual-curator-skill'
export const inject = ['visualCurator', 'skills']
export const Config = z.strictObject({ skill: z.enum(Object.keys(instructions) as [keyof typeof instructions, ...Array<keyof typeof instructions>]) })

/** Register one reversible native skill for its optional feature row.
 * @param ctx Profile context with the native skill registry.
 * @param config Validated packaged skill identifier.
 */
export function apply(ctx: Context, config: z.infer<typeof Config>): void {
  const skill = instructions[config.skill]
  ctx.effect(() => ctx.skills.register({ name: config.skill, source: 'bundled', provider: 'dsh-plugin-visual-curator',
    description: skill.description, content: skill.content }), `Visual Curator skill ${config.skill}`)
}
