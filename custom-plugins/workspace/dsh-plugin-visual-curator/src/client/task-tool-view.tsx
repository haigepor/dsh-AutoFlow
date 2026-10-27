/** @jsxRuntime classic */
/** @jsx React.createElement */
/** Session-scoped tool result navigation never accepts a model-supplied owner. */
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { WorkbenchText } from './workbench-locale.ts'
import { z } from 'zod'

/** @param React Shared runtime. @param ui Shared controls. @returns Native tool renderer with a trusted Session callback. */
export function createTaskToolView(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  return function TaskToolView({ phase, block, toolName, openTask, t }: ToolCallViewProps & { openTask(runId: string): Promise<void>; t: WorkbenchText }) {
    const [error, setError] = React.useState<'taskScopeFailed' | 'taskPanelUnavailable' | null>(null), [pending, setPending] = React.useState(false)
    const text = phase === 'result' ? block.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n') : ''
    let runId: string | undefined
    if (phase === 'result' && !block.isError) {
      try { const parsed = z.object({ runId: z.string().min(1) }).safeParse(JSON.parse(text)); if (parsed.success) runId = parsed.data.runId }
      catch (failure) { /* 历史或错误响应保留原文，不从未验证文本猜测任务 ID。 */ }
    }
    return <section className="vc-task-tool"><p>{toolName}</p>{text && <details><summary>{t('taskDetails')}</summary><pre>{text}</pre></details>}{runId && <ui.Button variant="outline" disabled={pending} onClick={() => { const id = runId!; setPending(true); setError(null); void openTask(id).catch(failure => setError(failure instanceof Error && failure.message === 'panel-disabled' ? 'taskPanelUnavailable' : 'taskScopeFailed')).finally(() => setPending(false)) }}>{t('taskOpen')}</ui.Button>}{error && <p role="alert">{t(error)}</p>}</section>
  }
}
