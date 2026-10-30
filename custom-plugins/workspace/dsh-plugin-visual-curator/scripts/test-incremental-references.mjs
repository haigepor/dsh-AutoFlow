/** Exercise collection deduplication, observation reuse, cancellation and client state without paid services. */
import { spawnSync } from 'node:child_process'
const result = spawnSync(process.execPath, ['--import', 'tsx/esm', '--test', 'tests/incremental-references.test.ts', 'tests/gallery-remote-reference.test.ts', 'tests/gallery-workflow.test.ts', 'tests/gallery-background.test.ts', 'tests/gallery-reference.test.ts', 'tests/analysis-recovery.test.ts', 'tests/analysis-runtime.test.ts', 'tests/analysis-client.test.ts'], { cwd: new URL('../', import.meta.url), stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
