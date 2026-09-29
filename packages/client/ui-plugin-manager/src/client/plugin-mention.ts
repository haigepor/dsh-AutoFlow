/** Enabled profile bundles exposed as atomic `@` references in the composer. */
import type { BundleInfo } from '@deepseek-ai/dsh-plugin-manager/types'
import type { LocalizedText } from '@deepseek-ai/dsh-package-manifest'
import { PluginArtworkDefault, type IconProps } from '@deepseek-ai/dsh-client-ui-primitives'
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { createElement, useState, type ComponentType } from 'react'
import type { PluginManagerLocaleKey } from './locales.ts'
import { BUILTIN_PROFILE_BUNDLES } from './presentation.ts'

type Translate = (key: PluginManagerLocaleKey) => string

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
 * Create the `@` source. A fresh Host read is required on menu open and submit,
 * so a disabled bundle cannot survive as an apparently usable stale chip.
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
    trigger: '@', name: 'plugin', order: 10, showGroupTitle: false,
    async candidates(_session, { quoted, signal }) {
      if (quoted === true) return []
      signal.throwIfAborted()
      const bundles = await listBundles()
      signal.throwIfAborted()
      return bundles.filter(bundle => bundle.enabled && bundle.error === undefined && !BUILTIN_PROFILE_BUNDLES.has(bundle.name))
        .map(bundle => ({
          name: bundle.name,
          label: bundle.meta?.title === undefined ? bundle.name : resolveText(bundle.meta.title),
          ...(bundle.meta?.description === undefined ? {} : { description: resolveText(bundle.meta.description) }),
          icon: artwork(bundle.meta?.icon),
          ...(bundle.meta?.icon === undefined ? {} : { value: bundle.meta.icon }),
          iconSize: 24,
          section: t('mentionGroup'),
        }))
        .sort((a, b) => a.label.localeCompare(b.label))
    },
    onPick({ candidate }) {
      return { insert: {
        source: 'plugin', ref: candidate.name, label: candidate.label ?? candidate.name,
        appearance: 'plugin', clipboardText: `@${candidate.name.replace(/^@/u, '')}`,
        ...(candidate.value === undefined ? {} : { artwork: candidate.value }),
      } }
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
