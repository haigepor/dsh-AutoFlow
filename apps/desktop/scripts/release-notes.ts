/** Accumulate reviewed changes and bind published notes to the exact build commit. */
import { execFile } from 'node:child_process'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { valid } from 'semver'
import { DESKTOP_RELEASE_NOTE_CATEGORIES, parseDesktopReleaseNotes, type DesktopReleaseNotes } from '../src/update-release-notes.ts'

const run = promisify(execFile)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

/**
 * Read reviewed notes from the source commit recorded by packaging, never from a later worktree.
 * @param commit - Full immutable source commit.
 * @param version - Exact desktop build version.
 * @param repository - Local Git checkout; defaults to this repository.
 * @returns Parsed repository JSON; absent files and invalid notes reject publication.
 */
export async function readCommittedReleaseNotes(commit: string, version: string, repository = root): Promise<DesktopReleaseNotes> {
  if (!/^[a-f0-9]{40}$/u.test(commit) || valid(version) !== version) throw new Error('desktop release notes: invalid build identity')
  const { stdout } = await run('git', ['show', `${commit}:apps/desktop/release-notes/releases/${version}.json`],
    { cwd: repository, encoding: 'utf8', maxBuffer: 1024 * 1024, windowsHide: true })
  return parseDesktopReleaseNotes(JSON.parse(stdout), version)
}

/**
 * Render the same reviewed items for the public Release and standard updater metadata.
 * @param notes - Validated version-bound notes.
 * @param language - Chinese or English content.
 * @returns Grouped Markdown with plain text escaped.
 */
export function releaseNotesMarkdown(notes: DesktopReleaseNotes, language: 'en' | 'zh-CN'): string {
  const titles = language === 'zh-CN' ? ['新增功能', '体验优化', '问题修复', '其他变更'] : ['New features', 'Improvements', 'Bug fixes', 'Other changes']
  return DESKTOP_RELEASE_NOTE_CATEGORIES.flatMap((category, index) => {
    const items = notes.items.filter(item => item.category === category)
    return items.length === 0 ? [] : [`## ${titles[index]}\n\n${items.map(item => `- ${item.text[language].replace(/[\\`*_{}\[\]()<>]/gu, '\\$&')}`).join('\n')}`]
  }).join('\n\n')
}

/**
 * Consolidate unreleased fragments without deleting history or overwriting an existing version.
 * @param directory - Desktop release-notes directory.
 * @param version - Reviewed exact build version selected by the release owner.
 * @returns Path of the newly prepared manifest; committing it remains a separate action.
 */
export async function prepareReleaseNotes(directory: string, version: string): Promise<string> {
  if (valid(version) !== version) throw new Error('desktop release notes: select an exact SemVer build version')
  const releases = join(directory, 'releases')
  await mkdir(releases, { recursive: true })
  const released = new Set<string>()
  for (const name of await readdir(releases)) {
    if (!name.endsWith('.json')) continue
    const previous = parseDesktopReleaseNotes(JSON.parse(await readFile(join(releases, name), 'utf8')), name.slice(0, -5))
    for (const item of previous.items) released.add(item.id)
  }
  const items = []
  for (const name of (await readdir(join(directory, 'changes'))).sort()) {
    if (!name.endsWith('.json')) continue
    const item: unknown = JSON.parse(await readFile(join(directory, 'changes', name), 'utf8'))
    const note = parseDesktopReleaseNotes({ schemaVersion: 1, version, items: [item] }, version).items[0]!
    if (!released.has(note.id)) items.push(note)
  }
  const notes = parseDesktopReleaseNotes({ schemaVersion: 1, version, items }, version)
  const path = join(releases, `${version}.json`)
  await writeFile(path, `${JSON.stringify(notes, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  return path
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = process.argv[2] ?? ''
  const path = await prepareReleaseNotes(join(root, 'apps/desktop/release-notes'), version)
  process.stdout.write(`Prepared ${path}; review and commit before packaging.\n`)
}
