/** Reusable user contents inside a caller-owned message row. */
import { Fragment } from 'react'
import type { FactoryComponentPropsOf } from '@deepseek-ai/dsh-client-ui-slots'
import { Button, fileExtension, FileTypeIcon, fileSizeText, JsonBlock, Tooltip } from '@deepseek-ai/dsh-client-ui-primitives'
import css from './MessageItem.module.css'

const EMPTY_LABELS: readonly string[] = []

/**
 * Render prepared text, ordered attachments, and references without message chrome.
 * Long text uses a compact card when the Session supplies a sidebar reader.
 * The caller owns row identity, pending/echo state, time, and message actions.
 * @param props - prepared content, facts, authorized image loader, and framework Factory/locale seats.
 * @returns the content stack using the existing user-message layout.
 */
export function UserContent(props: FactoryComponentPropsOf<'conversation.chat.user.content'>) {
  return renderContent(props, true)
}

/**
 * Render native user content without requiring a Session or its image slot.
 * @param props - prepared content, explicit image authorization, and framework seats.
 * @returns the same bubble and attachment stack as Chat.
 */
export function UserPreview(props: FactoryComponentPropsOf<'conversation.chat.user.preview'>) {
  return renderContent(props, false)
}

function renderContent(props: FactoryComponentPropsOf<'conversation.chat.user.content'>
  | FactoryComponentPropsOf<'conversation.chat.user.preview'>, sessionImages: boolean) {
  const { content, loadImage, renderFactorySlot, t } = props
  const { text, attachments, extraBlocks, referenceLabels = EMPTY_LABELS } = content
  const compactImages = attachments.length > 1
  const truncated = (total: number): string => t('json.truncated', { total })
  const openLongText = 'openLongText' in props ? props.openLongText : undefined
  const compactText = openLongText !== undefined && (text.length > 1000 || text.split(/\r\n|\r|\n/u, 13).length > 12)
  const showBubble = !compactText && text !== '' || extraBlocks.length > 0
  return (
    <div className={css.userStack}>
      {attachments.length > 0 && (
        <div className={css.attachmentRow} data-message-attachments>
          {attachments.map((attachment, index) => attachment.type === 'image'
            ? (
              <Fragment key={`image:${index}`}>
                {sessionImages && 'renderSlot' in props
                  ? props.renderSlot('conversation.chat.user.images', {
                    images: [attachment.image], loadImage, align: 'end', compact: compactImages,
                  })
                  : renderFactorySlot('conversation.images.content', {
                    images: [attachment.image], loadImage, align: 'end', compact: compactImages,
                  })}
              </Fragment>
            )
            : (
              <span key={`file:${index}`} className={css.fileCard} title={attachment.file.name}>
                <FileTypeIcon path={attachment.file.name} className={css.fileIcon} />
                <span className={css.fileContent}>
                  <span className={css.fileName}>{attachment.file.name}</span>
                  <span className={css.fileMeta}>
                    {[fileExtension(attachment.file.name).toUpperCase().slice(0, 8), fileSizeText(attachment.file.bytes)]
                      .filter(Boolean).join(' ')}
                  </span>
                </span>
              </span>
            ))}
        </div>
      )}
      {compactText && <Tooltip label={t('message.longText.open')} side="top">
        <Button className={css.longTextCard} aria-label={t('message.longText.open')} onClick={() => openLongText(text)}>
          <FileTypeIcon path="message.txt" size={16} className={css.longTextCardIcon} />
          <span className={css.longTextCardLabel}>{text.trimStart().slice(0, 240).replace(/\s+/gu, ' ') || t('message.longText.title')}</span>
          <span className={css.longTextCardAction}>{t('message.longText.read')}</span>
        </Button>
      </Tooltip>}
      {showBubble && <div className={css.bubble}>
        {!compactText && (sessionImages && 'facts' in props
          ? renderFactorySlot('conversation.user.text', { text, facts: props.facts, interactive: props.interactive ?? false, ellipsis: props.ellipsis ?? false })
          : text)}
        {extraBlocks.map((block, index) => (
          <JsonBlock key={index} label={t('message.extraBlock')} payload={block} truncatedLabel={truncated} />
        ))}
      </div>}
      {referenceLabels.length > 0 && (
        <div className={css.referenceSummary}>
          {t('message.referenceSummary', { labels: referenceLabels.join(t('message.referenceSeparator')) })}
        </div>
      )}
    </div>
  )
}
