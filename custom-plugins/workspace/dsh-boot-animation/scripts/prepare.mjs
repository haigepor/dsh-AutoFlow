/** Prepare Host modules and embed the selected cyberpunk MP4 for the media API. */
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const root = fileURLToPath(new URL('../', import.meta.url))
mkdirSync(new URL('../lib/host/', import.meta.url), { recursive: true })
cpSync(new URL('../src/host/', import.meta.url), new URL('../lib/host/', import.meta.url), { recursive: true })
writeFileSync(new URL('../lib/index.js', import.meta.url), "export { apply, name, inject } from './host/index.js'\n", 'utf8')

const clip = JSON.parse(readFileSync(new URL('../src/clip.json', import.meta.url), 'utf8'))
const video = readFileSync(new URL(`../assets/${clip.id}.mp4`, import.meta.url))
const hash = createHash('sha256').update(video).digest('hex')
if (video.length !== clip.bytes || hash !== clip.sha256) {
  throw new Error(`MP4 does not match the selected upstream clip: ${clip.id}`)
}
const encoded = video.toString('base64')
const metadata = { ...clip, ext: '.mp4', sha256: hash.slice(0, 16), b64: encoded.length }
writeFileSync(new URL('../lib/clips.meta.js', import.meta.url),
  `// Generated from src/clip.json and assets/${clip.id}.mp4.\nexport const CLIPS = ${JSON.stringify([metadata], null, 2)}\n`, 'utf8')
writeFileSync(new URL('../lib/clips.data.js', import.meta.url),
  `// Generated from assets/${clip.id}.mp4.\nexport const ${clip.id} = ${JSON.stringify(encoded)}\n`, 'utf8')
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
console.log(`Prepared dsh-boot-animation ${version}: ${clip.id}.mp4, ${video.length} bytes (${root})`)
