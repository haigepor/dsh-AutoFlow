/** Loading placeholders reserve server rows and editor fields without fake controls. */
import css from './McpSettings.module.css'

/**
 * Reserve the geometry of the content being loaded.
 * @param props - list or detail presentation.
 * @returns decorative placeholders using the theme skeleton token.
 */
export function McpSkeleton({ detail = false }: { detail?: boolean }) {
  const bar = (className: string | undefined) => <span className={`${css.skeletonBar} ${className}`} />
  return detail ? <div className={`${css.panel} ${css.skeletonDetail}`} data-mcp-skeleton="detail" aria-hidden="true">
    <div className={css.detailHeader}>{bar(css.skeletonTitle)}{bar(css.skeletonButton)}</div>
    {[0, 1, 2, 3].map(index => <div key={index} className={css.field}>
      {bar(css.skeletonLabel)}{bar(css.skeletonInput)}
    </div>)}
    <div className={css.formActions}>{bar(css.skeletonButton)}{bar(css.skeletonButton)}</div>
  </div> : <div className={css.list} data-mcp-skeleton="list" aria-hidden="true">
    {[0, 1, 2].map(index => <div key={index} className={`${css.row} ${css.skeletonRow}`}>
      <div className={css.skeletonMain}><div className={css.rowTitle}>{bar(css.skeletonTitle)}{bar(css.skeletonBadge)}</div>
        {bar(css.skeletonMeta)}</div>
      {bar(css.skeletonSwitch)}{bar(css.skeletonArrow)}
    </div>)}
  </div>
}
