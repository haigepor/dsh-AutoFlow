/** Real FFI callbacks validate pointer width, COM identity and callback cleanup without a desktop. */
import koffi from 'koffi'
import { describe, expect, it, vi } from 'vitest'
import { createWin32DialogEvents } from '../src/win32-dialog-events.ts'

describe('file dialog COM events', () => {
  it('queries both interfaces, forwards the folder action and unregisters every retained callback once', () => {
    // Koffi 3.1.1 首次同步调用分配回调栈；生产端在注册前已调用 CoInitializeEx。
    if (process.platform === 'win32') koffi.load('kernel32.dll').func('uint32 GetCurrentThreadId()')()
    else koffi.load(process.platform === 'darwin' ? '/usr/lib/libSystem.B.dylib' : 'libc.so.6').func('int getpid()')()
    const registered: bigint[] = [], unregistered: bigint[] = [], clicked = vi.fn(() => 0)
    const sink = createWin32DialogEvents({ ...koffi,
      register: (fn, type) => {
        const pointer = koffi.register(fn, type as ReturnType<typeof koffi.pointer>); registered.push(pointer); return pointer
      },
      unregister: (pointer) => { unregistered.push(pointer as bigint); koffi.unregister(pointer as bigint) },
    }, clicked)
    const method = (self: unknown, slot: number, args: unknown[], types: string[]) => {
      const vtable: unknown = koffi.decode(self, 'void *'), target: unknown = koffi.decode(vtable, slot * koffi.sizeof('void *'), 'void *')
      return koffi.call(target, koffi.proto('__stdcall', 'int32', ['void *', ...types]), self, ...args) as number
    }
    try {
      const out = Buffer.alloc(koffi.sizeof('void *'))
      const controlsIid = Buffer.from('4266113613d7974b9b837484a9d00433', 'hex')
      expect(method(sink.pointer, 0, [controlsIid, out], ['void *', 'void *'])).toBe(0)
      const controls: unknown = koffi.decode(out, 'void *')
      expect(method(controls, 4, [null, 1001], ['void *', 'uint32'])).toBe(0)
      expect(clicked).toHaveBeenCalledWith(1001)
      const identity = Buffer.alloc(koffi.sizeof('void *'))
      expect(method(controls, 0, [Buffer.from('0000000000000000c000000000000046', 'hex'), identity], ['void *', 'void *'])).toBe(0)
      expect(koffi.decode(identity, 'void *')).toBe(koffi.address(sink.pointer))
      expect(method(sink.pointer, 0, [Buffer.alloc(16, 1), out], ['void *', 'void *'])).toBe(0x80004002 | 0)
      expect(koffi.decode(out, 'void *')).toBeNull()
      const response = Buffer.alloc(4, 0xff)
      expect(method(sink.pointer, 7, [null, null, response], ['void *', 'void *', 'void *'])).toBe(0)
      expect(response.readUInt32LE()).toBe(0)
    } finally { sink.dispose(); sink.dispose() }
    expect(registered.length).toBe(17); expect(unregistered).toEqual(registered)
  })
})
