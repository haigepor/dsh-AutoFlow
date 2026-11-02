/** Account metadata cache retains no authorization input and never reuses another identity's listing. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createGalleryCache } from '../src/client/gallery-cache.ts'

const policy = { ttlMs: 100, maxPages: 2, maxBytes: 10000 }
const page = (id: string) => ({ items: [{ id, title: id, description: '', private: false, totalPhotos: 2 }], nextCursor: null })
const context = () => ({ namespace: 'profile-a', revision: 'revision-a', accounts: [{ id: 'a', userId: 'owner-a', credentialRef: 'COOKIE_A' }], policy })
const storage = () => { const values = new Map<string,string>(); return { values, get length() { return values.size }, key: (index:number) => [...values.keys()][index] ?? null, getItem: (key:string) => values.get(key) ?? null, setItem: (key:string,value:string) => { values.set(key,value) }, removeItem: (key:string) => { values.delete(key) } } }
test('fresh listings survive cache reconstruction and explicit refresh performs one new read', async () => {
  const saved = storage(); let calls = 0
  const dependencies = { context, storage: saved, now: () => 1, read: async () => { calls++; return page('folder') } }
  const first = createGalleryCache(dependencies), signal = new AbortController().signal
  const initial=await first.read('gallery-collections', { accountId: 'a', sessionToken: 'must-not-persist' }, signal)
  await first.read('gallery-collections', { accountId: 'a' }, signal)
  assert.equal(calls, 1); first.dispose()
  const next = createGalleryCache(dependencies)
  const reloaded=await next.read('gallery-collections', { accountId: 'a' }, signal); assert.equal(calls, 1)
  await next.read('gallery-collections', { accountId: 'a' }, signal, { refresh: true }); assert.equal(calls, 2)
  const authorizationPersisted=[...saved.values.values()].join('').includes('must-not-persist')
  assert.equal(authorizationPersisted, false)
  assert.deepEqual({firstCollection:(initial as ReturnType<typeof page>).items[0]!.id,sameTabReloadCollection:(reloaded as ReturnType<typeof page>).items[0]!.id,readsBeforeRefresh:1,readsAfterRefresh:calls,authorizationPersisted},JSON.parse(await readFile(new URL('./fixtures/gallery-cache.expected.json',import.meta.url),'utf8')))
  next.dispose()
})

test('a legacy direct-image cache cannot hide freshly projected Host preview paths after upgrade', async () => {
  const saved = storage(), owner = context(), base = JSON.stringify(['gallery-collections', 'a', null, null])
  saved.setItem('visual-curator.gallery-cache.v1', JSON.stringify({ identity: JSON.stringify([owner.namespace, owner.revision, owner.accounts]), entries: [{ key: JSON.stringify([base, null]), base, at: 1, value: page('old-direct') }] }))
  let reads = 0
  const current = { items: [{ ...page('current').items[0]!, coverUrl: 'https://images.unsplash.com/photo', coverPath: '/api/visual-curator/resource?galleryUrl=photo' }], nextCursor: null }
  const cache = createGalleryCache({ context, storage: saved, now: () => 1, read: async () => { reads++; return current } })
  try {
    assert.deepEqual(await cache.read('gallery-collections', { accountId: 'a' }, new AbortController().signal), current)
    assert.equal(reads, 1)
    assert.equal(saved.values.has('visual-curator.gallery-cache.v1'), false)
  } finally { cache.dispose() }
})

test('an explicit gallery refresh requests a fresh Host identity check without persisting that flag', async () => {
  const args: import('../src/client/contract.ts').ActionArgs[] = []
  const cache = createGalleryCache({ context, read: async (_operation, value) => { args.push(value); return page('folder') } })
  const signal = new AbortController().signal
  await cache.read('gallery-collections', { accountId: 'a' }, signal)
  await cache.read('gallery-collections', { accountId: 'a' }, signal, { refresh: true })
  assert.equal(args[0]?.refreshIdentity, undefined)
  assert.equal(args[1]?.refreshIdentity, true)
  cache.dispose()
})
test('photo scopes and cursors remain separate even when optional credit links are absent', async()=>{
  let calls=0
  const cache=createGalleryCache({context:()=>({...context(),policy:{...policy,maxPages:10}}),read:async()=>{calls++;return {items:[{id:'p',title:'p',width:10,height:10,thumbnailUrl:'https://images.unsplash.com/p',referenceUrl:'https://images.unsplash.com/p',pageUrl:'',photographer:'',photographerUrl:'',premium:false}],nextCursor:null}}})
  const signal=new AbortController().signal
  const args={accountId:'a',scope:{kind:'collection',collectionId:'one'}}
  await cache.read('gallery-photos',args,signal);await cache.read('gallery-photos',args,signal);assert.equal(calls,1)
  await cache.read('gallery-photos',{...args,scope:{kind:'collection',collectionId:'two'}},signal)
  await cache.read('gallery-photos',{...args,cursor:'next'},signal);assert.equal(calls,3);cache.dispose()
})
test('account, scope, cursor, expiry and configuration changes cannot share a cached response', async () => {
  let time = 0, calls = 0, revision = 'one'
  const cache = createGalleryCache({ context: () => ({ ...context(), revision }), now: () => time, read: async () => { calls++; return page(String(calls)) } })
  const signal = new AbortController().signal
  const read = (args: Record<string,string>) => cache.read('gallery-collections', args, signal)
  await read({ accountId: 'a' }); await read({ accountId: 'b' }); await read({ accountId: 'a', cursor: 'next' }); assert.equal(calls, 3)
  time=101; await read({ accountId: 'a' }); assert.equal(calls, 4)
  revision='two'; await read({ accountId: 'a' }); assert.equal(calls, 5); cache.dispose()
})
test('one cancelled subscriber does not cancel another reader of the same pending page', async () => {
  let complete!: (value:unknown) => void, calls=0
  const cache = createGalleryCache({ context, read: async () => { calls++; return await new Promise(resolve => { complete=resolve }) } })
  const cancelled = new AbortController(), live = new AbortController()
  const first = cache.read('gallery-collections', { accountId:'a' }, cancelled.signal)
  const second = cache.read('gallery-collections', { accountId:'a' }, live.signal)
  cancelled.abort(); await assert.rejects(first, { name:'AbortError' })
  complete(page('safe')); assert.deepEqual(await second,page('safe')); assert.equal(calls,1); cache.dispose()
})
test('a late response after all subscribers cancel cannot populate the next reader cache', async()=>{
  let complete!: (value:unknown)=>void,calls=0
  const cache=createGalleryCache({context,read:async()=>{calls++;if(calls===1)return await new Promise(resolve=>{complete=resolve});return page('current')}})
  const lifetime=new AbortController(),pending=cache.read('gallery-collections',{},lifetime.signal)
  await Promise.resolve();lifetime.abort();await assert.rejects(pending,{name:'AbortError'});complete(page('old'))
  await Promise.resolve();assert.deepEqual(await cache.read('gallery-collections',{},new AbortController().signal),page('current'));assert.equal(calls,2);cache.dispose()
})
test('oversized, corrupt storage, rejected reads and non-list operations are never cached', async () => {
  const saved=storage(); saved.values.set('visual-curator.gallery-cache.v3','invalid JSON')
  let calls=0
  const cache=createGalleryCache({context,storage:saved,read:async operation=>{calls++;if(operation==='gallery-collections')throw new Error('offline');return {accountId:'a'}}})
  const signal=new AbortController().signal
  await assert.rejects(cache.read('gallery-collections',{},signal)); await assert.rejects(cache.read('gallery-collections',{},signal))
  await cache.read('gallery-login-status',{},signal); await cache.read('gallery-login-status',{},signal); assert.equal(calls,4); cache.dispose()
})
test('the configured page and byte budgets evict old pages without persisting an oversized response', async () => {
  const saved=storage(); let calls=0
  const cache=createGalleryCache({context:()=>({...context(),policy:{...policy,maxPages:1}}),storage:saved,read:async()=>{calls++;return page(String(calls))}})
  const signal=new AbortController().signal
  await cache.read('gallery-collections',{accountId:'a'},signal); await cache.read('gallery-collections',{accountId:'a',cursor:'next'},signal); await cache.read('gallery-collections',{accountId:'a'},signal)
  assert.equal(calls,3); cache.dispose()
  const tiny=createGalleryCache({context:()=>({...context(),policy:{...policy,maxBytes:100}}),storage:saved,read:async()=>{calls++;return page('oversized')}})
  await tiny.read('gallery-collections',{},signal); await tiny.read('gallery-collections',{},signal); assert.equal(calls,5); assert.equal(saved.values.size,0); tiny.dispose()
})

test('incremental persistence stays proportional to loaded metadata and retains every committed page after reconstruction', async () => {
  const saved = storage(), writes: number[] = [], set = saved.setItem
  saved.setItem = (key, value) => { writes.push(Buffer.byteLength(value)); set(key, value) }
  let calls = 0
  const dependencies = { context: () => ({ ...context(), policy: { ...policy, maxPages: 40, maxBytes: 256_000 } }), storage: saved, now: () => 1, read: async (_operation: string, args: Record<string,unknown>) => { calls++; const value = page(String(args.cursor)); value.items[0]!.title = 'Synthetic gallery metadata '.repeat(80); return value } }
  const signal = new AbortController().signal, cache = createGalleryCache(dependencies)
  for (let cursor = 0; cursor < 40; cursor++) await cache.read('gallery-collections', { accountId: 'a', cursor: String(cursor) }, signal)
  const retained = [...saved.values.values()].reduce((sum, value) => sum + Buffer.byteLength(value), 0)
  assert.ok(retained <= 256_000)
  assert.ok(writes.reduce((sum, bytes) => sum + bytes, 0) < retained * 3, 'loading another page must not rewrite earlier page contents')
  cache.dispose()
  const reloaded = createGalleryCache(dependencies)
  try {
    for (let cursor = 0; cursor < 40; cursor++) assert.equal((await reloaded.read('gallery-collections', { accountId: 'a', cursor: String(cursor) }, signal) as ReturnType<typeof page>).items[0]!.id, String(cursor))
    assert.equal(calls, 40)
  } finally { reloaded.dispose() }
})

test('a quota failure while publishing the index preserves memory reads without exposing an uncommitted page on reload', async () => {
  const saved = storage(), set = saved.setItem
  let writes = 0, calls = 0
  saved.setItem = (key, value) => { if (++writes === 3) throw new DOMException('Storage quota', 'QuotaExceededError'); set(key, value) }
  const dependencies = { context, storage: saved, now: () => 1, read: async () => page(String(++calls)) }, signal = new AbortController().signal
  const cache = createGalleryCache(dependencies)
  assert.deepEqual(await cache.read('gallery-collections', {}, signal), page('1'))
  assert.deepEqual(await cache.read('gallery-collections', {}, signal), page('1'))
  assert.equal(calls, 1); assert.equal(saved.values.size, 0); cache.dispose()
  const reloaded = createGalleryCache(dependencies)
  try { assert.deepEqual(await reloaded.read('gallery-collections', {}, signal), page('2')) }
  finally { reloaded.dispose() }
})

test('reconstruction discards an interrupted page write while preserving previously committed pages', async () => {
  const saved = storage(), set = saved.setItem
  let interrupted = new Map<string,string>(), calls = 0
  saved.setItem = (key, value) => { set(key, value); if (key.includes('.page.')) interrupted = new Map(saved.values) }
  const dependencies = { context, storage: saved, now: () => 1, read: async () => page(String(++calls)) }, signal = new AbortController().signal
  const cache = createGalleryCache(dependencies)
  await cache.read('gallery-collections', {}, signal)
  await cache.read('gallery-collections', { cursor: 'next' }, signal)
  cache.dispose(); saved.values.clear()
  for (const [key, value] of interrupted) saved.values.set(key, value)
  const reloaded = createGalleryCache(dependencies)
  try {
    assert.deepEqual(await reloaded.read('gallery-collections', {}, signal), page('1'))
    assert.equal(calls, 2)
    assert.deepEqual(await reloaded.read('gallery-collections', { cursor: 'next' }, signal), page('3'))
    assert.equal(saved.values.size, 3)
    assert.equal(JSON.parse(saved.getItem('visual-curator.gallery-cache.v3')!).writing, undefined)
  } finally { reloaded.dispose() }
})

test('refresh removes every page of its list while keeping unrelated cached lists available after reload', async () => {
  const saved = storage()
  let calls = 0
  const dependencies = { context: () => ({ ...context(), policy: { ...policy, maxPages: 5 } }), storage: saved, now: () => 1, read: async () => page(String(++calls)) }, signal = new AbortController().signal
  const cache = createGalleryCache(dependencies)
  await cache.read('gallery-collections', { accountId: 'a' }, signal)
  await cache.read('gallery-collections', { accountId: 'a', cursor: 'next' }, signal)
  await cache.read('gallery-collections', { accountId: 'b' }, signal)
  await cache.read('gallery-collections', { accountId: 'a' }, signal, { refresh: true })
  cache.dispose()
  const reloaded = createGalleryCache(dependencies)
  try {
    assert.deepEqual(await reloaded.read('gallery-collections', { accountId: 'b' }, signal), page('3'))
    assert.equal(calls, 4)
    assert.deepEqual(await reloaded.read('gallery-collections', { accountId: 'a', cursor: 'next' }, signal), page('5'))
  } finally { reloaded.dispose() }
})

test('identity changes, expiry and corrupt indexes clean persisted page records before a new read', async () => {
  const signal = new AbortController().signal
  for (const change of ['namespace', 'revision', 'account', 'expired', 'future', 'corrupt'] as const) {
    const saved = storage()
    let owner = context(), time = 1, calls = 0
    const dependencies = { context: () => owner, storage: saved, now: () => time, read: async () => page(String(++calls)) }
    const cache = createGalleryCache(dependencies)
    await cache.read('gallery-collections', {}, signal); cache.dispose()
    if (change === 'namespace') owner = { ...owner, namespace: 'profile-b' }
    if (change === 'revision') owner = { ...owner, revision: 'revision-b' }
    if (change === 'account') owner = { ...owner, accounts: [{ id: 'a', userId: 'owner-b', credentialRef: 'COOKIE_B' }] }
    if (change === 'expired') time = 101
    if (change === 'future') time = 0
    if (change === 'corrupt') saved.setItem('visual-curator.gallery-cache.v3', 'invalid JSON')
    const reloaded = createGalleryCache(dependencies)
    try {
      assert.deepEqual(await reloaded.read('gallery-collections', {}, signal), page('2'), change)
      assert.equal(saved.values.size, 2, change)
    } finally { reloaded.dispose() }
  }
})

test('byte ceilings still bound the cache when session storage is unavailable', async () => {
  let calls = 0
  const cache = createGalleryCache({ context: () => ({ ...context(), policy: { ...policy, maxBytes: 100 } }), read: async () => page(String(++calls)) })
  try {
    const signal = new AbortController().signal
    await cache.read('gallery-collections', {}, signal)
    await cache.read('gallery-collections', {}, signal)
    assert.equal(calls, 2)
  } finally { cache.dispose() }
})

test('disposing aborts pending source work and a late response cannot change persisted pages', async () => {
  const saved = storage()
  let finish!: (value: unknown) => void, sourceSignal!: AbortSignal
  const cache = createGalleryCache({ context, storage: saved, read: async (_operation, _args, signal) => { sourceSignal = signal; return await new Promise(resolve => { finish = resolve }) } })
  const reading = cache.read('gallery-collections', {}, new AbortController().signal)
  await Promise.resolve(); cache.dispose()
  assert.equal(sourceSignal.aborted, true)
  finish(page('late')); await reading
  assert.equal(saved.values.size, 0)
  await assert.rejects(cache.read('gallery-collections', {}, new AbortController().signal), { name: 'AbortError' })
})
