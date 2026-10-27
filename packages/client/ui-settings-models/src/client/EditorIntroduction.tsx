/** Compact decorative introductions shared by model and connection dialogs. */
import type { ReactNode } from 'react'
import modelArtwork from './assets/model-editor-whale-maid-v1.webp'
import providerArtwork from './assets/provider-editor-whale-maid-v1.webp'
import styles from './ModelsDirectory.module.css'
import { FieldHelp } from './FieldHelp.tsx'
import type { ModelsKey } from './locales.ts'

/**
 * Render the editor subject and guidance beside the project's character artwork.
 * @param props - editor kind and locale-owned subject and guidance.
 * @returns the compact editor introduction.
 */
export function EditorIntroduction({ kind, title, description, help, icon, t }: {
  kind: 'model' | 'provider'
  title: string
  description: string
  help?: { title: string; text: string }
  icon?: ReactNode
  t: (key: ModelsKey) => string
}): ReactNode {
  return <div className={styles['editorIntroduction']}>
    <div><div className={styles['introTitle']}>{icon === undefined ? null : <span aria-hidden="true">{icon}</span>}<h2>{title}</h2>
      {help === undefined ? null : <FieldHelp key={help.title} title={help.title} text={help.text} t={t} />}</div>
    <p>{description}</p></div>
    <img src={kind === 'model' ? modelArtwork : providerArtwork} width={80} height={80}
      alt="" aria-hidden="true" draggable={false} decoding="async" />
  </div>
}
