/** COM event sink retained until the dialog releases its native callback references. */
interface EventBindings {
  proto(convention: string, result: string, args: string[]): unknown
  pointer(type: unknown): unknown
  register(fn: (...args: unknown[]) => unknown, type: unknown): unknown
  unregister(callback: unknown): void
  sizeof(type: string): number
  address(value: Buffer): bigint
  decode(value: unknown, type: string, length: number): unknown
  encode(value: unknown, type: string, data: unknown): void
}

const E_NOINTERFACE = 0x80004002 | 0
const IID_UNKNOWN = '0000000000000000c000000000000046'
const IID_EVENTS = 'db1035977f7d2b45897574a85828d354'
const IID_CONTROLS = '4266113613d7974b9b837484a9d00433'

/** Register IFileDialogEvents and IFileDialogControlEvents after native STA initialization on one COM identity.
 * @param koffi Native callback marshalling.
 * @param onButton HRESULT-returning callback that never throws across FFI.
 * @returns Native event pointer and disposer; dispose only after Unadvise and releasing the dialog.
 */
export function createWin32DialogEvents(koffi: EventBindings, onButton: (id: number) => number): { pointer: Buffer; dispose(): void } {
  const pointerSize = koffi.sizeof('void *'), callbacks: unknown[] = [], allocations: Buffer[] = []
  const events = Buffer.alloc(pointerSize), controls = Buffer.alloc(pointerSize)
  let references = 1
  const writePointer = (buffer: Buffer, offset: number, address: bigint) => {
    if (pointerSize === 8) buffer.writeBigUInt64LE(address, offset)
    else buffer.writeUInt32LE(Number(address), offset)
  }
  const query = (_self: unknown, iid: unknown, out: unknown) => {
    const requested = Buffer.from(koffi.decode(iid, 'uint8', 16) as number[]).toString('hex')
    const target = requested === IID_UNKNOWN || requested === IID_EVENTS ? events : requested === IID_CONTROLS ? controls : null
    koffi.encode(out, 'void *', target)
    if (!target) return E_NOINTERFACE
    references++; return 0
  }
  const addRef = () => ++references, release = () => --references
  const register = (result: string, args: string[], fn: (...args: unknown[]) => unknown) => {
    const callback = koffi.register(fn, koffi.pointer(koffi.proto('__stdcall', result, args)))
    callbacks.push(callback)
    return BigInt(callback as bigint | number)
  }
  const unknownMethods = () => [register('int32', ['void *', 'void *', 'void *'], query), register('uint32', ['void *'], addRef), register('uint32', ['void *'], release)]
  const ok = () => 0
  const response = (_self: unknown, _dialog: unknown, _item: unknown, out: unknown) => { koffi.encode(out, 'uint32', 0); return 0 }
  const build = (object: Buffer, methods: bigint[]) => {
    const vtable = Buffer.alloc(methods.length * pointerSize)
    methods.forEach((address, index) => { writePointer(vtable, index * pointerSize, address) })
    writePointer(object, 0, koffi.address(vtable)); allocations.push(vtable)
  }
  try {
    build(events, [...unknownMethods(),
      register('int32', ['void *', 'void *'], ok),
      register('int32', ['void *', 'void *', 'void *'], ok),
      register('int32', ['void *', 'void *'], ok),
      register('int32', ['void *', 'void *'], ok),
      register('int32', ['void *', 'void *', 'void *', 'void *'], response),
      register('int32', ['void *', 'void *'], ok),
      register('int32', ['void *', 'void *', 'void *', 'void *'], response),
    ])
    build(controls, [...unknownMethods(),
      register('int32', ['void *', 'void *', 'uint32', 'uint32'], ok),
      register('int32', ['void *', 'void *', 'uint32'], (_self, _customize, id) => onButton(id as number)),
      register('int32', ['void *', 'void *', 'uint32', 'int32'], ok),
      register('int32', ['void *', 'void *', 'uint32'], ok),
    ])
  } catch (error) { callbacks.forEach((callback) => { koffi.unregister(callback) }); throw error }
  let disposed = false
  return { pointer: events, dispose: () => {
    if (disposed) return
    disposed = true
    // Buffer 必须与注册回调一起保留，直到 COM 已释放两个接口。
    void controls; void allocations
    callbacks.forEach((callback) => { koffi.unregister(callback) })
  } }
}
