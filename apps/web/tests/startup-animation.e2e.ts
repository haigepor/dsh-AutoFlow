/** Keyless browser acceptance of early playback and the actual initial-data handoff. */
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

let scaffold: WebScaffold
let browser: Browser
let page: Page

beforeAll(async () => {
  scaffold = await launchWebScaffold({ profile: { packages: [], bundles: [
    'dsh-boot-animation', 'dsh-plugin-afp', 'dsh-plugin-visual-curator', 'dsh-plugin-style-prompt',
  ] } })
  browser = await chromium.launch()
  page = await browser.newPage({ locale: 'en-US', reducedMotion: 'no-preference' })
}, 180_000)

afterAll(async () => {
  await browser?.close()
  await scaffold?.close()
})

it('plays before plugin activation and reveals the mounted app only after its data baseline', async () => {
  await page.addInitScript(() => {
    const gate = Promise.withResolvers<undefined>()
    Object.defineProperty(window, '__DSH_BOOT_READY__', {
      configurable: true,
      value: { promise: gate.promise, resolve() {}, reject: gate.reject },
    })
    window.addEventListener('test:release-boot', () => { gate.resolve(undefined) }, { once: true })
  })
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  await page.waitForFunction(() => {
    const video = document.querySelector('video')
    return video !== null && video.readyState >= 2 && !video.paused
  }, undefined, { timeout: 20_000 })
  const media = await page.$eval('video', video => ({ src: video.currentSrc, muted: video.muted,
    width: video.videoWidth, height: video.videoHeight, fit: getComputedStyle(video).objectFit }))
  expect(new URL(media.src).pathname).toMatch(/\/assets\/cyberpunk-[^/]+\.mp4$/)
  expect(media.muted).toBe(true)
  expect({ width: media.width, height: media.height, fit: media.fit }).toEqual({ width: 1280, height: 720, fit: 'contain' })

  await page.$eval('video', (video) => { video.currentTime = video.duration })
  await page.waitForSelector('[data-dsh-startup-animation="waiting"]')
  expect(await page.evaluate(() => ({
    animation: document.querySelector('[data-dsh-startup-animation]')?.getAttribute('data-dsh-startup-animation'),
    dataReady: document.documentElement.getAttribute('data-dsh-startup-state') === 'ready',
    applicationBlocked: document.getElementById('root')?.inert,
    pluginBootVisible: document.querySelector('[data-dsh-boot]') !== null,
  }))).toMatchInlineSnapshot(`
    {
      "animation": "waiting",
      "applicationBlocked": true,
      "dataReady": false,
      "pluginBootVisible": true,
    }
  `)

  await page.evaluate(() => { window.dispatchEvent(new Event('test:release-boot')) })
  await page.waitForSelector('html[data-dsh-startup-state="ready"]', { timeout: 30_000 })
  await page.waitForSelector('[data-dsh-startup-animation]', { state: 'detached', timeout: 10_000 })
  expect(await page.evaluate(() => ({
    dataReady: document.documentElement.getAttribute('data-dsh-startup-state'),
    applicationBlocked: document.getElementById('root')?.inert,
    sidebarMounted: document.querySelector('[data-slot="sidebar"]') !== null,
    videoReleased: document.querySelector('video') === null,
  }))).toMatchInlineSnapshot(`
    {
      "applicationBlocked": false,
      "dataReady": "ready",
      "sidebarMounted": true,
      "videoReleased": true,
    }
  `)
}, 60_000)

it('uses native sidebar glyphs, enlarged detail artwork and title-based introductions at desktop and mobile widths', async () => {
  await page.setViewportSize({ width: 1440, height: 960 })
  const navigation = page.getByRole('navigation', { name: 'Global panels' })
  await navigation.getByRole('button', { name: 'Plugins', exact: true }).click()
  const panel = page.locator('[data-plugin-panel]')
  const names = ['dsh-boot-animation', 'dsh-plugin-afp', 'dsh-plugin-codex-subscription', 'dsh-plugin-style-prompt', 'dsh-plugin-visual-curator']
  for (const name of names) {
    const card = panel.locator(`[data-plugin-package="${name}"]`)
    await card.waitFor()
    await expect.poll(() => card.locator('img').first().evaluate(image => image instanceof HTMLImageElement
      && image.complete && image.naturalWidth === 512 && image.naturalHeight === 512)).toBe(true)
    expect(await card.locator('img').first().evaluate(image => image.getBoundingClientRect().width)).toBe(36)
    await card.getByRole('button', { name: /^View / }).click()
    const detail = panel.locator(`[data-plugin-detail="${name}"]`)
    await detail.waitFor()
    expect(await detail.locator('img').first().evaluate(image => image.getBoundingClientRect().width)).toBeGreaterThanOrEqual(56)
    if (name === 'dsh-plugin-afp') {
      await page.setViewportSize({ width: 390, height: 844 })
      expect(await detail.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true)
      await page.setViewportSize({ width: 1440, height: 960 })
    }
    expect(await detail.locator('[data-detail-document]').count()).toBe(0)
    await detail.getByRole('button', { name: 'Details', exact: true }).click()
    const dialog = page.getByRole('dialog', { name: 'Details', exact: true })
    await dialog.waitFor()
    await dialog.locator('[data-detail-document]').waitFor()
    expect(await dialog.innerText()).not.toContain('Reading details')
    await page.keyboard.press('Escape')
    await dialog.waitFor({ state: 'detached' })
    if (name === 'dsh-plugin-visual-curator') {
      await detail.getByRole('switch', { name: 'Enable feature Global panel', exact: true }).click()
    }
    await detail.getByRole('button', { name: 'Back to plugins', exact: true }).click()
  }

  for (const glyph of ['search-outline', 'inspect-outline', 'list-pen-outline']) {
    const icon = navigation.locator(`svg[data-icon="dsw-icon-${glyph}-regular"]`)
    await icon.waitFor()
    expect(await icon.evaluate(element => ({
      height: element.getBoundingClientRect().height,
      inheritedColor: getComputedStyle(element).color === getComputedStyle(element.closest('button')!).color,
      hasRasterLogo: element.closest('button')!.querySelector('img') !== null,
    }))).toEqual({ height: 18, inheritedColor: true, hasRasterLogo: false })
  }

  await panel.locator('[data-plugin-package="dsh-boot-animation"]').getByRole('button', { name: /^View / }).click()
  const boot = panel.locator('[data-plugin-detail="dsh-boot-animation"]')
  expect(await boot.getByRole('switch').first().getAttribute('aria-checked')).toBe('true')
  await page.setViewportSize({ width: 390, height: 844 })
  await boot.getByRole('button', { name: 'Details', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: 'Details', exact: true })
  await dialog.waitFor()
  expect(await dialog.evaluate((element) => {
    const rect = element.getBoundingClientRect()
    return rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight
  })).toBe(true)
  await dialog.getByRole('button', { name: 'Close', exact: true }).click()
  await dialog.waitFor({ state: 'detached' })
}, 60_000)

it('does not request or display startup video on a new document after disabling the bundle or its feature', async () => {
  const management = await browser.newPage({ locale: 'en-US', reducedMotion: 'no-preference' })
  try {
    await management.goto(scaffold.authenticatedUrl)
    await management.locator('[data-dsh-startup-animation]').waitFor({ state: 'detached', timeout: 35_000 })
    await management.getByRole('navigation', { name: 'Global panels' }).getByRole('button', { name: 'Plugins', exact: true }).click()
    await management.locator('[data-plugin-package="dsh-boot-animation"]').getByRole('button', { name: /^View / }).click()
    const detail = management.locator('[data-plugin-detail="dsh-boot-animation"]')
    for (const target of ['bundle', 'feature']) {
      const toggle = target === 'bundle' ? detail.getByRole('switch').first()
        : detail.getByRole('switch', { name: 'Enable feature Startup animation', exact: true })
      await toggle.click()
      await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('false')
      await expect.poll(() => toggle.isEnabled(), { timeout: 30_000, message: `Save disabled ${target}` }).toBe(true)
      const fresh = await browser.newPage({ locale: 'en-US', reducedMotion: 'no-preference' })
      try {
        const requests: string[] = []
        fresh.on('request', (request) => { if (/cyberpunk.*\.mp4/.test(request.url())) requests.push(request.url()) })
        await fresh.goto(scaffold.authenticatedUrl)
        await fresh.waitForSelector('[data-slot="sidebar"]', { timeout: 30_000 })
        expect(await fresh.locator('[data-dsh-startup-animation], video').count(), `disabled ${target}`).toBe(0)
        expect(requests).toEqual([])
      } finally { await fresh.close() }
      if (target === 'bundle') {
        await toggle.click()
        await expect.poll(() => toggle.getAttribute('aria-checked')).toBe('true')
        await expect.poll(() => toggle.isEnabled(), { timeout: 30_000, message: 'Save enabled bundle' }).toBe(true)
      }
    }
  } finally { await management.close() }
}, 120_000)
