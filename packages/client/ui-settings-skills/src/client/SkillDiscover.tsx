/** Marketplace search and pinned repository installs share one explicit installation target. */
import { useId, useState } from 'react'
import {
  Button,
  IconFolderOpenOutlineRegular,
  IconGlobeOutlineRegular,
  Input,
  SegmentedTabs,
  Tag,
  Tooltip,
  IconCloseOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { ManagedDirectory, MarketplaceSkill, RepositorySkill } from '@deepseek-ai/dsh-skill-manager/types'
import type { SkillSettingsProps } from './contract.ts'
import { SkillChoice } from './SkillChoice.tsx'
import { SkillSkeleton } from './SkillSkeleton.tsx'
import css from './SkillSettings.module.css'

/** Discover remote skills through distinct market and repository views.
 * @param props - registered workspaces, writable roots and native discovery operations.
 * @returns one scoped installation surface with result cards and repository subscriptions.
 */
export function SkillDiscover(
  props: SkillSettingsProps & {
    directories: ManagedDirectory[]
    workspace: string
    workspaces: string[]
    onWorkspaceChange: (path: string) => void
  },
) {
  const { t } = props
  const id = useId()
  const [view, setView] = useState<'market' | 'repository'>('market')
  const [destination, setDestination] = useState(props.directories[0]?.id)
  const target = props.directories.find(root => root.id === destination) ?? props.directories[0]
  const busy = props.useStore(state => state.busy)
  const [catalog, setCatalog] = useState<MarketplaceSkill['catalog']>('skills.sh')
  const [query, setQuery] = useState('')
  const [marketItems, setMarketItems] = useState<MarketplaceSkill[]>()
  const [searching, setSearching] = useState(false)
  const [repository, setRepository] = useState('')
  const [ref, setRef] = useState('HEAD')
  const [repoItems, setRepoItems] = useState<RepositorySkill[]>()
  const [browsing, setBrowsing] = useState(false)
  const subscriptions = props.useResource<'skill-repositories'>('dsh-resource://skill-repositories/list')
  async function browse(address: string, revision: string): Promise<void> {
    setBrowsing(true)
    try {
      const result = await props.discover(address, revision)
      if (result !== undefined) setRepoItems(result)
    } finally {
      setBrowsing(false)
    }
  }
  return (
    <div className={css.discover}>
      <div className={css.discoveryIntro}>
        <h2>{t('discoverTitle')}</h2>
        <p>{t('discoverHelp')}</p>
      </div>
      <div className={css.installTarget}>
        <label className={css.field}>
          {t('workspaceContext')}
          <SkillChoice
            label={t('workspace')}
            value={props.workspace}
            items={[{ id: '', label: t('global') }, ...props.workspaces.map(path => ({ id: path, label: path }))]}
            onChange={props.onWorkspaceChange}
            disabled={busy}
          />
        </label>
        <label className={css.field}>
          {t('destination')}
          <SkillChoice
            label={t('destination')}
            value={target?.id ?? ''}
            items={props.directories.map(root => ({ id: root.id, label: root.path }))}
            onChange={(value) => {
              setDestination(props.directories.find(root => root.id === value)?.id)
            }}
            disabled={busy}
          />
        </label>
      </div>
      {!target ? <p className={css.notice}>{t('noDestination')}</p> : null}
      <SegmentedTabs
        value={view}
        onChange={setView}
        label={t('discoverSources')}
        variant="underline"
        items={[
          { value: 'market', label: t('publicMarket'), id: `${id}-market`, panelId: `${id}-panel` },
          { value: 'repository', label: t('githubRepositories'), id: `${id}-repository`, panelId: `${id}-panel` },
        ]}
      />
      <div id={`${id}-panel`} role="tabpanel" aria-labelledby={`${id}-${view}`}>
        {view === 'market' ? (
          <section className={css.discoverPanel}>
            <form
              className={css.marketSearch}
              onSubmit={(event) => {
                event.preventDefault()
                setSearching(true)
                void props
                  .marketplace(catalog, query)
                  .then((result) => {
                    if (result !== undefined) setMarketItems(result)
                  })
                  .finally(() => {
                    setSearching(false)
                  })
              }}
            >
              <SkillChoice
                label={t('catalog')}
                value={catalog}
                disabled={searching}
                items={[
                  { id: 'skills.sh', label: t('skillsShName') },
                  { id: 'clawhub', label: t('clawhubName') },
                ]}
                onChange={(value) => {
                  if (value === 'skills.sh' || value === 'clawhub') {
                    setCatalog(value)
                    setMarketItems(undefined)
                  }
                }}
              />
              <Input
                value={query}
                disabled={searching}
                aria-label={t('catalogQuery')}
                placeholder={t('marketSearchHint')}
                onChange={(event) => {
                  setQuery(event.target.value)
                }}
              />
              <Button
                variant="primary"
                type="submit"
                disabled={searching || (catalog === 'skills.sh' && !query.trim())}
              >
                {t('catalogSearch')}
              </Button>
            </form>
            {searching ? (
              <SkillSkeleton label={t('loading')} />
            ) : marketItems === undefined ? (
              <div className={css.discoverEmpty}>
                <IconGlobeOutlineRegular size={28} />
                <h3>{t('marketEmptyTitle')}</h3>
                <p>{t('marketEmptyHint')}</p>
              </div>
            ) : !marketItems.length ? (
              <div className={css.discoverEmpty}>
                <h3>{t('noMatches')}</h3>
                <p>{t('marketNoMatches')}</p>
              </div>
            ) : (
              <>
                <div className={css.resultsHeader}>
                  <h3>{t('searchResults')}</h3>
                  <span>{t('resultCount', { count: marketItems.length })}</span>
                </div>
                <div className={css.cardGrid}>
                  {marketItems.map(item => (
                    <InstallCard
                      key={`${item.catalog}:${item.owner}/${item.slug}`}
                      name={item.name}
                      description={item.description}
                      source={item.repository || `${item.owner}/${item.slug}`}
                      disabled={busy || !target}
                      t={t}
                      onInstall={() => {
                        if (target) void props.installMarketplace(item, target.id, false, props.workspace)
                      }}
                    />
                  ))}
                </div>
              </>
            )}
          </section>
        ) : (
          <div className={css.repositoryLayout}>
            <section className={css.discoverPanel}>
              <form
                className={css.repositorySearch}
                onSubmit={(event) => {
                  event.preventDefault()
                  void browse(repository, ref)
                }}
              >
                <label className={css.field}>
                  {t('repository')}
                  <Input
                    required
                    value={repository}
                    disabled={browsing}
                    placeholder={t('repositoryPlaceholder')}
                    onChange={(event) => {
                      setRepository(event.target.value)
                    }}
                  />
                </label>
                <label className={css.field}>
                  {t('ref')}
                  <Input
                    required
                    value={ref}
                    disabled={browsing}
                    onChange={(event) => {
                      setRef(event.target.value)
                    }}
                  />
                </label>
                <div className={css.repositoryActions}>
                  <Button
                    type="submit"
                    variant="primary"
                    disabled={browsing || busy || !repository.trim() || !ref.trim()}
                  >
                    {t('browse')}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy || browsing || !repository.trim() || !ref.trim()}
                    onClick={() => {
                      void props.subscribe(repository, ref, false)
                    }}
                  >
                    {t('subscribe')}
                  </Button>
                </div>
              </form>
              {browsing ? (
                <SkillSkeleton label={t('loading')} />
              ) : !repoItems?.length ? (
                <div className={css.discoverEmpty}>
                  <IconFolderOpenOutlineRegular size={28} />
                  <h3>{t(repoItems === undefined ? 'repositoryEmptyTitle' : 'repositoryNone')}</h3>
                  <p>{t(repoItems === undefined ? 'repositoryEmpty' : 'marketNoMatches')}</p>
                </div>
              ) : (
                <>
                  <div className={css.resultsHeader}>
                    <h3>{t('repositorySkills')}</h3>
                    <span>{t('resultCount', { count: repoItems.length })}</span>
                  </div>
                  <div className={css.repositoryResults}>
                    {repoItems.map(item => (
                      <InstallCard
                        key={item.path}
                        name={item.name}
                        description={item.description}
                        source={item.repository}
                        version={item.commit.slice(0, 12)}
                        disabled={busy || !target}
                        t={t}
                        onInstall={() => {
                          if (target) void props.install(item, target.id, false, props.workspace)
                        }}
                      />
                    ))}
                  </div>
                </>
              )}
            </section>
            <aside className={css.subscriptionPanel} aria-label={t('subscriptions')}>
              <header className={css.groupHeader}>
                <h3>{t('subscriptions')}</h3>
                <span className={css.sourceCount}>{subscriptions.value?.length ?? 0}</span>
              </header>
              {subscriptions.status === 'failed' ? (
                <p className={css.notice}>
                  {t('loadFailed')}
                  <Button size="sm" onClick={props.refresh}>
                    {t('retry')}
                  </Button>
                </p>
              ) : !subscriptions.value?.length ? (
                <p className={css.groupEmpty}>{t('noSubscriptions')}</p>
              ) : (
                <ul className={css.subscriptionList}>
                  {subscriptions.value.map(item => (
                    <li key={item.repository}>
                      <button
                        type="button"
                        className={css.subscriptionMain}
                        disabled={browsing}
                        onClick={() => {
                          setRepository(item.repository)
                          setRef(item.ref)
                          void browse(item.repository, item.ref)
                        }}
                      >
                        <span>{item.repository}</span>
                        <span className={css.path}>{item.ref}</span>
                      </button>
                      <Tooltip label={t('unsubscribeRepository', { name: item.repository })} portal>
                        <Button
                          size="sm"
                          disabled={busy}
                          icon={<IconCloseOutlineRegular size={14} />}
                          aria-label={t('unsubscribeRepository', { name: item.repository })}
                          onClick={() => {
                            void props.subscribe(item.repository, item.ref, true)
                          }}
                        />
                      </Tooltip>
                    </li>
                  ))}
                </ul>
              )}
            </aside>
          </div>
        )}
      </div>
    </div>
  )
}

function InstallCard({
  name,
  description,
  source,
  version,
  disabled,
  onInstall,
  t,
}: {
  name: string
  description: string
  source: string
  version?: string
  disabled: boolean
  onInstall: () => void
  t: SkillSettingsProps['t']
}) {
  return (
    <article className={css.installCard}>
      <div className={css.installCardBody}>
        <h3>{name}</h3>
        <p>{description}</p>
        <span className={css.path}>{source}</span>
      </div>
      <footer>
        {version ? <Tag>{version}</Tag> : <span />}
        <Button variant="outline" size="sm" disabled={disabled} onClick={onInstall}>
          {t('install')}
        </Button>
      </footer>
    </article>
  )
}
