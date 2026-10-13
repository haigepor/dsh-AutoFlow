/** Shared profile composition preserves per-entry inheritance and detached results.
 * Work-count spies require Vite-transformed source exports; native ESM namespaces are immutable.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import * as appBoot from '@deepseek-ai/dsh-app-boot'
import { configurationFixture } from './configuration-fixture.ts'

it('retains disabled row configuration without allowing inactive config changes or activation', async () => {
  const { ctx, profile, start } = await configurationFixture({ hmr: false })
  await ctx.fiber.dispose()
  writeFileSync(profile.patchPath, JSON.stringify([{ id: 'second', disabled: true }]), 'utf8')
  const disabled = await start()
  const entry = disabled.configEditor.entries().find(row => row.options.id === 'second')!
  expect(entry.fiber).toBeUndefined()
  await expect(disabled.configEditor.edit(entry, (value) => { value['ordinary'] = 'changed'; return value }, { retainOverride: true })).rejects.toThrow('no longer active')
  await expect(disabled.configEditor.edit(entry, value => value)).rejects.toThrow('no longer active')
  await disabled.configEditor.edit(entry, value => value, { retainOverride: true })
  expect(readFileSync(profile.patchPath, 'utf8')).toContain('ordinary: second')
  expect(entry.options.disabled).toBe(true)
  expect(entry.fiber).toBeUndefined()
})

it.each(['local style', 'saved style'])('retains deselected bundle configuration %s across replacement without mounting it', async (expected) => {
  const { ctx, profile, start } = await configurationFixture({ hmr: false })
  const bundleDir = join(profile.dir, 'node_modules', 'optional-bundle')
  mkdirSync(bundleDir, { recursive: true })
  writeFileSync(join(bundleDir, 'package.json'), JSON.stringify({ name: 'optional-bundle', version: '1.0.0', dsh: { bundle: { patch: 'cordis.patch.yml' } } }), 'utf8')
  const bundlePatch = join(bundleDir, 'cordis.patch.yml')
  const defaults = [{ insert: [{ id: 'optional', name: 'cordis:probe', config: { ordinary: 'local style' } }] }]
  writeFileSync(bundlePatch, JSON.stringify(defaults), 'utf8')
  const manifestPath = join(profile.dir, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as { dependencies: Record<string, string>; dsh: { profile: { bundles: string[] } } }
  manifest.dependencies['optional-bundle'] = '1.0.0'
  writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8')
  if (expected === 'saved style') writeFileSync(profile.patchPath, JSON.stringify([{ id: 'optional', config: { ordinary: expected } }]), 'utf8')
  await ctx.configEditor.retainDisabledBundle('optional-bundle')
  const saved = readFileSync(profile.patchPath, 'utf8')
  expect(saved).toContain(`ordinary: ${expected}`)
  await ctx.configEditor.retainDisabledBundle('optional-bundle')
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(saved)
  expect(ctx.configEditor.entries().some(row => row.options.id === 'optional')).toBe(false)
  expect(JSON.parse(readFileSync(manifestPath, 'utf8'))).toEqual(manifest)
  writeFileSync(bundlePatch, JSON.stringify([{ insert: [{ id: 'second', name: 'cordis:probe' }] }]), 'utf8')
  await expect(ctx.configEditor.retainDisabledBundle('optional-bundle')).rejects.toThrow('already in use')
  expect(readFileSync(profile.patchPath, 'utf8')).toBe(saved)
  await ctx.fiber.dispose()
  defaults[0]!.insert[0]!.config.ordinary = 'new official default'
  writeFileSync(bundlePatch, JSON.stringify(defaults), 'utf8')
  manifest.dsh.profile.bundles.push('optional-bundle')
  writeFileSync(manifestPath, JSON.stringify(manifest), 'utf8')
  const restored = await start()
  expect(restored.configEditor.entries().find(row => row.options.id === 'optional')?.options.config).toEqual({ ordinary: expected })
  await expect(restored.configEditor.retainDisabledBundle('optional-bundle')).rejects.toThrow('Bundle is selected')
})

it('retains an explicit inherited config across bundle default replacement when requested', async () => {
  const { ctx, profile, start } = await configurationFixture({ hmr: false })
  const entry = ctx.configEditor.entries().find(row => row.options.id === 'second')!
  await ctx.configEditor.edit(entry, current => current)
  expect(readFileSync(profile.patchPath, 'utf8')).not.toContain('ordinary: second')
  await ctx.configEditor.edit(entry, current => current, { retainOverride: true })
  expect(readFileSync(profile.patchPath, 'utf8')).toContain('ordinary: second')
  await ctx.fiber.dispose()
  const bundlePath = join(profile.dir, 'node_modules', 'test-bundle', 'cordis.patch.yml')
  const patches = JSON.parse(readFileSync(bundlePath, 'utf8')) as Array<{ insert: Array<{ id: string; config?: object }> }>
  patches[0]!.insert.find(row => row.id === 'second')!.config = { ordinary: 'new default' }
  writeFileSync(bundlePath, JSON.stringify(patches))
  const restored = await start()
  expect(restored.configEditor.entries().find(row => row.options.id === 'second')!.options.config).toEqual({ ordinary: 'second' })
})

it('shares composition for entries without config overrides while retaining group and insert inheritance', async () => {
  const { ctx, profile, start } = await configurationFixture({ hmr: false })
  await ctx.fiber.dispose()
  writeFileSync(profile.patchPath, JSON.stringify([
    { id: 'first', config: { ordinary: 'fixed', count: 8 } },
    { id: 'first', config: { ordinary: 'fixed', count: 9 } },
    { id: 'second', disabled: false },
    { insert: [
      { id: 'inserted', name: 'cordis:probe', config: { ordinary: 'inserted', count: 3 } },
      { id: 'group', name: 'cordis:group', group: true, config: [
        { id: 'nested', name: 'cordis:probe', config: { ordinary: 'original', count: 4 } },
      ] },
    ] },
    { id: 'inserted', config: { ordinary: 'inserted', count: 7 } },
    { id: 'group', config: [
      { id: 'nested', name: 'cordis:probe', config: { ordinary: 'replacement', count: 6 } },
    ] },
  ]))
  const restored = await start()
  const compose = vi.spyOn(appBoot, 'composeEntries')
  try {
    const rows = restored.configEditor.configuration()
    const inherited = Object.fromEntries(rows.map(row => [row.entry.options.id, row.inherited]))
    expect(inherited).toMatchObject({
      first: { ordinary: 'fixed', token: 'private' },
      second: { ordinary: 'second' },
      inserted: { ordinary: 'inserted', count: 3 },
      nested: { ordinary: 'replacement', count: 6 },
      group: [{ id: 'nested', name: 'cordis:probe', config: { ordinary: 'original', count: 4 } }],
    })
    expect(inherited['first']).not.toHaveProperty('count')
    expect(compose).toHaveBeenCalledTimes(4)
    const nested = rows.find(row => row.entry.options.id === 'nested')!
    nested.inherited['ordinary'] = 'mutated'
    expect(nested.entry.options.config).toMatchObject({ ordinary: 'replacement' })
    expect(restored.configEditor.configuration().find(row => row.entry.options.id === 'nested')!.inherited)
      .toEqual({ ordinary: 'replacement', count: 6 })
  } finally {
    compose.mockRestore()
  }
})

it('recomposes unoverridden entries after bundle changes and returns empty configs when absent', async () => {
  const { ctx, profile } = await configurationFixture({ hmr: false })
  const read = () => ctx.configEditor.configuration()
  const before = read()
  expect(before.find(row => row.entry.options.id === 'config-editor')!.inherited).toEqual({})
  const bundlePath = join(profile.dir, 'node_modules', 'test-bundle', 'cordis.patch.yml')
  const patches = JSON.parse(readFileSync(bundlePath, 'utf8')) as Array<{ insert: Array<{ id: string; config?: object }> }>
  patches[0]!.insert.find(row => row.id === 'second')!.config = { ordinary: 'new bundle value' }
  writeFileSync(bundlePath, JSON.stringify(patches))
  expect(read().find(row => row.entry.options.id === 'second')!.inherited).toEqual({ ordinary: 'new bundle value' })
  expect(before.find(row => row.entry.options.id === 'second')!.inherited).toEqual({ ordinary: 'second' })
  patches[0]!.insert.push({ id: 'second', config: { ordinary: 'duplicate' } })
  writeFileSync(bundlePath, JSON.stringify(patches))
  expect(read().find(row => row.entry.options.id === 'second')!.inherited).toEqual({ ordinary: 'new bundle value' })
})

it.each([0, 13, 190])('bounds composition work for 190 entries with %i config overrides', async (overrideCount) => {
  const { ctx, profile, start } = await configurationFixture({ hmr: false })
  await ctx.fiber.dispose()
  const bundlePath = join(profile.dir, 'node_modules', 'test-bundle', 'cordis.patch.yml')
  const patches = JSON.parse(readFileSync(bundlePath, 'utf8')) as Array<{ insert: Array<{ id: string; config?: object }> }>
  const entries = Array.from({ length: 185 }, (_, index) => ({
    id: `generated-${index}`, name: 'cordis:probe', config: { ordinary: `value-${index}` },
  }))
  patches[0]!.insert.push(...entries)
  writeFileSync(bundlePath, JSON.stringify(patches))
  writeFileSync(profile.patchPath, JSON.stringify(patches[0]!.insert.slice(0, overrideCount).map(entry => ({
    id: entry.id, config: entry.config ?? {},
  }))))
  const restored = await start()
  const compose = vi.spyOn(appBoot, 'composeEntries')
  try {
    const rows = restored.configEditor.configuration()
    expect(rows).toHaveLength(190)
    expect(rows.find(row => row.entry.options.id === 'generated-0')!.inherited).toEqual({ ordinary: 'value-0' })
    expect(compose).toHaveBeenCalledTimes(overrideCount + Number(overrideCount < rows.length))
  } finally {
    compose.mockRestore()
  }
})
