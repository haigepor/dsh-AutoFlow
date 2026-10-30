/** Keyless browser coverage for sidebar disclosure motion and shared navigation feedback. */
import { fileURLToPath } from 'node:url'
import type { Locator } from 'playwright'
import { chromium } from 'playwright'
import { expect, it, onTestFinished } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, watchConsole, webSnapshotMode,
} from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const EXPECTED = fileURLToPath(new URL('./expected/sidebar-navigation/more.expected.md', import.meta.url))

/**
 * Sample a real disclosure transition at its midpoint without depending on frame timing.
 * @param trigger - More button controlling the inline menu.
 * @returns Height interpolation and accessibility state while the transition is active.
 */
async function sampleDisclosure(trigger: Locator) {
  return trigger.evaluate(async (button: HTMLButtonElement) => {
    button.click()
    await new Promise(requestAnimationFrame)
    const menu = document.getElementById(button.getAttribute('aria-controls')!)!
    const disclosure = menu.closest<HTMLElement>('[aria-hidden]')!
    const animations = disclosure.getAnimations()
    for (const animation of animations) {
      animation.pause()
      animation.currentTime = Number(animation.effect!.getTiming().duration) / 2
    }
    const height = disclosure.getBoundingClientRect().height
    const fullHeight = disclosure.firstElementChild!.scrollHeight
    const result = {
      animated: animations.some(animation => animation instanceof CSSTransition && animation.transitionProperty === 'grid-template-rows'),
      intermediate: height > 0 && height < fullHeight,
      ariaHidden: disclosure.getAttribute('aria-hidden'),
      inert: disclosure.inert,
    }
    for (const animation of animations) animation.finish()
    return result
  })
}

it('animates More in both directions and glides onto New Session in both themes', async () => {
  const scaffold = await launchWebScaffold({
    extraOverlayPath: fileURLToPath(new URL('./pin-browse-picker.overlay.yml', import.meta.url)),
  })
  onTestFinished(() => scaffold.close())
  const browser = await chromium.launch()
  onTestFinished(() => browser.close())
  const page = await newEnglishPage(browser)
  const tripwire = watchConsole(page)
  await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
  const navigation = page.getByRole('navigation', { name: 'Global panels' })
  const more = navigation.getByRole('button', { name: 'More', exact: true })
  await more.waitFor()
  const newSession = page.getByRole('button', { name: 'New session', exact: true }).filter({ hasText: 'New Session' })
  for (const colorScheme of ['light', 'dark'] as const) {
    await page.emulateMedia({ colorScheme })
    await more.hover()
    await newSession.hover()
    await expect.poll(() => newSession.evaluate((button) => {
      const layer = button.parentElement!.querySelector<HTMLElement>('[data-glide-placed]')!
      const style = getComputedStyle(layer)
      const target = button.getBoundingClientRect()
      const rect = layer.getBoundingClientRect()
      return style.visibility === 'visible' && style.opacity === '1'
        && style.backgroundColor !== 'rgba(0, 0, 0, 0)'
        && getComputedStyle(button).backgroundColor === 'rgba(0, 0, 0, 0)'
        && Math.abs(rect.top - target.top) < 1 && Math.abs(rect.height - target.height) < 1
    })).toBe(true)
  }

  expect(await sampleDisclosure(more)).toEqual({ animated: true, intermediate: true, ariaHidden: 'false', inert: false })
  await compareOrRefreshGolden(EXPECTED,
    await captureStableAria(page, 'nav[aria-label="Global panels"]', scaffold.workspaceCwd), webSnapshotMode())
  expect(await sampleDisclosure(more)).toEqual({ animated: true, intermediate: true, ariaHidden: 'true', inert: true })
  expect(await navigation.getByRole('menu').count()).toBe(0)

  await more.click()
  const firstAction = navigation.getByRole('menuitem').first()
  await firstAction.focus()
  await page.keyboard.press('Escape')
  expect(await more.evaluate(button => document.activeElement === button)).toBe(true)
  await more.click()
  await navigation.getByRole('menu').waitFor()
  expect(await more.getAttribute('aria-expanded')).toBe('true')
  await more.click()

  await page.emulateMedia({ reducedMotion: 'reduce' })
  await more.click()
  expect(await navigation.getByRole('menu').evaluate(menu => menu.closest('[aria-hidden]')!.getAnimations().length)).toBe(0)
  await more.click()
  expect(await navigation.getByRole('menu').count()).toBe(0)
  await page.getByRole('button', { name: 'Collapse sidebar', exact: true }).click()
  await expect.poll(() => more.getAttribute('aria-haspopup')).toBe('menu')
  await more.click()
  await page.getByRole('menu').waitFor()
  await page.keyboard.press('Escape')
  await expect.poll(() => page.getByRole('menu').count()).toBe(0)
  expect(tripwire.pageErrors).toEqual([])
  expect(tripwire.warnings).toEqual([])
})
