import test from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { acquireSkill, skillNames } from '../src/host/afp-skill-leases.js'

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
    const previous = current.replace(/## DSH task tracking\r?\n[\s\S]+?(?=## DSH workflow)/, '')
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
