import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { test } from 'node:test'
import { runInNewContext } from 'node:vm'

const root = resolve(import.meta.dirname, '..')

test('published metadata names the demo, disabled features, locales, and icon', async () => {
  const manifest = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'))
  const patch = await readFile(resolve(root, manifest.dsh.bundle.patch), 'utf8')
  assert.equal(manifest.name, 'dsh-custom-plugin-demo')
  assert.deepEqual(manifest.dsh.bundle.features.map(item => item.id), ['prompt', 'skill', 'execute'])
  assert.deepEqual(manifest.dsh.bundle.examples.map(item => item.id), ['instructions', 'skill', 'tool'])
  for (const item of manifest.dsh.bundle.features) {
    assert.equal(item.defaultEnabled, false)
    assert.match(patch, new RegExp(`id: ${item.rowId}\\s+name: .*\\s+disabled: true`))
  }
  assert.equal(manifest.exports['./client'], './client.js')
  for (const locale of ['en', 'zh']) {
    const text = JSON.parse(await readFile(resolve(root, `locale/${locale}.json`), 'utf8'))
    assert.ok(text.meta.title && text.meta.description)
  }
  assert.match(await readFile(resolve(root, manifest.icon), 'utf8'), /^<svg /)
})

test('client contributes Settings navigation without a duplicate plugin detail panel', async () => {
  const code = await readFile(resolve(root, 'client.js'), 'utf8')
  let definition
  const names = []
  runInNewContext(code, { window: { __ModuleLoader__: { load: value => { definition = value } } } })
  assert.equal(definition.id, 'dsh-custom-plugin-demo')
  const plugin = definition.factory(name => {
    assert.equal(name, 'react')
    return { createElement: (tag, props, ...children) => ({ tag, props, children }) }
  })
  plugin.apply({
    effect: register => register(),
    locale: { register: () => () => {}, bind: () => key => key },
    slots: { inject: (name, register) => { names.push(name); register() }, register: () => () => {} },
  })
  assert.deepEqual(names, ['settings.section'])
})
