/** @jsxRuntime classic */
/** @jsx React.createElement */
/** Tool receipts stay in the process; live task presentation belongs to the Session dock. */
import type { ToolCallViewProps } from '@deepseek-ai/dsh-client-ui-tool/client'
import type { WorkbenchText } from './workbench-locale.ts'

/** @param React Shared runtime. @param ui Native controls. @returns Compact localized tool receipts with original call inspection. */
export function createTaskToolView(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  return function TaskToolView({ phase, block, toolName, inspect, t }: ToolCallViewProps & { t: WorkbenchText }) {
    const failed = phase === 'result' && block.isError
    const title = t(toolName === 'visual_run_get' ? 'taskReadProgress' : toolName === 'visual_crop_start' ? 'cropKind' : 'searchKind')
    const text = phase === 'result' ? block.content.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n') : ''
    return <div className="vc-task-call" data-task-call={toolName}>
      <ui.StateDot state={failed ? 'error' : phase === 'result' ? 'done' : 'ongoing'} />
      <span>{title}</span><small>{t(failed ? 'failed' : phase === 'result' ? 'taskCallReturned' : 'running')}</small>
      {inspect ? <ui.Button size="sm" variant="ghost" onClick={inspect}>{t('taskRawDetails')}</ui.Button> : text && <details><summary>{t('taskRawDetails')}</summary><pre>{text}</pre></details>}
    </div>
  }
}
