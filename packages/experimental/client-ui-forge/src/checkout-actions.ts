/** Local checkout status and explicit Git writes under the Session's permissions. */

import type { Context } from '@deepseek-ai/cordis'
import type { Session } from '@deepseek-ai/dsh-session'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import { gitIn, type GitConfig, type Inspection } from './git.ts'
import type { ForgeGitFile, ForgeGitStatus, ForgeGitTarget } from './types.ts'
import { within } from './worktree.ts'

/** Read NUL-delimited porcelain v1, whose rename destination precedes its original path. */
function changedFiles(text: string): ForgeGitFile[] {
  const records = text.split('\0')
  const files: ForgeGitFile[] = []
  for (let i = 0; i < records.length - 1; i++) {
    const record = records[i] as string
    const index = record[0] as string
    const worktree = record[1] as string
    const renamed = index === 'R' || index === 'C' || worktree === 'R' || worktree === 'C'
    files.push({
      path: record.slice(3), originalPath: renamed ? records[++i] as string : null, index, worktree,
      conflicted: index === 'U' || worktree === 'U' || (index === 'A' && worktree === 'A') || (index === 'D' && worktree === 'D'),
    })
  }
  return files
}

/**
 * Read changed files and locally known tracking counts without fetching or changing the index.
 * @param ctx - filesystem, subprocess, and sandbox services.
 * @param config - Git query limits.
 * @param session - Session whose execution world and permissions apply.
 * @param inspection - checkout inspected in the Session's current directory.
 * @param signal - cancellation.
 * @returns working-tree status and whether its metadata can be written.
 */
export async function checkoutStatus(
  ctx: Context, config: GitConfig, session: Session, inspection: Inspection, signal: AbortSignal,
): Promise<ForgeGitStatus> {
  const root = inspection.checkout.root
  const git = gitIn(ctx, config, session, root, signal)
  const files = await git('status', ['status', '--porcelain=v1', '-z', '--untracked-files=all'])
  const head = await git('head', ['rev-parse', '--verify', '--quiet', 'HEAD'], [0, 1])
  const counts = inspection.upstream === null || head.exitCode !== 0 ? null
    : (await git('tracking', ['rev-list', '--left-right', '--count', 'HEAD...@{upstream}'])).stdout.trim().split(/\s+/).map(Number)
  const policy = ctx.sandboxPolicy.resolve({ session })
  const writableRoot = policy.mode === 'workspace-write'
    ? ctx.fs.processPath(await ctx.fs.resolve(policy.workspaceRoot, { signal })) : null
  return {
    root, branch: inspection.checkout.branch, head: head.exitCode === 0 ? head.stdout.trim() : null,
    files: changedFiles(files.stdout), upstream: inspection.upstream,
    ahead: counts === null ? null : counts[0] as number, behind: counts === null ? null : counts[1] as number,
    remotes: inspection.remotes.map(remote => remote.name),
    blocker: policy.mode === 'read-only' ? 'read-only'
      : writableRoot !== null && (!within(writableRoot, root) || !within(writableRoot, inspection.commonDir)) ? 'outside-writable-root' : null,
  }
}

/**
 * Reject writes against another checkout or against HEAD/branch values the user did not inspect.
 * @param status - freshly read status under the write reservation.
 * @param target - identity displayed to the user.
 */
export function checkGitTarget(status: ForgeGitStatus, target: ForgeGitTarget): void {
  if (status.blocker !== null) throw new RemoteError('forgePanel/git-read-only', 'The Session cannot write this checkout and its Git directory', {})
  if (status.root !== target.root || status.branch !== target.branch || status.head !== target.head) {
    throw new RemoteError('forgePanel/git-stale', 'The checkout or branch changed; refresh before trying again', {})
  }
}

/**
 * Commit the complete current contents of selected changed files, retaining unrelated staged files.
 * Failed hooks can leave the selected files staged; no rollback discards their contents.
 * @param ctx - execution services.
 * @param config - write timeout and output limits.
 * @param session - Session whose permissions apply.
 * @param status - freshly checked working-tree state.
 * @param paths - selected changed paths, using each rename's destination.
 * @param message - nonempty commit message.
 * @param signal - cancellation.
 */
export async function commitFiles(
  ctx: Context, config: GitConfig, session: Session, status: ForgeGitStatus, paths: readonly string[], message: string, signal: AbortSignal,
): Promise<void> {
  if (message.trim() === '' || message.includes('\0') || paths.length === 0 || status.files.some(file => file.conflicted)) {
    throw new RemoteError('forgePanel/git-invalid', 'Select changed files, enter a commit message, and resolve conflicts before committing', {})
  }
  const selected = status.files.filter(file => paths.includes(file.path))
  if (selected.length !== new Set(paths).size) throw new RemoteError('forgePanel/git-invalid', 'The selected files changed; refresh before committing', {})
  const names = [...new Set(selected.flatMap(file => file.originalPath !== null && (file.index === 'R' || file.worktree === 'R')
    ? [file.originalPath, file.path] : [file.path]))]
  // A staged deletion or rename has already removed its old path from the index, so `add` cannot name it again.
  const stage = [...new Set(selected.flatMap(file => file.index === 'D' && file.worktree === ' ' ? []
    : file.worktree === 'R' && file.originalPath !== null ? [file.originalPath, file.path] : [file.path]))]
  const git = gitIn(ctx, config, session, status.root, signal, 'write')
  if (stage.length > 0) await git('add', ['add', '--all', '--', ...stage])
  await git('commit', ['commit', '--only', '-m', message, '--', ...names])
}

/**
 * Push only the inspected HEAD to one selected remote, establishing its upstream without force or tag pushes.
 * @param ctx - execution services.
 * @param config - write limits.
 * @param session - Session whose permissions apply.
 * @param status - freshly checked working-tree state.
 * @param remote - one of the checkout's configured remotes.
 * @param signal - cancellation.
 */
export async function pushBranch(
  ctx: Context, config: GitConfig, session: Session, status: ForgeGitStatus, remote: string, signal: AbortSignal,
): Promise<void> {
  if (status.branch === null || status.head === null || !status.remotes.includes(remote)) {
    throw new RemoteError('forgePanel/git-invalid', 'Push requires a committed branch and a configured remote', {})
  }
  const destination = status.upstream?.startsWith(`${remote}/`) === true ? status.upstream.slice(remote.length + 1) : status.branch
  const git = gitIn(ctx, config, session, status.root, signal, 'write')
  await git('push', ['push', '--porcelain', '--no-follow-tags', '--set-upstream', '--', remote, `HEAD:refs/heads/${destination}`])
}

/**
 * Switch a clean checkout to an existing local branch. Git refuses branches occupied by other worktrees.
 * @param ctx - execution services.
 * @param config - write limits.
 * @param session - Session whose permissions apply.
 * @param status - freshly checked working-tree state.
 * @param branch - exact local branch name.
 * @param signal - cancellation.
 */
export async function switchBranch(
  ctx: Context, config: GitConfig, session: Session, status: ForgeGitStatus, branch: string, signal: AbortSignal,
): Promise<void> {
  if (status.files.length > 0) throw new RemoteError('forgePanel/git-invalid', 'Commit or otherwise handle uncommitted changes before switching branches', {})
  const git = gitIn(ctx, config, session, status.root, signal, 'write')
  const found = await git('branch', ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], [0, 1])
  if (found.exitCode !== 0) throw new RemoteError('forgePanel/git-invalid', 'The selected local branch no longer exists', {})
  await git('switch', ['switch', '--no-guess', '--', branch])
}
