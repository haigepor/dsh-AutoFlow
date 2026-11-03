/** Prepare Style Prompt's exact-source package and update metadata. */
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { prepareRelease } from '../../../release-governance/prepare-plugin-release.mjs'

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareRelease({ packageRoot: fileURLToPath(new URL('../', import.meta.url)), expectedPackage: 'dsh-plugin-style-prompt', packageManager: process.env.npm_execpath })
}
