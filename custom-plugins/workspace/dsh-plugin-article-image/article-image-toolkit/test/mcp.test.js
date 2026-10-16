/** End-to-end smoke test: real MCP stdio handshake, tool listing and a tool call. */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'

const ENTRY = fileURLToPath(new URL('../bin/article-image-toolkit.js', import.meta.url))
const SHEET_URL = 'https://docs.google.com/spreadsheets/d/1qggSoBOoLrdHOM-Y3YGaMUTQ3BwphWohVeDtOABWRCg/edit#gid=461869238'
const sampleCsv = readFileSync(fileURLToPath(new URL('./fixtures/sample-sheet.csv', import.meta.url)), 'utf8')

let dir, client, transport, fixtureServer

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'article-image-mcp-'))
  // fixture 服务器提供 CSV 与文章页面，使冒烟测试不依赖外网。
  const { createServer } = await import('node:http')
  fixtureServer = createServer((request, response) => {
    if (request.url.startsWith('/sheet')) {
      response.writeHead(200, { 'content-type': 'text/csv' }); response.end(sampleCsv); return
    }
    const body = `<html lang="pt-BR"><head><title>Roteiro</title></head><body><article><h1>Roteiro</h1>${
      Array.from({ length: 14 }, (_, index) => `<p>Parágrafo ${index + 1} com conteúdo suficiente para passar do limite mínimo de extração configurado.</p>`).join('')
    }</article></body></html>`
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); response.end(body)
  })
  await new Promise(resolve => fixtureServer.listen(0, '127.0.0.1', resolve))
  transport = new StdioClientTransport({ command: process.execPath, args: [ENTRY, '--data-dir', dir] })
  client = new Client({ name: 'smoke', version: '1.0.0' })
  await client.connect(transport)
}, 60000)

afterAll(async () => {
  await client?.close()
  await new Promise(resolve => fixtureServer?.close(resolve))
  await rm(dir, { recursive: true, force: true })
})

describe('MCP stdio surface', () => {
  it('lists the article image tools with JSON-Schema inputs', async () => {
    const { tools } = await client.listTools()
    expect(tools.map(tool => tool.name)).toContain('article_image_import')
    expect(tools.map(tool => tool.name)).toContain('article_image_save_plan')
    const importTool = tools.find(tool => tool.name === 'article_image_import')
    expect(importTool.inputSchema.type).toBe('object')
    expect(importTool.inputSchema.required).toContain('url')
  })

  it('runs status over the real transport', async () => {
    const result = await client.callTool({ name: 'article_image_status', arguments: {} })
    expect(result.isError).toBeFalsy()
    const status = JSON.parse(result.content[0].text)
    expect(status.count).toBe(0)
    expect(status.generation.available).toBe(false)
  })

  it('returns an owned error code for invalid arguments instead of a stack trace', async () => {
    const result = await client.callTool({ name: 'article_image_items', arguments: { offset: -5 } })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe('invalid-request')
  })

  it('reports an unknown tool without crashing the session', async () => {
    const result = await client.callTool({ name: 'article_image_does_not_exist', arguments: {} })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe('unknown-tool')
  })

  it('keeps the session alive after an error', async () => {
    const result = await client.callTool({ name: 'article_image_status', arguments: {} })
    expect(result.isError).toBeFalsy()
  })
})
