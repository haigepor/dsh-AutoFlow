/** Run the preview workflow and its original-output and observation regressions without external services. */
import { spawnSync } from 'node:child_process'

const result = spawnSync(process.execPath, ['--import', 'tsx/esm', '--test',
  'tests/preview-search-flow.test.ts', 'tests/search-workflow.test.ts',
  'tests/style-matching.test.ts', 'tests/conversation-feedback.test.ts',
  'tests/unsplash.test.ts', 'tests/plugin-tools.test.ts',
  'tests/search-batches.test.ts', 'tests/search-batches-client.test.ts',
  'tests/search-launch-client.test.ts', 'tests/search-launch.test.ts',
], { cwd: new URL('../', import.meta.url), stdio: 'inherit' })
if (result.error) throw result.error
process.exitCode = result.status ?? 1
