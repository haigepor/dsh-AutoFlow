/** @jsxRuntime classic */
/** @jsx React.createElement */
/** @jsxFrag React.Fragment */
/** Location and view controls share the workbench's saved-task selection. */
import type { WorkbenchText } from './workbench-locale.ts'
import type { ExecutionNavigation } from './workbench-navigation.ts'

/** Presentation inputs; navigation remains owned by the workbench. */
export interface WorkflowNavigationProps {
  viewId: string
  view: ExecutionNavigation['view']
  collectionName: string
  archived: boolean
  batchId: string | undefined
  taskId: string | undefined
  image: { index: number; total: number } | undefined
  canvasAvailable: boolean
  resultsAvailable: boolean
  imageAvailable: boolean
  t: WorkbenchText
  onOverview(): void
  onBatch(): void
  onViewChange(view: ExecutionNavigation['view']): void
}

/** @param React Host React runtime. @param ui Existing accessible primitives. @returns Saved-work navigation with responsive breadcrumbs and view tabs. */
export function createWorkflowNavigation(React: typeof import('react'), ui: typeof import('@deepseek-ai/dsh-client-ui-primitives')) {
  const { Button, Tag, SegmentedTabs } = ui
  return function WorkflowNavigation({ viewId, view, collectionName, archived, batchId, taskId, image, canvasAvailable, resultsAvailable, imageAvailable, t, onOverview, onBatch, onViewChange }: WorkflowNavigationProps) {
    return <div className="vc-execution-navigation">
      <nav aria-label={t('workflowBreadcrumb')} className="vc-workflow-breadcrumb"><ol>
        <li className="vc-workflow-collection"><Button size="sm" variant="ghost" title={collectionName} disabled={!canvasAvailable} onClick={onOverview}><span>{collectionName}</span></Button>{archived && <Tag tone="neutral">{t('workflowArchivedCollection')}</Tag>}</li>
        {batchId ? <li><Button size="sm" variant="ghost" title={batchId} disabled={!canvasAvailable} aria-current={!taskId && !image ? 'page' : undefined} onClick={onBatch}><span>{t('workflowBatch')}</span><code>{batchId.slice(0, 8)}</code></Button></li> : !taskId && <li><span aria-current="page">{t('taskAllBatches')}</span></li>}
        {taskId && <li>{view === 'results' ? <span title={taskId} aria-current="page">{t('workflowSavedTask')} <code>{taskId.slice(0, 8)}</code></span> : <Button size="sm" variant="ghost" title={taskId} disabled={!resultsAvailable} onClick={() => onViewChange('results')}><span>{t('workflowSavedTask')}</span><code>{taskId.slice(0, 8)}</code></Button>}</li>}
        {image && <li><span aria-current="page">{t('wallpaperImage')} <strong>{image.index + 1}<small> / {image.total}</small></strong></span></li>}
      </ol></nav>
      <SegmentedTabs size="sm" className="vc-workflow-view-tabs" label={t('workflowNavigation')} value={view} onChange={onViewChange} items={[
        { value: 'canvas', label: t('workflowBatchCanvas'), disabled: !canvasAvailable, id: viewId + '-canvas-view', panelId: viewId + '-execution-content' },
        { value: 'results', label: t('workflowTaskResults'), disabled: !resultsAvailable, id: viewId + '-results-view', panelId: viewId + '-execution-content' },
        { value: 'image', label: t('wallpaperImageFlow'), disabled: !imageAvailable, id: viewId + '-image-view', panelId: viewId + '-execution-content' },
      ]} />
    </div>
  }
}
