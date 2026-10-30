/** Cross-platform native single-directory chooser behind the native backend's capability. */

import { runNativeCommand, type NativeCommandRunner } from '@deepseek-ai/dsh-native-command'
import { pickWin32Directory, pickWin32Images, pickWin32References } from './win32-dialog.ts'

/** Testable command boundary; native implementations never invoke a shell. */
export type DirectoryPickerRunner = NativeCommandRunner

/** Injectable platform facts for deterministic adapter tests. */
export interface DirectoryPickerInternals {
  platform?: NodeJS.Platform
  run?: DirectoryPickerRunner
  /** Replaces the in-process Win32 dialog (`pickWin32Directory`) for deterministic tests. */
  pickWin32Dialog?: (signal: AbortSignal) => Promise<string | null>
  /** Replaces the native image chooser for platform-independent tests. */
  pickWin32ImageDialog?: (signal: AbortSignal, title: string) => Promise<string[] | null>
  /** Replaces the combined image/folder window for deterministic tests. */
  pickWin32ReferenceDialog?: (signal: AbortSignal, title: string, folderLabel: string) => Promise<string[] | null>
}

/** The prompt every native chooser shows. */
const DIALOG_TITLE = 'Select Workspace Directory'

/**
 * macOS panel source, run by the system JXA host (`osascript -l JavaScript`).
 *
 * A native panel resolves ⌘C/⌘V/⌘A/⌘X as main-menu key equivalents rather than
 * as focused-field behavior, so the script installs that menu before opening
 * `NSOpenPanel`; AppleScript's `choose folder` runs in a helper that has no
 * menu, which leaves every text field of its panel (Go to Folder, Search,
 * Tags) un-pastable. Menu items stay untargeted, so AppKit enables them
 * against the responder chain that owns the panel's field editor. The prompt
 * arrives as argv, never as executable source, and a cancel prints an empty
 * line instead of failing. A cancelled panel still reports its highlighted or
 * current directory in `URLs`, so only an OK response reads the selection.
 * Activation is queued for the modal event loop; requesting it before that
 * loop starts can leave the panel inactive.
 */
const MAC_PANEL = `
ObjC.import('AppKit');
function run(argv) {
  var app = $.NSApplication.sharedApplication;
  app.setActivationPolicy($.NSApplicationActivationPolicyAccessory);
  var mainMenu = $.NSMenu.alloc.init;
  mainMenu.addItem($.NSMenuItem.alloc.init);
  var editMenu = $.NSMenu.alloc.initWithTitle('Edit');
  var editItem = $.NSMenuItem.alloc.init;
  editItem.submenu = editMenu;
  mainMenu.addItem(editItem);
  editMenu.addItemWithTitleActionKeyEquivalent('Undo', 'undo:', 'z');
  editMenu.addItemWithTitleActionKeyEquivalent('Redo', 'redo:', 'Z');
  editMenu.addItemWithTitleActionKeyEquivalent('Cut', 'cut:', 'x');
  editMenu.addItemWithTitleActionKeyEquivalent('Copy', 'copy:', 'c');
  editMenu.addItemWithTitleActionKeyEquivalent('Paste', 'paste:', 'v');
  editMenu.addItemWithTitleActionKeyEquivalent('Select All', 'selectAll:', 'a');
  app.mainMenu = mainMenu;
  var panel = $.NSOpenPanel.openPanel;
  panel.canChooseFiles = false;
  panel.canChooseDirectories = true;
  panel.canCreateDirectories = true;
  panel.allowsMultipleSelection = false;
  if (argv[1] === 'images' || argv[1] === 'references') {
    panel.canChooseFiles = true;
    panel.canChooseDirectories = argv[1] === 'references';
    panel.allowsMultipleSelection = true;
    panel.allowedFileTypes = ['jpg', 'jpeg', 'png', 'webp'];
  }
  panel.message = argv[0];
  $.NSOperationQueue.mainQueue.addOperationWithBlock(function() {
    app.activateIgnoringOtherApps(true);
  });
  if (panel.runModal !== $.NSModalResponseOK) return '';
  var urls = panel.URLs;
  if (urls.count < 1) return '';
  if (argv[1] === 'images' || argv[1] === 'references') {
    var paths = [];
    for (var index = 0; index < urls.count; index++) paths.push(ObjC.unwrap(urls.objectAtIndex(index).path));
    return JSON.stringify(paths);
  }
  return ObjC.unwrap(urls.objectAtIndex(0).path);
}`

function outputPath(stdout: string): string | null {
  const path = stdout.replace(/[\r\n]+$/, '')
  return path === '' ? null : path
}

function errorCode(error: unknown): string | number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  const code = (error as { code?: unknown }).code
  return typeof code === 'string' || typeof code === 'number' ? code : undefined
}

function isMissingCommand(error: unknown): boolean {
  return errorCode(error) === 'ENOENT'
}

function rethrowIfAborted(signal: AbortSignal, error: unknown): void {
  if (signal.aborted) throw error
}

/**
 * Open the platform directory picker.
 * @param signal - caller/connection lifetime; abort terminates the native command.
 * @param internals - Platform and runner hooks for deterministic tests.
 * @param title - Localized dialog title; workspace consumers use the default title.
 * @returns the selected path, or null when the user cancels.
 */
export async function pickNativeDirectory(
  signal: AbortSignal,
  internals: DirectoryPickerInternals = {},
  title = DIALOG_TITLE,
): Promise<string | null> {
  const platform = internals.platform ?? process.platform
  const run = internals.run ?? runNativeCommand

  if (platform === 'darwin') {
    const result = await run('osascript', ['-l', 'JavaScript', '-e', MAC_PANEL, title], signal, 'hidden')
    return outputPath(result.stdout)
  }

  if (platform === 'win32') {
    // The koffi-backed IFileOpenDialog child process — the modern picker with
    // per-monitor-v2 DPI and abort support. koffi is a packaged dependency
    // whose availability the install guarantees, so there is no fallback
    // tier: any failure surfaces as-is (no PowerShell fallback tier; see
    // .agents/notes/archived/simplification/2026-08-04-drop-windows-powershell-picker-fallback.md).
    return internals.pickWin32Dialog ? await internals.pickWin32Dialog(signal) : await pickWin32Directory(signal, {}, title)
  }

  if (platform === 'linux') {
    try {
      const result = await run('zenity', [
        '--file-selection', '--directory', `--title=${title}`,
      ], signal, 'hidden')
      return outputPath(result.stdout)
    } catch (error: unknown) {
      rethrowIfAborted(signal, error)
      if (errorCode(error) === 1) return null
      if (!isMissingCommand(error)) throw error
    }

    try {
      const result = await run('kdialog', [
        '--getexistingdirectory', '.', '--title', title,
      ], signal, 'hidden')
      return outputPath(result.stdout)
    } catch (error: unknown) {
      rethrowIfAborted(signal, error)
      if (errorCode(error) === 1) return null
      if (isMissingCommand(error)) {
        throw new Error('no supported native directory picker found (install zenity or kdialog)')
      }
      throw error
    }
  }

  throw new Error(`native directory picker is unsupported on ${platform}`)
}

/** Open the system image chooser, returning paths without reading or copying image bytes.
 * @param signal Caller lifetime; abort closes the chooser.
 * @param title Localized dialog title.
 * @param internals Platform and command operations used by deterministic tests.
 * @returns Selected JPEG, PNG or WebP paths, or null when the operator cancels.
 */
export async function pickNativeImages(
  signal: AbortSignal, title: string, internals: DirectoryPickerInternals = {},
): Promise<string[] | null> {
  signal.throwIfAborted()
  const platform = internals.platform ?? process.platform, run = internals.run ?? runNativeCommand
  if (platform === 'win32') return await (internals.pickWin32ImageDialog ?? pickWin32Images)(signal, title)
  if (platform === 'darwin') {
    const result = await run('osascript', ['-l', 'JavaScript', '-e', MAC_PANEL, title, 'images'], signal, 'hidden')
    if (!result.stdout.trim()) return null
    const paths: unknown = JSON.parse(result.stdout)
    if (!Array.isArray(paths) || !paths.every((path): path is string => typeof path === 'string' && path.length > 0)) throw new Error('native image picker returned invalid paths')
    return paths.length ? paths : null
  }
  if (platform === 'linux') {
    let output: string
    try {
      output = (await run('zenity', ['--file-selection', '--multiple', '--separator=\n', `--title=${title}`, '--file-filter=JPEG / PNG / WebP | *.jpg *.jpeg *.png *.webp *.JPG *.JPEG *.PNG *.WEBP'], signal, 'hidden')).stdout
    } catch (error) {
      rethrowIfAborted(signal, error)
      if (errorCode(error) === 1) return null
      if (!isMissingCommand(error)) throw error
      try { output = (await run('kdialog', ['--getopenfilename', '.', 'JPEG / PNG / WebP (*.jpg *.jpeg *.png *.webp *.JPG *.JPEG *.PNG *.WEBP)', '--multiple', '--separate-output', '--title', title], signal, 'hidden')).stdout }
      catch (fallbackError) {
        rethrowIfAborted(signal, fallbackError)
        if (errorCode(fallbackError) === 1) return null
        throw fallbackError
      }
    }
    const paths = output.replace(/[\r\n]+$/, '').split(/\r?\n/).filter(Boolean)
    return paths.length ? paths : null
  }
  throw new Error(`native image picker is unsupported on ${platform}`)
}

/** Select local image files or folders through one entry without reading image bytes.
 * @param signal Request lifetime.
 * @param labels Localized chooser and selection-mode labels.
 * @param internals Deterministic platform and native-command operations.
 * @returns Original paths, or null on cancellation. Linux asks for a mode before its platform chooser.
 */
export async function pickNativeReferences(
  signal: AbortSignal, labels: { title: string; folderLabel: string; imagesLabel: string }, internals: DirectoryPickerInternals = {},
): Promise<string[] | null> {
  signal.throwIfAborted()
  const platform = internals.platform ?? process.platform, run = internals.run ?? runNativeCommand
  if (platform === 'win32') return await (internals.pickWin32ReferenceDialog ?? pickWin32References)(signal, labels.title, labels.folderLabel)
  if (platform === 'darwin') {
    const result = await run('osascript', ['-l', 'JavaScript', '-e', MAC_PANEL, labels.title, 'references'], signal, 'hidden')
    if (!result.stdout.trim()) return null
    const paths: unknown = JSON.parse(result.stdout)
    if (!Array.isArray(paths) || !paths.every((path): path is string => typeof path === 'string' && path.length > 0)) throw new Error('native reference picker returned invalid paths')
    return paths.length ? paths : null
  }
  if (platform === 'linux') {
    let mode: string
    try { mode = (await run('zenity', ['--list', '--radiolist', '--hide-header', '--hide-column=2', '--print-column=2', `--title=${labels.title}`, '--column=', '--column=id', '--column=', 'TRUE', 'images', labels.imagesLabel, 'FALSE', 'folder', labels.folderLabel], signal, 'hidden')).stdout.trim() }
    catch (error) {
      rethrowIfAborted(signal, error)
      if (errorCode(error) === 1) return null
      if (!isMissingCommand(error)) throw error
      try { mode = (await run('kdialog', ['--menu', labels.title, 'images', labels.imagesLabel, 'folder', labels.folderLabel], signal, 'hidden')).stdout.trim() }
      catch (fallbackError) {
        rethrowIfAborted(signal, fallbackError)
        if (errorCode(fallbackError) === 1) return null
        throw fallbackError
      }
    }
    if (mode === 'images') return await pickNativeImages(signal, labels.title, internals)
    if (mode === 'folder') { const path = await pickNativeDirectory(signal, internals, labels.title); return path ? [path] : null }
    throw new Error('native reference picker returned an invalid selection mode')
  }
  throw new Error(`native reference picker is unsupported on ${platform}`)
}
