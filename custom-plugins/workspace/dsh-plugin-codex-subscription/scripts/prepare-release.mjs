/** Prepare the Host-only subscription bundle using the shared release protocol. */
import { fileURLToPath } from 'node:url'
import { resolve } from 'node:path'
import { prepareRelease } from '../../../release-governance/prepare-plugin-release.mjs'
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  // 发布验收必须读取实际构建入口，不能静默跳过分发回归。
  process.env.DSH_CODEX_VERIFY_BUILT = '1'
  await prepareRelease({ packageRoot: fileURLToPath(new URL('../', import.meta.url)), expectedPackage: 'dsh-plugin-codex-subscription', packageManager: process.env.npm_execpath })
}
