/** Public repository downloads and bounded archive decoding; downloaded scripts are never executed. */
import { unzipSync } from 'fflate'
import { z } from 'zod'
import { parseSkillDocument } from '@deepseek-ai/dsh-skill-filesystem'
import { containedPath, ManagementError } from './files.ts'
import type { RepositorySkill } from './types.ts'

/** Decode an archive after checking both compressed and expanded limits.
 *
 * @param bytes - ZIP bytes.
 * @param maxBytes - maximum compressed and expanded bytes.
 * @param maxFiles - maximum members.
 *
 * @returns safe relative members.

 */
export function decodeArchive(bytes: Uint8Array, maxBytes: number, maxFiles: number): Record<string, Uint8Array> {
  if (bytes.length > maxBytes) throw new ManagementError('too-large')
  let total = 0
  let count = 0
  const identities = new Set<string>()
  try {
    return unzipSync(bytes, {
      filter: (entry) => {
        if (entry.name.endsWith('/')) return false
        containedPath(process.cwd(), entry.name)
        const identity = entry.name.toLowerCase()
        if (identities.has(identity)) throw new ManagementError('conflict')
        identities.add(identity)
        total += entry.originalSize
        if (++count > maxFiles || total > maxBytes) throw new ManagementError('too-large')
        return true
      },
    })
  } catch (error) {
    if (error instanceof ManagementError) throw error
    throw new ManagementError('invalid')
  }
}
/** Download and inspect a public GitHub repository pinned to an immutable commit.
 *
 * @param input - owner/repository or GitHub repository URL.
 * @param ref - branch, tag or commit.
 *
 * @param maxBytes - archive byte limit.
 * @param maxFiles - expanded member limit.
 * @param timeoutMs - request deadline.
 *
 * @returns the immutable commit, safe archive and valid skill roots.

 */
export async function repositoryArchive(
  input: string,
  ref: string,
  maxBytes: number,
  maxFiles: number,
  timeoutMs: number,
): Promise<{ files: Record<string, Uint8Array>; skills: RepositorySkill[]; commit: string; repository: string }> {
  const repository = input
    .trim()
    .replace(/^https:\/\/github\.com\//u, '')
    .replace(/(?:\.git)?\/$/u, '')
    .replace(/\.git$/u, '')
  if (!/^[\w.-]+\/[\w.-]+$/u.test(repository) || !ref || ref.length > 200) throw new ManagementError('invalid')
  async function request(url: string): Promise<Uint8Array> {
    try {
      const response = await fetch(url, {
        signal: AbortSignal.timeout(timeoutMs),
        redirect: 'error',
        headers: { Accept: 'application/vnd.github+json' },
      })
      if (!response.ok || response.body === null) throw new ManagementError('network')
      const reader = response.body.getReader()
      const chunks: Uint8Array[] = []
      let size = 0
      try {
        for (;;) {
          const chunk = await reader.read()
          if (chunk.done) break
          size += chunk.value.length
          if (size > maxBytes) throw new ManagementError('too-large')
          chunks.push(chunk.value)
        }
      } finally {
        await reader.cancel()
        reader.releaseLock()
      }
      return Buffer.concat(chunks)
    } catch (error) {
      if (error instanceof ManagementError) throw error
      throw new ManagementError('network')
    }
  }
  const metadata = z
    .object({ sha: z.string().regex(/^[a-f0-9]{40}$/u) })
    .parse(
      JSON.parse(
        new TextDecoder().decode(
          await request(`https://api.github.com/repos/${repository}/commits/${encodeURIComponent(ref)}`),
        ),
      ),
    )
  const archive = decodeArchive(
    await request(`https://codeload.github.com/${repository}/zip/${metadata.sha}`),
    maxBytes,
    maxFiles,
  )
  const files = Object.create(null) as Record<string, Uint8Array>
  for (const [path, bytes] of Object.entries(archive)) {
    const slash = path.indexOf('/')
    if (slash >= 0) files[path.slice(slash + 1)] = bytes
  }
  const skills: RepositorySkill[] = []
  for (const [path, bytes] of Object.entries(files)) {
    if (path !== 'SKILL.md' && !path.endsWith('/SKILL.md')) continue
    try {
      const parsed = parseSkillDocument(new TextDecoder('utf-8', { fatal: true }).decode(bytes))
      skills.push({
        repository,
        commit: metadata.sha,
        path: path === 'SKILL.md' ? '' : path.slice(0, -9),
        name: parsed.name,
        description: parsed.description,
      })
    } catch (_invalidSkill) {
      /* Invalid upstream documents are not installable candidates. */
    }
  }
  return { files, skills, commit: metadata.sha, repository }
}
