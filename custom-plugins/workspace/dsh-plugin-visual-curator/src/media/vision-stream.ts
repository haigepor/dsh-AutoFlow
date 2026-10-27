/** Compatible chat deltas over the same maintained SSE framing used by the native client. */
import { z } from 'zod'
import { createParser } from 'eventsource-parser'
import { MediaError } from './errors.ts'

/** Actual fields returned by the provider; no hidden reasoning is reconstructed. */
export interface VisionDelta { content?: string; reasoning?: string }
const chunkSchema = z.object({ choices: z.array(z.object({ delta: z.object({ content: z.string().nullable().optional(), reasoning_content: z.string().nullable().optional() }).optional(), finish_reason: z.string().nullable().optional() })).max(1) })
function invalid(issue: string, modelOutput: unknown, retryable = true): MediaError { return new MediaError('vision-invalid-output', 'reviewing', retryable, 'The vision stream is incomplete or invalid.', 'Continue the pending batch within its saved retry budget.', { modelOutput, issues: [issue] }) }
const providerErrorSchema = z.object({ error: z.object({ code: z.union([z.string(), z.number()]).optional(), type: z.string().optional() }) })

/** One response collector accepts arbitrary UTF-8 and line splits, including CRLF and SSE comments. */
export class VisionStream {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  private readonly parser = createParser({ onEvent: event => this.event(event.data) })
  private ended = false
  private received = false
  content = ''
  finishReason: string | null = null
  constructor(private readonly onOutput?: (delta: VisionDelta) => void) {}
  /** @param bytes Next bounded transport chunk. */
  push(bytes: Uint8Array): void {
    this.received = true
    let text: string
    try { text = this.decoder.decode(bytes, { stream: true }) } catch (error) { throw invalid('invalid-utf8', { receivedBytes: bytes.length }, false) }
    this.parser.feed(text)
  }
  private event(text: string): void {
    if (text === '[DONE]') { this.ended = true; return }
    if (this.ended) throw invalid('event-after-end', { rawText: text })
    let raw: unknown
    try { raw = JSON.parse(text) } catch (error) { throw invalid('invalid-event-json', { rawText: text }) }
    const providerError = providerErrorSchema.safeParse(raw)
    if (providerError.success) {
      const code = String(providerError.data.error.code ?? providerError.data.error.type ?? 'unspecified')
      // 只按服务的结构化代码判断永久失败；未分类的流错误仍受调用方的有限重试约束。
      const retryable = !['400', '401', '403', '404', 'invalid_api_key', 'authentication_error', 'permission_denied', 'invalid_request_error', 'model_not_found'].includes(code)
      throw new MediaError('remote-request-failed', 'reviewing', retryable, 'The vision service reported a streaming request failure.', 'Check the saved request diagnostics or continue within the retry budget.', { modelOutput: raw, issues: [`provider-error:${code}`] })
    }
    const parsed = chunkSchema.safeParse(raw)
    if (!parsed.success) throw invalid(`invalid-event-fields:${parsed.error.issues.map(issue => `${issue.code}:${issue.path.join('.')}`).join(',')}`, raw)
    const choice = parsed.data.choices[0]
    if (!choice) return
    const content = choice.delta?.content, reasoning = choice.delta?.reasoning_content
    if (content) this.content += content
    if (content || reasoning) this.onOutput?.({ ...(content ? { content } : {}), ...(reasoning ? { reasoning } : {}) })
    if (choice.finish_reason) this.finishReason = choice.finish_reason
  }
  /** @param fallback Full body, used only by transports without chunk callbacks. @returns Collected text; the caller must reject a length finish even when its text is empty. */
  finish(fallback: Uint8Array): string {
    if (!this.received) this.push(fallback)
    let text: string
    try { text = this.decoder.decode() } catch (error) { throw invalid('invalid-utf8', { finishReason: this.finishReason }, false) }
    this.parser.feed(text)
    // 明确的 token 截断交给调用方统一报告，不能被空正文检查覆盖。
    if (!this.ended && this.finishReason === null || !this.content.trim() && this.finishReason !== 'length') throw invalid('incomplete-stream', { rawText: this.content, ended: this.ended, finishReason: this.finishReason })
    return this.content
  }
}
