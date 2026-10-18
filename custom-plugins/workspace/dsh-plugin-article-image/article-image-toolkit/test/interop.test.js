/** The harness MCP client generation (v2) must drive this toolkit's server (v1 SDK). */
import { describe, expect, it, beforeAll, afterAll } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

const ENTRY = fileURLToPath(new URL('../bin/article-image-toolkit.js', import.meta.url))

let dir, client

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'article-image-interop-'))
  client = new Client({ name: 'interop', version: '1.0.0' })
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [ENTRY, '--data-dir', dir] }))
}, 60000)

afterAll(async () => {
  await client?.close()
  await rm(dir, { recursive: true, force: true })
})

describe('cross-generation interop', () => {
  it('lists tools through a v2 client', async () => {
    const { tools } = await client.listTools()
    expect(tools).toHaveLength(18)
    expect(tools.map(tool => tool.name)).toContain('article_image_diagnostics')
    expect(tools.map(tool => tool.name)).toContain('article_image_save_plan')
    expect(tools.map(tool => tool.name)).toContain('article_image_capture_record')
  })

  it('calls a tool and parses its JSON result', async () => {
    const result = await client.callTool({ name: 'article_image_status', arguments: {} })
    expect(result.isError).toBeFalsy()
    expect(JSON.parse(result.content[0].text).count).toBe(0)
  })

  it('preserves the owned error code across generations', async () => {
    const result = await client.callTool({ name: 'article_image_items', arguments: { offset: -5 } })
    expect(result.isError).toBe(true)
    expect(result.content[0].text).toBe('invalid-request')
  })
})
