#!/usr/bin/env node
/** Stdio entry point: configuration comes from argv, then environment, then defaults. */
import { start } from '../src/server.js'

const argv = process.argv.slice(2)
const flag = name => {
  const index = argv.indexOf(`--${name}`)
  return index >= 0 ? argv[index + 1] : undefined
}
const dataDir = flag('data-dir') ?? process.env.ARTICLE_IMAGE_DATA_DIR
const sourceUrl = flag('source-url') ?? process.env.ARTICLE_IMAGE_SOURCE_URL
const timeout = flag('timeout-ms') ?? process.env.ARTICLE_IMAGE_TIMEOUT_MS
const config = {
  ...(dataDir ? { dataDir } : {}),
  ...(sourceUrl ? { sourceUrl } : {}),
  ...(timeout ? { requestTimeoutMs: Number(timeout) } : {}),
}

await start(config)
