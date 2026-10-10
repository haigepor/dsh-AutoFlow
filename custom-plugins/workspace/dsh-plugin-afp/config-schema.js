import { PREVIEW_ANIMATION_DEFAULTS } from './src/shared/afp-preview-animation-options.js'

/** Validated deployment settings; tool arguments cannot override credentials or URLs. */
const defaults = Object.freeze({
  allowWrites: false, autoRefreshToken: true,
  debugEnabled: false, debugMaxBytes: 262144, debugMaxEvents: 1000, debugMaxRuns: 20, debugRetentionDays: 7, debugFlushIntervalMs: 1000,
  accessTokenRef: 'AFP_ACCESS_TOKEN', usernameRef: 'AFP_USERNAME', passwordRef: 'AFP_PASSWORD',
  visionKeyRef: 'VISION_API_KEY', visionModel: '', visionBaseUrl: '', reasoningModel: '', reasoningEffort: '',
  language: 'en', farEndpoint: 'https://far-api-news.app.afp.com/',
  selectionsEndpoint: 'https://slt-api-news.app.afp.com',
  loginEndpoint: 'https://hub-api-news.app.afp.com/search',
  mediaEndpoint: 'https://afp-apicore-prod.afp.com/objects/api/medias', previewCdnHosts: [], previewAutoCdnHosts: true,
  targetPerCategory: 100, batchSize: 30, pageSize: 60, maxPages: 3, maxBatches: 10,
  concurrency: 3, threshold: 0.8, requestTimeoutMs: 180000, readRetries: 2,
  collectionConcurrency: 4, searchConcurrency: 3, maxSearchRequests: 30,
  preparationTimeoutMs: 600000, dedupSnapshotTtlMs: 600000, maxPhotoAttempts: 3, minimumReviewedPerCategory: 0,
  tokenRefreshMarginSeconds: 300, planTtlMs: 600000, outputLimitBytes: 16000,
  maxStateBytes: 67108864, maxPreviewBytes: 12582912, maxResponseBytes: 4194304, maxRedirects: 3,
  stateWriteRetryCount: 8, stateWriteRetryDelayMs: 50,
  maxDownloadBytes: 134217728, downloadConcurrency: 2,
  previewCacheMaxEntries: 300, previewCacheMaxBytes: 67108864, previewCacheTtlMs: 600000,
  previewRetryCount: 2, previewRetryDelayMs: 1000,
  previewAnimationEnabled: PREVIEW_ANIMATION_DEFAULTS.enabled,
  pollIntervalMs: 2000, agentResultMaxBytes: 16384,
})
const ranges = {
  debugMaxBytes: [65536, 4194304], debugMaxEvents: [10, 10000], debugMaxRuns: [1, 200], debugRetentionDays: [1, 30], debugFlushIntervalMs: [250, 10000],
  targetPerCategory: [1, 1000], batchSize: [1, 500], pageSize: [1, 120], maxPages: [1, 10],
  maxBatches: [1, 100], concurrency: [1, 16], requestTimeoutMs: [1000, 600000], readRetries: [0, 5],
  collectionConcurrency: [1, 16], searchConcurrency: [1, 16], maxSearchRequests: [1, 1000],
  preparationTimeoutMs: [1000, 3600000], dedupSnapshotTtlMs: [0, 3600000], maxPhotoAttempts: [1, 5], minimumReviewedPerCategory: [0, 1000],
  tokenRefreshMarginSeconds: [0, 3600], planTtlMs: [1000, 3600000], outputLimitBytes: [1024, 1000000],
  maxStateBytes: [1048576, 268435456], maxPreviewBytes: [1024, 52428800],
  stateWriteRetryCount: [0, 20], stateWriteRetryDelayMs: [10, 1000],
  maxResponseBytes: [1024, 16777216], maxRedirects: [0, 5], maxDownloadBytes: [1048576, 1073741824], downloadConcurrency: [1, 8],
  pollIntervalMs: [500, 60000], agentResultMaxBytes: [4096, 65536],
  previewCacheMaxEntries: [0, 5000], previewCacheMaxBytes: [1024, 268435456], previewCacheTtlMs: [1000, 3600000],
  previewRetryCount: [0, 3], previewRetryDelayMs: [100, 30000],
}

/** @param {object} input Deployment config. @returns {object} Validated explicit settings. */
export function resolveConfig(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('AFP config must be an object')
  for (const key of Object.keys(input)) if (!Object.hasOwn(defaults, key)) throw new Error(`Unknown AFP config field: ${key}`)
  const config = { ...defaults, ...input }
  if (typeof config.allowWrites !== 'boolean') throw new Error('allowWrites must be boolean')
  if (typeof config.debugEnabled !== 'boolean') throw new Error('debugEnabled must be boolean')
  if (typeof config.autoRefreshToken !== 'boolean') throw new Error('autoRefreshToken must be boolean')
  if (typeof config.previewAutoCdnHosts !== 'boolean') throw new Error('previewAutoCdnHosts must be boolean')
  if (typeof config.previewAnimationEnabled !== 'boolean') throw new Error('previewAnimationEnabled must be boolean')
  for (const [key, [min, max]] of Object.entries(ranges)) {
    if (!Number.isSafeInteger(config[key]) || config[key] < min || config[key] > max) throw new Error(`Invalid ${key}: expected integer ${min}..${max}`)
  }
  if (config.debugMaxBytes > config.maxStateBytes) throw new Error('debugMaxBytes must not exceed maxStateBytes')
  for (const key of ['accessTokenRef', 'usernameRef', 'passwordRef', 'visionKeyRef']) {
    if (typeof config[key] !== 'string' || !/^[A-Z_][A-Z0-9_]*$/.test(config[key])) throw new Error(`Invalid ${key}`)
  }
  for (const key of ['visionModel', 'reasoningModel', 'reasoningEffort', 'language']) {
    if (typeof config[key] !== 'string' || config[key].length > 200) throw new Error(`Invalid ${key}`)
  }
  if (!['', 'low', 'medium', 'high'].includes(config.reasoningEffort)) throw new Error('Invalid reasoningEffort')
  if (!Number.isFinite(config.threshold) || config.threshold < 0.8 || config.threshold > 1) throw new Error('threshold must be 0.8..1')
  for (const key of ['farEndpoint', 'selectionsEndpoint', 'loginEndpoint', 'mediaEndpoint', 'visionBaseUrl']) {
    if (key === 'visionBaseUrl' && config[key] === '') continue
    const url = new URL(config[key])
    if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error(`Invalid ${key}: use HTTPS without credentials/query/fragment`)
  }
  if (!Array.isArray(config.previewCdnHosts) || config.previewCdnHosts.some(host => typeof host !== 'string' || !/^[a-z0-9.-]+$/.test(host))) throw new Error('Invalid previewCdnHosts')
  return config
}

/** Cordis accepts Standard Schema without a runtime schema dependency. */
export const Config = {
  '~standard': { version: 1, vendor: 'dsh-plugin-afp', validate(input) {
    try { return { value: resolveConfig(input) } }
    catch (error) { return { issues: [{ message: error.message }] } }
  } },
}
