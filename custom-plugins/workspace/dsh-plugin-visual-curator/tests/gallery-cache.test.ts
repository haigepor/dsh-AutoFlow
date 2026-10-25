/** Account metadata cache retains no authorization input and never reuses another identity's listing. */
import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { createGalleryCache } from '../src/client/gallery-cache.ts'

const policy = { ttlMs: 100, maxPages: 2, maxBytes: 10000 }
const page = (id: string) => ({ items: [{ id, title: id, description: '', private: false, totalPhotos: 2 }], nextCursor: null })
const context = () => ({ namespace: 'profile-a', revision: 'revision-a', accounts: [{ id: 'a', userId: 'owner-a', credentialRef: 'COOKIE_A' }], policy })
const storage = () => { const values = new Map<string,string>(); return { values, getItem: (key:string) => values.get(key) ?? null, setItem: (key:string,value:string) => { values.set(key,value) }, removeItem: (key:string) => { values.delete(key) } } }
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
  const saved=storage(); saved.values.set('visual-curator.gallery-cache.v1','invalid JSON')
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
