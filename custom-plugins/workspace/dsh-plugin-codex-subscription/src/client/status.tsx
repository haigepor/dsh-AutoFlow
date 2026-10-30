/** One loading summary above the image card; original reasoning and calls stay in the shared disclosure. */
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import { imageSessionAddress } from './resource.ts'
import { imageTaskActive, recordedImageTask, selectImageTask } from './model.ts'
import { imageStatusFrame } from './status-schedule.ts'
import type { ImageCopyKey } from './locales.ts'

/** Shared process-seat props and the image namespace's localized copy. */
export type ImageProcessStatusProps = Pick<PropsRuntime<'conversation.chat.process.status'>,
  'sessionId' | 'useResource' | 'tool' | 'closed' | 'fallback' | 'renderLeadingIcon'> & PropsLocale<'codexImages'>

const PHRASES = ['phraseImagine', 'phraseInspiration', 'phraseDescribe', 'phraseDraw', 'phraseWait', 'phrasePatience'] as const satisfies readonly ImageCopyKey[]

/** Create the inline status from the shell's shared React and icon implementations.
 * @param React Shared React runtime.
 * @param ui Existing image-file icon primitive.
 * @returns A process-header renderer with task-local phrases and owned timer cleanup.
 */
export function createImageProcessStatus(React: typeof import('react'), ui: Pick<typeof import('@deepseek-ai/dsh-client-ui-primitives'), 'FileTypeIcon'>) {
  function Phrase({ value }: { value: string }) {
    const [displayed, setDisplayed] = React.useState(value), [leaving, setLeaving] = React.useState(false)
    React.useEffect(() => {
      if (value === displayed) return
      setLeaving(true)
      const timer = setTimeout(() => { setDisplayed(value); setLeaving(false) }, 160)
      return () => clearTimeout(timer)
    }, [value, displayed])
    return <span className="ci-status-copy" data-leaving={leaving}>{displayed}</span>
  }
  return function ImageProcessStatus({ sessionId, tool, closed, fallback, renderLeadingIcon, useResource, t }: ImageProcessStatusProps) {
    const resource = useResource<'codex-images'>(imageSessionAddress(sessionId))
    const view = resource.value?.sessionId === sessionId ? resource.value : undefined
    const result = 'kind' in tool ? tool : undefined
    const saved = React.useMemo(() => result ? recordedImageTask(result.meta, result.content, result.time) : undefined, [result])
    const name = 'phase' in tool ? tool.name : tool.call?.name ?? tool.name
    const requested = name === 'codex_image_result' ? tool.args.text('taskId') : undefined
    const task = selectImageTask(view, tool.callId, requested, saved)
    const queryFailed = name === 'codex_image_result' && result?.isError === true
    const active = !closed && !queryFailed && resource.status !== 'failed' && task !== undefined && imageTaskActive(task)
    const taskId = task?.taskId, createdAt = task?.createdAt
    const [now, setNow] = React.useState(Date.now)
    React.useEffect(() => {
      if (!active || taskId === undefined || createdAt === undefined) return
      let timer: ReturnType<typeof setTimeout> | undefined
      const update = () => {
        clearTimeout(timer)
        if (document.hidden) return
        const time = Date.now(); setNow(time)
        timer = setTimeout(update, Math.max(1, imageStatusFrame(taskId, createdAt, time).nextAt - time))
      }
      document.addEventListener('visibilitychange', update)
      update()
      return () => { clearTimeout(timer); document.removeEventListener('visibilitychange', update) }
    }, [active, taskId, createdAt])
    if (name !== 'codex_image_generate' && name !== 'codex_image_result') return fallback
    const state = task?.state
    const title = state === 'succeeded' ? t('succeeded')
      : state === 'failed' ? t('failed') : state === 'cancelled' ? t('cancelled') : state === 'outcome-unknown' ? t('unknown')
        : queryFailed ? t('unavailable') : !task && result?.isError ? t('failed') : resource.status === 'failed' ? t('reconnecting')
          : state === 'queued' ? t('queued') : active ? t('generating') : task ? t('loadingImage') : closed ? t('title') : t('preparing')
    const phrase = active && task ? PHRASES[imageStatusFrame(task.taskId, task.createdAt, now).index]! : undefined
    return <>{renderLeadingIcon(<ui.FileTypeIcon kind="image" size={14} />)}
      <span className="ci-process-summary" data-codex-image-summary data-state={state} aria-label={title}>
        <span>{title}</span>{phrase && <span className="ci-status-message" aria-hidden="true"><span>·</span><Phrase key={taskId} value={t(phrase)} /></span>}
      </span>
    </>
  }
}
