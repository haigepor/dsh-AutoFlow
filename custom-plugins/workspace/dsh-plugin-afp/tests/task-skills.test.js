import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireSkill, skillNames } from '../src/host/afp-skill-leases.js'
import { existsSync } from 'node:fs'

test('managed DSH Skills load checklist-first instructions and upgrade known versions without replacing user edits', async t => {
  const home = await mkdtemp(join(tmpdir(), 'afp-task-skills-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const revisions = JSON.parse(await readFile(new URL('../skills/managed-revisions.json', import.meta.url), 'utf8'))
  const expected = JSON.parse(await readFile(new URL('./fixtures/task-skills.expected.json', import.meta.url), 'utf8'))
  for (const skill of skillNames) {
    const args = { home, profile: join(home, 'profile'), skill, maxStateBytes: 2 ** 20 }
    const release = await acquireSkill(args)
    const path = join(home, 'skills', skill, 'SKILL.md')
    const current = await readFile(path, 'utf8')
    const section = current.match(/## DSH task tracking\r?\n([\s\S]+?)## DSH workflow/)
    assert.ok(section, skill)
    assert.equal(section[1].trim(), expected[skill], skill)
    const previous = await readFile(new URL(`./fixtures/skills-v0.1.1/${skill}/SKILL.md`, import.meta.url), 'utf8')
    const digest = createHash('sha256').update(previous.replaceAll('\r\n', '\n')).digest('hex')
    assert.ok(revisions[skill].includes(digest), `Known predecessor: ${skill}`)
    await writeFile(path, previous, 'utf8')
    const upgraded = await acquireSkill(args)
    assert.equal(await readFile(path, 'utf8'), current, skill)
    await upgraded()
    await writeFile(path, previous + '\nCustom checklist policy\n', 'utf8')
    const customized = await acquireSkill(args)
    assert.equal(await readFile(path, 'utf8'), previous + '\nCustom checklist policy\n', skill)
    await customized(); await release()
  }
})

test('managed reference files upgrade independently while customized instructions and references survive reload', async t => {
  const home = await mkdtemp(join(tmpdir(), 'afp-managed-files-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const skill = 'afp-core-visual-triage', args = { home, profile: join(home, 'profile'), skill, maxStateBytes: 2 ** 20 }
  const release = await acquireSkill(args)
  const root = join(home, 'skills', skill), reference = join(root, 'references', 'vision-contract.md'), customized = join(root, 'references', 'category-rubric.md')
  const old = await readFile(new URL(`./fixtures/skills-v0.1.1/${skill}/references/vision-contract.md`, import.meta.url), 'utf8')
  await writeFile(reference, old, 'utf8')
  await writeFile(join(root, 'SKILL.md'), 'Custom instructions\n', 'utf8')
  await writeFile(customized, 'Custom visual criteria\n', 'utf8')
  await release()
  const again = await acquireSkill(args)
  assert.equal(await readFile(reference, 'utf8'), await readFile(new URL(`../skills/${skill}/references/vision-contract.md`, import.meta.url), 'utf8'))
  assert.equal(await readFile(join(root, 'SKILL.md'), 'utf8'), 'Custom instructions\n')
  assert.equal(await readFile(customized, 'utf8'), 'Custom visual criteria\n')
  await again()
})

const repo = new URL('../../../../', import.meta.url)
test('a fresh DSH filesystem catalog discovers and loads all six managed Skills from an isolated Home',
  { skip: !existsSync(new URL('packages/skill/skill-filesystem/lib/index.js', repo)) }, async t => {
    const home = await mkdtemp(join(tmpdir(), 'afp-skill-catalog-'))
    const { Context } = await import(new URL('vendor/cordis/lib/index.js', repo))
    const { default: Registry } = await import(new URL('packages/skill/skill/lib/index.js', repo))
    const Filesystem = await import(new URL('packages/skill/skill-filesystem/lib/index.js', repo))
    const ctx = new Context(), releases = []
    t.after(async () => { await ctx.fiber.dispose(); for (const release of releases.reverse()) await release(); await rm(home, { recursive: true, force: true }) })
    for (const skill of skillNames) releases.push(await acquireSkill({ home, profile: join(home, 'profile'), skill, maxStateBytes: 2 ** 20 }))
    await ctx.plugin(Registry)
    await ctx.plugin(Filesystem, { includeDefaultRoots: false, customSkillDirs: [join(home, 'skills')], watch: false })
    assert.deepEqual((await ctx.skills.list({ cwd: home })).map(item => item.name).sort(), [...skillNames].sort())
    for (const skill of skillNames) {
      const loaded = await ctx.skills.get(skill, { cwd: home })
      assert.match(loaded.content, /todo_write/)
      assert.match(loaded.content, /without create_goal/)
      assert.match(loaded.content, /photo attempts stay bounded across resumes/)
    }
  })
