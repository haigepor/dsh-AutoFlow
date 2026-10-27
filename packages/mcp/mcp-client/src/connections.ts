/** Optional connection inventory for Host management; clients retain connection ownership. */
import { Context, Service, type Fiber } from '@deepseek-ai/cordis'
import type { McpConnectionSnapshot } from './types.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Connection-owned MCP readiness keyed by the owning plugin Fiber. */
    mcpConnections: McpConnections
  }
  interface Events {
    /**
     * One client's connection state or discovered tools changed.
     * @mode emit
     * @param fiber - MCP client whose connection or tools changed.
     */
    'mcp-client/changed'(fiber: Fiber): void
    /**
     * Registered connections or their readiness changed; listeners may refresh inventory.
     * @mode emit
     */
    'mcp-connections/changed'(): void
  }
}

/** Optional registry joining profile entries to their live MCP connections. */
export default class McpConnections extends Service {
  private readonly readers = new Map<Fiber, () => McpConnectionSnapshot>()

  constructor(ctx: Context) {
    super(ctx, 'mcpConnections')
    ctx.on('mcp-client/changed', (fiber) => {
      if (this.readers.has(fiber)) ctx.emit('mcp-connections/changed')
    })
  }

  /**
   * Register one client generation without taking its connection lifetime.
   * @param fiber - owning client Fiber.
   * @param read - connection-owned readiness and tool names.
   * @returns disposer for this exact registration.
   */
  register(fiber: Fiber, read: () => McpConnectionSnapshot): () => void {
    if (this.readers.has(fiber)) throw new Error('MCP connection is already registered')
    this.readers.set(fiber, read)
    this.ctx.emit('mcp-connections/changed')
    return () => {
      if (this.readers.get(fiber) !== read) return
      this.readers.delete(fiber)
      this.ctx.emit('mcp-connections/changed')
    }
  }

  /**
   * Read the current readiness of one configured entry.
   * @param fiber - owning client Fiber, when the entry is running.
   * @returns detached connection status, or undefined for an inactive entry.
   */
  snapshot(fiber: Fiber | undefined): McpConnectionSnapshot | undefined {
    return fiber === undefined ? undefined : this.readers.get(fiber)?.()
  }
}
