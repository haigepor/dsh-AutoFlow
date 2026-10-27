/** Stateless Streamable HTTP MCP exposes the same durable image service as native tools. */
import { createMcpHandler, McpServer, type CallToolResult } from '@modelcontextprotocol/server'
import { toNodeHandler, type NodeIncomingMessageLike } from '@modelcontextprotocol/node'
import { z } from 'zod'
import { imageInputSchema, publicImageTask } from '../relay/images.ts'
import { jsonBody, readBody, RelayError } from '../relay/http.ts'
import type { RelayConfig, RelayDependencies, RelayMcpHandler } from '../relay/types.ts'
import type { ImageOwner, ImageTask } from '../images/types.ts'

type AssetUrl = (keyId: string, taskId: string, assetId: string) => string

async function resultContent(task: ImageTask, owner: ImageOwner & { kind: 'gateway' }, dependencies: RelayDependencies, limit: number, assetUrl: AssetUrl): Promise<CallToolResult> {
  const files = task.state === 'succeeded' ? task.assets.map(asset => ({ url: assetUrl(owner.keyId, task.id, asset.id), inline: false })) : []
  const content: CallToolResult['content'] = []
  const pending = task.state === 'queued' || task.state === 'sent'
  const metadata = pending ? { 'usemagpie.ai/pending': task.id } : files.length > 0 ? { 'usemagpie.ai/files': files } : {}
  const text = () => ({ type: 'text' as const, text: JSON.stringify({ ...publicImageTask(task), id: task.id, ...(files.length ? { files } : {}) }) })
  if (task.state === 'succeeded') {
    for (const [index, asset] of task.assets.entries()) {
      // URL 先行交付；base64 放不下时无需再次读取原图，避免丢失已经成功的结果。
      if (Math.ceil(asset.original.bytes / 3) * 4 > limit) continue
      const image = await dependencies.readAsset(task.id, asset.id, owner)
      const inline = { type: 'image' as const, data: Buffer.from(image.data).toString('base64'), mimeType: image.mimeType }
      files[index]!.inline = true
      if (Buffer.byteLength(JSON.stringify({ content: [text(), ...content, inline], _meta: metadata })) <= limit) content.push(inline)
      else files[index]!.inline = false
    }
  }
  return { content: [text(), ...content], _meta: metadata, ...(task.state === 'failed' || task.state === 'cancelled' || task.state === 'outcome-unknown' ? { isError: true } : {}) }
}

function failure(error: unknown): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: error instanceof RelayError ? error.message : 'The image request failed or the task is not available to this gateway key.' }] }
}

/** Create bounded MCP handlers whose tool closures are bound to one authenticated key.
 * @param config - Host-resolved gateway limits and credentials.
 * @param dependencies - Shared image operations and durable asset reader.
 * @param assetUrl - Listener-owned signer for short-lived task downloads.
 * @returns an HTTP adapter that never accepts a caller-supplied owner.
 */
export function createImageMcpHandler(config: RelayConfig, dependencies: RelayDependencies, assetUrl: AssetUrl): RelayMcpHandler {
  const handlers = new Map<string, ReturnType<typeof createMcpHandler>>()
  for (const key of config.gatewayKeys) {
    const owner: ImageOwner & { kind: 'gateway' } = { kind: 'gateway', keyId: key.id }
    const handler = createMcpHandler(() => {
      const server = new McpServer({ name: 'autoflow-codex-images', version: '0.1.0' }, { capabilities: { tools: {} } })
      const generateSchema = imageInputSchema.extend({ reference_images: z.array(z.string().min(1)).optional(), output_format: z.enum(['png', 'jpeg', 'webp']).optional() }).refine(input => !(input.referenceImages !== undefined && input.reference_images !== undefined) && !(input.outputFormat !== undefined && input.output_format !== undefined), 'Use one spelling for references and output format.')
      server.registerTool('generate_image', { description: 'Start a durable image generation task and wait briefly. Use generation_result with its id until it succeeds. The authenticated gateway key owns the task.', inputSchema: generateSchema }, async (input, context): Promise<CallToolResult> => {
        try {
          const { reference_images, output_format, ...fields } = input
          let task = await dependencies.images.submit({ ...fields, ...(reference_images === undefined ? {} : { referenceImages: reference_images }), ...(output_format === undefined ? {} : { outputFormat: output_format }) }, owner)
          if (task.state === 'queued' || task.state === 'sent') task = await dependencies.images.getResult(task.id, owner, { waitMs: Math.min(config.imageWaitMs, 20_000), signal: context.mcpReq.signal })
          return await resultContent(task, owner, dependencies, config.maxResponseBytes, assetUrl)
        }
        catch (error) { return failure(error) }
      })
      server.registerTool('generation_result', { description: 'Read or wait for a task created by this gateway key. Results include original image bytes when they fit, plus signed download URLs.', inputSchema: z.object({ id: z.string().min(1).optional(), task_id: z.string().min(1).optional(), wait_ms: z.number().int().min(0).max(20_000).optional() }).strict().refine(input => (input.id ?? input.task_id) !== undefined && (input.id === undefined || input.task_id === undefined || input.id === input.task_id), 'Supply id or task_id; both must agree.') }, async (input, context): Promise<CallToolResult> => {
        try { return await resultContent(await dependencies.images.getResult((input.id ?? input.task_id)!, owner, { waitMs: input.wait_ms ?? 0, signal: context.mcpReq.signal }), owner, dependencies, config.maxResponseBytes, assetUrl) }
        catch (error) { return failure(error) }
      })
      return server
    }, { maxRequestBodySize: config.maxRequestBytes })
    handlers.set(key.id, handler)
  }
  return {
    handle: async (request, response, keyId, signal) => {
      const handler = handlers.get(keyId)
      if (handler === undefined) throw new RelayError(401, 'invalid_api_key', 'The gateway key is invalid.')
      // The official Node adapter owns HTTP/SSE framing; our signal also covers plugin teardown.
      const handle = toNodeHandler({ fetch: async (webRequest, options) => await handler.fetch(new Request(webRequest, { signal }), options) })
      // toNodeHandler buffers Node input before SDK limits run, so bound it before that adapter.
      const body = request.method === 'POST' ? jsonBody(await readBody(request, config.maxRequestBytes)) : undefined
      signal.throwIfAborted()
      await handle(request as NodeIncomingMessageLike, response, body)
    },
    close: async () => { await Promise.all(Array.from(handlers.values(), async handler => { await handler.close() })) },
  }
}
