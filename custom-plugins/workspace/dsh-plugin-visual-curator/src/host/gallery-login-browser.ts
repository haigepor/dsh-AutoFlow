/** Managed Chrome/Edge login uses an ephemeral profile rather than a personal browser's Cookie database. */
import { chromium, type BrowserContext } from 'playwright-core'
import type { CuratorConfig } from './config.ts'
import type { GalleryLoginBrowser } from './gallery-login.ts'
import { MediaError } from '../media/errors.ts'
import { normalizeCookie } from '../media/unsplash.ts'

const loginUrl = 'https://unsplash.com/login'
const apiUrl = 'https://unsplash.com/napi/me'
const environmentNames = new Set(['PATH', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'HOME', 'DISPLAY', 'WAYLAND_DISPLAY', 'XAUTHORITY', 'DBUS_SESSION_BUS_ADDRESS', 'LANG', 'LC_ALL'])

/** @param config Deployment browser selection, never a Client-provided executable. @param signal Accepted sign-in lifetime. @returns Official-site window with origin-scoped Cookie reading and awaited disposal. */
export async function launchGalleryLogin(config: CuratorConfig, signal: AbortSignal): Promise<GalleryLoginBrowser> {
  const options = config.source.unsplash.login
  const channels = options.executablePath ? [undefined] : options.browser === 'auto' ? process.platform === 'win32' ? ['msedge', 'chrome'] : ['chrome', 'msedge'] : [options.browser]
  let context: BrowserContext | undefined
  for (const channel of channels) {
    signal.throwIfAborted()
    try {
      // 空目录由 Playwright 创建并在 close 后清理；每次登录独立，避免账号会话互相覆盖。
      context = await chromium.launchPersistentContext('', {
        ...(options.executablePath ? { executablePath: options.executablePath } : channel ? { channel } : {}), headless: false,
        // 官网校验绑定 User-Agent；读取接口时必须与登录窗口使用同一配置。
        userAgent: config.source.unsplash.userAgent,
        chromiumSandbox: true, acceptDownloads: false, viewport: null, timeout: options.launchTimeoutMs,
        env: Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => environmentNames.has(entry[0].toUpperCase()) && entry[1] !== undefined)),
      })
      break
    } catch (_error) { signal.throwIfAborted() /* 自动模式只尝试安装的浏览器，不下载或切换到个人配置。 */ }
  }
  if (!context) throw new MediaError('gallery-login-browser-unavailable', 'gallery-login', false, 'No supported login browser could be opened.', 'Install Edge or Chrome, or configure the login executable.')
  const browser = context, closed = new AbortController()
  browser.once('close', () => closed.abort())
  const close = () => browser.close()
  const abort = () => { void close().catch(() => { /* 调用者仍通过 close 等待并报告关闭失败。 */ }) }
  signal.addEventListener('abort', abort, { once: true })
  try {
    signal.throwIfAborted()
    const page = browser.pages()[0] ?? await browser.newPage()
    await page.goto(loginUrl, { waitUntil: 'commit', timeout: options.launchTimeoutMs })
    signal.throwIfAborted()
    return {
      closed: closed.signal,
      async cookie() {
        // 指定 API URL 保留 HttpOnly 及路径语义，只读取 Unsplash 会话，不枚举其他站点。
        const cookies = (await browser.cookies(apiUrl)).filter(cookie => ['unsplash.com', '.unsplash.com'].includes(cookie.domain) && cookie.value && !cookie.partitionKey)
        // 访客阶段已有统计和官网校验 Cookie，不能据此提前进入账号验证。
        if (!cookies.some(cookie => cookie.name === 'un_sesh' || cookie.name === '_unsplash_session')) return ''
        return cookies.length ? normalizeCookie(cookies.map(cookie => `${cookie.name}=${cookie.value}`).join('; ')) : ''
      },
      async close() { signal.removeEventListener('abort', abort); await close() },
    }
  } catch (_error) {
    signal.removeEventListener('abort', abort)
    await close()
    signal.throwIfAborted()
    throw new MediaError('gallery-login-open-failed', 'gallery-login', false, 'The Unsplash login page could not open.', 'Check the network and open a new sign-in window.')
  }
}
