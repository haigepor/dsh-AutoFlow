/** Parser defaults are complete on the first parse and remain valid after Cordis resolves them. */
import { test, expect } from 'vitest'
import { resolveConfig, Config } from '../config-schema.js'

test('resolves nested capture and analysis defaults before any consumer runs', () => {
  const config = resolveConfig()
  expect(config.capture.maxImageBytes).toBe(12000000)
  expect(config.capture.adapters).toEqual([])
  expect(config.analysis.maxTokens).toBe(6000)
  expect(config.analysis.concurrency).toBe(1)
  expect(config.maxAssetBytes).toBe(config.capture.maxImageBytes)
})

test('accepts already-resolved Cordis values and an explicit compatible asset limit', () => {
  const first = Config['~standard'].validate({ maxAssetBytes: 4000000, capture: { maxImageBytes: 3000000 } }).value
  expect(resolveConfig(first)).toEqual(first)
  expect(first.maxAssetBytes).toBe(4000000)
})

test('inherits the plugin network route into capture without replacing adapters or analysis settings', () => {
  const input = { network: { proxyUrl: 'http://127.0.0.1:7897', dnsProvider: 'cloudflare' },
    capture: { adapters: [{ id: 'publisher', hosts: ['news.example.test'], articleSelector: 'article' }] },
    analysis: { provider: 'configured-provider', model: 'configured-model' } }
  const config = resolveConfig(input)
  expect(config.capture.network).toEqual(config.network)
  expect(config.capture.network).toMatchObject(input.network)
  expect(config.capture.adapters).toEqual(expect.arrayContaining([expect.objectContaining({ id: 'publisher' })]))
  expect(config.analysis).toMatchObject(input.analysis)
  const validated = Config['~standard'].validate(input)
  expect(validated.issues).toBeUndefined()
  expect(resolveConfig(validated.value)).toEqual(config)
})

test('keeps an explicit capture network override through repeated Cordis parsing', () => {
  const input = { network: { proxyUrl: 'http://127.0.0.1:7897', dnsProvider: 'cloudflare' }, capture: { network: { dnsProvider: 'system' } } }
  const config = resolveConfig(input)
  expect(config.capture.network.dnsProvider).toBe('system')
  expect(config.capture.network.proxyUrl).toBeUndefined()
  expect(resolveConfig(config)).toEqual(config)
})

test('rejects credentialed proxies and malformed capture values rather than masking them during inheritance', () => {
  expect(() => resolveConfig({ network: { proxyUrl: 'http://user:secret@127.0.0.1:7897' } })).toThrow()
  for (const capture of [null, [], 'invalid']) expect(() => resolveConfig({ network: { dnsProvider: 'cloudflare' }, capture })).toThrow()
})
