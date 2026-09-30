import { setTimeout as delay } from 'node:timers/promises'
import { digest } from './afp-state-store.js'
import { ensureAfpToken } from '../vendor/auto-afp-img/ensure-afp-token.mjs'
import { createAfpApiClient } from '../vendor/auto-afp-img/afp-api-client.mjs'
import { createAfpPreviewClient } from '../vendor/auto-afp-img/afp-preview-client.mjs'
import { createOpenAiCompatibleVisionClient } from '../vendor/auto-afp-img/openai-compatible-vision.mjs'

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
  async open(signal, write = false, vision = false) {
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
    let token
    // Serialize refresh within the credential provider so parallel tools do not race token storage.
    await this.credentials.modifyRecord(key, async current => {
      const cached = current?.kind === 'grant' && current.payload?.fingerprint === fingerprint && typeof current.payload?.token === 'string' ? current.payload.token : ''
      const authenticated = await ensureAfpToken({
        environment: { AFP_ACCESS_TOKEN: cached || accessToken, AFP_USERNAME: username, AFP_PASSWORD: password, AFP_LANG: config.language },
        fetchImpl, sleep, refreshMarginSeconds: config.tokenRefreshMarginSeconds,
        selectionsEndpoint: `${config.selectionsEndpoint.replace(/\/$/, '')}/get-selections/byuser?includeClientSelections=true`,
        hubLoginEndpoint: config.loginEndpoint, requestTimeoutMs: config.requestTimeoutMs,
        retries: config.readRetries, maxResponseBytes: config.maxResponseBytes,
      })
      signal.throwIfAborted()
      token = authenticated.accessToken
      return { kind: 'grant', payload: { fingerprint, token } }
    })
    const common = { accessToken: token, fetchImpl, sleep, requestTimeoutMs: config.requestTimeoutMs,
      retries: write ? 0 : config.readRetries, maxResponseBytes: config.maxResponseBytes,
      farEndpoint: config.farEndpoint, selectionsEndpoint: config.selectionsEndpoint.replace(/\/$/, '') }
    const api = createAfpApiClient(common)
    const client = Object.fromEntries(Object.entries(api).map(([name, method]) => [name, async (...args) => {
      signal.throwIfAborted()
      const result = await method(...args)
      signal.throwIfAborted()
      return result
    }]))
    if (!vision) return { client, account }
    if (!config.visionModel || !config.visionBaseUrl) throw new Error('Configure visionModel and visionBaseUrl in the AFP plugin config')
    const apiKey = await value(config.visionKeyRef)
    if (!apiKey) throw new Error('Vision credentials are missing')
    return { client, account,
      previewClient: createAfpPreviewClient({ ...common, apicoreEndpoint: config.mediaEndpoint,
        allowedCdnHosts: config.previewCdnHosts, maxRedirects: config.maxRedirects, maxResponseBytes: config.maxPreviewBytes }),
      visionClient: createOpenAiCompatibleVisionClient({ baseUrl: config.visionBaseUrl, apiKey,
        model: config.visionModel, reasoningModel: config.reasoningModel || null, reasoningEffort: config.reasoningEffort || null,
        fetchImpl, sleep, requestTimeoutMs: config.requestTimeoutMs, retries: config.readRetries, maxResponseBytes: config.maxResponseBytes }),
    }
  }
}
