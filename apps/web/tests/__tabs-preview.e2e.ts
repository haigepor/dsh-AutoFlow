import { writeFile, access } from 'node:fs/promises'
import { setTimeout as delay } from 'node:timers/promises'
import { it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { launchWebScaffold } from './scaffold.ts'

it('holds an isolated preview for browser inspection', async () => {
  const scaffold = await launchWebScaffold({ developerTools: true })
  try {
    const handle = await scaffold.ctx.agents.create({
      sessionId: SessionId('view-tabs-preview'), meta: { cwd: scaffold.workspaceCwd },
    })
    handle.agent.session.append('turn/start', { turn: 1 })
    handle.agent.session.append('session/title', {
      title: '会话标签栏折叠预览', messageSeqs: [], source: { kind: 'fallback' },
    })
    handle.agent.session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
    await scaffold.ctx.sessions.flush(handle.agent.session)
    await writeFile('C:/Users/haige/AppData/Local/Temp/dsh-tabs-preview.json', JSON.stringify({
      url: scaffold.authenticatedUrl,
    }), 'utf8')
    for (let count = 0; count < 300; count++) {
      try { await access('C:/Users/haige/AppData/Local/Temp/dsh-tabs-preview.done'); break }
      catch { await delay(1000) }
    }
  } finally { await scaffold.close() }
}, 360_000)
