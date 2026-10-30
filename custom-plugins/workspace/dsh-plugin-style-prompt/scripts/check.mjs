/** Check source and test programs independently of the application build. */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
for (const face of ['host', 'client', 'tests']) {
  const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '-p', `tsconfig.${face}.json`], { cwd: new URL('../', import.meta.url), stdio: 'inherit' })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
