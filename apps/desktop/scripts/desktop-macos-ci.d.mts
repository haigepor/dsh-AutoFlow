/** Types for the artifact-only macOS Actions adapter. */

/** Confirmed dispatch inputs and observed source checkout. */
export interface MacOSCIBuild {
  deployment: string
  version: string
  productVersion: string
  expectedCommit: string
  actualCommit: string
  dirty: boolean
}

/** Paths belonging to one temporary CI invocation. */
export interface MacOSCIPaths {
  directory: string
  runnerTemp: string
  appRoot: string
}

/**
 * Reject implicit environments, automatic versions and a different or dirty checkout.
 * @param input Confirmed dispatch values and observed checkout.
 * @returns Nothing; invalid inputs throw before credentials are loaded.
 */
export function validateMacOSCIBuild(input: MacOSCIBuild): void

/**
 * Allocate private credentials, temporary files and artifact staging directories.
 * @param runnerTemp Existing runner temporary directory.
 * @param appRoot Desktop checkout directory.
 * @returns Owned root that must never be cached or uploaded wholesale.
 */
export function initializeMacOSCI(runnerTemp: string, appRoot: string): string

/**
 * Decode credentials and exclusively create .env.macos; validate without signing or contacting Apple.
 * @param options Owned paths, Environment secrets and optional keychain search-list adapter.
 * @returns Resolves after existing package environment validation.
 */
export function prepareMacOSCI(options: MacOSCIPaths & {
  environment: NodeJS.ProcessEnv
  runSecurity?: (args: string[]) => string
}): Promise<void>

/**
 * Retain new packaging journals after credential and URL-token redaction.
 * @param options Owned paths.
 * @returns Nothing; configuration, credentials and prepared runtimes are excluded.
 */
export function collectMacOSCIDiagnostics(options: MacOSCIPaths): void

/**
 * Verify completion and feed hashes before staging the explicit artifact list and SHA256SUMS.
 * @param options Owned paths and confirmed dispatch values.
 * @returns Resolves after staging, without networking or publication.
 */
export function stageMacOSCIArtifacts(options: MacOSCIPaths & {
  version: string
  productVersion: string
  deployment: string
  expectedCommit: string
}): Promise<void>

/**
 * Restore keychains and remove owned credentials/configuration while retaining staged evidence.
 * @param options Owned paths and optional Apple command adapter.
 * @returns Nothing; cleanup failure throws after attempting private-file removal.
 */
export function cleanupMacOSCI(options: MacOSCIPaths & {
  runSecurity?: (args: string[]) => string
}): void
