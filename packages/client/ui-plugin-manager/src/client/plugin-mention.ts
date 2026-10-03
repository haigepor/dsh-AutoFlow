/** Profile bundles exposed as atomic `@` references; submission requires an enabled bundle. */
import type { BundleInfo } from '@deepseek-ai/dsh-plugin-manager/types'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import { PluginArtworkDefault, type IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InputTriggerSource, ReferenceInsert } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { createElement, useState, type ComponentType } from 'react'
import type { PluginManagerLocaleKey } from './locales.ts'
import { BUILTIN_PROFILE_BUNDLES } from './presentation.ts'

type Translate = (key: PluginManagerLocaleKey) => string

/** Build the same atomic plugin reference for menu picks and example drafts.
 * @param name Bundle package name.
 * @param label Localized display title.
 * @param icon Optional manifest artwork.
 * @returns Reference routed through the plugin codec on submission.
 */
export function pluginReference(name: string, label: string, icon?: string): ReferenceInsert {
  return { source: 'plugin', ref: name, label, appearance: 'plugin',
    clipboardText: `@${name.replace(/^@/u, '')}`, ...icon === undefined ? {} : { artwork: icon } }
}

/** Manifest artwork in the menu, with the same fallback as the plugin card. */
function artwork(src: string | undefined): ComponentType<IconProps> {
  if (src === undefined) return PluginArtworkDefault
  return function PluginMentionArtwork({ size = 22, className }: IconProps) {
    const [failed, setFailed] = useState(false)
    return failed
      ? createElement(PluginArtworkDefault, { size, className })
      : createElement('img', { src, width: size, height: size, className, alt: '', onError: () => { setFailed(true) } })
  }
}

/**
 * Create the `@` source. The menu includes disabled bundles with a status hint;
 * a fresh Host read on submission refuses references to unavailable bundles.
 * @param listBundles - current profile bundle listing.
 * @param resolveText - current locale's plugin display text.
 * @param t - plugin manager dictionary.
 * @returns the source registered through the input-trigger lifecycle.
 */
export function pluginMentionSource(
  listBundles: () => Promise<readonly BundleInfo[]>,
  resolveText: (value: LocalizedText) => string,
  t: Translate,
): InputTriggerSource {
  return {
    trigger: '@', name: 'plugin', order: -10, showGroupTitle: false,
    async candidates(_session, { query, quoted, drilled, signal }) {
      if (quoted === true || drilled) return []
      signal.throwIfAborted()
      const bundles = await listBundles()
      signal.throwIfAborted()
      return bundles.filter(bundle => bundle.error === undefined && !BUILTIN_PROFILE_BUNDLES.has(bundle.name))
        .map(bundle => ({
          name: bundle.name,
          label: bundle.meta?.title === undefined ? bundle.name : resolveText(bundle.meta.title),
          ...!bundle.enabled ? { description: t('mentionDisabled') }
            : bundle.meta?.description === undefined ? {} : { description: resolveText(bundle.meta.description) },
          icon: artwork(bundle.meta?.icon),
          ...(bundle.meta?.icon === undefined ? {} : { value: bundle.meta.icon }),
          iconSize: 24,
          section: t('mentionGroup'),
        }))
        .filter(candidate => [candidate.name, candidate.label].some(value => value.toLocaleLowerCase().includes(query.toLocaleLowerCase())))
        .sort((a, b) => a.label.localeCompare(b.label))
    },
    onPick({ candidate }) {
      return { insert: pluginReference(candidate.name, candidate.label ?? candidate.name, candidate.value) }
    },
    codec: {
      clipboardText: ref => `@${ref.replace(/^@/u, '')}`,
      async serialize(ref, signal) {
        signal.throwIfAborted()
        const bundles = await listBundles()
        signal.throwIfAborted()
        const bundle = bundles.find(item => item.name === ref && item.enabled
          && item.error === undefined && !BUILTIN_PROFILE_BUNDLES.has(item.name))
        if (bundle === undefined) throw new Error(t('mentionUnavailable'))
        const label = (bundle.meta?.title === undefined ? bundle.name : resolveText(bundle.meta.title))
          .replace(/[\]\r\n]/gu, ' ')
        return `@[${label}](dsh-plugin:${bundle.name})`
      },
    },
  }
}
