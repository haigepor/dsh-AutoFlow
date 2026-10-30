import { setTimeout as delay } from 'node:timers/promises'
import { digest } from './afp-state-store.js'
import { ensureAfpToken, decodeJwtExpiry, isTokenFresh } from '../vendor/auto-afp-img/ensure-afp-token.mjs'
import { createAfpApiClient, isAfpAuthenticationError } from '../vendor/auto-afp-img/afp-api-client.mjs'
import { createAfpPreviewClient } from '../vendor/auto-afp-img/afp-preview-client.mjs'
import { createNativeVisionClient, nativeVisionInformation } from './afp-native-vision.js'
import { createAccountProfileReader } from './afp-account-profile.js'

// 认证恢复只重放明确的读取；写入、购买及交付字节请求不在此列表内。
const renewableReads = new Set(['searchPhotos', 'photosByIds', 'photoSelectionsByIds', 'listSelections', 'getSelection', 'downloadPhotoDetails'])

/** Fuse job cancellation with each bounded HTTP request; redirects cannot forward credentials. */
export function transport(signal, fetchImpl = globalThis.fetch) {
  return async (url, options = {}) => {
    signal.throwIfAborted()
    const response = await fetchImpl(url, { ...options, redirect: 'manual',
      signal: options.signal ? AbortSignal.any([signal, options.signal]) : signal })
    // Preview's own manual redirect checker enforces its configured CDN allowlist.
    if (response.status >= 300 && response.status < 400 && options.redirect !== 'manual') {
      await response.body?.cancel()
      throw new Error('AFP refuses an unexpected API redirect')
    }
    return response
  }
}

/** Only resolve configured references; token cache uses the DSH credentials provider, never run files. */
export class Connection {
  constructor(credentials, config, fetchImpl = globalThis.fetch, modelServices = {}) {
    this.credentials = credentials; this.config = config; this.fetchImpl = fetchImpl
    this.modelServices = modelServices
    this.authentications = new Map(); this.verifiedGrant = null
  }
  /** Share authentication work while each caller retains independent cancellation.
   * @param {object} input Resolved credential references and account record key.
   * @param {AbortSignal} signal Calling read or job lifetime.
   * @param {object} [failed] Rejected token/generation; absence permits recent verification reuse.
   * @returns {Promise<object>} Committed grant; old persisted verification alone is never sufficient.
   */
  async acquireGrant(input, signal, failed) {
    signal.throwIfAborted()
    const { key, fingerprint } = input, config = this.config
    if (failed && this.verifiedGrant?.key === key && this.verifiedGrant.token === failed.token && this.verifiedGrant.generation === failed.generation) this.verifiedGrant = null
    const refreshing = () => [...this.authentications.values()].find(task => task.key === key && task.fingerprint === fingerprint && task.failed && !task.controller.signal.aborted)
    let flight = failed ? undefined : refreshing()
    if (!flight && !failed && this.verifiedGrant?.key === key && this.verifiedGrant.fingerprint === fingerprint && config.tokenValidationTtlMs > 0) {
      const verified = this.verifiedGrant, stored = await this.credentials.readRecord(key)
      signal.throwIfAborted()
      flight = refreshing()
      const payload = stored?.kind === 'grant' && stored.payload?.fingerprint === fingerprint ? stored.payload : null
      const now = Date.now()
      if (!flight && this.verifiedGrant === verified && payload && payload.token === verified.token && (payload.generation ?? 0) === verified.generation
        && now >= verified.verifiedAt && now - verified.verifiedAt < config.tokenValidationTtlMs
        && isTokenFresh(payload.token, { now, refreshMarginSeconds: config.tokenRefreshMarginSeconds })) return payload
    }
    const flightKey = JSON.stringify([key, fingerprint, failed?.token ?? null, failed?.generation ?? null])
    flight ??= this.authentications.get(flightKey)
    if (!flight || flight.controller.signal.aborted) {
      flight = { key, fingerprint, failed: Boolean(failed), controller: new AbortController(), waiters: 0, settled: false, done: null }
      const owned = flight
      owned.done = Promise.resolve().then(async () => {
        const taskSignal = owned.controller.signal
        const fetchImpl = transport(taskSignal, this.fetchImpl)
        const sleep = milliseconds => delay(milliseconds, undefined, { signal: taskSignal })
        let grant
        await this.credentials.modifyRecord(key, async current => {
          taskSignal.throwIfAborted()
          const cached = current?.kind === 'grant' && current.payload?.fingerprint === fingerprint && typeof current.payload?.token === 'string' ? current.payload : null
          const replaced = failed && cached && (cached.token !== failed.token || (cached.generation ?? 0) !== failed.generation)
          const authenticated = await ensureAfpToken({
            environment: { AFP_ACCESS_TOKEN: cached?.token || input.accessToken, AFP_REFRESH_TOKEN: cached?.refreshToken,
              AFP_USERNAME: input.username, AFP_PASSWORD: input.password, AFP_LANG: config.language },
            fetchImpl, sleep, refreshMarginSeconds: config.tokenRefreshMarginSeconds,
            farEndpoint: config.farEndpoint, forceRefresh: Boolean(failed) && !replaced, autoRefresh: config.autoRefreshToken,
            hubLoginEndpoint: config.loginEndpoint, requestTimeoutMs: config.requestTimeoutMs,
            retries: config.readRetries, maxResponseBytes: config.maxResponseBytes,
          })
          taskSignal.throwIfAborted()
          grant = { fingerprint, token: authenticated.accessToken, refreshToken: authenticated.refreshToken,
            generation: (cached?.generation ?? 0) + (authenticated.source === 'existing' ? 0 : 1), verifiedAt: Date.now() }
          return { kind: 'grant', payload: grant }
        })
        taskSignal.throwIfAborted()
        // 只复用本实例已成功验证并提交的 grant；跨实例记录仍须首次校验。
        this.verifiedGrant = { key, fingerprint, token: grant.token, generation: grant.generation ?? 0, verifiedAt: grant.verifiedAt }
        return grant
      }).finally(() => {
        owned.settled = true
        if (this.authentications.get(flightKey) === owned) this.authentications.delete(flightKey)
      })
      // 所有等待者取消后，任务仍须释放请求和凭据锁，不能产生未处理拒绝。
      void owned.done.catch(authenticationError => { /* 等待者负责报告认证失败；无等待者时只释放资源。 */ })
      this.authentications.set(flightKey, owned)
    }
    const shared = flight
    shared.waiters++
    return new Promise((resolve, reject) => {
      let finished = false
      const leave = () => {
        if (finished) return false
        finished = true; shared.waiters--; signal.removeEventListener('abort', aborted)
        return true
      }
      const aborted = () => {
        if (!leave()) return
        if (!shared.waiters && !shared.settled) {
          shared.controller.abort(signal.reason)
          // 最后一个等待者在认证资源释放后退出；其他等待者取消不影响共享请求。
          void shared.done.then(() => reject(signal.reason), () => reject(signal.reason))
        } else reject(signal.reason)
      }
      signal.addEventListener('abort', aborted, { once: true })
      shared.done.then(value => { if (leave()) resolve(value) }, error => { if (leave()) reject(error) })
      if (signal.aborted) aborted()
    })
  }
  async status() {
    const config = this.config
    const entries = await Promise.all(['accessTokenRef', 'usernameRef', 'passwordRef'].map(async key => [key, (await this.credentials.describe(config[key])).configured]))
    return { credentials: Object.fromEntries(entries), visionConfigured: (await this.visionInformation()).state === 'ready', writesEnabled: config.allowWrites }
  }
  /** Read fresh model choices from the profile without resolving or returning provider credentials. */
  visionInformation() { return nativeVisionInformation(this.modelServices.llm, this.config) }
  /** Return credential metadata; an explicit allowed reveal key adds only that secret for the authenticated editor. */
  async configurationInfo(revealKey) {
    if (revealKey !== undefined && !['passwordRef', 'accessTokenRef'].includes(revealKey)) throw new Error('Invalid AFP credential field')
    const config = this.config
    const keys = ['accessTokenRef', 'usernameRef', 'passwordRef']
    const entries = await Promise.all(keys.map(async key => [key, await this.credentials.describe(config[key])]))
    const values = await Promise.all(['accessTokenRef', 'usernameRef', 'passwordRef'].map(async key =>
      (await this.credentials.resolve(config[key]))?.value ?? ''))
    const [accessToken, username, password] = values
    const identity = username || accessToken
    const account = digest(`${config.selectionsEndpoint}\n${identity}`)
    const record = identity ? await this.credentials.readRecord(`dsh-plugin-afp/account-${account}`) : undefined
    const fingerprint = digest(JSON.stringify([accessToken, username, password, config.loginEndpoint]))
    const payload = record?.kind === 'grant' && record.payload?.fingerprint === fingerprint && typeof record.payload?.token === 'string' ? record.payload : null
    const token = payload?.token || accessToken
    const credentials = Object.fromEntries(entries)
    credentials.accessTokenRef = { ...credentials.accessTokenRef, configured: Boolean(token) }
    const revealed = revealKey === 'passwordRef' ? password : revealKey === 'accessTokenRef' ? token : undefined
    return { username, credentials, ...(revealKey === undefined ? {} : { value: revealed }), token: {
      configured: Boolean(payload?.token || accessToken),
      expiresAt: payload?.token ? decodeJwtExpiry(payload.token) : accessToken ? decodeJwtExpiry(accessToken) : null,
      verifiedAt: payload?.verifiedAt ?? null,
    } }
  }
  async open(signal, write = false, vision = false, preview = false, onProgress) {
    const config = this.config
    const visionClient = vision ? await createNativeVisionClient({ ...this.modelServices, config, signal }) : undefined
    const value = async name => (await this.credentials.resolve(name))?.value ?? ''
    const [accessToken, username, password] = await Promise.all([value(config.accessTokenRef), value(config.usernameRef), value(config.passwordRef)])
    if (!accessToken && (!username || !password)) throw new Error('AFP credentials are missing')
    const identity = username || accessToken
    const account = digest(`${config.selectionsEndpoint}\n${identity}`)
    const fingerprint = digest(JSON.stringify([accessToken, username, password, config.loginEndpoint]))
    const key = `dsh-plugin-afp/account-${account}`
    const fetchImpl = transport(signal, this.fetchImpl)
    const sleep = milliseconds => delay(milliseconds, undefined, { signal })
    let token, generation
    const acquire = async failed => {
      const grant = await this.acquireGrant({ key, fingerprint, accessToken, username, password }, signal, failed)
      token = grant.token; generation = grant.generation ?? 0
    }
    await acquire()
    const common = () => ({ logger: onProgress, accessToken: token, fetchImpl, sleep, requestTimeoutMs: config.requestTimeoutMs,
      retries: write ? 0 : config.readRetries, maxResponseBytes: config.maxResponseBytes,
      farEndpoint: config.farEndpoint, hubEndpoint: config.loginEndpoint,
      selectionsEndpoint: config.selectionsEndpoint.replace(/\/$/, '') })
    const read = async operation => {
      signal.throwIfAborted()
      const failed = { token, generation }
      let result
      try { result = await operation() }
      catch (error) {
        signal.throwIfAborted()
        if (write || !config.autoRefreshToken || !isAfpAuthenticationError(error)) throw error
        await acquire(failed)
        // 第二次拒绝直接返回，不能递归刷新或再次重放。
        result = await operation()
      }
      signal.throwIfAborted()
      return result
    }
    const api = createAfpApiClient(common())
    const client = Object.fromEntries(Object.keys(api).map(name => [name, async (...args) => {
      signal.throwIfAborted()
      const operation = () => createAfpApiClient(common())[name](...args)
      if (renewableReads.has(name)) return read(operation)
      const result = await operation()
      signal.throwIfAborted()
      return result
    }]))
    const services = { client, account, readAccountProfile: () => read(() => createAccountProfileReader({ accessToken: token, fetchImpl, sleep, config })()) }
    if (vision || preview) services.previewClient = { getPreviewBytes: (id, options) => read(() => createAfpPreviewClient({ ...common(), apicoreEndpoint: config.mediaEndpoint,
      allowedCdnHosts: config.previewCdnHosts, autoDiscoverCdnHosts: config.previewAutoCdnHosts,
      maxRedirects: config.maxRedirects, maxResponseBytes: config.maxPreviewBytes }).getPreviewBytes(id, options)) }
    if (!vision) return services
    services.visionClient = visionClient
    return services
  }
}
