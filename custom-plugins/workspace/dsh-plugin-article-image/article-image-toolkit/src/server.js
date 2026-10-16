/** MCP stdio server exposing article image planning tools to any agent client. */
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
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
    try {
      const value = await tool.run(request.params.arguments ?? {}, extra.signal)
      return { content: [{ type: 'text', text: JSON.stringify(value) }] }
    } catch (error) {
      // 只回传自有错误码；远端与解析器文本不进客户端。
      return { content: [{ type: 'text', text: errorCode(error) }], isError: true }
    }
  })
  return server
}

/** Start the stdio MCP server for the given deployment settings. @param {object} input Config fields. @returns {Promise<void>} Resolves when the transport closes. */
export async function start(input = {}) {
  const config = resolveConfig(input)
  const service = new ArticleService(config)
  const server = createServer(service)
  const transport = new StdioServerTransport()
  const close = async () => { await service.dispose(); await server.close() }
  process.once('SIGINT', () => { close().finally(() => process.exit(0)) })
  process.once('SIGTERM', () => { close().finally(() => process.exit(0)) })
  await server.connect(transport)
}
