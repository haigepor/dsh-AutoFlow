/** Validated GitHub sources that allow independent custom bundle updates. */
import type { DshBundleUpdateSource } from '@deepseek-ai/dsh-package-manifest'

/** Read an optional update declaration, refusing official runtime package overrides.
 * @param name Manifest package name.
 * @param value Untrusted JSON declaration.
 * @returns Validated GitHub source, or undefined when absent.
 */
export function parseBundleUpdateSource(name: string, value: unknown): DshBundleUpdateSource | undefined {
  if (value === undefined) return undefined
  if (name.startsWith('@deepseek-ai/')) throw new Error('Official runtime bundles cannot declare independent updates')
  if (typeof value !== 'object' || value === null || Array.isArray(value)) throw new Error('Invalid bundle update source')
  const input = value as Record<string, unknown>
  if (input.provider !== 'github' || typeof input.repository !== 'string'
    || !/^[A-Za-z0-9][A-Za-z0-9_.-]*\/[A-Za-z0-9][A-Za-z0-9_.-]*$/.test(input.repository)
    || typeof input.tagPrefix !== 'string' || !/^[a-z][a-z0-9-]*-v$/.test(input.tagPrefix)
    || typeof input.metadataAsset !== 'string' || !/^[a-z][a-z0-9.-]*\.json$/.test(input.metadataAsset)
    || Object.keys(input).some(key => !['provider', 'repository', 'tagPrefix', 'metadataAsset'].includes(key))) {
    throw new Error('Invalid GitHub bundle update source')
  }
  return { provider: 'github', repository: input.repository, tagPrefix: input.tagPrefix, metadataAsset: input.metadataAsset }
}
