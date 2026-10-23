/** Persisted plugin mentions rendered through the shared user-text extension API. */
import { ReferenceChip } from '@deepseek-ai/dsh-client-ui-primitives'
import type { UserTextNodeProps, UserTextRule } from '@deepseek-ai/dsh-client-ui-conversation/client'

declare module '@deepseek-ai/dsh-client-ui-conversation/client' {
  interface UserTextDataMap {
    /** Explicit wire reference, retaining the installed package identity and display label. */
    plugin: { readonly name: string; readonly label: string }
  }
}

/** Match explicit plugin references without querying the current installation. */
export const pluginReferenceRule: UserTextRule<'plugin'> = {
  id: 'plugin', order: 5,
  match(text, from) {
    const pattern = /@\[([^\]\n]+)\]\(dsh-plugin:([^\s)]+)\)/gu
    pattern.lastIndex = from
    const match = pattern.exec(text)
    const name = match?.[2]
    const label = match?.[1]
    if (match === null || name === undefined || label === undefined) return undefined
    return {
      id: 'plugin', start: match.index, end: match.index + match[0].length,
      data: { name, label },
    }
  },
}

/**
 * Display a saved plugin mention without changing its recorded identity.
 * @param props - parsed label and its original wire text.
 * @returns the local plugin reference chip.
 */
export function PluginReference({ node, raw }: UserTextNodeProps<'plugin'>) {
  return <ReferenceChip appearance="plugin" label={node.data.label} title={raw} />
}
