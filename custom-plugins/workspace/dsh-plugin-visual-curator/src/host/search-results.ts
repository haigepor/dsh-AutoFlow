/** Verified search deliverables are confined to the owner-selected task directory. */
import { createHash, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, open, readFile, realpath, stat, unlink } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import type { CuratorDomain } from '../domain/curator.ts'
import { contentDigest } from '../domain/repository.ts'
import type { AssetFiles } from '../media/index.ts'
import type { DomainActor } from '../shared/model.ts'
import { CuratorError } from '../shared/errors.ts'
import { specOf } from './runtime.ts'
import { z } from 'zod'

/** @param domain Authorized records. @param files Digest-verified private files. @param selectionId Final selection. @param actor Receiving Session. @returns Exact source-original bytes and MIME, never a preview. */
export async function originalSearchResult(domain: CuratorDomain, files: AssetFiles, selectionId: string, actor: DomainActor) {
  const selection = domain.require('selection', selectionId), run = domain.require('run', selection.runId), spec = specOf(run)
  if (run.owner.kind !== 'session' || run.owner.sessionId !== actor.sessionId || actor.profileId !== run.profileId || typeof spec.fixed.searchLaunchId !== 'string' || !z.object({ kind: z.literal('original') }).safeParse(spec.fixed.output).success || selection.qualification !== 'auto-qualified') throw new CuratorError('owner-denied', 'search-delivery', 'Only this launch Session can download its qualified original results.')
  const final = domain.require('assessment', selection.assessmentId)
  if (final.stage !== 'final' || final.runId !== run.id || final.imageVersionId !== selection.imageVersionId || final.technicalStatus !== 'completed' || final.verdict !== 'pass') throw new CuratorError('constraint-conflict', 'search-delivery', 'The result has no completed final qualification.')
  const { asset } = domain.authorizedImage(selection.imageVersionId, actor)
  if (!asset.originalBlob) throw new CuratorError('reference-unavailable', 'search-delivery', 'The source original is unavailable.')
  return { bytes: await files.read(asset.originalBlob), mime: asset.originalBlob.mime, digest: asset.originalBlob.digest }
}

function within(root: string, path: string) {
  const child = relative(root, path)
  if (!child || child === '..' || child.startsWith(`..${sep}`) || isAbsolute(child)) throw new CuratorError('owner-denied', 'search-delivery', 'The output directory is outside the selected Workspace.')
}
async function childDirectory(root: string, name: string) {
  const path = join(root, name)
  await mkdir(path).catch(async error => { if (error.code !== 'EEXIST') throw error })
  const info = await lstat(path), canonical = await realpath(path)
  if (info.isSymbolicLink() || !info.isDirectory() || resolve(canonical) !== resolve(path)) throw new CuratorError('owner-denied', 'search-delivery', 'The task directory is redirected or unavailable.')
  within(root, canonical)
  return canonical
}
async function exclusiveFile(path: string, bytes: Uint8Array) {
  const temporary = join(dirname(path), `.pending-${randomUUID()}`), file = await open(temporary, 'wx')
  try {
    await file.writeFile(bytes); await file.sync(); await file.close()
    // 先完成私有临时文件再原子发布，崩溃或磁盘写入失败不会留下半张可交付图片。
    try { await link(temporary, path) } catch (error) {
      if (!(error instanceof Error) || !('code' in error) || error.code !== 'EEXIST') throw error
      const info = await lstat(path)
      if (!info.isFile() || info.isSymbolicLink() || !Buffer.from(bytes).equals(await readFile(path))) throw new CuratorError('constraint-conflict', 'search-delivery', 'An existing task file differs; it has not been overwritten.')
    }
  } finally {
    await file.close(); await unlink(temporary)
  }
}

/** @param input Human-authorized launch and its Session-owned qualified results. @returns Completion after exclusive files and the durable delivery receipt; unrelated files are never replaced. */
export async function deliverSearchResults(input: { domain: CuratorDomain; files: AssetFiles; launchId: string; sessionId: string; workspace: { id: string; path: string; device: string; inode: string }; runId: string; original: boolean }): Promise<void> {
  const { domain, files, launchId, sessionId, workspace, runId } = input
  if (!/^[a-zA-Z0-9-]+$/.test(launchId)) throw new CuratorError('invalid-input', 'search-delivery', 'The task directory identity is invalid.')
  const run = domain.require('run', runId)
  if (run.owner.kind !== 'session' || run.owner.sessionId !== sessionId || specOf(run).fixed.searchLaunchId !== launchId) throw new CuratorError('owner-denied', 'search-delivery', 'The search belongs to another launch.')
  const selections = domain.repository.list('selection').filter(item => item.runId === runId && item.qualification === 'auto-qualified')
  if (!selections.length) return
  const canonical = await realpath(workspace.path)
  const identity = await stat(canonical)
  if (resolve(canonical) !== resolve(workspace.path) || String(identity.dev) !== workspace.device || String(identity.ino) !== workspace.inode) throw new CuratorError('owner-denied', 'search-delivery', 'The selected Workspace directory changed.')
  const parent = await childDirectory(canonical, '.visual-curator'), directory = await childDirectory(parent, launchId)
  const actor: DomainActor = { kind: 'agent', id: sessionId, sessionId, profileId: domain.profileId }, delivered = []
  for (const selection of selections) {
    const image = domain.authorizedImage(selection.imageVersionId, actor).image
    const resource = input.original ? await originalSearchResult(domain, files, selection.id, actor) : { bytes: await files.read(image.blob), mime: image.blob.mime, digest: image.blob.digest }
    if (createHash('sha256').update(resource.bytes).digest('hex') !== resource.digest) throw new CuratorError('reference-unavailable', 'search-delivery', 'The result bytes do not match the committed digest.')
    if (await realpath(directory) !== directory || await realpath(canonical) !== canonical) throw new CuratorError('owner-denied', 'search-delivery', 'The output directory changed during delivery.')
    const extension = resource.mime === 'image/jpeg' ? 'jpg' : resource.mime === 'image/webp' ? 'webp' : 'png', name = `${selection.id}.${extension}`
    await exclusiveFile(join(directory, name), resource.bytes)
    delivered.push({ selectionId: selection.id, imageVersionId: selection.imageVersionId, file: name, digest: resource.digest, bytes: resource.bytes.length })
  }
  const state = { workspaceId: workspace.id, directory, files: delivered }, aggregateId = `search-delivery:${launchId}:${runId}`, previous = domain.repository.manifest(aggregateId)
  if (previous?.state && contentDigest(previous.state) === contentDigest(state)) return
  await domain.repository.commit({ aggregateId, expectedRevision: previous?.revision ?? 0, operationId: `${aggregateId}:${contentDigest(state)}`, request: state, records: [], state })
}
