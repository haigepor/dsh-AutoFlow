/**
 * koffi-backed Win32 bindings for the folder dialog: the COM vtable calls
 * behind {@link Win32DialogBindings} plus the cross-thread window closer the
 * driver uses to service aborts. The module loads on every platform; koffi
 * itself is imported lazily inside each function, so non-Windows processes
 * never load it — the same containment as the repo's other `win32.ts`
 * modules.
 *
 * The COM surface used here (IModalWindow/IFileDialog/IFileOpenDialog and
 * IShellItem vtable order, the GUIDs, `FOS_*` and `SIGDN_FILESYSPATH`) is
 * frozen Windows ABI since Vista; slots are offsets into the vtable at the
 * object's first pointer.
 */

import type { Win32DialogBindings, Win32FolderDialog } from './win32-dialog-logic.ts'
import { createWin32DialogEvents } from './win32-dialog-events.ts'

interface KoffiFunction { (...args: unknown[]): unknown }
interface KoffiLibrary { func(convention: string, name: string, result: string, args: string[]): KoffiFunction }
interface Koffi {
  load(path: string): KoffiLibrary
  proto(declaration: string): unknown
  proto(convention: string, result: string, args: string[]): unknown
  struct(name: string, members: Record<string, string>): unknown
  pointer(type: unknown): unknown
  call(pointer: unknown, proto: unknown, ...args: unknown[]): unknown
  decode(value: unknown, offsetOrType: unknown, type?: unknown): unknown
  register(fn: (...args: unknown[]) => unknown, type: unknown): unknown
  unregister(callback: unknown): void
  sizeof(type: string): number
  address(value: Buffer): bigint
  encode(value: unknown, type: string, data: unknown): void
}

/**
 * Read a valid NUL-terminated UTF-16 allocation without an external buffer.
 * Generic `koffi.decode(..., 'str16')` expects a pointer variable, so the
 * buffer holds the string address rather than the string bytes.
 * @param koffi - the loaded koffi binding.
 * @param address - the string address surfaced by the `_Out_ void **` param.
 * @param pointerSize - the process's pointer width (`koffi.sizeof('void *')`).
 * @returns the decoded UTF-16 path.
 */
function readUtf16(koffi: Koffi, address: unknown, pointerSize: number): string {
  const pointer = Buffer.alloc(8)
  // koffi 3 surfaces `_Out_ void **` values as BigInt native addresses.
  pointer.writeBigUInt64LE(BigInt(address as bigint | number))
  return koffi.decode(pointer.subarray(0, pointerSize), 'str16') as string
}

const COINIT_APARTMENTTHREADED = 0x2
const CLSCTX_INPROC_SERVER = 0x1
const SIGDN_FILESYSPATH = 0x80058000 | 0
/**
 * Thread DPI awareness contexts, best first: per-monitor-v2 (Windows 10
 * 1703+), per-monitor (1607+), then system-aware. `SetThreadDpiAwarenessContext`
 * returns NULL for an unsupported context instead of throwing, so the caller
 * cascades to the best one the host accepts; DPI stays a cosmetic
 * best-effort — an unsupported host still gets the modern dialog.
 */
const DPI_AWARENESS_CONTEXTS = [-4, -3, -2]
const WM_CLOSE = 0x10
/** `VK_MENU`: the synthesized Alt press's virtual key. */
const VK_MENU = 0x12
/** `KEYEVENTF_KEYUP`: the synthesized Alt press's release flag. */
const KEYEVENTF_KEYUP = 0x2

/** IFileOpenDialog vtable slots (IUnknown 0-2, IModalWindow 3, IFileDialog 4+). */
const SLOT_RELEASE = 2
const SLOT_SHOW = 3
const SLOT_SET_OPTIONS = 9
const SLOT_SET_TITLE = 17
const SLOT_GET_RESULT = 20
const SLOT_SET_FILE_TYPES = 4
const SLOT_GET_RESULTS = 27
const SLOT_ARRAY_GET_COUNT = 7
const SLOT_ARRAY_GET_ITEM = 8
/** IShellItem vtable slot for `GetDisplayName`. */
const SLOT_GET_DISPLAY_NAME = 5

/**
 * Encode a canonical GUID string as its 16 little-endian bytes.
 * @param text - the `xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx` form.
 * @returns the in-memory GUID bytes CoCreateInstance expects.
 */
function guidBytes(text: string): Buffer {
  const match = /^([0-9a-f]{8})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{4})-([0-9a-f]{12})$/i.exec(text) as RegExpExecArray
  const bytes = Buffer.alloc(16)
  bytes.writeUInt32LE(parseInt(match[1] as string, 16), 0)
  bytes.writeUInt16LE(parseInt(match[2] as string, 16), 4)
  bytes.writeUInt16LE(parseInt(match[3] as string, 16), 6)
  Buffer.from((match[4] as string) + (match[5] as string), 'hex').copy(bytes, 8)
  return bytes
}

const CLSID_FILE_OPEN_DIALOG = guidBytes('dc1c5a9c-e88a-4dde-a5a1-60f82a20aef7')
const IID_IFILE_OPEN_DIALOG = guidBytes('d57c7288-d4ad-4768-be02-9d969532d960')
const IID_IFILE_DIALOG_CUSTOMIZE = guidBytes('e6fdd21a-163f-4975-9c8c-a69f1ba37034')
const FOLDER_BUTTON_ID = 1001

/**
 * Load koffi and expose the dialog bindings for this thread.
 * @returns the bindings {@link runFolderDialog} sequences against.
 */
export async function loadWin32DialogBindings(): Promise<Win32DialogBindings> {
  const koffi = (await import('koffi')).default as Koffi
  const ole32 = koffi.load('ole32.dll')
  const user32 = koffi.load('user32.dll')
  const kernel32 = koffi.load('kernel32.dll')

  // Vtable slots and out-pointers are pointer-width offsets: 8 on x64/arm64,
  // 4 on ia32 — koffi reports the running process's width.
  const pointerSize = koffi.sizeof('void *')
  const coInitializeEx = ole32.func('__stdcall', 'CoInitializeEx', 'int32', ['void *', 'uint32'])
  const coUninitialize = ole32.func('__stdcall', 'CoUninitialize', 'void', [])
  const coCreateInstance = ole32.func('__stdcall', 'CoCreateInstance', 'int32', ['void *', 'void *', 'uint32', 'void *', 'void *'])
  const coTaskMemFree = ole32.func('__stdcall', 'CoTaskMemFree', 'void', ['void *'])
  const getCurrentThreadId = kernel32.func('__stdcall', 'GetCurrentThreadId', 'uint32', [])
  const keybdEvent = user32.func('__stdcall', 'keybd_event', 'void', ['uint8', 'uint8', 'uint32', 'uintptr'])

  const protoShow = koffi.proto('int32 __stdcall DshDialogShow(void *self, void *owner)')
  const protoSetOptions = koffi.proto('int32 __stdcall DshDialogSetOptions(void *self, uint32 options)')
  const protoSetTitle = koffi.proto('int32 __stdcall DshDialogSetTitle(void *self, str16 title)')
  const protoGetResult = koffi.proto('int32 __stdcall DshDialogGetResult(void *self, _Out_ void **item)')
  koffi.struct('DshImageFilter', { name: 'str16', spec: 'str16' })
  const protoSetFileTypes = koffi.proto('int32 __stdcall DshDialogSetFileTypes(void *self, uint32 count, const DshImageFilter *filters)')
  const protoGetCount = koffi.proto('int32 __stdcall DshItemsGetCount(void *self, _Out_ uint32 *count)')
  const protoGetItem = koffi.proto('int32 __stdcall DshItemsGetItemAt(void *self, uint32 index, _Out_ void **item)')
  const protoGetDisplayName = koffi.proto('int32 __stdcall DshItemGetDisplayName(void *self, int32 form, _Out_ void **name)')
  const protoRelease = koffi.proto('uint32 __stdcall DshComRelease(void *self)')
  const protoQuery = koffi.proto('int32 __stdcall DshComQuery(void *self, void *iid, _Out_ void **object)')
  const protoAddButton = koffi.proto('int32 __stdcall DshAddButton(void *self, uint32 id, str16 label)')
  const protoAdvise = koffi.proto('int32 __stdcall DshAdvise(void *self, void *events, _Out_ uint32 *cookie)')
  const protoUnadvise = koffi.proto('int32 __stdcall DshUnadvise(void *self, uint32 cookie)')
  const protoClose = koffi.proto('int32 __stdcall DshDialogClose(void *self, int32 result)')

  /** Bind vtable slot `slot` of COM object `self` to a caller through `proto`. */
  const method = (self: unknown, slot: number, proto: unknown): (...args: unknown[]) => number => {
    const vtable = koffi.decode(self, 'void *')
    const fn = koffi.decode(vtable, slot * pointerSize, 'void *')
    return (...args: unknown[]) => koffi.call(fn, proto, self, ...args) as number
  }

  return {
    setThreadDpiAwareness: () => {
      let setContext: KoffiFunction
      try {
        setContext = user32.func('__stdcall', 'SetThreadDpiAwarenessContext', 'void *', ['intptr'])
      } catch {
        // Symbol absent (pre-1607 Windows): no per-thread DPI control exists.
        // Proceed anyway — the cost is a blurry dialog above 100 % scaling on
        // museum hosts, and the modern picker still beats dropping to the
        // legacy 5.1 tree over a cosmetic concern.
        return
      }
      for (const context of DPI_AWARENESS_CONTEXTS) {
        if (setContext(context) !== null) return
      }
      // Unreachable in practice (SYSTEM_AWARE is accepted wherever the symbol
      // exists); if a host ever refuses everything, the dialog still works —
      // just without a DPI opt-in.
    },
    coInitializeSta: () => coInitializeEx(null, COINIT_APARTMENTTHREADED) as number,
    coUninitialize: () => {
      coUninitialize()
    },
    currentThreadId: () => getCurrentThreadId() as number,
    pressAltForForeground: () => {
      keybdEvent(VK_MENU, 0, 0, 0)
      keybdEvent(VK_MENU, 0, KEYEVENTF_KEYUP, 0)
    },
    createFolderDialog: (): Win32FolderDialog => {
      const out = Buffer.alloc(pointerSize)
      const created = coCreateInstance(CLSID_FILE_OPEN_DIALOG, null, CLSCTX_INPROC_SERVER, IID_IFILE_OPEN_DIALOG, out) as number
      if (created < 0) throw new Error(`CoCreateInstance(FileOpenDialog) failed: HRESULT 0x${(created >>> 0).toString(16)}`)
      const dialog = koffi.decode(out, 'void *')
      let customize: unknown, sink: ReturnType<typeof createWin32DialogEvents> | undefined, cookie: number | undefined
      let folderPath: string | undefined, callbackError: Error | undefined
      return {
        setOptions: options => method(dialog, SLOT_SET_OPTIONS, protoSetOptions)(options),
        setTitle: title => method(dialog, SLOT_SET_TITLE, protoSetTitle)(title),
        setImageFilter: () => method(dialog, SLOT_SET_FILE_TYPES, protoSetFileTypes)(1, [{ name: 'JPEG / PNG / WebP', spec: '*.jpg;*.jpeg;*.png;*.webp' }]),
        show: () => { const hr = method(dialog, SLOT_SHOW, protoShow)(null); if (callbackError) throw callbackError; return hr },
        enableFolderChoice: (label) => {
          const customOut: unknown[] = [null]
          const queried = method(dialog, 0, protoQuery)(IID_IFILE_DIALOG_CUSTOMIZE, customOut)
          if (queried < 0) return queried
          customize = customOut[0]
          const added = method(customize, 5, protoAddButton)(FOLDER_BUTTON_ID, label)
          if (added < 0) return added
          sink = createWin32DialogEvents(koffi, (id) => {
            if (id !== FOLDER_BUTTON_ID) return 0
            try {
              const itemOut: unknown[] = [null]
              const got = method(dialog, 13, protoGetResult)(itemOut)
              if (got < 0) throw new Error(`GetFolder failed: HRESULT 0x${(got >>> 0).toString(16)}`)
              const item = itemOut[0]
              try {
                const nameOut: unknown[] = [null]
                const named = method(item, SLOT_GET_DISPLAY_NAME, protoGetDisplayName)(SIGDN_FILESYSPATH, nameOut)
                if (named < 0) throw new Error(`GetDisplayName failed: HRESULT 0x${(named >>> 0).toString(16)}`)
                try { folderPath = readUtf16(koffi, nameOut[0], pointerSize) } finally { coTaskMemFree(nameOut[0]) }
              } finally { method(item, SLOT_RELEASE, protoRelease)() }
              const closed = method(dialog, 23, protoClose)(0)
              if (closed < 0) throw new Error(`Close failed: HRESULT 0x${(closed >>> 0).toString(16)}`)
              return 0
            } catch (error) {
              // 异常不能穿过 COM 回调；关闭窗口后在 Show 的调用方报告。
              callbackError = error instanceof Error ? error : new Error(String(error))
              method(dialog, 23, protoClose)(0x80004005 | 0)
              return 0x80004005 | 0
            }
          })
          const advised: [number] = [0]
          const hr = method(dialog, 7, protoAdvise)(sink.pointer, advised)
          if (hr >= 0) cookie = advised[0]
          return hr
        },
        resultPath: () => {
          const itemOut: unknown[] = [null]
          const gotItem = method(dialog, SLOT_GET_RESULT, protoGetResult)(itemOut)
          if (gotItem < 0) return { hr: gotItem }
          const item = itemOut[0]
          try {
            const nameOut: unknown[] = [null]
            const gotName = method(item, SLOT_GET_DISPLAY_NAME, protoGetDisplayName)(SIGDN_FILESYSPATH, nameOut)
            if (gotName < 0) return { hr: gotName }
            const path = readUtf16(koffi, nameOut[0], pointerSize)
            coTaskMemFree(nameOut[0])
            return { hr: gotName, path }
          } finally {
            method(item, SLOT_RELEASE, protoRelease)()
          }
        },
        resultPaths: () => {
          if (folderPath !== undefined) return { hr: 0, paths: [folderPath] }
          const itemsOut: unknown[] = [null]
          const gotItems = method(dialog, SLOT_GET_RESULTS, protoGetResult)(itemsOut)
          if (gotItems < 0) return { hr: gotItems }
          const items = itemsOut[0]
          try {
            const count: [number] = [0]
            const counted = method(items, SLOT_ARRAY_GET_COUNT, protoGetCount)(count)
            if (counted < 0) return { hr: counted }
            const paths: string[] = []
            for (let index = 0; index < count[0]; index++) {
              const itemOut: unknown[] = [null]
              const gotItem = method(items, SLOT_ARRAY_GET_ITEM, protoGetItem)(index, itemOut)
              if (gotItem < 0) return { hr: gotItem }
              const item = itemOut[0]
              try {
                const nameOut: unknown[] = [null]
                const named = method(item, SLOT_GET_DISPLAY_NAME, protoGetDisplayName)(SIGDN_FILESYSPATH, nameOut)
                if (named < 0) return { hr: named }
                try { paths.push(readUtf16(koffi, nameOut[0], pointerSize)) } finally { coTaskMemFree(nameOut[0]) }
              } finally { method(item, SLOT_RELEASE, protoRelease)() }
            }
            return { hr: 0, paths }
          } finally { method(items, SLOT_RELEASE, protoRelease)() }
        },
        release: () => {
          try { if (cookie !== undefined) method(dialog, 8, protoUnadvise)(cookie) }
          finally {
            try { if (customize !== undefined) method(customize, SLOT_RELEASE, protoRelease)() }
            finally { try { method(dialog, SLOT_RELEASE, protoRelease)() } finally { sink?.dispose() } }
          }
        },
      }
    },
  }
}

/**
 * Post `WM_CLOSE` to every window of a native thread — the driver's abort
 * lever against the worker blocked inside `Show`, after which `Show` returns
 * `HRESULT_CANCELLED` and the worker unwinds normally.
 * @param threadId - the dialog thread's native id (from the `showing` notice).
 */
export async function closeThreadWindows(threadId: number): Promise<void> {
  const koffi = (await import('koffi')).default as Koffi
  const user32 = koffi.load('user32.dll')
  const enumThreadWindows = user32.func('__stdcall', 'EnumThreadWindows', 'int', ['uint32', 'void *', 'intptr'])
  const postMessageW = user32.func('__stdcall', 'PostMessageW', 'int', ['void *', 'uint32', 'uintptr', 'intptr'])
  const protoEnumProc = koffi.proto('int __stdcall DshEnumThreadWndProc(void *hwnd, intptr lparam)')
  const callback = koffi.register((hwnd: unknown) => {
    postMessageW(hwnd, WM_CLOSE, 0, 0)
    return 1
  }, koffi.pointer(protoEnumProc))
  try {
    enumThreadWindows(threadId, callback, 0)
  } finally {
    koffi.unregister(callback)
  }
}
