/**
 * Shared route, framing, timeout, assembly, and validation policy for
 * model-backed session-title providers.
 * @module @deepseek-ai/dsh-session-title-llm
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { setTimeout as delay } from 'node:timers/promises'
import { createUserMessage, BlockAssembler } from '@deepseek-ai/dsh-llm'
import type { ContextFormed } from '@deepseek-ai/dsh-llm'
declare module '@deepseek-ai/dsh-llm' {
  interface MessageSourceMap {
    'dsh-session-title-llm': { kind: 'dsh-session-title-llm' } & ContextFormed
  }
}

import type { FinishReason, GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { deadline, MAX_TIMER_DELAY_MS } from '@deepseek-ai/dsh-timeout'
import { deepFreeze } from '@deepseek-ai/dsh-util-values'
import type { SessionSeq } from '@deepseek-ai/dsh-session'
import {
  normalizeSessionTitle,
  sessionTitleInputText,
  SessionTitleProviderId,
} from '@deepseek-ai/dsh-session-title'
import type {
  SessionTitleAutomaticMode,
  SessionTitleModelIdentity,
  SessionTitleProviderRequest,
  SessionTitleProviderResult,
  SessionTitleUserMessage,
} from '@deepseek-ai/dsh-session-title'

/** Exact model-visible request recorded before one auxiliary title dispatch. */
export interface SessionTitleLlmRequestEventData {
  /** Registered title-provider identity responsible for the request. */
  readonly titleProvider: SessionTitleProviderId
  /** Exact human `user/message` seqs represented in `messages`. */
  readonly messageSeqs: SessionSeq[]
  /** Exact auxiliary LLM route. */
  readonly route: SessionTitleModelIdentity
  /** Exact auxiliary system prompt. */
  readonly system: string
  /** Exact auxiliary message list. */
  readonly messages: Message[]
  /** Exact auxiliary output-token cap. */
  readonly maxTokens: number
  /** Exact effort when the model declares selectable reasoning. Older records omit it. */
  readonly reasoningEffort?: string
}

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Log-only pre-dispatch record of one session-title model request. */
    'session/title-llm-request': SessionTitleLlmRequestEventData
    /** Log-only sanitized lifecycle of one auxiliary title attempt. */
    'session/title-llm-attempt': SessionTitleLlmAttemptEventData
  }
}

/** Sanitized attempt telemetry; contains no provider response or credentials. */
export interface SessionTitleLlmAttemptEventData {
  readonly titleProvider: SessionTitleProviderId
  readonly route: SessionTitleModelIdentity
  readonly attempt: number
  readonly status: 'started' | 'succeeded' | 'failed' | 'cancelled'
  readonly durationMs: number
  readonly reasoning: 'disabled' | 'lowest-declared' | 'provider-default'
  readonly failureCode?: string
}

/** Capability-owned timeout reason code for auxiliary title requests. */
export const SESSION_TITLE_TIMEOUT_CODE = 'SESSION_TITLE_TIMEOUT'

/** Required deployment policy for one model-backed title plugin. */
export interface SessionTitleLlmConfig {
  /** Target word count for non-CJK titles. */
  readonly targetWords: number
  /** Target character count for Chinese, Japanese, or Korean titles. */
  readonly targetCjkCharacters: number
  /** Maximum UTF-8 bytes in the final JSON-framed user prompt. */
  readonly maxInputBytes: number
  /** Auxiliary generation output-token cap. */
  readonly maxOutputTokens: number
  /** Maximum dispatch count, including the first attempt. */
  readonly maxAttempts?: number
  /** Retry delays indexed by the preceding failed attempt. */
  readonly retryDelaysMs?: number[]
  /** Deadline for each auxiliary attempt in milliseconds. */
  readonly timeoutMs: number
  /** Optional explicit provider route; must be paired with `model`. */
  readonly provider?: string
  /** Optional explicit model id; must be paired with `provider`. */
  readonly model?: string
}

/** Validated immutable model-provider policy. */
export interface ResolvedSessionTitleLlmConfig extends Omit<SessionTitleLlmConfig, 'maxAttempts' | 'retryDelaysMs'> {
  readonly maxAttempts: number
  readonly retryDelaysMs: number[]
}

/** Shared Loader fields with configurable retry defaults. */
export const SessionTitleLlmConfigFields = {
  targetWords: z.number().step(1).min(1).required(),
  targetCjkCharacters: z.number().step(1).min(1).required(),
  maxInputBytes: z.number().step(1).min(1).required(),
  maxOutputTokens: z.number().step(1).min(1).required(),
  maxAttempts: z.number().step(1).min(1).max(3).default(3),
  retryDelaysMs: z.array(z.number().step(1).min(0).max(MAX_TIMER_DELAY_MS)).default([1000, 3000]),
  timeoutMs: z.number().step(1).min(1).max(MAX_TIMER_DELAY_MS).required(),
  provider: z.string(),
  model: z.string(),
}

/** Shared Loader schema for required sizing and defaulted retry policy. */
export const SessionTitleLlmConfigSchema: z<SessionTitleLlmConfig> = z.object(SessionTitleLlmConfigFields)

/** Complete configuration key set for direct construction validation. */
const CONFIG_KEYS: ReadonlySet<string> = new Set([
  'targetWords',
  'targetCjkCharacters',
  'maxInputBytes',
  'maxOutputTokens',
  'timeoutMs',
  'maxAttempts',
  'retryDelaysMs',
  'provider',
  'model',
])

/** Validate one positive integer limit. */
function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`session-title-llm: ${name} must be a positive integer`)
  }
}

/**
 * Validate and detach required model-provider configuration.
 * @param config - untrusted plugin configuration.
 * @returns immutable policy with optional route absence preserved.
 */
export function resolveSessionTitleLlmConfig(
  config: SessionTitleLlmConfig,
): ResolvedSessionTitleLlmConfig {
  const candidate: unknown = config
  if (candidate === null || typeof candidate !== 'object') {
    throw new Error('session-title-llm: configuration is required')
  }
  const value = candidate as SessionTitleLlmConfig
  for (const key of Object.keys(value)) {
    if (!CONFIG_KEYS.has(key)) throw new Error(`session-title-llm: unknown config key "${key}"`)
  }
  assertPositiveInteger('targetWords', value.targetWords)
  assertPositiveInteger('targetCjkCharacters', value.targetCjkCharacters)
  assertPositiveInteger('maxInputBytes', value.maxInputBytes)
  assertPositiveInteger('maxOutputTokens', value.maxOutputTokens)
  assertPositiveInteger('timeoutMs', value.timeoutMs)
  if (value.timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`session-title-llm: timeoutMs must not exceed ${MAX_TIMER_DELAY_MS}`)
  }
  const hasProvider = value.provider !== undefined
  const hasModel = value.model !== undefined
  if (hasProvider !== hasModel) {
    throw new Error('session-title-llm: provider and model must be supplied together')
  }
  if (hasProvider
    && (typeof value.provider !== 'string' || value.provider.length === 0
      || typeof value.model !== 'string' || value.model.length === 0)) {
    throw new Error('session-title-llm: provider and model overrides must be non-empty strings')
  }
  const maxAttempts = value.maxAttempts ?? 3
  const retryDelaysMs = value.retryDelaysMs ?? [1000, 3000]
  assertPositiveInteger('maxAttempts', maxAttempts)
  if (maxAttempts > 3 || !Array.isArray(retryDelaysMs) || retryDelaysMs.length < maxAttempts - 1
    || retryDelaysMs.some(ms => !Number.isSafeInteger(ms) || ms < 0 || ms > MAX_TIMER_DELAY_MS)) {
    throw new Error('session-title-llm: invalid retry policy')
  }
  return deepFreeze({ ...value, maxAttempts, retryDelaysMs: [...retryDelaysMs] })
}

/** Select the provider-owned message subset from one fixed service revision. */
export type SessionTitleLlmMessageSelector = (
  messages: readonly SessionTitleUserMessage[],
) => readonly SessionTitleUserMessage[]

/**
 * Register one model-backed provider through the shared configuration and call policy.
 * @param ctx - context exposing the title and LLM services.
 * @param config - untrusted required deployment policy.
 * @param id - stable plugin id recorded with generated titles.
 * @param automatic - provider-owned automatic generation cadence.
 * @param selectMessages - exact source-message selection for one revision.
 */
export function registerSessionTitleLlmProvider(
  ctx: Context,
  config: SessionTitleLlmConfig,
  id: string,
  automatic: SessionTitleAutomaticMode,
  selectMessages: SessionTitleLlmMessageSelector,
): void {
  const resolved = resolveSessionTitleLlmConfig(config)
  const titleProvider = SessionTitleProviderId(id)
  ctx.sessionTitle.register({
    id: titleProvider,
    automatic,
    async generate(request) {
      return generateSessionTitleWithLlm(ctx, resolved, request, selectMessages(request.messages), titleProvider)
    },
  })
}

/** Resolve the explicit pair or the exact route captured from `request/header`. */
function resolveRoute(
  config: ResolvedSessionTitleLlmConfig,
  request: SessionTitleProviderRequest,
): SessionTitleModelIdentity {
  if (config.provider !== undefined && config.model !== undefined) {
    return { provider: config.provider, model: config.model }
  }
  if (request.route === undefined) {
    throw Object.assign(new Error('session-title-llm: no logged request route is available; configure provider and model together'), { code: 'TITLE_CONFIG' })
  }
  return request.route
}

/** Stable language-aware system instruction shared by both provider plugins. */
function systemPrompt(config: ResolvedSessionTitleLlmConfig): string {
  return [
    'Create a concise title for an AI coding-assistant session from the supplied human messages.',
    'Return only the title on one line, **in plain text of natural language**, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.',
    'Use the language of the messages.',
    `Aim for about ${config.targetWords} words in non-CJK languages or ${config.targetCjkCharacters} CJK characters.`,
  ].join('\n')
}

/** Frame exact messages as JSON so user text cannot break structural delimiters. */
function frameMessages(messages: readonly SessionTitleUserMessage[]): string {
  return `Generate the session title from this JSON array of human messages:\n${JSON.stringify(messages.map(message => ({ ...message, text: sessionTitleInputText(message.text) })))}`
}

/** Translate terminal finish reasons into an auxiliary-call failure. */
function finishError(finish: FinishReason): Error | undefined {
  switch (finish.kind) {
    case 'stop':
      return undefined
    case 'error':
    case 'aborted': {
      const error = new Error(finish.failure.message) as Error & { code?: string }
      error.code = finish.failure.code
      return error
    }
    case 'max-tokens':
      return new Error('session-title-llm: title output reached maxOutputTokens')
    case 'tool-calls':
      return new Error('session-title-llm: title model unexpectedly requested a tool')
    default:
      return new Error(`session-title-llm: unsupported finish reason "${String((finish as { kind?: unknown }).kind)}"`)
  }
}

/**
 * Generate one title through the shared auxiliary LLM call.
 * @param ctx - context exposing the registered LLM service.
 * @param config - validated model-provider policy.
 * @param request - service-owned session, route, message snapshot, and cancellation.
 * @param selectedMessages - exact provider-selected subset to frame and attribute.
 * @param titleProvider - registered title-provider identity recorded with the request.
 * @returns normalized non-empty title, exact source seqs, and used model route.
 */
export async function generateSessionTitleWithLlm(
  ctx: Context,
  config: ResolvedSessionTitleLlmConfig,
  request: SessionTitleProviderRequest,
  selectedMessages: readonly SessionTitleUserMessage[],
  titleProvider: SessionTitleProviderId,
): Promise<SessionTitleProviderResult> {
  request.signal.throwIfAborted()
  if (selectedMessages.length === 0) {
    throw Object.assign(new Error('session-title-llm: at least one source message is required'), { code: 'TITLE_EMPTY' })
  }
  const framedInput = frameMessages(selectedMessages)
  const inputBytes = Buffer.byteLength(framedInput, 'utf8')
  if (inputBytes > config.maxInputBytes) {
    throw Object.assign(new Error(`session-title-llm: input is ${inputBytes} bytes, exceeding maxInputBytes ${config.maxInputBytes}`), { code: 'TITLE_CONFIG' })
  }
  const route = resolveRoute(config, request)
  const messages: Message[] = [createUserMessage({
    content: [{ type: 'text', text: framedInput }],
    source: { kind: 'dsh-session-title-llm' },
  })]
  const system = systemPrompt(config)
  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    request.signal.throwIfAborted()
    const started = performance.now()
    using callDeadline = deadline(request.signal, config.timeoutMs, SESSION_TITLE_TIMEOUT_CODE)
    let reasoning: SessionTitleLlmAttemptEventData['reasoning'] = 'provider-default'
    const record = (status: SessionTitleLlmAttemptEventData['status'], failureCode?: string): void => {
      // 会话关闭后不能追加记录；取消与重命名仍由服务的 revision 检查控制接受。
      if (ctx.sessions.get(request.session.id) !== request.session) return
      request.session.append('session/title-llm-attempt', {
        titleProvider, route, attempt, status, reasoning,
        durationMs: Math.round(performance.now() - started),
        ...failureCode === undefined ? {} : { failureCode },
      })
    }
    try {
      const info = await ctx.llm.resolveModelInfo(route.provider, route.model, callDeadline.signal)
      // 元数据读取期间可能已取消、重命名或关闭会话，记录分发前必须复查。
      callDeadline.signal.throwIfAborted()
      const efforts = info.reasoning?.efforts
      const effort = efforts?.find(item => item.id === 'off')
        ?? ['minimal', 'low', 'medium', 'high', 'max'].map(id => efforts?.find(item => item.id === id)).find(item => item !== undefined)
        ?? efforts?.[0]
      if (effort !== undefined) reasoning = effort.id === 'off' ? 'disabled' : 'lowest-declared'
      const options: GenerateOptions = deepFreeze({
        provider: route.provider, model: route.model, messages, system,
        maxTokens: config.maxOutputTokens, sessionId: request.session.id,
        purpose: 'session-title', signal: callDeadline.signal,
        ...effort === undefined ? {} : { reasoningEffort: effort.id },
      })
      request.session.append('session/title-llm-request', {
        titleProvider, messageSeqs: selectedMessages.map(message => message.seq), route,
        system, messages, maxTokens: config.maxOutputTokens,
        ...effort === undefined ? {} : { reasoningEffort: effort.id },
      })
      record('started')
      callDeadline.signal.throwIfAborted()
      const assembler = new BlockAssembler()
      for await (const chunk of ctx.llm.stream(options)) {
        callDeadline.signal.throwIfAborted()
        assembler.push(chunk)
      }
      callDeadline.signal.throwIfAborted()
      const terminalError = finishError(assembler.finish)
      if (terminalError !== undefined) throw terminalError
      const blocks = assembler.blocks()
      if (blocks.some(block => block.type === 'tool-call')) {
        throw Object.assign(new Error('Title model requested a tool'), { code: 'TITLE_INVALID_OUTPUT' })
      }
      const text = blocks
        .filter((block): block is Extract<(typeof blocks)[number], { type: 'text' }> => block.type === 'text')
        .map(block => block.text).join(' ')
      const title = normalizeSessionTitle(text, Number.MAX_SAFE_INTEGER)
      if (title.length === 0) throw Object.assign(new Error('Title model produced no text'), { code: 'TITLE_EMPTY' })
      record('succeeded')
      return { title, messageSeqs: selectedMessages.map(message => message.seq), model: route }
    } catch (error: unknown) {
      const failureCode = request.signal.aborted ? 'TITLE_CANCELLED'
        : callDeadline.signal.aborted ? 'TITLE_TIMEOUT' : titleFailureCode(error)
      record(request.signal.aborted ? 'cancelled' : 'failed', failureCode)
      request.signal.throwIfAborted()
      if (attempt >= config.maxAttempts || !['TITLE_TIMEOUT', 'TITLE_NETWORK', 'TITLE_RATE_LIMIT', 'TITLE_EMPTY'].includes(failureCode)) {
        throw Object.assign(new Error(failureCode), { code: failureCode })
      }
    }
    await delay(config.retryDelaysMs[attempt - 1], undefined, { signal: request.signal })
  }
  throw new Error('TITLE_ATTEMPTS_EXHAUSTED')
}

/** Classify failures without persisting a provider message, URL, or request body. */
function titleFailureCode(error: unknown): string {
  const value = error instanceof Error ? error : new Error('Unknown title error')
  const code = 'code' in value ? String(value.code) : ''
  const status = 'status' in value ? Number(value.status) : 0
  const description = code + ' ' + value.message
  if (code === 'TITLE_EMPTY') return code
  if (status === 401 || status === 403 || /auth|unauthorized|forbidden|api.?key/i.test(description)) return 'TITLE_AUTH'
  if (status === 429 || /rate.?limit|too many requests/i.test(description)) return 'TITLE_RATE_LIMIT'
  if (/timeout|timed.?out|ETIMEDOUT/i.test(description)) return 'TITLE_TIMEOUT'
  if (code === 'SERVER' || code === 'NETWORK' || status >= 500
    || /ECONN|EAI_AGAIN|ENET|fetch failed|network|socket|connection|overloaded|service.?unavailable/i.test(description)) return 'TITLE_NETWORK'
  if (/NO_ADAPTER|UNSUPPORTED|UNKNOWN_MODEL|MODEL_NOT_FOUND|config|model.?not.?found|404/i.test(description)) return 'TITLE_CONFIG'
  if (/abort|cancel/i.test(description)) return 'TITLE_CANCELLED'
  return 'TITLE_INVALID_OUTPUT'
}
