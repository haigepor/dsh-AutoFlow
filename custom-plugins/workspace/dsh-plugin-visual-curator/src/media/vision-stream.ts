/** Incremental compatible chat SSE decoding; transport owns byte bounds and cancellation. */
import { z } from 'zod'
import { MediaError } from './errors.ts'

/** Actual fields returned by the provider; no hidden reasoning is reconstructed. */
export interface VisionDelta { content?: string; reasoning?: string }
const chunkSchema = z.object({ choices: z.array(z.object({ delta: z.object({ content: z.string().nullable().optional(), reasoning_content: z.string().nullable().optional() }).optional(), finish_reason: z.string().nullable().optional() })).max(1) })
function invalid(): MediaError { return new MediaError('vision-invalid-output', 'reviewing', false, 'The vision stream is incomplete or invalid.', 'Inspect the retained task output and provider streaming support.') }

/** One response collector accepts arbitrary UTF-8 and line splits, including CRLF and SSE comments. */
export class VisionStream {
  private readonly decoder = new TextDecoder('utf-8', { fatal: true })
  private pending = ''
  private lines: string[] = []
  private ended = false
  private received = false
  content = ''
  finishReason: string | null = null
  constructor(private readonly onOutput?: (delta: VisionDelta) => void) {}
  /** @param bytes Next bounded transport chunk. */
  push(bytes: Uint8Array): void {
    this.received = true
    let text: string
    try { text = this.decoder.decode(bytes, { stream: true }) } catch (error) { throw invalid() }
    this.consume(text)
  }
  private consume(text: string): void {
    this.pending += text
    let end: number
    while ((end = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, end).replace(/\r$/, '')
      this.pending = this.pending.slice(end + 1)
      if (line === '') { this.event(); this.lines = [] }
      else if (line.startsWith('data:')) this.lines.push(line.slice(5).replace(/^ /, ''))
    }
  }
  private event(): void {
    if (!this.lines.length) return
    const text = this.lines.join('\n')
    if (text === '[DONE]') { this.ended = true; return }
    if (this.ended) throw invalid()
    let raw: unknown
    try { raw = JSON.parse(text) } catch (error) { throw invalid() }
    const parsed = chunkSchema.safeParse(raw)
    if (!parsed.success) throw invalid()
    const choice = parsed.data.choices[0]
    if (!choice) return
    const content = choice.delta?.content, reasoning = choice.delta?.reasoning_content
    if (content) this.content += content
    if (content || reasoning) this.onOutput?.({ ...(content ? { content } : {}), ...(reasoning ? { reasoning } : {}) })
    if (choice.finish_reason) this.finishReason = choice.finish_reason
  }
  /** @param fallback Full body, used only by transports without chunk callbacks. @returns Completed model text. */
  finish(fallback: Uint8Array): string {
    if (!this.received) this.push(fallback)
    let text: string
    try { text = this.decoder.decode() } catch (error) { throw invalid() }
    this.consume(text)
    if (this.pending || this.lines.length || !this.ended && this.finishReason === null || !this.content.trim()) throw invalid()
    return this.content
  }
}
