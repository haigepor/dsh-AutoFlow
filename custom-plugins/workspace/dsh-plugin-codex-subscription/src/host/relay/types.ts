/** Dependency-injected HTTP gateway; credentials never cross its public responses. */
import type { IncomingMessage, ServerResponse } from 'node:http'
import type { ImageInput, ImageOwner, ImageTask } from '../images/types.ts'

/** A separately revocable local gateway credential, provided by the Host credential store. */
export interface GatewayKey {
  readonly id: string
  readonly secret: string
}

/** Validated deployment settings; the caller resolves defaults before opening the listener. */
export interface RelayConfig {
  readonly host: '127.0.0.1' | '::1'
  readonly port: number
  readonly gatewayKeys: readonly GatewayKey[]
  readonly allowedOrigins: readonly string[]
  readonly maxRequestBytes: number
  readonly maxResponseBytes: number
  readonly requestTimeoutMs: number
  readonly imageWaitMs: number
  readonly assetUrlTtlMs: number
  readonly maxConcurrentRequests: number
  readonly maxSocketConnections: number
  readonly maxSocketQueuedTurns: number
  readonly maxSocketHistoryBytes: number
}

/** Models exposed by this subscription transport. */
export interface RelayModel {
  readonly id: string
  readonly name?: string
}

/** Authenticated local client identity; optional contexts leave internal call cache identity unchanged. */
export interface RelayRequestContext {
  readonly keyId: string
  readonly headers: Headers
  /** Host-owned continuation metadata; absent for stateless HTTP requests. */
  readonly replayAccountKey?: string
  /** Receives the successful selected account for connection-local replay; absent callers need no replay bookkeeping. */
  readonly onAccount?: (accountKey: string) => void
}

/** Image operations retain ownership in the durable image service. */
export interface RelayImages {
  submit(input: ImageInput, owner: ImageOwner): Promise<ImageTask>
  getResult(id: string, owner: ImageOwner, options?: { waitMs?: number; signal?: AbortSignal }): Promise<ImageTask>
}

/** Original bytes are read through the attachment owner rather than a raw filesystem path. */
export interface RelayAsset {
  readonly data: Uint8Array
  readonly mimeType: string
}

/** Shared business operations; network and storage stay injectable for keyless tests. */
export interface RelayDependencies {
  /** Called only after gateway authentication; hints may raise the Codex compatibility version. */
  observeClient?(headers: Headers): void
  requestResponses(body: Record<string, unknown>, signal: AbortSignal, context?: RelayRequestContext): Promise<Response>
  listModels(signal: AbortSignal): Promise<readonly RelayModel[]>
  readonly images: RelayImages
  readAsset(taskId: string, assetId: string, owner: ImageOwner): Promise<RelayAsset>
}

/** A per-request authenticated MCP handler; the listener owns admission and shutdown. */
export interface RelayMcpHandler {
  handle(request: IncomingMessage, response: ServerResponse, keyId: string, signal: AbortSignal): Promise<void>
  close(): Promise<void>
}

/** The caller closes this listener before disposing its image/account services. */
export interface RelayServer {
  readonly origin: string
  readonly port: number
  close(): Promise<void>
}
