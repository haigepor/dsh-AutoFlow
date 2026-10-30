/** Session-independent answer content sharing Chat's Markdown vocabulary and typography. */
import { memo, useMemo } from 'react'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import { MarkdownText } from '@deepseek-ai/dsh-client-ui-primitives'
import type { MarkdownFileMentions, MarkdownPathImages } from '@deepseek-ai/dsh-client-ui-primitives'
import { markdownLabels } from '../markdown-labels.ts'
import css from './AssistantMarkdown.module.css'

type ContentProps = FactoryComponentPropsOf<'conversation.chat.assistant.content'>

/**
 * Render answer Markdown with the same locale controls in Chat and standalone content.
 * @param props - answer text, streaming state, locale, and optional caller-authorized file rendering.
 * @returns the shared answer body; local paths are inactive without an explicit resolver.
 */
export const AssistantText = memo(function AssistantText({ text, streaming, t, mentions, pathImages, textInteractionSource = false }:
Pick<ContentProps, 'text' | 'streaming' | 't'> & {
  mentions?: MarkdownFileMentions | undefined
  pathImages?: MarkdownPathImages | undefined
  textInteractionSource?: boolean
}) {
  const labels = useMemo(() => markdownLabels(t), [t])
  return <MarkdownText text={text} streaming={streaming} labels={labels} fileMentions={mentions} pathImages={pathImages}
    textInteractionSource={textInteractionSource} />
})

/**
 * Render read-only answer content outside a Session using Chat's original layout.
 * @param props - plain answer content and the framework-owned Chat locale.
 * @returns native Markdown, code controls, and an optional stopped marker.
 */
export function AssistantContent({ text, streaming, interrupted, t }: ContentProps) {
  return <div className={css.root} data-streaming={streaming || undefined}>
    <div className={css.body}>
      <AssistantText text={text} streaming={streaming} t={t} />
      {interrupted && <span className={css.stopped}>{t('message.stopped')}</span>}
    </div>
  </div>
}
