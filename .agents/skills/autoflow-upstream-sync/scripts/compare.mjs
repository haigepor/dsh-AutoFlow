/** Read-only Git inventory for an explicitly selected AutoFlow release comparison. */
import { execFileSync } from 'node:child_process'
import { parseArgs } from 'node:util'

const { values } = parseArgs({ options: {
  local: { type: 'string' }, mirror: { type: 'string' }, old: { type: 'string' }, target: { type: 'string' },
}, allowPositionals: false })

/** Run Git without a shell; output is data, never another command. */
function git(...args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 }).trimEnd()
}

/** Resolve a supplied ref to a commit, refusing arguments that Git could parse as options. */
function commit(ref) {
  if (!ref || ref.startsWith('-')) throw new Error('Supply non-option refs for --local, --mirror, --old, and --target')
  return git('rev-parse', '--verify', `${ref}^{commit}`)
}

/** Return complete changed paths relative to a pinned commit. */
function changed(base, head) {
  const output = git('diff', '--name-status', '--no-renames', base, head)
  return output === '' ? [] : output.split('\n').map(line => {
    const index = line.indexOf('\t')
    return { status: line.slice(0, index), path: line.slice(index + 1) }
  })
}

try {
  const local = commit(values.local), mirror = commit(values.mirror)
  const old = commit(values.old), target = commit(values.target)
  if (mirror !== target) throw new Error('Mirror differs from the selected official target; preserve the old ref and verify the remote before repair')
  for (const head of [local, target]) {
    if (git('merge-base', old, head) !== old) throw new Error('Old official baseline is not an ancestor of both selected heads')
  }
  const officialChanges = changed(old, target), localChanges = changed(old, local)
  const localPaths = new Set(localChanges.map(row => row.path))
  const overlap = officialChanges.filter(row => localPaths.has(row.path)).map(row => row.path)
  const visualCandidates = officialChanges.filter(row => /\.(css|tsx)$/.test(row.path)).map(row => row.path)
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    repository: git('rev-parse', '--show-toplevel'),
    refs: { local: values.local, mirror: values.mirror, old: values.old, target: values.target },
    commits: { local, mirror, old, target, mergeBase: git('merge-base', local, target) },
    remoteVerified: false,
    workingTree: git('status', '--short', '--untracked-files=normal'),
    officialCommitCount: Number(git('rev-list', '--count', `${old}..${target}`)),
    counts: { official: officialChanges.length, local: localChanges.length, overlap: overlap.length },
    officialChanges, localChanges, overlap, visualCandidates,
  }, null, 2) + '\n')
} catch (error) {
  process.stderr.write(`autoflow-upstream-sync: ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
}
