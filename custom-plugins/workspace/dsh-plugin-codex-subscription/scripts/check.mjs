/** Check the Host package and its tests as separate programs. */
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
for (const project of ['tsconfig.json', 'tsconfig.tests.json']) {
  const result = spawnSync(process.execPath, [require.resolve('typescript/bin/tsc'), '--noEmit', '-p', project], { stdio: 'inherit', cwd: new URL('../', import.meta.url) })
  if (result.error) throw result.error
  if (result.status !== 0) process.exit(result.status ?? 1)
}
