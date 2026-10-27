/** Connection readiness exposed without server credentials or transport diagnostics. */
export interface McpConnectionSnapshot {
  /** Current transport and discovery phase; only connected admits new operations. */
  phase: 'connecting' | 'connected' | 'reconnecting' | 'failed' | 'stopped'
  /** Last registered public tool names, including retained tools during reconnect. */
  tools: string[]
}
