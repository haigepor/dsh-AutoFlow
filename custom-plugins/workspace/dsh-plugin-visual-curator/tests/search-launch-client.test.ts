import assert from 'node:assert/strict'
import { test } from 'node:test'
import { createSearchLaunchStore } from '../src/client/search-launch-store.ts'
import { randomUUID } from 'node:crypto'

const draft = () => ({ operationId: randomUUID(), workspaceId: 'photos', modelProfileId: 'profile', taskBrief: 'Muted green photos.', targetCount: 10, output: { kind: 'original' as const } })
const view = (input: ReturnType<typeof draft>) => ({ id: input.operationId, input, sessionId: 'native-session', status: 'accepted', stage: 'accepted', createdAt: '2026-10-29T00:00:00Z', updatedAt: '2026-10-29T00:00:00Z', runIds: [], qualified: 0 })

test('a lost acknowledgement retains launch input and retry identity without navigating to an unsent draft', async () => {
  const input = draft(), ids: unknown[] = [], opened: string[] = []
  let fail = true
  const store = createSearchLaunchStore({ context: () => ({ scope: 1, styleId: 'style', pollMs: 60000 }), openSession: id => opened.push(id), invoke: async (operation, args) => {
    if (operation === 'search-launch-start') { ids.push(args.operationId); if (fail) { fail = false; throw new Error('lost ack') } return view(input) }
    return []
  } })
  try {
    await store.start(input)
    assert.equal(store.getSnapshot().submission?.status, 'unknown')
    assert.deepEqual(store.getSnapshot().submission?.input, input)
    await store.start(store.getSnapshot().submission!.input)
    assert.deepEqual(ids, [input.operationId, input.operationId]); assert.equal(store.getSnapshot().submission, null)
    assert.deepEqual(opened, [])
    store.openSession(store.getSnapshot().entries[0]!.sessionId); assert.deepEqual(opened, ['native-session'])
  } finally { store.dispose() }
})

test('scoped late acknowledgement and stale lists never restore another collection’s launch', async () => {
  let scope = 1, styleId = 'first', resolve!: (value: unknown) => void
  const input = draft(), pending = new Promise<unknown>(done => { resolve = done })
  const store = createSearchLaunchStore({ context: () => ({ scope, styleId, pollMs: 60000 }), openSession: () => {}, invoke: async operation => operation === 'search-launch-start' ? pending : [] })
  try {
    store.sync(); const submission = store.start(input)
    scope++; styleId = 'second'; store.sync(); resolve(view(input)); await submission
    assert.deepEqual(store.getSnapshot().entries, []); assert.equal(store.getSnapshot().submission, null)
  } finally { store.dispose() }
})

test('preparation observes real Workspace choices and stops only the selected launch', async () => {
  const input = draft(), commands: string[] = []
  const store = createSearchLaunchStore({ context: () => ({ scope: 1, styleId: 'style', pollMs: 60000 }), openSession: () => {}, invoke: async (operation, args) => {
    if (operation === 'search-launch-options') return { workspaces: [{ id: 'photos', title: 'Photos', path: 'D:/Photos' }], defaultTargetCount: 10, maxTargetCount: 200 }
    if (operation === 'search-launch-start') return view(input)
    if (operation === 'search-launch-stop') { commands.push(String(args.id)); return { ...view(input), stage: 'stopped', status: 'stopped' } }
    return []
  } })
  try {
    await store.loadOptions(); assert.equal(store.getSnapshot().options?.workspaces[0]?.path, 'D:/Photos')
    await store.start(input); await store.stop(input.operationId)
    assert.deepEqual(commands, [input.operationId]); assert.equal(store.getSnapshot().entries[0]?.status, 'stopped')
  } finally { store.dispose() }
})

test('size presets load from their paginated source instead of the lightweight image snapshot', async () => {
  const cursors: unknown[] = []
  const store = createSearchLaunchStore({ context: () => ({ scope: 1, styleId: 'style', pollMs: 60000 }), openSession: () => {}, invoke: async (_operation, args) => {
    cursors.push(args.usagePageToken)
    return { workspaces: [], usages: [{ usageRevisionId: args.usagePageToken ? 'portrait' : 'landscape', name: 'Preset', targetWidth: 400, targetHeight: 200 }], ...(args.usagePageToken ? {} : { usagePageToken: 'next-presets' }), defaultTargetCount: 10, maxTargetCount: 200 }
  } })
  try {
    await store.loadOptions(); await store.loadOptions(true)
    assert.deepEqual(cursors, [undefined, 'next-presets'])
    assert.deepEqual(store.getSnapshot().options?.usages.map(item => item.usageRevisionId), ['landscape', 'portrait'])
  } finally { store.dispose() }
})

test('switching collections inside the same Session discards an older launch acknowledgement', async () => {
  let styleId = 'first', resolve!: (value: unknown) => void
  const input = draft(), pending = new Promise<unknown>(done => { resolve = done })
  const store = createSearchLaunchStore({ context: () => ({ scope: 1, styleId, pollMs: 60000 }), openSession: () => {}, invoke: async operation => operation === 'search-launch-start' ? pending : [] })
  try {
    store.sync(); const submission = store.start(input)
    styleId = 'second'; store.sync(); resolve(view(input)); await submission
    assert.deepEqual(store.getSnapshot().entries, []); assert.equal(store.getSnapshot().submission, null)
  } finally { store.dispose() }
})
