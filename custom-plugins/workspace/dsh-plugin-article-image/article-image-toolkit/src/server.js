/** MCP stdio server exposing article image planning tools to any agent client. */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { performance } from 'node:perf_hooks'
import { resolveConfig } from './config.js'
import { ArticleService } from './service.js'
import { createTools } from './tools.js'
import { errorCode } from './contracts.js'

/** Compile one tool's parameter schema into the JSON Schema MCP clients advertise. @param {object} schema Zod object schema. @returns {object} JSON Schema object. */
function parametersOf(schema) {
  // refine/transform 无法表达为 JSON Schema；降级为宽松对象，真正的校验由 handler 的 zod parse 完成。
  const json = z.toJSONSchema(schema, { io: 'input', unrepresentable: 'any' })
  delete json.$schema
  return json
}

/** Create the MCP server bound to one article service. @param {object} service Article service. @returns {Server} Configured MCP server. */
export function createServer(service) {
  const tools = createTools(service)
  const byName = new Map(tools.map(tool => [tool.name, tool]))
  const server = new Server({ name: 'article-image-toolkit', version: '0.1.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: tools.map(tool => ({
    name: tool.name, description: tool.description, inputSchema: parametersOf(tool.schema),
  })) }))
  server.setRequestHandler(CallToolRequestSchema, async (request, extra) => {
    const tool = byName.get(request.params.name)
    if (!tool) return { content: [{ type: 'text', text: 'unknown-tool' }], isError: true }
    const token = request.params._meta?.progressToken
    let finished = false, lastPhase = '', lastAt = -Infinity
    const progress = async event => {
      if (finished || extra.signal.aborted || token === undefined) return
      const now = performance.now(), terminal = ['completed', 'failed', 'cancelled'].includes(event.phase)
      if (!terminal && event.phase === lastPhase && now - lastAt < service.config.progressIntervalMs) return
      lastPhase = event.phase; lastAt = now
      try {
        await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: event.sequence, message: `${event.phase}: ${event.event}` } })
      } catch (error) { void error /* 客户端关闭或不接收通知，不影响正文结果。 */ }
    }
    try {
      const value = await tool.run(request.params.arguments ?? {}, extra.signal, progress)
      return { content: [{ type: 'text', text: JSON.stringify(value) }] }
    } catch (error) {
      // 只回传自有错误码；远端与解析器文本不进客户端。
      return { content: [{ type: 'text', text: errorCode(error) }], isError: true,
        ...(error.diagnosticId ? { _meta: { diagnosticId: error.diagnosticId } } : {}) }
    } finally { finished = true }
  })
  return server
}

/** Start an owned stdio server and await quiescent shutdown on EOF, close or signal. @param {object} input Config fields. @param {object} [dependencies] Optional service, streams and signal emitter. @returns {Promise<void>} Resolves after requests and resource cleanup settle. */
export async function start(input = {}, dependencies = {}) {
  const config = resolveConfig(input)
  const service = dependencies.service ?? new ArticleService(config)
  const server = createServer(service)
  const stdin = dependencies.stdin ?? process.stdin, signals = dependencies.signals ?? process
  const transport = new StdioServerTransport(stdin, dependencies.stdout ?? process.stdout)
  let closing, resolveClosed, rejectClosed
  const closed = new Promise((resolve, reject) => { resolveClosed = resolve; rejectClosed = reject })
  const close = () => {
    if (!closing) {
      closing = Promise.resolve().then(async () => {
        const results = await Promise.allSettled([service.dispose(), server.close()])
        const failed = results.find(result => result.status === 'rejected')
        if (failed) throw failed.reason
      })
      void closing.then(resolveClosed, rejectClosed)
    }
    return closing
  }
  const shutdown = () => { void close().catch(error => { void error /* closed 将关闭错误交给 start 调用方。 */ }) }
  server.onclose = shutdown
  stdin.once('end', shutdown)
  signals.once('SIGINT', shutdown); signals.once('SIGTERM', shutdown)
  try { await server.connect(transport); await closed }
  catch (error) { await close().catch(cleanupError => { void cleanupError }); throw error }
  finally {
    stdin.removeListener('end', shutdown)
    signals.removeListener('SIGINT', shutdown); signals.removeListener('SIGTERM', shutdown)
  }
}
