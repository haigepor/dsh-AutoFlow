import { setTimeout as delay } from 'node:timers/promises'
import { digest } from './afp-state-store.js'
import { ensureAfpToken, decodeJwtExpiry } from '../vendor/auto-afp-img/ensure-afp-token.mjs'
import { createAfpApiClient, isAfpAuthenticationError } from '../vendor/auto-afp-img/afp-api-client.mjs'
import { createAfpPreviewClient } from '../vendor/auto-afp-img/afp-preview-client.mjs'
import { createOpenAiCompatibleVisionClient } from '../vendor/auto-afp-img/openai-compatible-vision.mjs'
import { createAccountProfileReader } from './afp-account-profile.js'

// 认证恢复只重放明确的读取；写入、购买及交付字节请求不在此列表内。
const renewableReads = new Set(['searchPhotos', 'photosByIds', 'listSelections', 'getSelection', 'downloadPhotoDetails'])

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
  constructor(credentials, config, fetchImpl = globalThis.fetch) {
    this.credentials = credentials; this.config = config; this.fetchImpl = fetchImpl
  }
  async status() {
    const config = this.config
    const entries = await Promise.all(['accessTokenRef', 'usernameRef', 'passwordRef', 'visionKeyRef'].map(async key => [key, (await this.credentials.describe(config[key])).configured]))
    return { credentials: Object.fromEntries(entries), visionConfigured: Boolean(config.visionModel && config.visionBaseUrl), writesEnabled: config.allowWrites }
  }
  /** Return credential metadata; an explicit allowed reveal key adds only that secret for the authenticated editor. */
  async configurationInfo(revealKey) {
    if (revealKey !== undefined && !['passwordRef', 'accessTokenRef', 'visionKeyRef'].includes(revealKey)) throw new Error('Invalid AFP credential field')
    const config = this.config
    const keys = ['accessTokenRef', 'usernameRef', 'passwordRef', 'visionKeyRef']
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
    const revealed = revealKey === 'passwordRef' ? password : revealKey === 'accessTokenRef' ? token
      : revealKey === 'visionKeyRef' ? (await this.credentials.resolve(config.visionKeyRef))?.value ?? '' : undefined
    return { username, credentials, ...(revealKey === undefined ? {} : { value: revealed }), token: {
      configured: Boolean(payload?.token || accessToken),
      expiresAt: payload?.token ? decodeJwtExpiry(payload.token) : accessToken ? decodeJwtExpiry(accessToken) : null,
      verifiedAt: payload?.verifiedAt ?? null,
    } }
  }
  async open(signal, write = false, vision = false, preview = false, onProgress) {
    const config = this.config
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
    // Serialize refresh within the credential provider so parallel tools do not race token storage.
    const acquire = async failed => this.credentials.modifyRecord(key, async current => {
      signal.throwIfAborted()
      const cached = current?.kind === 'grant' && current.payload?.fingerprint === fingerprint && typeof current.payload?.token === 'string' ? current.payload : null
      // 即便远端刷新返回同一 access token，generation 也能避免并发请求重复刷新。
      if (failed && cached && (cached.token !== failed.token || (cached.generation ?? 0) !== failed.generation)) {
        token = cached.token; generation = cached.generation ?? 0
        return current
      }
      const authenticated = await ensureAfpToken({
        environment: { AFP_ACCESS_TOKEN: cached?.token || accessToken, AFP_REFRESH_TOKEN: cached?.refreshToken,
          AFP_USERNAME: username, AFP_PASSWORD: password, AFP_LANG: config.language },
        fetchImpl, sleep, refreshMarginSeconds: config.tokenRefreshMarginSeconds,
        farEndpoint: config.farEndpoint, forceRefresh: Boolean(failed), autoRefresh: config.autoRefreshToken,
        hubLoginEndpoint: config.loginEndpoint, requestTimeoutMs: config.requestTimeoutMs,
        retries: config.readRetries, maxResponseBytes: config.maxResponseBytes,
      })
      signal.throwIfAborted()
      token = authenticated.accessToken
      generation = (cached?.generation ?? 0) + (authenticated.source === 'existing' ? 0 : 1)
      return { kind: 'grant', payload: { fingerprint, token, refreshToken: authenticated.refreshToken, generation, verifiedAt: Date.now() } }
    })
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
    if (vision || preview) services.previewClient = { getPreviewBytes: id => read(() => createAfpPreviewClient({ ...common(), apicoreEndpoint: config.mediaEndpoint,
      allowedCdnHosts: config.previewCdnHosts, autoDiscoverCdnHosts: config.previewAutoCdnHosts,
      maxRedirects: config.maxRedirects, maxResponseBytes: config.maxPreviewBytes }).getPreviewBytes(id)) }
    if (!vision) return services
    if (!config.visionModel || !config.visionBaseUrl) throw new Error('Configure visionModel and visionBaseUrl in the AFP plugin config')
    const apiKey = await value(config.visionKeyRef)
    if (!apiKey) throw new Error('Vision credentials are missing')
    services.visionClient = createOpenAiCompatibleVisionClient({ baseUrl: config.visionBaseUrl, apiKey,
        model: config.visionModel, reasoningModel: config.reasoningModel || null, reasoningEffort: config.reasoningEffort || null,
        fetchImpl, sleep, requestTimeoutMs: config.requestTimeoutMs, retries: config.readRetries, maxResponseBytes: config.maxResponseBytes })
    return services
  }
}
