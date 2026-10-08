#!/usr/bin/env node
/**
 * Command-line entry for dsh.
 * @module @deepseek-ai/dsh/bin
 */

/* v8 ignore file -- built-bin acceptance exercises this self-executing dispatch. */

import { getDshRuntimeVersion, loadLayeredEnv, StartupError } from '@deepseek-ai/dsh-app-boot'
import { resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { parseDshArgs } from './args.ts'
import { reportStartupFailure } from './startup-diagnostics.ts'
import type { RunProfileOptions } from './profile-boot.ts'

/** Installation-owned dependencies supplied by a packaged CLI launcher. */
export type RunCliOptions = Pick<RunProfileOptions, 'packageManager'> & {
  /** Permit plugin commands for Desktop's existing profile; reserved for its installed carrier. */
  manageDesktopProfile?: boolean
}

/**
 * Run the public dsh command-line interface.
 * @param options - Package runtime and Desktop profile access supplied by the installation.
 * @returns a promise that settles when the selected command mode finishes.
 */
export async function runCli(options: RunCliOptions = {}): Promise<void> {
  const version = getDshRuntimeVersion()
  const { manageDesktopProfile, ...profileOptions } = options
  const invocation = parseDshArgs(process.argv.slice(2), version, manageDesktopProfile)

  switch (invocation.mode) {
    case 'profile': {
      const { WEB_CHILD_ENV, superviseWeb } = await import('./web-supervisor.ts')
      const supervised = process.env[WEB_CHILD_ENV] === '1' && process.connected
      if (invocation.profile === 'web' && !supervised) {
        process.exitCode = await superviseWeb()
        break
      }
      const childState = { pendingShutdown: false }
      let interrupt: (() => void) | undefined
      const shutdownChild = (): void => { childState.pendingShutdown = true; interrupt?.() }
      const parentMessage = (message: unknown): void => {
        if (typeof message === 'object' && message !== null && 'type' in message && message.type === 'dsh-web-shutdown') {
          shutdownChild()
        }
      }
      if (supervised) {
        process.on('message', parentMessage)
        process.once('disconnect', shutdownChild)
        process.send?.({ type: 'dsh-web-listening' })
      }
      try {
        const { runProfile } = await import('./profile-boot.ts')
        const application = await runProfile({
          environment: loadLayeredEnv('dsh'),
          profile: invocation.profile,
          fromDefaultProfile: invocation.fromDefaultProfile,
          patchFiles: invocation.patches,
          args: invocation.args,
          ...profileOptions,
          ...(supervised ? { restart: () => { process.send?.({ type: 'dsh-web-restart' }) } } : {}),
        })
        if (supervised) {
          interrupt = () => { application.shutdown.interrupt(0) }
          if (childState.pendingShutdown) { interrupt(); break }
          const port = application.ctx.get('webServer')?.port
          if (port !== undefined) process.send?.({ type: 'dsh-web-ready', port })
        }
      } catch (error) {
        if (supervised) {
          process.off('message', parentMessage)
          process.off('disconnect', shutdownChild)
        }
        if (!(error instanceof StartupError)) throw error
        await reportStartupFailure(error, { home: resolveDshHome(), version, profile: invocation.profile })
        process.exit(1)
      }
      break
    }
    case 'plugin': {
      const { runPlugin } = await import('./plugin.ts')
      process.exit(await runPlugin(invocation.profile, invocation.args, options.packageManager))
      break
    }
    case 'dump-config': {
      const { runDumpConfig } = await import('./dump-config.ts')
      runDumpConfig(
        invocation.profile,
        invocation.defaultOnly,
        invocation.patches,
        invocation.fromDefaultProfile,
      )
      break
    }
    case 'dump-config-schema': {
      const { runDumpConfigSchema } = await import('./dump-config-schema.ts')
      await runDumpConfigSchema(invocation.profile, invocation.patches, invocation.fromDefaultProfile)
      break
    }
    default:
      invocation satisfies never
      throw new Error(`dsh: unhandled invocation mode ${JSON.stringify(invocation)}`)
  }
}

if (import.meta.main) {
  await runCli()
}
