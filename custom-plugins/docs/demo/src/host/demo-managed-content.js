import { randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, open, readFile, readdir, rename, rmdir, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const NAME = 'dsh-custom-plugin-demo'
const SKILL = 'dsh-demo-example'
const BEGIN = `<!-- ${NAME}:prompt:begin -->`
const END = `<!-- ${NAME}:prompt:end -->`
const PACKAGE = fileURLToPath(new URL('../../', import.meta.url))
const UTF8 = new TextDecoder('utf-8', { fatal: true })

function paths(home) {
  const root = join(home, '.managed-plugins', NAME)
  return {
    home, root, state: join(root, 'state.json'), lock: join(root, 'lock'),
    agents: join(home, 'AGENTS.md'), activeSkill: join(home, 'skills', SKILL),
    inactivePrompt: join(root, 'inactive', 'prompt.md'),
    inactiveSkill: join(root, 'inactive', 'skills', SKILL),
  }
}

async function stat(path) {
  try { return await lstat(path) }
  catch (error) {
    if (error.code === 'ENOENT') return undefined
    throw error
  }
}

async function fileText(path) {
  const info = await stat(path)
  if (info === undefined) return undefined
  if (!info.isFile()) throw new Error(`Refusing non-file: ${path}`)
  try { return UTF8.decode(await readFile(path)) }
  catch { throw new Error(`Refusing non-UTF-8 file: ${path}`) }
}

async function directoryOrAbsent(path) {
  const info = await stat(path)
  if (info !== undefined && !info.isDirectory()) throw new Error(`Refusing non-directory: ${path}`)
  return info
}

async function atomicText(path, value) {
  await directoryOrAbsent(dirname(path))
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const temp = join(dirname(path), `.${randomUUID()}.tmp`)
  try {
    const previous = await stat(path)
    await writeFile(temp, value, { flag: 'wx', mode: previous?.mode ?? 0o600 })
    await rename(temp, path)
  } finally {
    if (await stat(temp)) await unlink(temp)
  }
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true }
  catch (error) { return error.code !== 'ESRCH' }
}

async function withLock(p, operation) {
  await directoryOrAbsent(p.home)
  await directoryOrAbsent(join(p.home, '.managed-plugins'))
  await directoryOrAbsent(p.root)
  await mkdir(p.root, { recursive: true, mode: 0o700 })
  let handle
  for (let attempt = 0; attempt < 200; attempt++) {
    try { handle = await open(p.lock, 'wx', 0o600); break }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      const owner = await fileText(p.lock)
      // The owner may still be writing the lock record after creating the file.
      if (owner === '' || owner === undefined) {
        await new Promise(done => setTimeout(done, 50))
        continue
      }
      let pid
      try { pid = JSON.parse(owner).pid }
      catch { throw new Error(`Unrecognized plugin lock: ${p.lock}`) }
      if (!alive(pid)) {
        try { await unlink(p.lock) }
        catch (failure) { if (failure.code !== 'ENOENT') throw failure }
        continue
      }
      await new Promise(done => setTimeout(done, 50))
    }
  }
  if (handle === undefined) throw new Error(`Timed out waiting for plugin lock: ${p.lock}`)
  try {
    await handle.writeFile(JSON.stringify({ pid: process.pid }))
    return await operation()
  } finally {
    await handle.close()
    try { await unlink(p.lock) }
    catch (error) { if (error.code !== 'ENOENT') throw error }
  }
}

function emptyState() {
  return { schema: 2, active: { prompt: false, skill: false }, leases: { prompt: [], skill: [] },
    promptPrefix: '', createdAgents: false }
}

async function readState(p) {
  const content = await fileText(p.state)
  if (content === undefined) return emptyState()
  const value = JSON.parse(content)
  if (value?.schema !== 2 || typeof value.active?.prompt !== 'boolean' || typeof value.active?.skill !== 'boolean'
    || !Array.isArray(value.leases?.prompt) || !Array.isArray(value.leases?.skill)
    || !['', '\n', '\r\n'].includes(value.promptPrefix) || typeof value.createdAgents !== 'boolean') {
    throw new Error(`Invalid plugin state: ${p.state}`)
  }
  for (const feature of ['prompt', 'skill']) {
    if (!value.leases[feature].every(lease => typeof lease?.id === 'string'
      && Number.isSafeInteger(lease.pid) && typeof lease.profile === 'string')) {
      throw new Error(`Invalid plugin lease: ${p.state}`)
    }
  }
  return value
}

async function saveState(p, state) { await atomicText(p.state, `${JSON.stringify(state, null, 2)}\n`) }

function findBlock(text) {
  const begin = text.indexOf(BEGIN)
  const end = text.indexOf(END)
  if (begin < 0 || end < begin || text.indexOf(BEGIN, begin + BEGIN.length) >= 0
    || text.indexOf(END, end + END.length) >= 0) throw new Error('Managed prompt markers are missing or duplicated')
  const finish = end + END.length + (text.slice(end + END.length).startsWith('\r\n') ? 2
    : text.slice(end + END.length).startsWith('\n') ? 1 : 0)
  return { begin, finish, content: text.slice(begin, finish) }
}

async function enablePrompt(p, state) {
  const before = await fileText(p.agents)
  if (before?.includes(BEGIN) || before?.includes(END)) throw new Error('Unowned managed prompt markers already exist')
  let block = await fileText(p.inactivePrompt)
  if (block === undefined) {
    const fragment = (await fileText(join(PACKAGE, 'assets', 'AGENTS.fragment.md')))?.trim()
    if (!fragment) throw new Error('The packaged prompt is empty')
    block = `${BEGIN}\n${fragment}\n${END}\n`
  }
  findBlock(block)
  if (!block.startsWith(BEGIN) || block.trimEnd().endsWith(END) === false) {
    throw new Error('Invalid inactive prompt block')
  }
  const newline = before?.includes('\r\n') ? '\r\n' : '\n'
  state.promptPrefix = before && !before.endsWith('\n') ? newline : ''
  state.createdAgents = before === undefined
  await atomicText(p.agents, `${before ?? ''}${state.promptPrefix}${block}`)
  if (await stat(p.inactivePrompt)) await unlink(p.inactivePrompt)
}

async function parkPrompt(p, state) {
  const before = await fileText(p.agents)
  if (before === undefined) throw new Error('Managed AGENTS.md disappeared')
  const block = findBlock(before)
  const prefixStart = block.begin - state.promptPrefix.length
  if (prefixStart < 0 || before.slice(prefixStart, block.begin) !== state.promptPrefix) {
    throw new Error('Managed prompt separator changed')
  }
  const inactive = await fileText(p.inactivePrompt)
  if (inactive !== undefined && inactive !== block.content) throw new Error('Inactive prompt conflicts with active content')
  if (inactive === undefined) await atomicText(p.inactivePrompt, block.content)
  const updated = before.slice(0, prefixStart) + before.slice(block.finish)
  if (updated === '' && state.createdAgents) await unlink(p.agents)
  else await atomicText(p.agents, updated)
}

async function enableSkill(p) {
  await directoryOrAbsent(join(p.home, 'skills'))
  if (await stat(p.activeSkill)) throw new Error(`Skill directory already exists: ${p.activeSkill}`)
  await mkdir(dirname(p.activeSkill), { recursive: true, mode: 0o700 })
  const inactive = await directoryOrAbsent(p.inactiveSkill)
  if (inactive) await rename(p.inactiveSkill, p.activeSkill)
  else await cp(join(PACKAGE, 'skills', SKILL), p.activeSkill, { recursive: true, force: false, errorOnExist: true })
}

async function parkSkill(p) {
  if (!await directoryOrAbsent(p.activeSkill)) throw new Error(`Managed Skill disappeared: ${p.activeSkill}`)
  if (await stat(p.inactiveSkill)) throw new Error('Inactive Skill already exists')
  await mkdir(dirname(p.inactiveSkill), { recursive: true, mode: 0o700 })
  await rename(p.activeSkill, p.inactiveSkill)
}

async function park(p, state, feature) {
  if (!state.active[feature]) return
  if (feature === 'prompt') await parkPrompt(p, state)
  else await parkSkill(p)
  state.active[feature] = false
}

async function reconcile(p, state) {
  for (const feature of ['prompt', 'skill']) {
    state.leases[feature] = state.leases[feature].filter(lease => alive(lease.pid))
    if (state.leases[feature].length === 0) await park(p, state, feature)
  }
  await saveState(p, state)
}

async function deleteDirectory(path) {
  const info = await stat(path)
  if (info === undefined) return
  if (!info.isDirectory()) { await unlink(path); return }
  for (const entry of await readdir(path)) await deleteDirectory(join(path, entry))
  await rmdir(path)
}

/** Resolve the same DSH_HOME override as the launcher. */
export function resolveHome(env = process.env) {
  const value = env.DSH_HOME?.trim()
  const selected = value ? value : join(homedir(), '.dsh')
  return resolve(selected === '~' ? homedir() : selected.startsWith('~/') || selected.startsWith('~\\')
    ? join(homedir(), selected.slice(2)) : selected)
}

/** Acquire one profile's lease and expose only the selected content. */
export async function activateFeature(feature, profile, home = resolveHome()) {
  if (!['prompt', 'skill'].includes(feature) || !isAbsolute(profile) || !isAbsolute(home)) throw new Error('Invalid feature or profile path')
  const p = paths(home), id = randomUUID()
  await withLock(p, async () => {
    const state = await readState(p)
    await reconcile(p, state)
    if (!state.active[feature]) {
      if (feature === 'prompt') await enablePrompt(p, state)
      else await enableSkill(p)
      state.active[feature] = true
    }
    state.leases[feature].push({ id, pid: process.pid, profile })
    await saveState(p, state)
  })
  return { dispose: async () => withLock(p, async () => {
    const state = await readState(p)
    state.leases[feature] = state.leases[feature].filter(lease => lease.id !== id)
    await reconcile(p, state)
  }) }
}

/** Report effective global content and inactive copies. */
export async function status(home = resolveHome()) {
  const p = paths(home)
  return withLock(p, async () => {
    const state = await readState(p)
    await reconcile(p, state)
    return {
      prompt: { active: state.active.prompt, users: state.leases.prompt.length, retained: !!await stat(p.inactivePrompt), path: p.agents },
      skill: { active: state.active.skill, users: state.leases.skill.length, retained: !!await stat(p.inactiveSkill), path: p.activeSkill },
    }
  })
}

/** Permanently remove one inactive copy after every profile has released it. */
export async function removeFeature(feature, home = resolveHome()) {
  if (!['prompt', 'skill'].includes(feature)) throw new Error('Invalid feature')
  const p = paths(home)
  return withLock(p, async () => {
    const state = await readState(p)
    await reconcile(p, state)
    if (state.leases[feature].length > 0) throw new Error(`Feature is still in use: ${feature}`)
    if (feature === 'prompt') {
      if (await stat(p.inactivePrompt)) await unlink(p.inactivePrompt)
    } else await deleteDirectory(p.inactiveSkill)
    return { removed: feature }
  })
}
