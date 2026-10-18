/** Explicit rule-file resolution. Each run owns a detached, hashed copy of every effective file. */
import { readFile } from 'node:fs/promises'
import { isAbsolute } from 'node:path'
import { z } from 'zod'
import { analysisHash } from '../shared/analysis-contracts.js'

/** Deployment controls; resolving these never contacts a model or installs a browser. */
export const analysisConfigSchema = z.object({
  enabled: z.boolean().default(true), provider: z.string().max(200).default(''), model: z.string().max(300).default(''),
  reasoningEffort: z.string().min(1).max(100).optional(), maxTokens: z.number().int().min(512).max(65536).default(6000),
  contextChars: z.number().int().min(4000).max(400000).default(60000),
  maxInputChars: z.number().int().min(1000).max(2000000).default(300000), maxChunks: z.number().int().min(1).max(100).default(24),
  maxImagesPerChunk: z.number().int().min(1).max(100).default(8), maxImageBytes: z.number().int().min(1024).max(50000000).default(12000000),
  maxTotalImageBytes: z.number().int().min(1024).max(500000000).default(60000000),
  maxSteps: z.number().int().min(1).max(100).default(6), timeoutMs: z.number().int().min(1000).max(3600000).default(300000),
  concurrency: z.number().int().min(1).max(8).default(1), rulesFile: z.string().max(4000).default(''),
}).strict()

/** Resolve controls once at the configuration parser. @param {object} input Raw analysis config. @returns {object} Complete controls. */
export function resolveAnalysisConfig(input = {}) { return analysisConfigSchema.parse(input) }

const policyFields = {
  explanationLanguage: z.string().min(1).max(100), promptLanguage: z.string().min(1).max(100),
  coverCount: z.literal(1), inlineCount: z.number().int().min(0).max(11),
  ratio: z.enum(['16:9', '4:3', '3:2', '1:1', '9:16']),
  style: z.string().min(1).max(4000), audience: z.string().max(2000), brandConstraints: z.string().max(4000),
}
const policySchema = z.object(policyFields).strict()
const profileSchema = z.object({ version: z.literal(1), policy: z.object(policyFields).partial().strict() }).strict()
const selectionSchema = z.object({ inlineCount: policyFields.inlineCount.optional(), ratio: policyFields.ratio.optional() }).strict()
const resources = [
  ['understanding', '../../skills/article-image-editorial-prompts/references/understanding.md'],
  ['visual-planning', '../../skills/article-image-editorial-prompts/references/visual-planning.md'],
  ['understand-template', '../../rules/understand.md'], ['synthesis-template', '../../rules/synthesis.md'], ['plan-template', '../../rules/plan.md'],
]

/** Load package references, defaults, profile overrides, then explicit per-run choices. @param {object} config Resolved controls. @param {object} selection Count/ratio overrides. @returns {Promise<object>} Immutable rule snapshot. */
export async function loadEditorialRules(config, selection = {}) {
  const files = []
  const templates = {}
  const load = async (id, path) => {
    let content
    try { content = await readFile(path, 'utf8') } catch (error) { throw Object.assign(new Error('analysis-rules-unavailable', { cause: error }), { code: 'analysis-rules-unavailable' }) }
    if (content.length > 64000 || content.includes('\uFFFD')) throw Object.assign(new Error('analysis-rules-invalid'), { code: 'analysis-rules-invalid' })
    files.push({ id, hash: analysisHash(content), content })
    return content
  }
  let policy
  try {
    for (const [key, relative] of resources) templates[key] = await load(relative.replace('../../', ''), new URL(relative, import.meta.url))
    policy = policySchema.parse(JSON.parse(await load('rules/defaults.json', new URL('../../rules/defaults.json', import.meta.url))))
    if (config.rulesFile) {
      if (!isAbsolute(config.rulesFile)) throw new Error('Profile rule path must be absolute')
      const override = profileSchema.parse(JSON.parse(await load('profile-editorial-rules', config.rulesFile)))
      policy = policySchema.parse({ ...policy, ...override.policy })
    }
    policy = policySchema.parse({ ...policy, ...selectionSchema.parse(selection) })
  } catch (error) {
    if (error.code === 'analysis-rules-unavailable') throw error
    throw Object.assign(new Error('analysis-rules-invalid', { cause: error }), { code: 'analysis-rules-invalid' })
  }
  const data = { version: 1, files, policy, templates }
  return structuredClone({ ...data, rulesHash: analysisHash(data) })
}
