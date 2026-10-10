import type { MacOSSigningEnvironment } from './desktop-release-environment.mjs'

/**
 * Reject signature details that do not describe a certificate-free ad-hoc identity.
 * @param details Output from codesign --display --verbose=4.
 */
export function assertMacOSAdHocSignatureDetails(details: string): void

/**
 * Sign one runtime file without a certificate, keychain or timestamp service.
 * @param path Writable standalone Mach-O file.
 * @param identifier Stable runtime identifier.
 * @param entitlements Optional JIT entitlement plist.
 * @returns Resolves after codesign exits successfully.
 */
export function signMacOSAdHocCode(path: string, identifier: string, entitlements: string | undefined): Promise<void>

/**
 * Verify integrity and an ad-hoc identity without asserting Apple trust.
 * @param path Runtime file or application bundle.
 * @param deep Whether to verify nested code.
 */
export function verifyMacOSAdHocSignature(path: string, deep?: boolean): void

/**
 * Reject signature metadata that does not name the company release authority and team.
 * @param details - Output from `codesign --display --verbose=4`.
 * @param expected - Public release identity.
 */
export function assertMacOSSignatureDetails(details: string, expected: MacOSSigningEnvironment): void

/**
 * Require the signature properties Apple validates for executable runtime content.
 * @param details - Output from `codesign --display --verbose=4`.
 * @param expected - Public release identity.
 */
export function assertMacOSRuntimeSignatureDetails(details: string, expected: MacOSSigningEnvironment): void

/**
 * Sign one Mach-O file using the packaging-owned CSC_KEYCHAIN; missing setup rejects before signing.
 * @param path - Writable standalone Mach-O file.
 * @param identifier - Stable code-signing identifier derived from the release app ID and CAS digest.
 * @param expected - Public release identity.
 * @param entitlements - Optional entitlement plist for this executable.
 * @returns Resolves after codesign exits successfully.
 */
export function signMacOSRuntimeCode(
  path: string,
  identifier: string,
  expected: MacOSSigningEnvironment,
  entitlements?: string,
): Promise<void>

/**
 * Verify one Mach-O file embedded in the runtime tree.
 * @param path - Mach-O file to inspect.
 * @param expected - Public release identity.
 */
export function verifyMacOSRuntimeCode(path: string, expected: MacOSSigningEnvironment): void

/**
 * Verify the full application signature and its release owner.
 * @param appPath - Path to the packaged `.app` directory.
 * @param expected - Public release identity.
 */
export function verifyMacOSSignature(appPath: string, expected: MacOSSigningEnvironment): void

/**
 * Verify an independently distributed application's signature, ticket, and Gatekeeper acceptance.
 * @param appPath - Path to the stapled `.app` directory.
 * @param expected - Public release identity.
 */
export function verifyMacOSNotarizedApplication(appPath: string, expected: MacOSSigningEnvironment): void

/**
 * Verify the release identity, stapled ticket, and Gatekeeper acceptance of one disk image.
 * @param diskImagePath - Path to the packaged `.dmg` file.
 * @param expected - Public release identity.
 */
export function verifyMacOSDiskImage(
  diskImagePath: string,
  expected: MacOSSigningEnvironment,
): void

/** Electron-builder fields required to locate a signed macOS application. */
export interface MacOSAfterSignContext {
  readonly electronPlatformName: string
  readonly appOutDir: string
  readonly packager: {
    readonly appInfo: {
      readonly productFilename: string
    }
  }
}

/**
 * Verify the macOS application produced by electron-builder's signing phase.
 * @param context - electron-builder hook context.
 * @param expected - Public release identity.
 */
export function verifyMacOSSignatureAfterSign(
  context: MacOSAfterSignContext,
  expected: MacOSSigningEnvironment,
): void
