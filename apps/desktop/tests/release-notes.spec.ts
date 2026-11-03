/** Reviewed fragments, immutable build-source reads and bounded feed notes. */
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, onTestFinished } from 'vitest'
import { prepareReleaseNotes, readCommittedReleaseNotes, releaseNotesMarkdown } from '../scripts/release-notes.ts'
import { parseDesktopReleaseNotes } from '../src/update-release-notes.ts'

const item = { id: 'download-progress', category: 'improvements', text: { en: 'Show measured byte progress.', 'zh-CN': '显示真实字节进度。' } }
async function directory(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'desktop-notes-'))
  onTestFinished(async () => { await rm(root, { recursive: true, force: true }) })
  return root
}

it('consolidates unreleased bilingual items and retains the daily records', async () => {
  const root = await directory()
  await mkdir(join(root, 'changes'))
  await writeFile(join(root, 'changes/progress.json'), JSON.stringify(item), 'utf8')
  const path = await prepareReleaseNotes(root, '1.2.3-alpha.1')
  expect(JSON.parse(await readFile(path, 'utf8'))).toEqual({ schemaVersion: 1, version: '1.2.3-alpha.1', items: [item] })
  expect(JSON.parse(await readFile(join(root, 'changes/progress.json'), 'utf8'))).toEqual(item)
  await expect(prepareReleaseNotes(root, '1.2.3-alpha.1')).rejects.toThrow()
  await expect(prepareReleaseNotes(root, '1.2.3-alpha.2')).rejects.toThrow('release notes')
})

it('uses the packaged source commit even when the checkout has later note edits', async () => {
  const root = await directory()
  const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true }).trim()
  git('init', '--quiet')
  const releases = join(root, 'apps/desktop/release-notes/releases')
  await mkdir(releases, { recursive: true })
  const file = join(releases, '1.2.3.json')
  const notes = { schemaVersion: 1, version: '1.2.3', items: [item] }
  await writeFile(file, JSON.stringify(notes), 'utf8')
  git('add', 'apps')
  git('-c', 'user.name=Release fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Fixture notes')
  const commit = git('rev-parse', 'HEAD')
  await writeFile(file, '{}', 'utf8')
  expect(await readCommittedReleaseNotes(commit, '1.2.3', root)).toEqual(notes)
  await expect(readCommittedReleaseNotes(commit, '1.2.4', root)).rejects.toThrow()
})

it('rejects duplicate identities, unreviewed text and oversized external notes', () => {
  for (const items of [[item, item], [{ ...item, text: { en: 'TBD', 'zh-CN': '待补充' } }],
    [{ ...item, text: { en: 'x'.repeat(601), 'zh-CN': '中文说明。' } }]]) {
    expect(() => parseDesktopReleaseNotes({ schemaVersion: 1, version: '1.2.3', items }, '1.2.3')).toThrow('release notes')
  }
  const notes = parseDesktopReleaseNotes({ schemaVersion: 1, version: '1.2.3', items: [item] }, '1.2.3')
  expect(releaseNotesMarkdown(notes, 'zh-CN')).toBe('## 体验优化\n\n- 显示真实字节进度。')
})
