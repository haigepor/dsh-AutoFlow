#!/usr/bin/env node
/** Stdio entry point: configuration comes from argv, then environment, then defaults. */
import { start } from '../src/server.js'

const argv = process.argv.slice(2)
const flag = name => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : undefined
}
const dataDir = flag('data-dir') ?? process.env.ARTICLE_IMAGE_DATA_DIR
const sourceUrl = flag('source-url') ?? process.env.ARTICLE_IMAGE_SOURCE_URL
const timeout = flag('timeout-ms') ?? process.env.ARTICLE_IMAGE_TIMEOUT_MS
const renderMode = flag('render-mode') ?? process.env.ARTICLE_IMAGE_RENDER_MODE
const renderHeadless = flag('render-headless') ?? process.env.ARTICLE_IMAGE_RENDER_HEADLESS
const renderTimeout = flag('render-timeout-ms') ?? process.env.ARTICLE_IMAGE_RENDER_TIMEOUT_MS
const renderWait = flag('render-wait-ms') ?? process.env.ARTICLE_IMAGE_RENDER_WAIT_MS
const renderUserDataDir = flag('render-user-data-dir') ?? process.env.ARTICLE_IMAGE_RENDER_USER_DATA_DIR
const hostRate = flag('host-rate') ?? process.env.ARTICLE_IMAGE_HOST_RATE
const hostBurst = flag('host-burst') ?? process.env.ARTICLE_IMAGE_HOST_BURST
const maxRetryAfter = flag('max-retry-after-ms') ?? process.env.ARTICLE_IMAGE_MAX_RETRY_AFTER_MS
const maxSessionCookies = flag('max-session-cookies') ?? process.env.ARTICLE_IMAGE_MAX_SESSION_COOKIES
const fetchConcurrency = flag('fetch-concurrency') ?? process.env.ARTICLE_IMAGE_FETCH_CONCURRENCY
const fetchCache = flag('fetch-cache') ?? process.env.ARTICLE_IMAGE_FETCH_CACHE
const diagnosticRuns = flag('max-diagnostic-runs') ?? process.env.ARTICLE_IMAGE_MAX_DIAGNOSTIC_RUNS
const diagnosticEvents = flag('max-diagnostic-events') ?? process.env.ARTICLE_IMAGE_MAX_DIAGNOSTIC_EVENTS
const progressInterval = flag('progress-interval-ms') ?? process.env.ARTICLE_IMAGE_PROGRESS_INTERVAL_MS
const proxyUrl = flag('proxy-url') ?? process.env.ARTICLE_IMAGE_PROXY_URL
const dnsProvider = flag('dns-provider') ?? process.env.ARTICLE_IMAGE_DNS_PROVIDER
const config = {
  ...((proxyUrl || dnsProvider) ? { network: { ...(proxyUrl ? { proxyUrl } : {}), ...(dnsProvider ? { dnsProvider } : {}) } } : {}),
  ...(dataDir ? { dataDir } : {}),
  ...(sourceUrl ? { sourceUrl } : {}),
  ...(timeout ? { requestTimeoutMs: Number(timeout) } : {}),
  ...(renderMode ? { renderMode } : {}),
  ...(renderHeadless !== undefined ? { renderHeadless: renderHeadless !== 'false' } : {}),
  ...(renderTimeout ? { renderTimeoutMs: Number(renderTimeout) } : {}),
  ...(renderWait ? { renderWaitMs: Number(renderWait) } : {}),
  ...(renderUserDataDir ? { renderUserDataDir } : {}),
  ...(hostRate ? { hostRatePerSecond: Number(hostRate) } : {}),
  ...(hostBurst ? { hostBurst: Number(hostBurst) } : {}),
  ...(maxRetryAfter ? { maxRetryAfterMs: Number(maxRetryAfter) } : {}),
  ...(maxSessionCookies ? { maxSessionCookies: Number(maxSessionCookies) } : {}),
  ...(fetchConcurrency ? { fetchConcurrency: Number(fetchConcurrency) } : {}),
  // 布尔开关按存在性读取：--fetch-cache 与 --fetch-cache false 都能表达意图。
  ...(fetchCache !== undefined ? { fetchCache: fetchCache !== 'false' } : {}),
  ...(diagnosticRuns !== undefined ? { maxDiagnosticRuns: Number(diagnosticRuns) } : {}),
  ...(diagnosticEvents !== undefined ? { maxDiagnosticEvents: Number(diagnosticEvents) } : {}),
  ...(progressInterval !== undefined ? { progressIntervalMs: Number(progressInterval) } : {}),
}

await start(config)
