import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { activateFeature, removeFeature, status } from '../src/host/demo-managed-content.js'

const skill = 'dsh-demo-example'
const managed = root => join(root, '.managed-plugins', 'dsh-custom-plugin-demo')
const missing = path => assert.rejects(readFile(path), { code: 'ENOENT' })

async function home(t) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-demo-test-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('independent prompt and Skill leases preserve user files across profiles', async t => {
  const root = await home(t)
  await writeFile(join(root, 'AGENTS.md'), '# My rules\r\nKeep these.\r\n')
  await mkdir(join(root, 'skills', 'user-skill'), { recursive: true })
  await writeFile(join(root, 'skills', 'user-skill', 'SKILL.md'), 'User skill\n')
  const a = await activateFeature('prompt', join(root, 'a'), root)
  const b = await activateFeature('prompt', join(root, 'b'), root)
  const c = await activateFeature('skill', join(root, 'a'), root)
  const agents = join(root, 'AGENTS.md')
  const active = await readFile(agents, 'utf8')
  assert.equal(active.match(/dsh-custom-plugin-demo:prompt:begin/g)?.length, 1)
  await writeFile(agents, `${active}User added later.\n`)
  await a.dispose()
  assert.equal((await status(root)).prompt.users, 1)
  await b.dispose()
  assert.equal(await readFile(agents, 'utf8'), '# My rules\r\nKeep these.\r\nUser added later.\n')
  assert.equal((await status(root)).prompt.retained, true)
  assert.equal((await status(root)).skill.active, true)
  await c.dispose()
  await missing(join(root, 'skills', skill, 'SKILL.md'))
  assert.equal(await readFile(join(root, 'skills', 'user-skill', 'SKILL.md'), 'utf8'), 'User skill\n')
  assert.match(await readFile(join(managed(root), 'inactive', 'skills', skill, 'SKILL.md'), 'utf8'), /dsh-demo-example/)
})

test('inactive copies restore and removal requires all owners to stop', async t => {
  const root = await home(t)
  const profile = join(root, 'profile')
  const prompt = await activateFeature('prompt', profile, root)
  const skillLease = await activateFeature('skill', profile, root)
  await assert.rejects(removeFeature('prompt', root), /still in use/)
  await prompt.dispose()
  await skillLease.dispose()
  const inactivePrompt = join(managed(root), 'inactive', 'prompt.md')
  await writeFile(inactivePrompt, '<!-- dsh-custom-plugin-demo:prompt:begin -->\nCustom.\n<!-- dsh-custom-plugin-demo:prompt:end -->\n')
  const restored = await activateFeature('prompt', profile, root)
  assert.match(await readFile(join(root, 'AGENTS.md'), 'utf8'), /Custom\./)
  await restored.dispose()
  await removeFeature('prompt', root)
  await removeFeature('skill', root)
  await missing(inactivePrompt)
  await missing(join(managed(root), 'inactive', 'skills', skill, 'SKILL.md'))
})

test('collision, broken marker, and stale process keep ownership explicit', async t => {
  const root = await home(t)
  await mkdir(join(root, 'skills', skill), { recursive: true })
  await writeFile(join(root, 'skills', skill, 'SKILL.md'), 'User owned\n')
  await assert.rejects(activateFeature('skill', join(root, 'p'), root), /already exists/)
  assert.equal(await readFile(join(root, 'skills', skill, 'SKILL.md'), 'utf8'), 'User owned\n')
  const lease = await activateFeature('prompt', join(root, 'p'), root)
  const agents = join(root, 'AGENTS.md')
  const original = await readFile(agents, 'utf8')
  await writeFile(agents, original.replace('prompt:end', 'prompt:broken'))
  await assert.rejects(lease.dispose(), /markers/)
  assert.match(await readFile(agents, 'utf8'), /prompt:broken/)
  await writeFile(agents, original)
  const stateFile = join(managed(root), 'state.json')
  const state = JSON.parse(await readFile(stateFile, 'utf8'))
  state.leases.prompt[0].pid = 99999999
  await writeFile(stateFile, `${JSON.stringify(state)}\n`)
  const recovered = await status(root)
  assert.equal(recovered.prompt.active, false)
  assert.equal(recovered.prompt.retained, true)
  await missing(agents)
})
