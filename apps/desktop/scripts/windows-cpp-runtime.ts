/** Prepare app-local Microsoft runtime DLLs for the Windows Office helper. */
import { execFile } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

async function run(output: string | undefined, environment: NodeJS.ProcessEnv): Promise<void> {
  // Windows PowerShell 不能加载继承自 PowerShell 7 的 Core 模块目录。
  const env = Object.fromEntries(Object.entries(environment).filter(([name]) => !/^PSModulePath$/iu.test(name)))
  const { stdout } = await promisify(execFile)('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
    '-File', fileURLToPath(new URL('./prepare-windows-cpp-runtime.ps1', import.meta.url)),
    ...(output === undefined ? ['-CheckOnly'] : ['-OutputDirectory', output]),
  ], { env, windowsHide: true, timeout: 120_000 })
  process.stdout.write(stdout)
}

/**
 * Validate the build host's redistributable DLLs without changing the system or creating payload files.
 * @param environment Build-tool locations and optional explicit CRT directory.
 * @returns Resolves after x64 architecture, supported version and Microsoft signatures pass.
 */
export async function checkWindowsCppRuntime(environment: NodeJS.ProcessEnv): Promise<void> {
  await run(undefined, environment)
}

/**
 * Copy verified Microsoft DLLs beside the native Office executable; updates service these private copies.
 * @param directory Native Office helper directory owned by the prepared payload.
 * @param environment Build-tool locations and optional explicit CRT directory.
 * @returns Resolves after validation, copying and writing version/hash metadata.
 */
export async function prepareWindowsCppRuntime(directory: string, environment: NodeJS.ProcessEnv): Promise<void> {
  await run(resolve(directory), environment)
}
