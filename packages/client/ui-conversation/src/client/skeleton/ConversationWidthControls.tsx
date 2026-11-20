import { useLayoutEffect } from 'react'
import type { ConversationWidthControlsProps } from '../contract/slots.ts'

/**
 * Share the transcript's usable width with the main Conversation layout.
 * @param props - Mounted Conversation body and presentation phase.
 * @returns no visible control.
 */
export function ConversationWidthControls({ container }: ConversationWidthControlsProps) {
  useLayoutEffect(() => {
    if (container === null) return
    const scrollport = container.querySelector('[data-conversation-scroll]')
    if (scrollport === null) return

    // The content box excludes the scrollbar and padding reserved for task cards.
    const observer = new ResizeObserver((entries) => {
      for (const { contentRect } of entries) {
        container.style.setProperty('--dsh-conversation-column-width', `${contentRect.width}px`)
      }
    })
    observer.observe(scrollport)
    return () => {
      observer.disconnect()
      container.style.removeProperty('--dsh-conversation-column-width')
    }
  }, [container])

  return null
}
