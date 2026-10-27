/** Initial-load geometry for the Models settings workspace. */
import styles from './ModelsSection.module.css'
import directoryStyles from './ModelsDirectory.module.css'

/**
 * Reserve tabs, filters and model rows without exposing fake controls.
 * @returns decorative directory loading placeholders.
 */
export function ModelsSkeleton() {
  return <div className={directoryStyles['directory']} data-models-skeleton aria-hidden="true">
    <div className={directoryStyles['filters']}>
      <div className={`${styles['skeleton']} ${styles['skeletonLabel']}`} />
      <div className={`${styles['skeleton']} ${styles['skeletonButton']}`} />
    </div>
    {[0, 1, 2, 3].map(index => <div key={index} className={`${styles['skeleton']} ${styles['skeletonProvider']}`} />)}
  </div>
}
