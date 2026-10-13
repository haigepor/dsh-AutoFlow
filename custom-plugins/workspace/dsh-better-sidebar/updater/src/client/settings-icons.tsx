/** Local SVG sources also shipped as individually reusable vector assets. */
import files from '../../assets/icons/files.svg'
import changes from '../../assets/icons/changes.svg'
import tasks from '../../assets/icons/tasks.svg'
import chat from '../../assets/icons/chat.svg'
import terminal from '../../assets/icons/terminal.svg'
import diff from '../../assets/icons/diff.svg'
import markdown from '../../assets/icons/markdown.svg'
import html from '../../assets/icons/html.svg'
import code from '../../assets/icons/code.svg'

const sources: Record<string, string> = {
  'tab:editor': files, 'tab:git': changes, 'tab:subagent': tasks,
  'tab:sidechat': chat, 'tab:terminal-bottom': terminal, 'tab:diff': diff,
  'viewer:markdown': markdown, 'viewer:html': html, 'viewer:code': code,
}
const urls = Object.fromEntries(Object.entries(sources).map(([key, svg]) => [key, `data:image/svg+xml,${encodeURIComponent(svg)}`]))

/** Return an owned builtin icon, leaving unknown extension icons to their descriptor. */
export function settingsIcon(kind: string, id: string) {
  const src = urls[`${kind}:${id}`]
  return src ? <img src={src} alt="" width={22} height={22} draggable={false} /> : undefined
}
