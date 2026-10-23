import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { cordisConfigFiles, readCordisConfig } from './cordis-config-files.ts'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('cordisConfigFiles', () => {
  it('resolves only index-declared link stubs and rejects cycles and escaping targets', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-cordis-config-links-'))
    roots.push(root)
    execFileSync('git', ['init', '--quiet', root])
    mkdirSync(join(root, 'config'))
    writeFileSync(join(root, 'target.yml'), '[]\n', 'utf8')
    const link = (name: string, target: string): void => {
      writeFileSync(join(root, name), target, 'utf8')
      const hash = execFileSync('git', ['hash-object', '-w', '--stdin'], { cwd: root, input: target, encoding: 'utf8' }).trim()
      execFileSync('git', ['update-index', '--add', '--cacheinfo', `120000,${hash},${name}`], { cwd: root })
    }
    link('config/cordis.yml', '../target.yml')
    expect(readCordisConfig(root, 'config/cordis.yml')).toBe('[]\n')
    link('bare.cordis.yml', 'target.yml')
    expect(readCordisConfig(root, 'bare.cordis.yml')).toBe('[]\n')
    writeFileSync(join(root, 'plain.yml'), './target.yml', 'utf8')
    expect(readCordisConfig(root, 'plain.yml')).toBe('./target.yml')
    link('config/cordis.yml', '../config/cordis.yml')
    expect(() => readCordisConfig(root, 'config/cordis.yml')).toThrow('Cyclic')
    link('config/cordis.yml', '../../outside.yml')
    expect(() => readCordisConfig(root, 'config/cordis.yml')).toThrow('leaves repository')
  })
  it('finds Loader YAML without treating translation records as configs', () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-cordis-config-files-'))
    roots.push(root)
    for (const directory of ['.claude', 'apps/cli/config/examples', 'docs', 'node_modules/pkg', 'vendor/pkg']) {
      mkdirSync(join(root, directory), { recursive: true })
    }
    for (const file of [
      '.claude/hidden.cordis.yml',
      'docs/cordis-primer.i18n.yaml',
      'apps/cli/config/examples/agent.cordis.yaml',
      'apps/cli/config/examples/headless.cordis.yml',
      'node_modules/pkg/hidden.cordis.yml',
      'vendor/pkg/hidden.cordis.yml',
    ]) {
      writeFileSync(join(root, file), '[]\n')
    }

    expect(cordisConfigFiles(root)).toEqual([
      join('apps', 'cli', 'config', 'examples', 'agent.cordis.yaml'),
      join('apps', 'cli', 'config', 'examples', 'headless.cordis.yml'),
    ])
  })
})
