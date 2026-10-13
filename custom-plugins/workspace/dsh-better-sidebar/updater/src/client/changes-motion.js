/** Follow the existing file-change selection without changing its input handlers or layout. */
const scope = ':where([data-dsh-native-tab-host], [data-dsh-better-sidebar])'
const tabs = `${scope} [role="tablist"]:has(> button[id^="changes-lens-"])`
const filters = `${scope} div:has(> [role="tablist"] > button[id^="changes-lens-"]) + div > [role="group"]:has(> button[aria-pressed])`
const properties = ['--dsh-changes-x', '--dsh-changes-y', '--dsh-changes-width', '--dsh-changes-height']

/** Install measured selection indicators on containers opted in by customCss.
 * @param {Document} doc Browser document; detached documents retain ordinary selection styling.
 * @returns {() => void} Removes observers, scheduled work and indicator measurements.
 */
export function installChangesMotion(doc) {
  const view = doc.defaultView
  if (!view || !doc.body) return () => {}
  const containers = new Map()
  let frame = 0, disposed = false
  const restore = root => {
    const entry = containers.get(root)
    entry.resize?.disconnect()
    root.removeAttribute('data-dsh-changes-motion')
    root.removeAttribute('data-dsh-changes-motion-ready')
    for (const property of properties) {
      const previous = entry.original.get(property)
      if (previous.value) root.style.setProperty(property, previous.value, previous.priority)
      else root.style.removeProperty(property)
    }
    containers.delete(root)
  }
  const refresh = () => {
    frame = 0
    if (disposed) return
    const roots = new Set(doc.querySelectorAll(`${tabs}, ${filters}`))
    for (const root of containers.keys()) {
      if (!roots.has(root) || view.getComputedStyle(root).getPropertyValue('--dsh-changes-motion-enabled').trim() !== '1') restore(root)
    }
    for (const root of roots) {
      if (view.getComputedStyle(root).getPropertyValue('--dsh-changes-motion-enabled').trim() !== '1') continue
      const kind = root.getAttribute('role') === 'tablist' ? 'tabs' : 'filters'
      const selected = root.querySelector(kind === 'tabs' ? ':scope > button[aria-selected="true"]' : ':scope > button[aria-pressed="true"]')
      if (!selected) continue
      let entry = containers.get(root)
      if (!entry) {
        entry = { original: new Map(properties.map(property => [property, {
          value: root.style.getPropertyValue(property), priority: root.style.getPropertyPriority(property),
        }])), buttons: new Set(), resize: view.ResizeObserver ? new view.ResizeObserver(schedule) : undefined }
        containers.set(root, entry)
        root.setAttribute('data-dsh-changes-motion', kind)
        entry.resize?.observe(root)
      }
      // 数量文字、字体和窗口尺寸都可能改变按钮宽度；只观察此区域的按钮。
      const buttons = new Set(root.querySelectorAll(':scope > button'))
      for (const button of entry.buttons) if (!buttons.has(button)) entry.resize?.unobserve(button)
      for (const button of buttons) if (!entry.buttons.has(button)) entry.resize?.observe(button)
      entry.buttons = buttons
      const values = [selected.offsetLeft, selected.offsetTop, selected.offsetWidth, selected.offsetHeight]
      for (let index = 0; index < properties.length; index++) {
        const value = `${values[index]}px`
        if (root.style.getPropertyValue(properties[index]) !== value) root.style.setProperty(properties[index], value)
      }
      // 首次挂载直接对齐；之后的连续切换从当前动画位置继续移动。
      if (!root.hasAttribute('data-dsh-changes-motion-ready')) {
        void view.getComputedStyle(kind === 'tabs' ? root.querySelector(':scope > span[aria-hidden="true"]') : root,
          kind === 'tabs' ? null : '::before').transform
        root.setAttribute('data-dsh-changes-motion-ready', '')
      }
    }
  }
  function schedule() {
    if (!disposed && !frame) frame = view.requestAnimationFrame(refresh)
  }
  const observer = new view.MutationObserver(records => {
    // 样式变量写入不进入观察范围，避免指示层的测量形成反馈循环。
    if (records.some(record => record.type === 'attributes'
      ? record.target.matches('button[id^="changes-lens-"]') || record.target.closest('[data-dsh-changes-motion]')
      : [...record.addedNodes, ...record.removedNodes].some(node => node.nodeType === 1))) schedule()
  })
  observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-selected', 'aria-pressed'] })
  view.addEventListener('resize', schedule)
  refresh()
  return () => {
    disposed = true
    observer.disconnect()
    view.removeEventListener('resize', schedule)
    if (frame) view.cancelAnimationFrame(frame)
    for (const root of containers.keys()) restore(root)
  }
}
