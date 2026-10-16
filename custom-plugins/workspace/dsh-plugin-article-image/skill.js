/** Package-owned Skill provider; no Home files are copied or overwritten. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
export const inject = ['skills']
const entries = [
  { name: 'article-image-workflow', description: 'Import Google Sheets article links, read saved article paragraphs and save image plans using article_image tools.' },
  { name: 'article-image-editorial-prompts', description: 'Understand article facts and write detailed realistic editorial cover and inline image prompts grounded in numbered source paragraphs.' },
]

/** Register bundled Skills for this runtime only. @param {object} ctx Skill context. @returns {void} Disposal removes the provider. */
export function apply(ctx) {
  const candidates = entries.map(entry => ({ ...entry, provider: 'article-image', source: 'bundled', rank: 600,
    invocation: { modelInvocable: true, userInvocable: true },
    resourceBase: { kind: 'directory', path: fileURLToPath(new URL(`./skills/${entry.name}/`, import.meta.url)) },
    locator: new URL(`./skills/${entry.name}/SKILL.md`, import.meta.url),
  }))
  ctx.effect(() => ctx.skills.registerProvider(() => ({ name: 'article-image', list: async () => candidates,
    get: async candidate => ({ ...candidate, content: (await readFile(candidate.locator, 'utf8')).replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '') }),
  })), 'Article image Skills')
}
