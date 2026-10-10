import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { load } from 'js-yaml'
import { describe, expect, it } from 'vitest'

interface Step {
  name?: string
  uses?: string
  run?: string
  if?: string
  with?: Record<string, unknown>
  env?: Record<string, string>
}
interface Workflow {
  on: Record<string, { inputs: Record<string, { required: boolean; type: string; options?: string[]; default?: unknown }> }>
  permissions: Record<string, string>
  concurrency: Record<string, unknown>
  jobs: Record<string, { 'runs-on': string; 'timeout-minutes': number; environment: string; if: string; env: Record<string, string>; permissions?: unknown; steps: Step[] }>
}
const workflow = load(readFileSync(resolve(import.meta.dirname, '../.github/workflows/desktop-macos-build.yml'), 'utf8')) as Workflow

function guardrails(value: Workflow): void {
  expect(Object.keys(value.on)).toEqual(['workflow_dispatch'])
  expect(value.permissions).toEqual({ contents: 'read' })
  expect(Object.keys(value.jobs)).toEqual(['arm64'])
  const job = value.jobs.arm64!
  for (const step of job.steps.filter(step => Object.values(step.env ?? {}).some(entry => entry.includes('secrets.')))) {
    expect(step.if).toBe("inputs.signing == 'signed'")
  }
  expect(job.permissions).toBeUndefined()
  expect(job['runs-on']).toBe('macos-15')
  expect(job.if).toContain("github.repository == 'haigepor/dsh-AutoFlow'")
  expect(job.if).toContain("github.ref == 'refs/heads/main'")
  for (const step of job.steps) {
    if (step.uses !== undefined) expect(step.uses).toMatch(/^[\w/-]+@[0-9a-f]{40}$/u)
    expect(step.run ?? '').not.toMatch(/publish:github|upload:mac|gh release|deploy-pages|prepare:desktop|--build-version auto/u)
    expect(step.run ?? '').not.toContain('${{ inputs.')
  }
  const cleanup = job.steps.find(step => step.run?.endsWith('desktop-macos-ci.mjs cleanup'))
  const diagnostics = job.steps.find(step => step.run?.endsWith('desktop-macos-ci.mjs diagnostics'))
  expect(cleanup?.if).toBe("always() && steps.initialize.outcome == 'success'")
  expect(diagnostics?.if).toBe(cleanup?.if)
  const uploads = job.steps.filter(step => step.uses?.startsWith('actions/upload-artifact@'))
  expect(uploads).toHaveLength(2)
  expect(uploads.map(step => step.with?.path).sort()).toEqual(['${{ env.DESKTOP_MACOS_DELIVERABLES }}', '${{ env.DESKTOP_MACOS_DIAGNOSTICS }}'].sort())
  for (const step of uploads) {
    expect(step.with?.['retention-days']).toBe(7)
    expect(step.with?.['include-hidden-files']).toBeUndefined()
  }
  expect(uploads.find(step => step.with?.path === '${{ env.DESKTOP_MACOS_DELIVERABLES }}')?.if).toBe("success() && steps.stage.outcome == 'success'")
}

describe('artifact-only native macOS Desktop workflow', () => {
  it('retains manual triggering, least privilege, pinned actions and failure cleanup', () => { guardrails(workflow) })

  it('requires an explicit deployment, full version and exact source commit', () => {
    const inputs = workflow.on.workflow_dispatch!.inputs
    expect(Object.keys(inputs).sort()).toEqual(['deployment', 'expected_commit', 'signing', 'version'])
    for (const input of Object.values(inputs)) { expect(input.required).toBe(true); expect(input.default).toBeUndefined() }
    expect(inputs.deployment?.options).toEqual(['unconfirmed', 'test', 'production'])
    expect(inputs.signing?.options).toEqual(['unconfirmed', 'signed', 'unsigned'])
    const job = workflow.jobs.arm64!
    expect(job.env).toMatchObject({ BUILD_VERSION: '${{ inputs.version }}', EXPECTED_COMMIT: '${{ inputs.expected_commit }}', DEPLOYMENT: '${{ inputs.deployment }}' })
    expect(job.environment).toContain('desktop-macos-production')
    expect(job.environment).toContain('desktop-macos-test')
    expect(job['timeout-minutes']).toBe(180)
    expect(workflow.concurrency['cancel-in-progress']).toBe(false)
  })

  it('uses fresh locked dependencies and the complete existing package entry after preflight', () => {
    const steps = workflow.jobs.arm64!.steps
    const commands = steps.map(step => step.run ?? '')
    expect(commands.some(command => command.includes('pnpm --dir apps/desktop run check:package "${args[@]}"'))).toBe(true)
    expect(commands.some(command => command.includes('pnpm run package:desktop:mac:arm64 "${args[@]}"'))).toBe(true)
    for (const command of commands.filter(command => command.includes('"${args[@]}"'))) {
      expect(command).toContain('if [[ "$SIGNING_MODE" == \'unsigned\' ]]; then args+=(--unsigned); fi')
      expect(command).toContain('--build-version "$BUILD_VERSION"')
    }
    const initialize = commands.findIndex(command => command.endsWith('desktop-macos-ci.mjs init'))
    const install = commands.findIndex(command => command.includes('pnpm install --frozen-lockfile'))
    const configure = commands.findIndex(command => command.endsWith('desktop-macos-ci.mjs prepare'))
    const preflight = commands.findIndex(command => command.includes('pnpm --dir apps/desktop run check:package'))
    const build = commands.findIndex(command => command.includes('pnpm run package:desktop:mac:arm64'))
    expect(initialize).toBeLessThan(install)
    expect(install).toBeLessThan(configure)
    expect(configure).toBeLessThan(preflight)
    expect(preflight).toBeLessThan(build)
    expect(steps.find(step => step.uses?.startsWith('actions/checkout@'))?.with?.['persist-credentials']).toBe(false)
    expect(steps.find(step => step.uses?.startsWith('actions/setup-node@'))?.with).toMatchObject({ 'node-version': '24.14.0', architecture: 'arm64', cache: 'pnpm' })
    expect(steps.find(step => step.uses?.startsWith('actions/setup-node@'))?.with?.['cache-dependency-path']).toBe('pnpm-lock.yaml\n.github/workflows/desktop-macos-build.yml\n')
    expect(steps.filter(step => Object.values(step.env ?? {}).some(value => value.includes('secrets.')))).toHaveLength(1)
    const signed = steps.find(step => Object.values(step.env ?? {}).some(value => value.includes('secrets.')))
    expect(signed?.if).toBe("inputs.signing == 'signed'")
    const unsigned = steps.find(step => step.env?.DESKTOP_APP_ID === '${{ vars.DESKTOP_UNSIGNED_APP_ID }}')
    expect(unsigned?.if).toBe("inputs.signing == 'unsigned'")
    expect(unsigned?.run).toBe('node apps/desktop/scripts/desktop-macos-ci.mjs prepare')
  })

  it.each(['automatic-trigger', 'write-permission', 'publish-step', 'missing-cleanup', 'broad-upload', 'unsigned-secrets'])('rejects a dangerous workflow mutation: %s', (mutation) => {
    const changed = structuredClone(workflow)
    const steps = changed.jobs.arm64!.steps
    if (mutation === 'automatic-trigger') changed.on.push = { inputs: {} }
    else if (mutation === 'write-permission') changed.permissions.contents = 'write'
    else if (mutation === 'publish-step') steps.push({ run: 'pnpm --dir apps/desktop run publish:github mac-arm64' })
    else if (mutation === 'missing-cleanup') changed.jobs.arm64!.steps = steps.filter(step => !step.run?.endsWith('desktop-macos-ci.mjs cleanup'))
    else if (mutation === 'unsigned-secrets') delete steps.find(step => Object.values(step.env ?? {}).some(entry => entry.includes('secrets.')))!.if
    else steps.find(step => step.uses?.startsWith('actions/upload-artifact@'))!.with!.path = 'apps/desktop/.desktop-build/**'
    expect(() =>{  guardrails(changed) }).toThrow()
  })
})
