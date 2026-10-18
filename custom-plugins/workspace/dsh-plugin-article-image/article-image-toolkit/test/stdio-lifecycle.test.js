/** EOF shuts down the real stdio owner before a clean process exit. */
import { expect, it } from 'vitest'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createInterface } from 'node:readline'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Client } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'

it('awaits service disposal after the parent closes stdin', async () => {
  const root = await mkdtemp(join(tmpdir(), 'article-stdio-eof-'))
  const child = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/foundation-server.mjs', import.meta.url)), root], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:path|systemroot|temp|tmp)$/i.test(name))),
  })
  const exited = once(child, 'exit')
  const lines = createInterface({ input: child.stdout })
  let errorText = ''
  child.stderr.on('data', value => { errorText += value })
  try {
    const ready = once(lines, 'line')
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'eof-fixture', version: '1' } } }) + '\n')
    expect(JSON.parse((await ready)[0]).id).toBe(1)
    child.stdin.end()
    const [code, signal] = await exited
    expect({ code, signal, errorText }).toEqual({ code: 0, signal: null, errorText: '' })
    expect(await readFile(join(root, 'disposed'), 'utf8')).toBe('closed\n')
  } finally {
    lines.close()
    if (child.exitCode === null && child.signalCode === null) { child.kill(); await exited }
    await rm(root, { recursive: true, force: true })
  }
}, 30000)

it('carries progress and diagnostics over stdio to the harness client generation', async () => {
  const root = await mkdtemp(join(tmpdir(), 'article-stdio-progress-'))
  const client = new Client({ name: 'stdio-progress', version: '1' })
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [fileURLToPath(new URL('./fixtures/foundation-server.mjs', import.meta.url)), root], stderr: 'pipe',
    env: Object.fromEntries(Object.entries(process.env).filter(([name]) => /^(?:path|systemroot|temp|tmp)$/i.test(name))),
  })
  const updates = [], notifications = []
  try {
    await client.connect(transport)
    const onmessage = transport.onmessage
    transport.onmessage = message => {
      if (message.method === 'notifications/progress') notifications.push(message.params)
      onmessage(message)
    }
    const result = await client.callTool({ name: 'article_image_capture_source', arguments: { url: 'https://articles.example.test/story' } }, { onprogress: event => { updates.push(event) } })
    expect(result.isError).toBeFalsy()
    const value = JSON.parse(result.content[0].text)
    // v2 SDK 异步派发通知；同一 stdio 数据块中的结果可先移除进度回调。按线上帧核验终止通知。
    expect(notifications.map(event => event.message)).toEqual(['queued: started', 'rendering: navigation-start', 'completed: completed'])
    expect(updates.every(event => notifications.some(message => message.progress === event.progress && message.message === event.message))).toBe(true)
    const diagnostic = await client.callTool({ name: 'article_image_diagnostics', arguments: { diagnosticId: value.diagnosticId } })
    expect(JSON.parse(diagnostic.content[0].text).state).toBe('completed')
  } finally { await client.close(); await rm(root, { recursive: true, force: true }) }
}, 30000)
