/** Encode continuous scan/palette motion over one generated subject; no pose cross-fades. */
import sharp from 'sharp'
import { readFile, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

const asset = name => fileURLToPath(new URL(`../assets/${name}`, import.meta.url))
const size = 192, frames = 75, duration = 2400
const original = await readFile(asset('analysis-status-base-v2.png'))
const image = await sharp(original).trim({ threshold: 10 }).resize({ width: 172, height: 130, fit: 'inside' }).ensureAlpha().png().toBuffer()
const dimensions = await sharp(image).metadata()
const left = Math.round((size - dimensions.width) / 2), top = 17
const base = await sharp({ create: { width: size, height: size, channels: 4, background: '#00000000' } }).composite([{ input: image, left, top }]).png().toBuffer()
const ease = value => { const x = Math.min(1, Math.max(0, value)); return x * x * (3 - 2 * x) }
const palette = ['#58756b', '#91a8ad', '#c6d4db', '#e4e7df']
const rendered = []
for (let frame = 0; frame < frames; frame++) {
  const phase = frame / frames
  const progress = ease((phase - .06) / .56)
  const x = 34 + progress * 123
  const visibility = ease(phase / .10) * (1 - ease((phase - .66) / .12))
  const chips = palette.map((color, index) => {
    const amount = ease((phase - .40 - index * .075) / .14) * (1 - ease((phase - .88) / .12))
    return `<rect x="${52 + index * 23}" y="${134 + (1 - amount) * 5}" width="18" height="9" rx="4.5" fill="${color}" opacity="${amount}"/>`
  }).join('')
  // 扫描仅在相片内部移动，起止均回到同一静态主体，循环处不会跳帧。
  const scan = `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}"><defs><clipPath id="photo"><rect x="34" y="42" width="123" height="77" rx="2"/></clipPath><linearGradient id="scan"><stop stop-color="#6c9cf8" stop-opacity="0"/><stop offset="1" stop-color="#91c6f7" stop-opacity=".24"/></linearGradient></defs><g clip-path="url(#photo)" opacity="${visibility}"><rect x="${x - 16}" y="42" width="16" height="77" fill="url(#scan)"/><path d="M${x} 42v77" stroke="#99cbff" stroke-width="1.8"/></g>${chips}</svg>`
  rendered.push(await sharp(base).composite([{ input: Buffer.from(scan) }]).ensureAlpha().raw().toBuffer())
}
await sharp(Buffer.concat(rendered), { raw: { width: size, height: size * frames, channels: 4, pageHeight: size } }).webp({ quality: 82, effort: 5, minSize: true, mixed: true, loop: 0, delay: Array(frames).fill(duration / frames) }).toFile(asset('analysis-status-animation-v2.webp'))
await sharp(rendered[Math.round(frames * .76)], { raw: { width: size, height: size, channels: 4 } }).webp({ quality: 90 }).toFile(asset('analysis-status-poster-v2.webp'))
await sharp({ create: { width: size * 4, height: size, channels: 4, background: '#00000000' } }).composite([0, .30, .55, .76].map((phase, index) => ({ input: rendered[Math.floor(phase * frames)], raw: { width: size, height: size, channels: 4 }, left: size * index, top: 0 }))).png().toFile(asset('analysis-status-phases-v2.png'))
const metadata = await sharp(asset('analysis-status-animation-v2.webp'), { animated: true }).metadata()
if (metadata.delay.reduce((sum, value) => sum + value, 0) !== duration) throw new Error('Encoded animation duration does not match the designed loop')
await writeFile(asset('analysis-status-animation-v2.json'), JSON.stringify({ width: size, height: size, frames: metadata.pages, durationMs: metadata.delay.reduce((sum, value) => sum + value, 0), fps: 1000 / (duration / frames), loop: metadata.loop, alpha: metadata.hasAlpha, stages: ['scan-in', 'scan-across', 'palette', 'return'], reducedMotion: 'analysis-status-poster-v2.webp' }, null, 2) + '\n', 'utf8')
console.log(JSON.stringify({ frames: metadata.pages, durationMs: duration, alpha: metadata.hasAlpha }))
