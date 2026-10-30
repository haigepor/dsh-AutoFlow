/** Optional browser half: keyed image cards and their shared Session resource. */
import type { Context } from '@deepseek-ai/cordis'
import type { DshWindow } from '@deepseek-ai/dsh-client-modules/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-resources/client'
import type {} from '@deepseek-ai/dsh-client-ui-tool/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import { z } from 'zod'
import { createImageCard, type ImageCardInjected } from './card.tsx'
import { createImageResource } from './resource.ts'
import { en, zh } from './locales.ts'
import { imageConversationDefinition, imageTurnDefinition } from './conversation.ts'
import { createImageProcessStatus } from './status.tsx'
import css from './entry.css'

const browser = window as Window & DshWindow
if (!browser.__ModuleLoader__) throw new Error('Codex image UI requires the client module loader.')
browser.__ModuleLoader__.load({ id: 'dsh-plugin-codex-subscription', factory(require) {
  const React = require('react') as typeof import('react')
  const ui = require('@deepseek-ai/dsh-client-ui-primitives') as typeof import('@deepseek-ai/dsh-client-ui-primitives')
  const { ToolCard, ConversationCard } = createImageCard(React, ui)
  const ProcessStatus = createImageProcessStatus(React, ui)
  return { inject: ['slots', 'locale', 'resources', 'uiConversation', 'remote', 'remote.pluginManager'], apply(ctx: Context) {
    ctx.effect(() => ctx.locale.register('codexImages', { en, zh }), 'Codex image dictionaries')
    ctx.effect(() => {
      const style = document.createElement('style'); style.dataset['codexImageUi'] = ''; style.textContent = css; document.head.append(style)
      return () => style.remove()
    }, 'Codex image styles')
    ctx.effect(() => ctx.uiConversation.events.register({ ...imageTurnDefinition, match: {
      'turn/start': imageTurnDefinition.match, 'turn/end': imageTurnDefinition.match,
      'step/start': imageTurnDefinition.match, 'step/end': imageTurnDefinition.match,
      'tool/call': imageTurnDefinition.match, 'tool/result': imageTurnDefinition.match,
      'assistant/message': imageTurnDefinition.match, 'assistant/live-chunk': imageTurnDefinition.match,
    } }), 'Codex image Turn results')
    ctx.effect(() => ctx.uiConversation.events.register({ ...imageConversationDefinition, match: {
      'tool/call': imageConversationDefinition.match,
      'tool/result': imageConversationDefinition.match,
      'tool/ptc-dispatch-start': imageConversationDefinition.match,
      'tool/ptc-dispatch': imageConversationDefinition.match,
    } }), 'Codex image conversation nodes')
    ctx.effect(() => ctx.resources.register(createImageResource(async (sessionId, signal) => {
      const response = await ctx.remote.pluginManager.invokeAction('dsh-plugin-codex-subscription', 'manage', { operation: 'image-session-view', args: JSON.stringify({ sessionId }) }, signal)
      if (!response.ok) throw response.error
      const payload: unknown = JSON.parse(response.value.output)
      return z.object({ ok: z.literal(true), value: z.unknown() }).parse(payload).value
    })), 'Codex image Session resource')
    const face = (sessionId: string): ImageCardInjected => ({ mediaUrl(taskId, assetId, variant, attempt = 0) {
      const url = new URL('api/codex-subscription/media', document.baseURI)
      url.searchParams.set('session', sessionId); url.searchParams.set('task', taskId); url.searchParams.set('asset', assetId)
      if (variant !== 'preview') url.searchParams.set('original', '1')
      if (variant === 'view') url.searchParams.set('view', '1')
      if (attempt) url.searchParams.set('attempt', String(attempt))
      return url.href
    } })
    ctx.slots.inject('tool.call.toolview', function* () {
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'codex_image_generate', locale: 'codexImages', inject: face }, ToolCard)
      yield ctx.slots.register({ name: 'tool.call.toolview', key: 'codex_image_result', locale: 'codexImages', inject: face }, ToolCard)
    })
    ctx.slots.inject('conversation.chat.node', () => ctx.slots.register({ name: 'conversation.chat.node', key: 'codex-image', locale: 'codexImages', inject: face }, ConversationCard))
    ctx.slots.inject('conversation.chat.process.status', function* () {
      yield ctx.slots.register({ name: 'conversation.chat.process.status', key: 'codex_image_generate', locale: 'codexImages' }, ProcessStatus)
      yield ctx.slots.register({ name: 'conversation.chat.process.status', key: 'codex_image_result', locale: 'codexImages' }, ProcessStatus)
    })
  } }
} })
