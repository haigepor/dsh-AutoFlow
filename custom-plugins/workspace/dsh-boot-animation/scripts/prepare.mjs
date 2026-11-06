/** Prepare Host modules and embed the selected cyberpunk MP4 for the media API. */
import { createHash } from 'node:crypto'
import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { join, resolve } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const output = process.argv[2] === '--outdir' && process.argv[3] ? resolve(process.argv[3]) : join(root, 'lib')
mkdirSync(join(output, 'host'), { recursive: true })
cpSync(new URL('../src/host/', import.meta.url), join(output, 'host'), { recursive: true })
writeFileSync(join(output, 'index.js'), "export { apply, name, inject } from './host/index.js'\n", 'utf8')

const clip = JSON.parse(readFileSync(new URL('../src/clip.json', import.meta.url), 'utf8'))
const video = readFileSync(new URL(`../assets/${clip.id}.mp4`, import.meta.url))
const hash = createHash('sha256').update(video).digest('hex')
if (video.length !== clip.bytes || hash !== clip.sha256) {
  throw new Error(`MP4 does not match the selected upstream clip: ${clip.id}`)
}
const encoded = video.toString('base64')
cpSync(new URL('../src/clips.meta.js', import.meta.url), join(output, 'clips.meta.js'))
cpSync(new URL('../src/clip.json', import.meta.url), join(output, 'clip.json'))
writeFileSync(join(output, 'clips.data.js'),
  `// Generated from assets/${clip.id}.mp4.\nexport const ${clip.id} = ${JSON.stringify(encoded)}\n`, 'utf8')
const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
console.log(`Prepared dsh-boot-animation ${version}: ${clip.id}.mp4, ${video.length} bytes (${root})`)
