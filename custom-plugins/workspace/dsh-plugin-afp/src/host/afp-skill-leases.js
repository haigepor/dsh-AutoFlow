import { createHash, randomUUID } from 'node:crypto'
import { cp, lstat, mkdir, readFile, rename, writeFile, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Store } from './afp-state-store.js'

export const skillNames = ['afp-core-news-search', 'afp-core-search-collections', 'afp-core-visual-triage', 'afp-curation-animals', 'afp-curation-landscape', 'afp-curation-celestial-wallpaper']
const source = fileURLToPath(new URL('../../skills/', import.meta.url))
async function stat(path) { try { return await lstat(path) } catch (error) { if (error.code === 'ENOENT') return null; throw error } }
async function directory(path) {
  const info = await stat(path)
  if (info && !info.isDirectory()) throw new Error(`AFP refuses linked or non-directory Skill paths: ${path}`)
  return info
}
function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1) throw new Error('Invalid AFP Skill holder')
  try { process.kill(pid, 0); return true } catch (error) { return error.code !== 'ESRCH' }
}

/** One Skill's cross-profile content lease. User edits follow the inactive copy on stop/restart. */
export async function acquireSkill({ home, profile, skill, maxStateBytes }) {
  if (!skillNames.includes(skill)) throw new Error('Unknown AFP Skill')
  const store = new Store(home, profile, maxStateBytes)
  const root = join(store.root, 'skills', skill), statePath = join(root, 'state.json')
  const active = join(home, 'skills', skill), inactive = join(root, 'inactive'), marker = '.dsh-afp-owner.json'
  const holder = { id: randomUUID(), pid: process.pid, profile }
  async function upgradeManagedInstructions(path) {
    const owned = await store.read(join(path, marker))
    const revisions = JSON.parse(await readFile(join(source, 'managed-revisions.json'), 'utf8'))
    const files = JSON.parse(await readFile(join(source, 'managed-file-revisions.json'), 'utf8'))[skill]
    if (!files || typeof files !== 'object') throw new Error('Missing AFP managed file revisions')
    const digest = text => createHash('sha256').update(text.replaceAll('\r\n', '\n')).digest('hex')
    const fileDigests = { ...(owned.fileDigests ?? {}) }
    for (const [relative, known] of Object.entries(files)) {
      if (relative !== 'SKILL.md' && !/^references\/[a-z0-9-]+\.md$/.test(relative)
        || !Array.isArray(known) || known.some(hash => !/^[a-f0-9]{64}$/.test(hash))) throw new Error('Invalid AFP managed file path or revisions')
      const parts = relative.split('/')
      for (let count = 1; count < parts.length; count++) {
        const parent = join(path, ...parts.slice(0, count))
        if (!await directory(parent)) await mkdir(parent, { mode: 0o700 })
      }
      const file = join(path, ...parts), info = await stat(file)
      if (info && (!info.isFile() || info.size > maxStateBytes)) throw new Error('Unsafe AFP managed Skill file')
      const next = await readFile(join(source, skill, ...parts), 'utf8'), nextDigest = digest(next)
      const current = info ? await readFile(file, 'utf8') : null
      const currentDigest = current === null ? null : digest(current)
      const recorded = fileDigests[relative] ?? (relative === 'SKILL.md' ? owned.instructionsDigest : undefined)
      const predecessors = relative === 'SKILL.md' ? [...known, ...(revisions[skill] ?? [])] : known
      // 每个文件单独判定所有权；自定义主说明不阻止未改写参考文件升级。
      if (current !== null && currentDigest !== nextDigest && recorded !== currentDigest && !predecessors.includes(currentDigest)) continue
      if (currentDigest !== nextDigest) {
        const temporary = file + '.' + randomUUID() + '.tmp'
        try { await writeFile(temporary, next, { flag: 'wx', mode: 0o600 }); await rename(temporary, file) }
        finally { try { await unlink(temporary) } catch (error) { if (error.code !== 'ENOENT') throw error } }
      }
      fileDigests[relative] = nextDigest
    }
    await store.write(join(path, marker), { ...owned, fileDigests, ...(fileDigests['SKILL.md'] ? { instructionsDigest: fileDigests['SKILL.md'] } : {}) })
  }
  async function state() {
    if (!await stat(statePath)) return { schema: 1, owned: false, leases: [], phase: 'inactive' }
    const value = await store.read(statePath)
    if (typeof value.owned !== 'boolean' || !Array.isArray(value.leases) || !['active', 'inactive', 'activating', 'parking'].includes(value.phase)
      || value.leases.some(item => typeof item.id !== 'string' || typeof item.profile !== 'string' || !Number.isSafeInteger(item.pid) || item.pid < 1)) throw new Error('Invalid AFP Skill lease state')
    return value
  }
  async function verify(path) {
    if (!await directory(path)) return false
    const markerPath = join(path, marker)
    if (!(await stat(markerPath))?.isFile()) throw new Error('AFP Skill ownership marker missing')
    const owner = JSON.parse(await readFile(markerPath, 'utf8'))
    if (owner.schema !== 1 || owner.package !== 'dsh-plugin-afp' || owner.skill !== skill) throw new Error('AFP Skill ownership conflict')
    return true
  }
  async function reconcile(value) {
    // 每次管理操作均检查扫描目录，拒绝用户替换为链接后的跨目录移动。
    await directory(home); await directory(join(home, 'skills'))
    value.leases = value.leases.filter(item => alive(item.pid))
    const current = await directory(active), saved = await directory(inactive)
    if (current && !value.owned && value.phase === 'activating') { await verify(active); value.owned = true }
    if (current && !value.owned) throw new Error('Refusing to overwrite an existing user Skill')
    if (value.owned && current) await verify(active)
    if (saved) await verify(inactive)
    if (current && saved) throw new Error('Conflicting active and retained AFP Skill copies')
    if (value.owned && !current && !saved) throw new Error('Managed AFP Skill disappeared; inspect its lease state')
    if (!current && value.leases.length) throw new Error('Active AFP Skill holder has no content')
    if (current && !value.leases.length) {
      value.phase = 'parking'; await store.write(statePath, value)
      await mkdir(root, { recursive: true, mode: 0o700 })
      await rename(active, inactive)
    }
    value.phase = value.leases.length ? 'active' : 'inactive'
    await store.write(statePath, value)
  }
  await store.lock(`skill:${skill}`, async () => {
    const value = await state()
    await reconcile(value)
    if (!await directory(active)) {
      await directory(home); await directory(join(home, 'skills'))
      await mkdir(dirname(active), { recursive: true, mode: 0o700 })
      value.phase = 'activating'; await store.write(statePath, value)
      if (await directory(inactive)) await rename(inactive, active)
      else {
        // 先复制到私有区再移动，复制失败不会在 Skill 扫描位置留下半成品。
        await cp(join(source, skill), inactive, { recursive: true, force: false, errorOnExist: true })
        await store.write(join(inactive, marker), { schema: 1, package: 'dsh-plugin-afp', skill })
        await rename(inactive, active)
      }
      value.owned = true
    }
    await upgradeManagedInstructions(active)
    value.leases.push(holder); value.phase = 'active'
    await store.write(statePath, value)
  })
  let released = false
  return async () => {
    if (released) return
    await store.lock(`skill:${skill}`, async () => {
      const value = await state(); value.leases = value.leases.filter(item => item.id !== holder.id)
      await reconcile(value)
    })
    released = true
  }
}
