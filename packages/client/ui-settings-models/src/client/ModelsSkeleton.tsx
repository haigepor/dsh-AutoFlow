/** Initial-load geometry for the Models settings workspace. */
import directoryStyles from './ModelsDirectory.module.css'
import catalogArtwork from './assets/catalog-whale-maid-v1.webp'
import styles from './ModelsSkeleton.module.css'

/**
 * Reserve tabs, filters and model rows without exposing fake controls.
 * @returns decorative directory loading placeholders.
 */
export function ModelsSkeleton() {
  const bar = (className: string | undefined) => <span className={`${styles['bar']} ${className}`} />
  return <div className={`${directoryStyles['directory']} ${styles['skeleton']}`} data-models-skeleton aria-hidden="true">
    <div className={styles['tabs']}>{bar(styles['tab'])}{bar(styles['tabShort'])}{bar(styles['tabWide'])}</div>
    <div className={`${directoryStyles['heading']} ${directoryStyles['catalogHeading']}`}>
      <div className={directoryStyles['catalogIntro']}>
        <img className={directoryStyles['catalogArtwork']} src={catalogArtwork} width={104} height={104}
          alt="" aria-hidden="true" draggable={false} decoding="async" />
        <div className={styles['introCopy']}><div className={styles['titleLine']}>{bar(styles['title'])}{bar(styles['count'])}</div>
          {bar(styles['description'])}</div>
      </div>
      {bar(styles['button'])}
    </div>
    <div className={directoryStyles['catalogSurface']}>
      <div className={directoryStyles['filters']}>
        <div className={styles['search']}>{bar(styles['searchIcon'])}{bar(styles['searchText'])}</div>
        <div className={styles['filter']}>{bar(styles['filterLabel'])}{bar(styles['filterControl'])}</div>
      </div>
      <div className={directoryStyles['tableScroll']}>
        <table className={`${directoryStyles['table']} ${styles['table']}`}>
          <thead><tr>{[0, 1, 2, 3, 4, 5].map(column => <th key={column}>{bar(styles['columnLabel'])}</th>)}</tr></thead>
          <tbody>{[0, 1, 2, 3].map(index => <tr key={index}>
            <td><div className={directoryStyles['modelIdentity']}>{bar(styles['modelMark'])}
              <div className={styles['modelCopy']}>{bar(styles['modelName'])}{bar(styles['modelId'])}</div></div></td>
            <td>{bar(styles['provider'])}</td>
            <td>{bar(styles['provider'])}</td>
            <td><div className={directoryStyles['capabilities']}>{bar(styles['capability'])}{bar(styles['capability'])}</div></td>
            <td><div className={styles['modelCopy']}>{bar(styles['capacity'])}{bar(styles['capacityDetail'])}</div></td>
            <td>{bar(styles['rowAction'])}</td>
          </tr>)}</tbody>
        </table>
      </div>
    </div>
  </div>
}
