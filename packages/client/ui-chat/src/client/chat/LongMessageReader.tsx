/** Read original user text in the existing Session right sidebar. */
import { FileTypeIcon } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { MessageIconActions } from './MessageIconActions.tsx'
import css from './LongMessageReader.module.css'

/** Identity used by the sidebar type and its keyed body/title registrations. */
export const LONG_READER_ID = '@deepseek-ai/dsh-client-ui-chat/long-message'

/** One replaceable reader page per Session pane. */
export const LONG_MESSAGE_KIND = 'chat-long-message'

declare module '@deepseek-ai/dsh-client-ui-sidebar-right/client' {
  interface SidebarRightTabParamsMap {
    /** Original text retained only by the in-memory navigation, never by the saved layout. */
    'chat-long-message': { messageText: string }
  }
}

type ReaderProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'chat'>

/**
 * Render the unchanged message with wrapping, scrolling and native copy controls.
 * @param props - Session tab navigation and localized Chat copy.
 * @returns the full-text reader, or a prompt to reopen a card after layout restoration.
 */
export function LongMessageReader({ useTabInfo, t }: ReaderProps) {
  const { tab } = useTabInfo()
  const params = tab.navigation.params
  const text = params !== undefined && 'messageText' in params ? params.messageText : undefined
  if (text === undefined) return <div className={css.empty}>{t('message.longText.reopen')}</div>
  return <section className={css.reader} aria-label={t('message.longText.full')}>
    <header className={css.header}>
      <span>{t('message.longText.full')}</span>
      <MessageIconActions text={text} clock="end" t={t} />
    </header>
    {/* Each navigation starts at the top, including reopening the same message. */}
    <div key={tab.navigation.revision} className={css.scroll} tabIndex={0} role="document" aria-label={t('message.longText.full')}>
      <pre className={css.text}>{text}</pre>
    </div>
  </section>
}

/**
 * Give the reader tab its native file glyph and localized title.
 * @param props - localized Chat copy.
 * @returns the standard sidebar chip contents.
 */
export function LongMessageReaderTitle({ t }: PropsRuntime<'sidebar.right.pane.tab.title'> & PropsLocale<'chat'>) {
  return <><FileTypeIcon path="message.txt" size={16} className={css.titleIcon} />{t('message.longText.title')}</>
}
