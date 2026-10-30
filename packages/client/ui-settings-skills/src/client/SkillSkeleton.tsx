/** Card placeholders shared by local inventory and discovery results. */
import css from './SkillSettings.module.css'

/** Reserve the same card grid while a list loads.
 * @param props - localized loading announcement.
 * @returns six non-interactive card placeholders.
 */
export function SkillSkeleton({ label }: { label: string }) {
  return (
    <div role="status" aria-label={label} aria-busy="true" className={css.cardGrid}>
      {[0, 1, 2, 3, 4, 5].map(value => (
        <div key={value} className={`${css.card} ${css.skeleton}`} aria-hidden="true">
          <div className={css.skeletonMain}>
            <div className={css.cardHeading}>
              <span className={css.skeletonIcon} />
              <span className={css.skeletonTitle} />
            </div>
            <span className={css.skeletonLine} />
            <span className={css.skeletonShort} />
            <span className={css.skeletonCategory} />
          </div>
          <div className={css.cardFooter}>
            <span className={css.skeletonBadge} />
            <span className={css.skeletonSwitch} />
          </div>
        </div>
      ))}
    </div>
  )
}
