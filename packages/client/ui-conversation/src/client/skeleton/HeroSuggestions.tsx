/** Hero task-suggestion cards: four categories, each expanding two task chips that fill the draft. */
import { useState } from 'react'
import type { ComponentType, CSSProperties, ReactNode } from 'react'
import {
  IconCompareSplitOutlineRegular, IconProjectAddOutlineRegular, IconProps, IconSearchOutlineRegular,
  IconWarningTriangleOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { HeroSuggestionPrefillOutcome, HeroSuggestionsProps } from '../contract/slots.ts'
import type { HeroSuggestionsKey } from '../suggestion-locales.ts'
import css from './HeroSuggestions.module.css'

/** One suggestion category: locale key, two task chips, tinted icon. */
interface SuggestionCategory {
  readonly id: 'explore' | 'build' | 'review' | 'fix'
  readonly labelKey: HeroSuggestionsKey
  readonly tasks: readonly [
    { readonly labelKey: HeroSuggestionsKey; readonly prompt: HeroSuggestionsKey },
    { readonly labelKey: HeroSuggestionsKey; readonly prompt: HeroSuggestionsKey },
  ]
  readonly icon: ComponentType<IconProps>
  /** Static token painted onto the card's icon via the per-card icon custom property. */
  readonly tint: string
}

const CATEGORIES: readonly [SuggestionCategory, SuggestionCategory, SuggestionCategory, SuggestionCategory] = [
  {
    id: 'explore', labelKey: 'explore', icon: IconSearchOutlineRegular, tint: 'var(--dsw-static-blue-500)',
    tasks: [
      { labelKey: 'explore.task1', prompt: 'explore.prompt1' },
      { labelKey: 'explore.task2', prompt: 'explore.prompt2' },
    ],
  },
  {
    id: 'build', labelKey: 'build', icon: IconProjectAddOutlineRegular, tint: 'var(--dsw-static-deepseek-500)',
    tasks: [
      { labelKey: 'build.task1', prompt: 'build.prompt1' },
      { labelKey: 'build.task2', prompt: 'build.prompt2' },
    ],
  },
  {
    id: 'review', labelKey: 'review', icon: IconCompareSplitOutlineRegular, tint: 'var(--dsw-static-green-500)',
    tasks: [
      { labelKey: 'review.task1', prompt: 'review.prompt1' },
      { labelKey: 'review.task2', prompt: 'review.prompt2' },
    ],
  },
  {
    id: 'fix', labelKey: 'fix', icon: IconWarningTriangleOutlineRegular, tint: 'var(--dsw-static-amber-500)',
    tasks: [
      { labelKey: 'fix.task1', prompt: 'fix.prompt1' },
      { labelKey: 'fix.task2', prompt: 'fix.prompt2' },
    ],
  },
]

/** Status hints share one grid cell; the draft hint keys the has-draft state. */
const HINT_KEYS: Readonly<Record<'workspace' | 'draft' | 'busy', HeroSuggestionsKey>> = {
  workspace: 'hint.workspace',
  draft: 'hint.draft',
  busy: 'hint.busy',
}

/**
 * Render the hero suggestion row under the headline. A category card expands
 * its two task chips; a chip prefills the draft through the owner. Every
 * partition reserves one shared grid cell, so expanding and switching never
 * re-height the centered hero. The whole row hides while a draft is present.
 * @param props - owner values (draft presence + prefill) and the namespace seat.
 * @returns the suggestion section.
 */
export function HeroSuggestions({ draftPresent, prefill, t }: HeroSuggestionsProps): ReactNode {
  const [selected, setSelected] = useState<SuggestionCategory['id']>()
  const [hint, setHint] = useState<HeroSuggestionPrefillOutcome>('ready')
  const activeHint = draftPresent ? 'draft' as const : hint === 'ready' ? undefined : hint
  return (
    <section
      className={css.suggestions}
      data-has-draft={draftPresent}
      aria-hidden={draftPresent}
      aria-label={t('title')}
    >
      <div className={css.cards}>
        {CATEGORIES.map(({ id, labelKey, icon: Icon, tint }) => (
          <button
            type="button"
            key={id}
            className={css.card}
            style={{ '--dsh-hero-suggestion-icon': tint } as CSSProperties}
            disabled={draftPresent}
            aria-pressed={selected === id}
            onClick={() => {
              setSelected(current => current === id ? undefined : id)
              setHint('ready')
            }}
          >
            <Icon className={css.cardIcon} size={16} />
            <span>{t(labelKey)}</span>
          </button>
        ))}
      </div>
      <div className={css.details}>
        {CATEGORIES.map(category => (
          <div
            key={category.id}
            className={css.tasks}
            data-active={selected === category.id}
            aria-hidden={selected !== category.id}
          >
            {category.tasks.map(task => (
              <button
                type="button"
                key={task.labelKey}
                className={css.task}
                disabled={draftPresent || selected !== category.id}
                onClick={() => { setHint(prefill(t(task.prompt))) }}
              >
                {t(task.labelKey)}
              </button>
            ))}
          </div>
        ))}
      </div>
      <div className={css.status}>
        {(Object.keys(HINT_KEYS) as Array<keyof typeof HINT_KEYS>).map(outcome => (
          <p
            key={outcome}
            className={css.hint}
            data-active={activeHint === outcome}
            aria-hidden={activeHint !== outcome}
            role={activeHint === outcome ? 'status' : undefined}
          >
            {t(HINT_KEYS[outcome])}
          </p>
        ))}
      </div>
    </section>
  )
}
