/** Manifest artwork shared by plugin cards, rows and update completion. */
import { useState, type ReactNode } from 'react'
import { PluginArtworkDefault, PluginArtworkSubagent } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './PluginManagerPage.module.css'

/**
 * Keep a neutral fallback when the package image cannot be decoded.
 * @param props - Manifest image, fallback family and display dimensions.
 * @returns An isolated image or the established plugin glyph.
 */
export function PackageArtwork({ src, row = false, size = row ? 30 : 36 }: {
  readonly src: string | undefined
  readonly row?: boolean
  readonly size?: number
}): ReactNode {
  const [failedSource, setFailedSource] = useState<string>()
  const Fallback = row ? PluginArtworkSubagent : PluginArtworkDefault
  return src === undefined || src === failedSource
    ? <Fallback size={size} />
    : <img className={css.packageImage} src={src} width={size} height={size} alt="" onError={() => { setFailedSource(src) }} />
}
