/** Initial-load geometry for the Models settings workspace. */
import styles from './ModelsSection.module.css'

/**
 * Reserve provider, editor and action space without exposing fake controls.
 * @returns decorative two-column loading placeholders.
 */
export function ModelsSkeleton() {
  return <div className={styles['workspace']} data-models-skeleton aria-hidden="true">
    <div className={styles['providerRail']}>
      <div className={`${styles['skeleton']} ${styles['skeletonLabel']}`} />
      {[0, 1, 2].map(index => <div key={index} className={`${styles['skeleton']} ${styles['skeletonProvider']}`} />)}
      <div className={`${styles['skeleton']} ${styles['skeletonAdd']}`} />
    </div>
    <div className={`${styles['detail']} ${styles['skeletonDetail']}`}>
      <div className={`${styles['skeleton']} ${styles['skeletonTitle']}`} />
      <div className={`${styles['skeleton']} ${styles['skeletonLabel']}`} />
      <div className={`${styles['skeleton']} ${styles['skeletonInput']}`} />
      <div className={`${styles['skeleton']} ${styles['skeletonLabel']}`} />
      <div className={styles['skeletonActions']}>
        {[0, 1].map(index => <div key={index} className={`${styles['skeleton']} ${styles['skeletonButton']}`} />)}
      </div>
    </div>
  </div>
}
