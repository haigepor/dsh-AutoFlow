/** AutoFlow main checks use hosted runners without credentials or publication. */
import { readFileSync } from 'node:fs'
import * as yaml from 'js-yaml'
import { describe, expect, it } from 'vitest'

const source = readFileSync(new URL('../.github/workflows/autoflow-ci.yml', import.meta.url), 'utf8')
const workflow = yaml.load(source) as {
  on: { push: { branches: string[] }; workflow_dispatch: null }
  permissions: Record<string, string>
  env: Record<string, string>
  jobs: Record<string, { if: string; 'runs-on': string; 'timeout-minutes': number; steps: { run?: string; uses?: string; with?: Record<string, unknown>; env?: Record<string, string> }[] }>
}

describe('AutoFlow main CI', () => {
  it('runs only main pushes and explicit main dispatches with read permissions', () => {
    expect(workflow.on).toEqual({ push: { branches: ['main'] }, workflow_dispatch: null })
    expect(workflow.permissions).toEqual({ contents: 'read' })
    expect(workflow.env.DSH_TELEMETRY_DISABLED).toBe('1')
    expect(workflow.env.DSH_CLI_HELP_CONCURRENCY).toBe('2')
    for (const job of Object.values(workflow.jobs)) {
      expect(job.if).toBe("github.ref == 'refs/heads/main'")
      expect(['ubuntu-24.04', 'windows-2025']).toContain(job['runs-on'])
      expect(job['timeout-minutes']).toBeGreaterThan(0)
      expect(job.steps).toContainEqual({ run: 'pnpm install --frozen-lockfile' })
      expect(job.steps.find(step => step.uses?.startsWith('actions/checkout@'))?.with)
        .toMatchObject({ 'persist-credentials': false })
    }
    expect(source).not.toMatch(/secrets\.|pull_request_target|continue-on-error|git push|npm publish/)
  })

  it('keeps static, full fork builds, style regressions and Linux keyless replay blocking', () => {
    expect(workflow.jobs.static?.steps).toContainEqual(expect.objectContaining({ run: 'pnpm run check:ci:static' }))
    const client = workflow.jobs['client-and-replay']
    expect(client?.steps).toContainEqual(expect.objectContaining({ run: 'pnpm run build' }))
    expect(client?.steps).toContainEqual(expect.objectContaining({ run: 'pnpm run hygiene' }))
    expect(client?.steps).toContainEqual(expect.objectContaining({ run: 'pnpm run check:ci:lint:contracts-ready' }))
    const commands = client?.steps.map(step => step.run).join('\n') ?? ''
    for (const owner of ['ui-theme/tests', 'ui-settings-general/tests', 'ui-settings-models/tests', 'ui-plugin-manager/tests']) {
      expect(commands).toContain(owner)
    }
    for (const job of [client, workflow.jobs.windows]) {
      expect(job?.steps).toContainEqual(expect.objectContaining({ run: "pnpm --filter './custom-plugins/workspace/**' --workspace-concurrency=1 run test" }))
      expect(job?.steps.some(step => step.run?.includes('scripts/prepare-ci-bubblewrap.spec.ts'))).toBe(true)
    }
    expect(commands).toContain("pnpm run test:snapshot snapshots/session/headless.snapshot.ts -t 'text-turn|tool-call-turn'")
    expect(workflow.jobs.windows?.steps).toContainEqual(expect.objectContaining({ run: 'pnpm run verify-cordis-config' }))
  })
})
