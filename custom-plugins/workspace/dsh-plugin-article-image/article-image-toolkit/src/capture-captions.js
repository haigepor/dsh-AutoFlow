/** Adapter-declared WebVTT sources add timed public text without claiming video capture. */
import { JSDOM } from 'jsdom'
import { captureUrl } from './capture-media.js'
import { failure, assertArticleStatus } from './contracts.js'

const tidy = text => (text ?? '').replace(/\s+/gu, ' ').trim()
const timestamp = '(?:[0-9]{2,}:)?[0-5][0-9]:[0-5][0-9]\\.[0-9]{3}'
const timing = new RegExp(`^(${timestamp})[ \\t]+-->[ \\t]+(${timestamp})(?:[ \\t]+[^\\n]*)?$`, 'u')
const cueTime = value => {
  const parts = value.split(':')
  if (parts.length === 2) parts.unshift('00')
  return { text: parts.join(':'), seconds: Number(parts[0]) * 3600 + Number(parts[1]) * 60 + Number(parts[2]) }
}

function fillPoster(root, anchor, poster, rule, url) {
  if (!anchor || !poster || !rule.metadata?.poster || typeof poster.url !== 'string' || poster.url.length > 16384 || typeof poster.title !== 'string' || poster.title.length > 2000) return
  try {
    const target = captureUrl(new URL(poster.url, url).href), noise = '.ima-ad-container,[data-ad],[data-ad-slot],[hidden],[aria-hidden="true"],[data-ai-hidden="true"],.advertisement,.advert'
    if (!rule.metadata.poster.hosts.includes(target.hostname)) return
    const videos = [...anchor.querySelectorAll('video')].filter(video => !video.closest(noise) && video.getAttribute('title')?.toLowerCase() !== 'advertisement')
    const matching = videos.filter(video => video.getAttribute('poster') && new URL(video.getAttribute('poster'), url).href === target.href)
    const selected = matching.length ? matching : videos.length === 1 && !videos[0].getAttribute('poster') ? videos : []
    // 只补当前文章声明且尚未初始化的封面属性；图片仍走普通候选、预算和真实解码。
    for (const video of selected) {
      if (!video.getAttribute('poster')) video.setAttribute('poster', target.href)
      if (!tidy(video.getAttribute('title'))) video.setAttribute('title', tidy(poster.title))
    }
    for (const image of root.querySelectorAll('img[src]')) if (!image.closest(noise) && !tidy(image.getAttribute('alt')) && new URL(image.getAttribute('src'), url).href === target.href) image.setAttribute('alt', tidy(poster.title))
  } catch (error) { void error /* 非法封面声明不影响独立且有效的公开字幕。 */ }
}

/** Parse the entire UTF-8 caption file before publishing any cues. Unsupported/malformed cues fail closed; NOTE, STYLE and REGION never become prose. @param {Buffer} bytes Bounded WebVTT. @param {number} limit Remaining cue budget. @returns {object[]} Timed plain text cues. */
export function parseCaptionCues(bytes, limit) {
  let source
  try { source = new TextDecoder('utf-8', { fatal: true }).decode(bytes).replace(/\r\n?/gu, '\n') }
  catch (error) { void error; throw failure('article-extraction') }
  if (source.includes('\0')) throw failure('article-extraction')
  const sections = source.split(/\n[ \t]*\n/gu)
  if (!/^WEBVTT(?:[ \t][^\n]*)?(?:\n|$)/u.test(sections.shift() ?? '')) throw failure('article-extraction')
  const cues = []
  for (const section of sections) {
    if (!section.trim() || /^(?:NOTE(?:[ \t\n]|$)|STYLE(?:\n|$)|REGION(?:\n|$))/u.test(section)) continue
    const lines = section.split('\n')
    const match = timing.exec(lines[0]) ?? timing.exec(lines[1] ?? '')
    if (!match) throw failure('article-extraction')
    const offset = timing.test(lines[0]) ? 1 : 2, start = cueTime(match[1]), end = cueTime(match[2])
    if (!Number.isFinite(end.seconds) || end.seconds <= start.seconds) throw failure('article-extraction')
    const payload = lines.slice(offset).join('\n').replace(/<(?:(?:[0-9]{2,}:)?[0-5][0-9]:[0-5][0-9]\.[0-9]{3})>/gu, '')
    const fragment = JSDOM.fragment(payload)
    for (const node of fragment.querySelectorAll('script,style,iframe,object,embed,svg,canvas')) node.remove()
    const text = tidy(fragment.textContent)
    if (!text) throw failure('article-extraction')
    if (cues.length >= limit) throw failure('article-resource-limit')
    cues.push({ start: start.text, end: end.text, text })
  }
  if (!cues.length) throw failure('article-extraction')
  return cues
}

/** Fetch only declared subtitle/caption tracks, sharing the parent's source/HTML/character budgets and cancellation. @param {object} input Article DOM, adapter, budgets, transport and safe progress observer. @returns {Promise<object>} Checks and partial reasons. */
export async function captureCaptions({ document, root, url, site, config, budget, count, request, jar, signal, onProgress, captionDeclarations = [] }) {
  const reasons = new Set(), checks = [], seen = new Set(), excluded = site.excludeSelector ? [...document.querySelectorAll(site.excludeSelector)] : []
  let usedCues = 0
  for (const [ruleIndex, rule] of (site.captionSources ?? []).entries()) {
    const candidates = [...root.querySelectorAll(rule.selector)].map(track => ({ track, anchor: null }))
    if (rule.metadata && root.querySelector(rule.metadata.anchorSelector)) {
      try {
        const declarations = Array.isArray(captionDeclarations) ? captionDeclarations.filter(value => value?.ruleIndex === ruleIndex) : []
        if (declarations.length !== 1) throw failure('article-content-not-ready')
        const declaration = declarations[0], anchors = root.querySelectorAll(rule.metadata.anchorSelector)
        if (declaration.code || declaration.identity !== url || anchors.length !== 1 || !Array.isArray(declaration.sources) || !declaration.sources.length || declaration.sources.length > config.maxEmbeddedSources) throw failure('article-extraction')
        const declared = []
        for (const src of declaration.sources) {
          if (typeof src !== 'string' || src.length > 16384) throw failure('article-extraction')
          const track = document.createElement('track')
          track.kind = 'subtitles'; track.src = captureUrl(new URL(src, url).href).href; track.srclang = rule.metadata.language
          declared.push({ track, anchor: anchors[0], poster: declaration.poster })
        }
        candidates.unshift(...declared)
      } catch (error) {
        reasons.add('embedded-source-incomplete')
        await onProgress({ phase: 'extracting', event: 'caption-source-failed', details: { code: /^article-[a-z-]+$/u.test(error.code ?? '') ? error.code : 'article-extraction' } })
      }
    }
    for (const { track, anchor, poster } of candidates) {
      if (!track.matches('track[src]') || !['subtitles', 'captions'].includes(track.getAttribute('kind')?.toLowerCase())) continue
      const media = anchor ?? track.closest('video,audio'), sourceNode = anchor ?? track
      if (!media || !root.contains(media) || excluded.some(node => node.contains(sourceNode))) continue
      if (sourceNode.closest('[hidden],[aria-hidden="true"],[data-ai-hidden="true"],nav,aside,footer,[role="navigation"],[role="complementary"],.related,.recommendations,.recommended,[class~="advertisement" i],[class~="advert" i],.comments,#comments,[data-ad],[data-ad-slot],[data-primis-wrapper],[aria-label="Advertisement" i],[title="Advertisement" i]')) continue
      let invisible = false
      // 播放器可用封面替代 visibility:hidden 的原生媒体；其公开 track 仍有效，隐藏祖先不例外。
      for (let node = media; node && root.contains(node); node = node.parentElement) if (node.style.display === 'none' || (node.style.visibility === 'hidden' && (node !== media || !media.matches('video,audio')))) invisible = true
      if (invisible) continue
      let target, response, allowance = 0
      try {
        target = captureUrl(new URL(track.getAttribute('src'), url).href)
        if (!rule.hosts.includes(target.hostname) || seen.has(target.href)) continue
        seen.add(target.href)
        fillPoster(root, anchor, poster, rule, url)
        if (++count > config.maxEmbeddedSources) throw failure('article-resource-limit')
        allowance = config.maxArticleHtmlBytes - budget.bytes
        if (allowance <= 0 || budget.chars >= config.maxArticleHtmlChars || budget.elements >= config.maxArticleElements) throw failure('article-resource-limit')
        await onProgress({ phase: 'extracting', event: 'caption-source-start', details: { origin: target.origin, attempt: count } })
        const cookie = jar.header(target.href)
        response = await request(target.href, { signal, maxBytes: allowance, headers: { accept: 'text/vtt', referer: new URL(url).origin + '/', ...(cookie ? { cookie } : {}) } })
        if (signal.aborted) throw failure('article-interrupted')
        budget.bytes += response.bytes.length
        if (budget.bytes > config.maxArticleHtmlBytes) throw failure('article-resource-limit')
        const final = captureUrl(response.url ?? target.href)
        if (final.origin !== target.origin) throw failure('article-redirect')
        assertArticleStatus(response.statusCode)
        if (response.mime !== 'text/vtt') throw failure('article-content-type')
        jar.store(final.href, response.headers ?? {})
        const cues = parseCaptionCues(response.bytes, config.maxCaptionCues - usedCues)
        budget.chars += new TextDecoder().decode(response.bytes).length
        budget.elements += cues.length + 3
        if (budget.chars > config.maxArticleHtmlChars || budget.elements > config.maxArticleElements) throw failure('article-resource-limit')
        const projection = document.createElement('section'), source = document.createElement('p'), link = document.createElement('a')
        link.href = final.href; link.textContent = `WebVTT · ${tidy(track.label || track.srclang || track.kind)}`
        source.append(link); projection.append(source)
        for (const cue of cues) {
          const paragraph = document.createElement('p')
          paragraph.textContent = `${cue.start}–${cue.end} ${cue.text}`
          projection.append(paragraph)
        }
        // 整份字幕验证并预留正文空间后才插入；失败不留下看似完整的前缀。
        if (tidy(root.textContent).length + tidy(projection.textContent).length > config.maxArticleChars) throw failure('article-resource-limit')
        media.before(projection); usedCues += cues.length
        checks.push(`caption-track:${cues.length}`)
        await onProgress({ phase: 'extracting', event: 'caption-source-complete', completed: cues.length, total: cues.length, details: { origin: final.origin, bytes: response.bytes.length, chars: cues.reduce((sum, cue) => sum + cue.text.length, 0) } })
      } catch (error) {
        if (signal.aborted) throw failure('article-interrupted')
        if (!response && allowance > 0 && !['article-url-blocked', 'article-redirect'].includes(error.code)) budget.bytes += allowance
        reasons.add('embedded-source-incomplete')
        const code = /^article-[a-z-]{1,80}$/u.test(error.code ?? '') ? error.code : 'article-extraction'
        await onProgress({ phase: 'extracting', event: 'caption-source-failed', details: { code, ...(target ? { origin: target.origin } : {}) } })
      }
    }
  }
  return { reasons, checks }
}
