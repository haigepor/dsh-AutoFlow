/** Check each compiler face explicitly; the solution is never an aggregate program. */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
for (const face of ['host', 'client', 'tests']) {
  const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '-p', `tsconfig.${face}.json`], { stdio: 'inherit', cwd: new URL('../', import.meta.url) })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
