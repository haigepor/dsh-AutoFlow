import { randomBytes, randomUUID } from 'node:crypto'
import { access, link, lstat, open, unlink } from 'node:fs/promises'
import { basename, join, resolve } from 'node:path'
import { cleanFilenamePart, downloadFilenameBase } from '../shared/afp-download-filenames.js'

const photoIdPattern = /^[^\u0000-\u001f\u007f]{1,256}$/
const recordStatuses = new Set(['queued', 'running', 'completed', 'partial', 'failed', 'cancelled', 'interrupted'])
const failureCodes = new Set(['download-auth-unavailable', 'download-photo-unavailable', 'download-no-renditions',
  'download-balance-unavailable', 'download-insufficient-credit', 'download-picker-unavailable', 'download-directory-expired',
  'download-options-expired', 'download-confirmation-expired', 'download-write-disabled', 'download-account-changed',
  'download-task-failed', 'download-cancelled'])

function failure(code) { return Object.assign(new Error(code), { code }) }

/** Return only fixed download failure codes; raw AFP/OS messages remain in the Host.
 * @param {Error} error Operation failure.
 * @returns {string|null} Safe code when explicitly tagged by this service.
 */
export function downloadErrorCode(error) { return failureCodes.has(error?.code) ? error.code : null }

async function readBalance(readAccountProfile, signal) {
  try { return (await readAccountProfile()).credit }
  catch (error) { signal.throwIfAborted(); return null }
}

function assertPhotoId(value) {
  if (typeof value !== 'string' || !photoIdPattern.test(value)) throw new Error('Invalid AFP photo ID')
  return value
}

function renditionDto(photo, media) {
  const key = typeof media?.mediaKey === 'string' && media.mediaKey ? media.mediaKey : null
  const cost = Number(media?.cost)
  if (!key || !Number.isFinite(cost) || cost < 0) return null
  return {
    id: randomBytes(18).toString('base64url'), expiresAt: Date.now() + 10 * 60_000,
    photoId: assertPhotoId(String(photo?.id ?? photo?.uno ?? '')),
    guid: typeof photo?.guid === 'string' && photo.guid ? photo.guid : null,
    title: typeof photo?.title === 'string' ? photo.title : String(photo?.id ?? photo?.uno ?? ''),
    mediaKey: key, href: typeof media.href === 'string' && media.href ? media.href : null,
    validateOrderId: typeof media.validateOrderId === 'string' && media.validateOrderId ? media.validateOrderId : null,
    label: [media.name, media.role].filter(value => typeof value === 'string' && value.trim()).join(' · ')
      || String(media.renditionType ?? 'AFP media'),
    cost, width: Number.isSafeInteger(Number(media.width)) && Number(media.width) > 0 ? Number(media.width) : null,
    height: Number.isSafeInteger(Number(media.height)) && Number(media.height) > 0 ? Number(media.height) : null,
    sizeInBytes: Number.isSafeInteger(Number(media.sizeInBytes)) && Number(media.sizeInBytes) >= 0 ? Number(media.sizeInBytes) : null,
    payable: media.payable !== false, viewOnly: media.isViewOnly === true,
    renditionType: typeof media.renditionType === 'string' ? media.renditionType : '',
  }
}

function dto(row) {
  const alreadyAvailable = Boolean(row.href)
  const canPurchase = !alreadyAvailable && row.cost > 0 && row.payable && !row.viewOnly
  return { id: row.id, photoId: row.photoId, title: row.title, quality: row.label,
    fileNameBase: downloadFilenameBase(row),
    width: row.width, height: row.height, sizeInBytes: row.sizeInBytes, cost: row.cost,
    purchaseCost: canPurchase ? row.cost : 0, alreadyAvailable,
    available: alreadyAvailable || canPurchase, disabledReason: row.viewOnly ? 'view-only' : row.payable ? null : 'not-payable' }
}

function sameQuote(left, right) {
  return left.photoId === right.photoId && left.mediaKey === right.mediaKey && left.cost === right.cost
    && left.label === right.label && left.width === right.width && left.height === right.height
    && left.sizeInBytes === right.sizeInBytes && Boolean(left.href) === Boolean(right.href)
    && left.payable === right.payable && left.viewOnly === right.viewOnly
}

function requestedBase(row, prefix, suffix) {
  return downloadFilenameBase({ fileName: row.responseName, guid: row.guid, photoId: row.photoId }, prefix, suffix)
}

function responseFileName(response) {
  const value = response.headers.get('content-disposition') ?? ''
  const encoded = value.match(/filename\*=UTF-8''([^;]+)/i)?.[1]
  if (encoded) {
    try { return decodeURIComponent(encoded.replace(/^"|"$/g, '')).slice(0, 1024) || null } catch (error) { /* Invalid encoded filenames fall back to the stable photo identifier. */ }
  }
  const plain = value.match(/filename="?([^";]+)"?/i)?.[1]
  return plain ? plain.slice(0, 1024) || null : null
}

function imageFormat(header) {
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) return { extension: '.jpg', contentType: 'image/jpeg' }
  if (header.length >= 8 && header[0] === 137 && header[1] === 80 && header[2] === 78 && header[3] === 71
    && header[4] === 13 && header[5] === 10 && header[6] === 26 && header[7] === 10) return { extension: '.png', contentType: 'image/png' }
  if (header.length >= 12 && String.fromCharCode(...header.slice(0, 4)) === 'RIFF'
    && String.fromCharCode(...header.slice(8, 12)) === 'WEBP') return { extension: '.webp', contentType: 'image/webp' }
  if (header.length >= 6 && /^GIF8[79]a$/.test(String.fromCharCode(...header.slice(0, 6)))) return { extension: '.gif', contentType: 'image/gif' }
  return null
}

async function writeAll(file, bytes) {
  let offset = 0
  while (offset < bytes.byteLength) {
    const { bytesWritten } = await file.write(bytes, offset, bytes.byteLength - offset)
    if (!bytesWritten) throw new Error('download-write-failed')
    offset += bytesWritten
  }
}

async function streamImage(response, directory, base, maxBytes, signal, prefix, suffix) {
  if (!response.ok || !response.body?.getReader) {
    await response.body?.cancel()
    throw new Error(`delivery-http-${response.status}`)
  }
  const declared = Number(response.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body.cancel()
    throw new Error('image-too-large')
  }
  const reader = response.body.getReader()
  const tempPath = join(directory, `.afp-${randomUUID()}.part`)
  const handle = await open(tempPath, 'wx', 0o600)
  let total = 0
  const header = new Uint8Array(12)
  let headerLength = 0
  try {
    while (true) {
      signal.throwIfAborted()
      const { done, value } = await reader.read()
      if (done) break
      const chunk = value instanceof Uint8Array ? value : new Uint8Array(value)
      total += chunk.byteLength
      if (total > maxBytes) throw new Error('image-too-large')
      const readLength = Math.min(header.byteLength - headerLength, chunk.byteLength)
      if (readLength > 0) { header.set(chunk.subarray(0, readLength), headerLength); headerLength += readLength }
      await writeAll(handle, chunk)
    }
    const format = imageFormat(header.subarray(0, headerLength))
    if (!format) throw new Error('invalid-image-signature')
    await handle.sync()
    await handle.close()
    const sourceName = responseFileName(response)
    const stem = sourceName ? downloadFilenameBase({ fileName: sourceName }, prefix, suffix) : base
    let index = 0
    while (true) {
      signal.throwIfAborted()
      const name = `${stem}${index === 0 ? '' : ` (${index})`}${format.extension}`
      const target = join(directory, name)
      try {
        await link(tempPath, target)
        await unlink(tempPath)
        return { fileName: name, sizeInBytes: total, contentType: format.contentType }
      } catch (error) {
        if (error.code !== 'EEXIST') throw error
        index++
      }
    }
  } catch (error) {
    await reader.cancel(error).catch(() => {})
    await handle.close().catch(() => {})
    await unlink(tempPath).catch(failure => { if (failure.code !== 'ENOENT') throw failure })
    throw error
  } finally {
    reader.releaseLock()
  }
}

/** Host-only quote plans and streamed AFP downloads; secrets and signed URLs never leave this class. */
/** Coordinate Host-only AFP rendition quotes, purchases, file transfers and persisted task status.
 * @remarks Destination paths, media keys and signed URLs remain in memory. Stored outcomes contain only photo metadata and basenames.
 */
export class AfpDownloads {
  /** Create the downloader for one AFP profile.
   * @param {object} dependencies Host services and the profile state store.
   * @param {object} dependencies.ctx Composed Host capabilities, including the directory picker.
   * @param {object} dependencies.config Validated AFP deployment settings.
   * @param {object} dependencies.connection AFP authenticated connection factory.
   * @param {object} dependencies.store Profile-owned AFP state store.
   * @param {Function} dependencies.schedule Profile job scheduler.
   * @param {Function} dependencies.requireFeature AFP feature gate.
   */
  constructor({ ctx, config, connection, store, schedule, requireFeature }) {
    this.ctx = ctx
    this.config = config
    this.connection = connection
    this.store = store
    this.schedule = schedule
    this.requireFeature = requireFeature
    this.directories = new Map()
    this.renditions = new Map()
    this.quoteSnapshots = new Map()
    this.plans = new Map()
    this.active = new Set()
    this.persistChains = new Map()
  }

  prune() {
    const now = Date.now()
    for (const [key, value] of this.renditions) if (value.expiresAt <= now) this.renditions.delete(key)
    for (const [key, value] of this.quoteSnapshots) if (value.expiresAt <= now) this.quoteSnapshots.delete(key)
    for (const [key, value] of this.plans) if (value.expiresAt <= now) this.plans.delete(key)
    for (const [key, value] of this.directories) if (value.expiresAt <= now) this.directories.delete(key)
  }

  async options({ photoIds }, signal) {
    this.prune()
    if (!Array.isArray(photoIds) || !photoIds.length || photoIds.length > 120) throw new Error('Select 1..120 AFP photos')
    const ids = [...new Set(photoIds.map(assertPhotoId))]
    let connection
    try { connection = await this.connection.open(signal) }
    catch (error) { signal.throwIfAborted(); throw failure('download-auth-unavailable') }
    const { client, account, readAccountProfile } = connection
    const creditBalance = await readBalance(readAccountProfile, signal)
    const photos = []
    for (const id of ids) {
      signal.throwIfAborted()
      let photo
      try { photo = await client.downloadPhotoDetails(id) }
      catch (error) { signal.throwIfAborted(); photos.push({ id, renditions: [], errorCode: 'download-photo-unavailable' }); continue }
      if (!photo || String(photo.id ?? photo.uno ?? '') !== id) {
        photos.push({ id, renditions: [], errorCode: 'download-photo-unavailable' }); continue
      }
      const media = Array.isArray(photo.downloadableMedias) ? photo.downloadableMedias : []
      const renditions = media.map(item => renditionDto(photo, item)).filter(Boolean)
      for (const row of renditions) {
        row.account = account
        this.renditions.set(row.id, row)
        this.quoteSnapshots.set(row.id, { balance: creditBalance, row: { ...row }, expiresAt: row.expiresAt })
      }
      photos.push({ id, guid: typeof photo.guid === 'string' ? photo.guid : null, title: String(photo.title ?? id), renditions: renditions.map(dto),
        errorCode: renditions.some(row => dto(row).available) ? null : 'download-no-renditions' })
    }
    return { photos, creditBalance, creditError: creditBalance === null ? 'download-balance-unavailable' : null }
  }

  /** List the configured browse backend without exposing a write destination token.
   * @param {object} input Optional absolute Host directory.
   * @param {AbortSignal} signal Request cancellation.
   * @returns {Promise<object>} Backend-owned directory listing.
   */
  async browseDirectory({ path } = {}, signal) {
    const capability = this.ctx.directoryPicker?.capability?.()
    if (capability?.kind !== 'browse') throw failure('download-picker-unavailable')
    if (path !== undefined && (typeof path !== 'string' || !path.trim() || path.length > 4096)) throw new Error('Invalid Host directory')
    return capability.list(path, signal)
  }

  async pickDirectory(signal, { path: requested } = {}) {
    const capability = this.ctx.directoryPicker?.capability?.()
    let selected
    if (capability?.kind === 'browse') {
      if (requested === undefined) return { browse: true }
      // 路径由浏览后端核验并规范化；下载计划仍只接受 Host 缓存的目录 ID。
      selected = (await this.browseDirectory({ path: requested }, signal)).path
    } else if (capability?.kind === 'native') {
      if (requested !== undefined) throw new Error('Native picker requires its own selection')
      selected = await capability.pick(signal)
    } else throw failure('download-picker-unavailable')
    if (!selected) return null
    signal.throwIfAborted()
    const path = resolve(selected)
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Choose a real directory on the AFP Host')
    await access(path)
    const id = randomBytes(24).toString('base64url')
    this.directories.set(id, { path, expiresAt: Date.now() + this.config.planTtlMs })
    return { directoryId: id, label: basename(path) || path }
  }

  dispose() {
    this.directories.clear()
    this.renditions.clear()
    this.quoteSnapshots.clear()
    this.plans.clear()
  }

  async refreshedRows(selected, signal) {
    const byPhoto = new Map()
    const { client, account, readAccountProfile } = await this.connection.open(signal)
    if (selected.some(item => item.account !== account)) throw failure('download-account-changed')
    const balance = await readBalance(readAccountProfile, signal)
    for (const item of selected) {
      signal.throwIfAborted()
      let photo = byPhoto.get(item.photoId)?.photo
      if (!photo) {
        photo = await client.downloadPhotoDetails(item.photoId)
        if (!photo || String(photo.id ?? photo.uno ?? '') !== item.photoId) throw failure('download-photo-unavailable')
        byPhoto.set(item.photoId, { photo, media: new Map((photo.downloadableMedias ?? []).map(media => [media.mediaKey, media])) })
      }
      const media = byPhoto.get(item.photoId).media.get(item.mediaKey)
      const fresh = media && renditionDto(photo, media)
      if (!fresh || !dto(fresh).available) throw failure('download-no-renditions')
      Object.assign(fresh, { id: item.id, account, expiresAt: Date.now() + 10 * 60_000 })
      byPhoto.get(item.photoId).media.set(item.mediaKey, fresh)
      item.fresh = fresh
    }
    return { balance, byPhoto }
  }

  async createPlan({ items, directoryId, prefix = '', suffix = '' }, signal, previous = null) {
    this.prune()
    if (!Array.isArray(items) || !items.length || items.length > 120
      || items.some(item => !item || typeof item.renditionId !== 'string' || typeof item.photoId !== 'string')) throw new Error('Invalid AFP download selection')
    if (typeof prefix !== 'string' || prefix.length > 80 || typeof suffix !== 'string' || suffix.length > 80) throw new Error('Invalid filename prefix or suffix')
    const directory = this.directories.get(directoryId)
    if (!directory || directory.expiresAt <= Date.now()) throw failure('download-directory-expired')
    const directoryInfo = await lstat(directory.path)
    if (!directoryInfo.isDirectory() || directoryInfo.isSymbolicLink()) throw new Error('Choose a real AFP Host directory')
    await access(directory.path)
    const selected = items.map(item => {
      const row = this.renditions.get(item.renditionId)
      if (!row || row.photoId !== item.photoId || row.expiresAt <= Date.now()) throw failure('download-options-expired')
      if (!dto(row).available) throw failure('download-no-renditions')
      return { ...row }
    })
    if (new Set(selected.map(item => item.photoId)).size !== selected.length) throw new Error('Choose only one rendition per image')
    const { balance, byPhoto } = await this.refreshedRows(selected, signal)
    const changed = previous
      ? previous.balance !== balance || selected.some((row, index) => !sameQuote(previous.items[index], row.fresh))
      : selected.some(row => {
        const snapshot = this.quoteSnapshots.get(row.id)
        return snapshot && (snapshot.balance !== balance || !sameQuote(snapshot.row, row.fresh))
      })
    const updatedRows = selected.map(row => {
      const id = randomBytes(18).toString('base64url')
      const fresh = { ...row.fresh, id, expiresAt: Date.now() + 10 * 60_000 }
      this.renditions.set(id, fresh)
      return fresh
    })
    const totalCost = updatedRows.reduce((sum, row) => sum + dto(row).purchaseCost, 0)
    if (changed) return this.changedQuote(updatedRows, { balance, byPhoto })
    if (totalCost > 0 && balance === null) throw failure('download-balance-unavailable')
    if (totalCost > 0 && totalCost > balance) throw failure('download-insufficient-credit')
    const confirmation = randomBytes(32).toString('hex')
    const planId = randomUUID()
    const expiresAt = Date.now() + Math.min(this.config.planTtlMs, 10 * 60_000)
    const plan = { planId, confirmation, expiresAt, account: updatedRows[0].account, items: updatedRows, directory: directory.path,
      prefix: cleanFilenamePart(prefix, 80), suffix: cleanFilenamePart(suffix, 80), balance, totalCost }
    this.plans.set(planId, plan)
    return { changed: false, planId, confirmation, expiresAt, creditBalance: balance, totalCost,
      items: updatedRows.map(row => ({ ...dto(row), fileNamePreview: requestedBase(row, plan.prefix, plan.suffix) })) }
  }

  changedQuote(updatedRows, { balance, byPhoto }) {
      for (const row of updatedRows) {
        row.id = randomBytes(18).toString('base64url')
        row.expiresAt = Date.now() + 10 * 60_000
        this.renditions.set(row.id, row)
      }
      const totalCost = updatedRows.reduce((sum, row) => sum + dto(row).purchaseCost, 0)
      const selectedIds = new Map(updatedRows.map(row => [`${row.photoId}\0${row.mediaKey}`, row.id]))
      const photos = [...byPhoto].map(([photoId, { photo }]) => ({
        id: photoId, guid: typeof photo.guid === 'string' ? photo.guid : null, title: String(photo.title ?? photoId),
        renditions: (Array.isArray(photo.downloadableMedias) ? photo.downloadableMedias : []).map(media => {
          const selectedId = selectedIds.get(`${photoId}\0${media.mediaKey}`)
          const prior = selectedId ? this.renditions.get(selectedId) : null
          const row = renditionDto(photo, media)
          if (!row) return null
          row.account = updatedRows.find(selected => selected.photoId === photoId).account
          row.id = prior?.id ?? randomBytes(18).toString('base64url')
          row.expiresAt = Date.now() + 10 * 60_000
          this.renditions.set(row.id, row)
          return dto(row)
        }).filter(Boolean),
      }))
      return { changed: true, creditBalance: balance, totalCost, photos,
      selected: updatedRows.map(row => ({ photoId: row.photoId, renditionId: row.id })) }
  }

  async prepare(input, signal) {
    return this.createPlan(input, signal)
  }

  async confirm({ planId, confirmation, confirmed }, signal) {
    const plan = this.plans.get(planId)
    if (confirmed !== true || !plan || plan.confirmation !== confirmation || plan.expiresAt <= Date.now()) throw failure('download-confirmation-expired')
    this.plans.delete(planId)
    if (plan.totalCost > 0) {
      try { this.requireFeature('write') }
      catch (error) { throw failure('download-write-disabled') }
    }
    const selected = plan.items.map(row => ({ ...row }))
    const refreshed = await this.refreshedRows(selected, signal)
    const changed = plan.balance !== refreshed.balance || selected.some(row => !sameQuote(row, row.fresh))
    if (changed) {
      // 使用已发现变化的同一次快照，避免再次读取使变化消失或返回不同响应字段。
      return { requiresReconfirmation: true, ...this.changedQuote(selected.map(row => row.fresh), refreshed) }
    }
    for (const row of selected) {
      row.href = row.fresh.href
      row.validateOrderId = row.fresh.validateOrderId
      delete row.fresh
    }
    const record = { schema: 1, id: randomUUID(), createdAt: Date.now(), updatedAt: Date.now(), status: 'queued',
      total: selected.length, completed: 0, failed: 0, pending: 0, items: selected.map(row => ({ photoId: row.photoId,
        title: row.title.slice(0, 200), rendition: row.label.slice(0, 120), status: 'queued', fileName: null, errorCode: null })) }
    await this.enqueuePersist(record)
    this.active.add(record.id)
    const feature = plan.totalCost > 0 ? 'write' : 'read'
    try {
      const job = this.schedule(feature, 'AFP image download', (taskSignal, handle) => this.execute(record, selected, plan, taskSignal, handle))
      record.jobId = job.jobId
      record.taskId = job.taskId
      record.updatedAt = Date.now()
      await this.enqueuePersist(record)
      return { queued: true, downloadId: record.id, jobId: job.jobId, taskId: job.taskId }
    } catch (error) {
      this.active.delete(record.id)
      record.status = 'failed'; record.failed = record.total; record.updatedAt = Date.now()
      record.items.forEach(item => { item.status = 'failed'; item.errorCode = 'job-start-failed' })
      await this.enqueuePersist(record)
      throw failure(downloadErrorCode(error) ?? (signal.aborted ? 'download-cancelled' : 'download-task-failed'))
    }
  }

  findDirectoryId(path) {
    for (const [id, value] of this.directories) if (value.path === path) return id
    const id = randomBytes(24).toString('base64url')
    this.directories.set(id, { path, expiresAt: Date.now() + this.config.planTtlMs })
    return id
  }

  async execute(record, selected, plan, signal, handle) {
    record.status = 'running'; record.updatedAt = Date.now(); await this.enqueuePersist(record)
    let client
    try {
      const destinationInfo = await lstat(plan.directory)
      if (!destinationInfo.isDirectory() || destinationInfo.isSymbolicLink()) throw new Error('download-directory-unavailable')
      await access(plan.directory)
      const paid = plan.totalCost > 0
      const connection = await this.connection.open(signal, paid)
      if (connection.account !== plan.account) throw failure('download-account-changed')
      client = connection.client
      let next = 0, settled = 0
      const worker = async () => {
        while (true) {
          const index = next++
          if (index >= selected.length) return
          const row = selected[index], item = record.items[index]
          if (signal.aborted) { item.status = 'cancelled'; settled++; record.cancelled = (record.cancelled ?? 0) + 1; await this.enqueuePersist(record); continue }
          item.status = 'running'; record.updatedAt = Date.now(); await this.enqueuePersist(record)
          let purchaseUnresolved = false
          try {
            let delivery = row.href
            if (!delivery && row.cost > 0) {
              purchaseUnresolved = true
              try {
                const result = await client.buyPhoto({ id: row.photoId, cost: row.cost, mediaKeys: [row.mediaKey] })
                if (!result.accepted) throw new Error('AFP purchase was not accepted')
                const refreshedPhoto = await client.downloadPhotoDetails(row.photoId)
                const refreshed = (refreshedPhoto?.downloadableMedias ?? []).find(media => media.mediaKey === row.mediaKey)
                delivery = typeof refreshed?.href === 'string' ? refreshed.href : ''
                if (!delivery) throw new Error('AFP delivery URL is unavailable after purchase')
                purchaseUnresolved = false
              } catch (error) {
                // The purchase may have reached AFP even when its response or delivery lookup failed.
                throw new Error('purchase-pending')
              }
            }
            if (!delivery) throw new Error('delivery-unavailable')
            let saved, lastError
            for (let attempt = 0; attempt <= this.config.readRetries; attempt++) {
              signal.throwIfAborted()
              try {
                const response = await client.downloadMedia(delivery, this.config.maxRedirects, this.config.requestTimeoutMs, signal)
                saved = await streamImage(response, plan.directory, requestedBase(row, plan.prefix, plan.suffix),
                  this.config.maxDownloadBytes, signal, plan.prefix, plan.suffix)
                break
              } catch (error) {
                lastError = error
                if (signal.aborted || attempt >= this.config.readRetries) break
                // Downloads may refresh an expired signed link. A paid purchase is never repeated here.
                const retryConnection = await this.connection.open(signal)
                if (retryConnection.account !== plan.account) throw failure('download-account-changed')
                const readClient = retryConnection.client
                const photo = await readClient.downloadPhotoDetails(row.photoId)
                const media = (photo?.downloadableMedias ?? []).find(value => value.mediaKey === row.mediaKey)
                if (typeof media?.href !== 'string' || !media.href) break
                delivery = media.href
              }
            }
            if (!saved) throw lastError ?? new Error('delivery-unavailable')
            item.status = 'completed'; item.fileName = saved.fileName; item.errorCode = null; record.completed++
          } catch (error) {
            const message = String(error?.message ?? error)
            item.status = purchaseUnresolved || message.includes('purchase-pending') ? 'pending' : signal.aborted ? 'cancelled' : 'failed'
            item.errorCode = purchaseUnresolved || message.includes('purchase-pending') ? 'purchase-pending' : message.includes('image-too-large') ? 'image-too-large'
              : message.includes('invalid-image-signature') ? 'invalid-image-signature' : signal.aborted ? 'cancelled' : 'download-failed'
            if (item.status === 'pending') record.pending++
            else if (item.status === 'cancelled') record.cancelled = (record.cancelled ?? 0) + 1
            else record.failed++
          }
          settled++
          record.updatedAt = Date.now()
          await this.enqueuePersist(record)
          handle.updateProgress(JSON.stringify({ phase: 'download', completed: settled, total: selected.length }))
        }
      }
      const results = await Promise.allSettled(Array.from({ length: Math.min(this.config.downloadConcurrency, selected.length) }, worker))
      const failedWorker = results.find(result => result.status === 'rejected')
      if (failedWorker) throw failedWorker.reason
      record.status = record.pending ? 'partial' : record.failed ? record.completed ? 'partial' : 'failed'
        : record.cancelled ? record.completed ? 'partial' : 'cancelled' : 'completed'
      return { status: record.status, downloadId: record.id, completed: record.completed, failed: record.failed,
        pending: record.pending, cancelled: record.cancelled ?? 0 }
    } catch (error) {
      for (const item of record.items) {
        if (item.status === 'queued' || item.status === 'running') {
          item.status = signal.aborted ? 'cancelled' : 'failed'
          item.errorCode = signal.aborted ? 'cancelled' : 'download-task-failed'
          if (signal.aborted) record.cancelled = (record.cancelled ?? 0) + 1
          else record.failed++
        }
      }
      record.status = signal.aborted ? record.completed || record.pending ? 'partial' : 'cancelled'
        : record.completed || record.pending ? 'partial' : 'failed'
      throw failure(downloadErrorCode(error) ?? (signal.aborted ? 'download-cancelled' : 'download-task-failed'))
    } finally {
      record.updatedAt = Date.now()
      await this.enqueuePersist(record)
      this.active.delete(record.id)
    }
  }

  enqueuePersist(record) {
    const snapshot = JSON.parse(JSON.stringify(record))
    const prior = this.persistChains.get(record.id) ?? Promise.resolve()
    const next = prior.catch(() => {}).then(() => this.store.saveDownload(snapshot))
    this.persistChains.set(record.id, next)
    return next
  }

  async status() {
    const records = await this.store.readDownloads(20)
    for (const record of records) {
      if (recordStatuses.has(record.status) && ['queued', 'running'].includes(record.status) && !this.active.has(record.id)) {
        record.status = 'interrupted'; record.updatedAt = Date.now()
        for (const item of record.items) if (['queued', 'running'].includes(item.status)) {
          item.status = 'failed'; item.errorCode = 'host-stopped'; record.failed++
        }
        await this.store.saveDownload(record)
      }
    }
    return records.map(record => ({ id: record.id, taskId: record.taskId ?? null, jobId: record.jobId ?? null,
      createdAt: record.createdAt, updatedAt: record.updatedAt, status: record.status,
      total: record.total, completed: record.completed, failed: record.failed, pending: record.pending,
      cancelled: record.cancelled ?? 0, items: record.items.map(item => ({ ...item })) }))
  }
}
