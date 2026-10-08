/** Owner-local IPC fixture: exercises supervisor replacement without booting a Harness application. */
import { appendFileSync, readFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { superviseWeb, WEB_CHILD_ENV } from '../../src/web-supervisor.ts'

const [logFile, mode] = process.argv.slice(2)
if (logFile === undefined || mode === undefined) throw new Error('missing fixture arguments')
const record = (event, fields = {}) => {
  appendFileSync(logFile, `${JSON.stringify({ event, pid: process.pid, ...fields })}\n`, 'utf8')
}

if (process.env[WEB_CHILD_ENV] !== '1') {
  process.on('message', message => {
    if (message?.type === 'fixture-interrupt') process.emit('SIGINT')
  })
  process.once('disconnect', () => { process.emit('SIGTERM') })
  const code = await superviseWeb()
  record('supervisor-exit', { code })
  process.disconnect?.()
  process.exitCode = code
} else {
  const generation = readFileSync(logFile, 'utf8').split('\n')
    .filter(line => line !== '' && JSON.parse(line).event === 'child-start').length + 1
  record('child-start', { generation, argv: process.argv.slice(2) })
  process.on('exit', code => { record('child-exit', { code, generation }) })
  const server = createServer()
  let stopping = false
  const shutdown = () => {
    if (stopping) return
    stopping = true
    record('child-shutdown', { generation })
    server.close(() => {
      record('child-disposed', { generation })
      process.disconnect?.()
      process.exitCode = mode === 'restart-failure' ? 23 : 0
    })
  }
  process.on('message', message => {
    if (message?.type === 'dsh-web-shutdown') shutdown()
  })
  process.once('disconnect', shutdown)
  const portIndex = process.argv.lastIndexOf('--port')
  const requestedPort = portIndex === -1 ? 0 : Number(process.argv[portIndex + 1])
  server.listen(requestedPort, '127.0.0.1', () => {
    const address = server.address()
    if (address === null || typeof address === 'string') throw new Error('fixture did not bind TCP')
    record('child-ready', { generation, port: address.port })
    process.send?.({ type: 'dsh-web-ready', port: address.port })
    if (mode === 'crash') process.exit(23)
    else if (mode === 'clean-exit' || generation > 1) shutdown()
    else if (mode === 'restart' || mode === 'restart-failure') {
      process.send?.({ type: 'dsh-web-restart' })
      process.send?.({ type: 'dsh-web-restart' })
    }
  })
}
