/** Open a visible browser (Playwright engine) with a renderer profile so a person can sign in by hand. */
import { mkdirSync } from 'node:fs'

const dir = process.argv[2] ?? process.env.ARTICLE_IMAGE_RENDER_USER_DATA_DIR
if (!dir) {
  console.error('usage: node scripts/login.mjs <profile-dir>')
  process.exit(1)
}
mkdirSync(dir, { recursive: true })
let chromium
try {
  ({ chromium } = await import('patchright'))
} catch (error) {
  // 包缺失与浏览器二进制缺失给出同一条可操作提示。
  void error
  console.error('patchright is not installed: npm install patchright && npx patchright install chromium')
  process.exit(1)
}
const context = await chromium.launchPersistentContext(dir, { headless: false })
const page = context.pages()[0] ?? await context.newPage()
await page.goto('about:blank')
console.log(`Sign in through this window, then close it. Renders with --render-user-data-dir ${dir} reuse the session.`)
await new Promise(resolve => context.once('close', resolve))
