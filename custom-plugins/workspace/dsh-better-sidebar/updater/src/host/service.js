/** Profile-owned updater state; the shared manager owns installation and rollback. */
import { mkdir, lstat, readFile, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { PACKAGE, discoverRelease, readBytes, verifyArchiveIntegrity } from './source.js'

/** One cancellable updater per active profile. */
export class SidebarUpdater {
  constructor(ctx, config) {
    this.ctx = ctx
    this.config = config
    this.abort = new AbortController()
    this.operation = undefined
    this.state = { status: 'unchecked', currentVersion: undefined, latestVersion: undefined, restartRequired: false }
  }

  async read() {
    const bundles = await this.ctx.pluginManager.listBundles()
    const bundle = bundles.find(item => item.name === PACKAGE)
    if (!bundle?.version) throw new Error('sidebar-unavailable')
    const pending = this.ctx.pluginManager.managedUpdateStatus(PACKAGE)
    if (pending) this.state = { ...this.state, ...pending, status: 'restart-required' }
    this.state.currentVersion ??= bundle.version
    return { ...this.state, installedVersion: bundle.version, pollIntervalMs: this.config.pollIntervalMs }
  }

  run(operation) {
    if (operation === 'read') return this.read()
    if (operation !== 'check' && operation !== 'install') return Promise.reject(new Error('unknown-operation'))
    if (this.operation) {
      if (operation === 'install') return Promise.reject(new Error('busy'))
      return this.operation
    }
    const task = this.perform(operation).finally(() => { if (this.operation === task) this.operation = undefined })
    this.operation = task
    return task
  }

  async perform(operation) {
    if (this.state.restartRequired) return this.read()
    const prior = await this.read()
    if (prior.restartRequired) return prior
    this.state = { ...this.state, status: operation === 'install' ? 'installing' : 'checking', errorCode: undefined }
    try {
      const release = await discoverRelease(prior.installedVersion, this.ctx.profileContext.runtimeVersion, this.config, this.abort.signal)
      if (operation === 'check' || release.status !== 'available') {
        this.state = { ...this.state, status: release.status, latestVersion: release.latestVersion, releaseUrl: release.releaseUrl }
        return this.read()
      }
      // 每次安装重新检查官方版本，不接受浏览器提供的版本或下载地址。
      await this.ctx.preservePreferences?.()
      const archive = await this.download(release)
      this.abort.signal.throwIfAborted()
      const result = await this.ctx.pluginManager.installManagedUpdate('dsh-plugin-better-sidebar-updater', PACKAGE, release.latestVersion, archive)
      if (result.error || result.application !== 'restart-required') throw new Error('installation')
      this.state = { ...this.state, status: 'restart-required', latestVersion: release.latestVersion, releaseUrl: release.releaseUrl, restartRequired: true }
      return this.read()
    } catch (error) {
      this.abort.signal.throwIfAborted()
      const allowed = ['network', 'response-size', 'release-unavailable', 'release-source', 'package-source', 'integrity', 'installation']
      this.state = { ...this.state, status: 'error', errorCode: allowed.includes(error?.message) ? error.message : 'operation' }
      return this.read()
    }
  }

  async download(release) {
    const bytes = await readBytes(release.tarball, this.config.archiveBytes, this.config, this.abort.signal)
    if (!bytes) throw new Error('package-source')
    verifyArchiveIntegrity(bytes, release.integrity)
    const owner = resolve(this.ctx.profileContext.dir)
    const directory = join(owner, '.plugin-updates', 'better-sidebar', createHash('sha256').update(bytes).digest('hex'))
    for (const path of [owner, join(owner, '.plugin-updates'), join(owner, '.plugin-updates', 'better-sidebar'), directory]) {
      try { if ((await lstat(path)).isSymbolicLink()) throw new Error('linked-cache') }
      catch (error) { if (error.code !== 'ENOENT') throw error }
    }
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const file = join(directory, `${PACKAGE}-${release.latestVersion}.tgz`)
    try { await writeFile(file, bytes, { flag: 'wx', mode: 0o600 }) }
    catch (error) {
      if (error.code !== 'EEXIST') throw error
      if ((await lstat(file)).isSymbolicLink()) throw new Error('linked-cache')
      verifyArchiveIntegrity(await readFile(file), release.integrity)
    }
    return file
  }

  async dispose() {
    this.abort.abort()
    // 调用方已收到操作结果；卸载只等待被取消的操作结束。
    await this.operation?.catch(error => { if (!this.abort.signal.aborted) throw error })
  }
}
