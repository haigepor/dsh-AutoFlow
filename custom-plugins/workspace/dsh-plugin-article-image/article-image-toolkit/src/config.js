/** Deployment limits and source defaults shared by the toolkit entry points. */
import { z } from 'zod'
import { captureConfigSchema } from './capture.js'
import { networkConfigSchema } from './network-config.js'

export const mappingSchema = z.object({ link: z.string().min(1).max(100), category: z.string().max(100).default(''), language: z.string().max(100).default(''), notes: z.string().max(100).default('') }).strict()
const schema = z.object({
  network: networkConfigSchema.prefault({}),
  dataDir: z.string().min(1).max(4096).default('.article-image'),
  sourceUrl: z.string().url().optional(),
  mapping: mappingSchema.default({ link: 'Links', category: 'Category', language: '语言', notes: '备注' }),
  maxCsvBytes: z.number().int().min(1024).max(16000000).default(2000000),
  maxRows: z.number().int().min(1).max(10000).default(2000),
  maxArticleChars: z.number().int().min(1000).max(500000).default(100000),
  minArticleChars: z.number().int().min(100).max(5000).default(200),
  maxArticleHtmlBytes: z.number().int().min(100000).max(32000000).default(8000000),
  maxArticleHtmlChars: z.number().int().min(100000).max(8000000).default(2000000),
  maxArticleElements: z.number().int().min(1000).max(200000).default(50000),
  articleUserAgent: z.string().min(1).max(300).regex(/^[^\r\n]+$/).default('ArticleImageToolkit (+https://github.com/haigepor/dsh-AutoFlow)'),
  maxStateBytes: z.number().int().min(1000000).max(268435456).default(33554432),
  // 45s 覆盖多数慢站点；个别站点（例如 otempo.com.br 约 69s）需按部署上调。
  requestTimeoutMs: z.number().int().min(1000).max(600000).default(45000),
  maxRedirects: z.number().int().min(0).max(8).default(3),
  // 'never' 保持纯静态抓取；'fallback' 仅在静态失败后改用 Playwright 引擎渲染；'always' 全部经渲染。
  renderMode: z.enum(['never', 'fallback', 'always']).default('never'),
  renderTimeoutMs: z.number().int().min(1000).max(600000).default(60000),
  // 渲染等待预算，按阶段各计一次：网络安静、正文就位、DOM 尺寸稳定。单页应用从启动到首个数据请求可间隔数秒
  // （bcb.gov.br 首个请求约 5 秒、正文约 15 秒），正文门槛用 minArticleChars 做判据，慢站等满预算后照常快照。
  renderWaitMs: z.number().int().min(0).max(60000).default(15000),
  renderHeadless: z.boolean().default(true),
  renderBlockAssets: z.boolean().default(true),
  renderUserDataDir: z.string().min(1).max(4096).optional(),
  fetchConcurrency: z.number().int().min(1).max(16).default(2),
  // 按源站的 Cache-Control: max-age 复用已抓取正文；命中时不发请求，毫秒级返回。
  // 关闭时每次抓取都走网络，适合要求正文绝对新鲜的部署。
  fetchCache: z.boolean().default(false),
  // 每主机持续补充的令牌速率与突发上限；跨主机的抓取互不阻塞。
  hostRatePerSecond: z.number().min(0.1).max(100).default(1),
  hostBurst: z.number().int().min(1).max(50).default(4),
  // 服务器用 Retry-After 要求的等待上限。超过它的要求不再替调用方无限期挂起，按截断值等待。
  maxRetryAfterMs: z.number().int().min(0).max(600000).default(60000),
  maxSessionCookies: z.number().int().min(1).max(2000).default(300),
  pageSize: z.number().int().min(1).max(100).default(30),
  articlePageChars: z.number().int().min(2000).max(20000).default(10000),
  toolResultBytes: z.number().int().min(8000).max(64000).default(16000),
  maxDiagnosticRuns: z.number().int().min(1).max(100).default(20),
  maxDiagnosticEvents: z.number().int().min(1).max(1000).default(128),
  progressIntervalMs: z.number().int().min(0).max(600000).default(250),
  maxPlanBytes: z.number().int().min(8000).max(100000).default(48000),
  capture: captureConfigSchema.prefault({}),
  maxCaptureDiskBytes: z.number().int().min(1000).max(1073741824).default(268435456),
  maxCaptureSnapshots: z.number().int().min(1).max(10000).default(1000),
  // 网络录制：'api' 只保留文档与 XHR/fetch/WebSocket，'all' 保留全部资源类型。
  recordScope: z.enum(['api', 'all']).default('api'),
  maxRecordEntries: z.number().int().min(1).max(5000).default(500),
  maxRecordDiskBytes: z.number().int().min(1024).max(1073741824).default(134217728),
  maxExchangeBytes: z.number().int().min(1024).max(4194304).default(262144),
  maxHarBytes: z.number().int().min(1024).max(67108864).default(8388608),
}).strict().refine(value => value.minArticleChars <= value.maxArticleChars, 'Invalid article limits')

/** Resolve and validate explicit deployment settings. @param {object} input Config fields. @returns {object} Complete settings. */
export function resolveConfig(input = {}) {
  const config = schema.parse(input)
  // 显式 capture.network 优先；否则两条读取链路使用同一份已解析网络部署配置。
  return { ...config, capture: { ...config.capture, network: input.capture?.network === undefined ? config.network : config.capture.network } }
}
