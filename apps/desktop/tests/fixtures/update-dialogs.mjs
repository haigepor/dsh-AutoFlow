/** Real isolated update dialogs; installer handoff is recorded by the caller's inert updater. */
import { DesktopUpdateOverlays } from '../../lib/types/update-overlay.js'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { access, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, BrowserWindow, nativeTheme, protocol } from 'electron'
import { DesktopUpdateDialog } from '../../lib/types/update-dialog.js'
import { DesktopBackgroundNotice } from '../../lib/types/background-notice.js'
import { desktopUpdateReadyConfirmation, resolveDesktopLocale } from '../../lib/types/locale.js'

async function rendered(window) {
  await window.webContents.executeJavaScript(`new Promise((resolve, reject) => {
    const observer = new MutationObserver(check);
    const deadline = setTimeout(() => { observer.disconnect(); reject(new Error('Dialog did not render')); }, 10000);
    function check() { if (document.querySelector('main:not([hidden])')) { observer.disconnect(); clearTimeout(deadline); resolve(); } }
    observer.observe(document, { subtree: true, attributes: true }); check();
  })`)
}

async function bounded(promise, label) {
  let timer
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Update dialog qualification timed out: ${label}`)), 10000)
    })])
  } finally { clearTimeout(timer) }
}

/** Exercise cancellation and explicit installation through the production preload and renderer. */
export async function qualifyUpdateDialogs(root, fixture) {
  const theme = nativeTheme.themeSource
  nativeTheme.themeSource = 'light'
  const locale = resolveDesktopLocale('zh-CN')
  const messages = locale.messages
  const screenshots = []
  const captureFailures = []
  async function capture(contents, name) {
    try {
      contents.setBackgroundThrottling(false)
      await bounded(contents.executeJavaScript(`document.getAnimations().filter(animation => Number.isFinite(animation.effect.getComputedTiming().endTime)).forEach(animation => animation.finish())`), `${name} animations`)
      await bounded(contents.executeJavaScript(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`), `${name} frame`)
      const bitmap = await bounded(contents.capturePage(), `${name} capture`)
      if (bitmap.isEmpty()) throw new Error('Electron returned an empty capture')
      await writeFile(join(root, name), bitmap.toPNG())
      screenshots.push(name)
    } catch (error) {
      captureFailures.push({ name, reason: error instanceof Error ? error.message : String(error) })
    }
  }
  protocol.handle('dsh-app', async request => {
    const name = new URL(request.url).pathname.slice(1)
    assert.ok(['design-platform.css', 'shell-theme.js', 'update-dialog.html', 'update-dialog.js', 'update-dialog.css',
      'update-close.svg', 'download-controls.js', 'download-controls.css', 'assets/update-download-whale-v1.webp'].includes(name))
    const mime = name.endsWith('.js') ? 'text/javascript' : name.endsWith('.css') ? 'text/css'
      : name.endsWith('.svg') ? 'image/svg+xml' : name.endsWith('.webp') ? 'image/webp' : 'text/html'
    const directory = name === 'design-platform.css' ? '../../lib/welcome'
      : ['download-controls.js', 'download-controls.css'].includes(name) ? '../../lib/shell' : '../../renderer'
    return new Response(await readFile(new URL(`${directory}/${name}`, import.meta.url)), { headers: { 'content-type': mime } })
  })
  const parent = new BrowserWindow({ show: true, width: 900, height: 650, webPreferences: { backgroundThrottling: false } })
  let controlled
  let transfer
  const dialogs = new DesktopUpdateDialog(fileURLToPath(new URL('../../lib/preload-update-dialog.cjs', import.meta.url)), locale,
    new DesktopUpdateOverlays(), async (action, version, choice) => {
      assert.equal(version, controlled.coordinator.state.version)
      if (action === 'source') await controlled.coordinator.selectSource(choice)
      else if (action === 'pause') await controlled.coordinator.pauseDownload()
      else if (action === 'resume') transfer = controlled.coordinator.download(version)
      else throw new Error('Unexpected download action')
    })
  try {
    await parent.loadURL('data:text/html;charset=utf-8,<title>Update dialog qualification</title><h1>Local updater</h1>')
    controlled = await fixture('hold-download', 60_000, true)
    controlled.observe(state => dialogs.updateDownload(state))
    await controlled.coordinator.check()
    const createdDownload = once(app, 'web-contents-created', { signal: AbortSignal.timeout(10_000) })
    let downloadPrompt = dialogs.show(parent, { title: messages.updateTitle, message: messages.updateTitle,
      detail: messages.updateDetail, buttons: [messages.updateClose], cancelId: 0, download: controlled.coordinator.state })
    let [, downloadContents] = await createdDownload
    downloadContents.setBackgroundThrottling(false)
    await once(downloadContents, 'did-finish-load', { signal: AbortSignal.timeout(10_000) })
    await rendered({ webContents: downloadContents })
    assert.ok(await downloadContents.executeJavaScript(`document.querySelector('[data-update-notes]').textContent.includes('更新内容')`))
    assert.ok(await downloadContents.executeJavaScript(`document.querySelector('[data-update-notes]').textContent.includes('换源与重启后保留经过校验的下载进度。')`))
    await downloadContents.executeJavaScript(`document.querySelector('#download-controls button[data-action="resume"]').click()`)
    await controlled.transferred()
    const retainedProgress = controlled.coordinator.state.download.transferred
    const closedActive = once(downloadContents, 'destroyed', { signal: AbortSignal.timeout(10_000) })
    dialogs.cancel()
    await downloadPrompt
    await closedActive
    assert.equal(controlled.coordinator.state.phase, 'downloading')
    assert.equal(controlled.download.isRunning, true)
    assert.equal(controlled.installations.length, 0)
    const reopened = once(app, 'web-contents-created', { signal: AbortSignal.timeout(10_000) })
    downloadPrompt = dialogs.show(parent, { title: messages.updateTitle, message: messages.updateTitle,
      detail: messages.updateDetail, buttons: [messages.updateClose], cancelId: 0, download: controlled.coordinator.state })
    const reopenedContents = await reopened
    downloadContents = reopenedContents[1]
    downloadContents.setBackgroundThrottling(false)
    await once(downloadContents, 'did-finish-load', { signal: AbortSignal.timeout(10_000) })
    await rendered({ webContents: downloadContents })
    assert.ok(controlled.coordinator.state.download.transferred >= retainedProgress)
    assert.ok(await downloadContents.executeJavaScript(`document.querySelector('[data-download-amount]').textContent.includes('KiB')`))
    await downloadContents.executeJavaScript(`document.querySelector('#download-controls button[data-action="pause"]').click()`)
    await downloadContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = setTimeout(() => { observer.disconnect(); reject(new Error('Pause did not render')); }, 10000);
      const observer = new MutationObserver(check);
      function check() { if (document.getElementById('download-status').textContent === ${JSON.stringify(messages.downloadPaused)}) {
        observer.disconnect(); clearTimeout(deadline); resolve(); } }
      observer.observe(document, {subtree:true, childList:true, characterData:true, attributes:true}); check();
    })`)
    assert.equal((await transfer).download.stage, 'paused')
    console.log('local updater dialog: paused after closing and reopening the active download')
    assert.equal(controlled.installations.length, 0)
    await bounded(downloadContents.executeJavaScript(`window.dshUpdateDialog.control('source', ${JSON.stringify(controlled.coordinator.state.version)}, {source:'github'})`), 'paused source selection')
    assert.deepEqual(await downloadContents.executeJavaScript(`({source: document.getElementById('download-source').dataset.source,
      status: document.getElementById('download-status').textContent,
      button: document.querySelector('#download-controls button[data-action]').textContent})`), {
      source: 'github', status: messages.downloadPaused, button: messages.downloadResume,
    })
    await capture(downloadContents, 'download-paused.png')
    nativeTheme.themeSource = 'dark'
    await downloadContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = setTimeout(() => { observer.disconnect(); reject(new Error('Download theme did not settle')); }, 10000);
      const observer = new MutationObserver(check);
      function check() { if (document.body.hasAttribute('data-ds-dark-theme')) { observer.disconnect(); clearTimeout(deadline); resolve(); } }
      observer.observe(document.body, {attributes:true}); check();
    })`)
    const layout = await downloadContents.executeJavaScript(`({height:innerHeight,main:document.querySelector('main').clientHeight,
      scroll:document.querySelector('main').scrollHeight,notes:document.querySelector('[data-update-notes] [role="region"]').clientHeight,
      actionsBottom:document.querySelector('#download-controls button[data-action]').getBoundingClientRect().bottom})`)
    assert.ok(layout.scroll <= layout.main + 1, JSON.stringify(layout))
    assert.ok(layout.actionsBottom <= layout.height, JSON.stringify(layout))
    console.log(`local updater dialog layout: ${JSON.stringify(layout)}`)
    assert.ok(layout.notes >= 80, JSON.stringify(layout))
    await capture(downloadContents, 'download-paused-dark.png')
    await downloadContents.executeJavaScript(`document.getElementById('download-source').click()`)
    const menuBounds = await downloadContents.executeJavaScript(`new Promise((resolve, reject) => {
      const deadline = setTimeout(() => { observer.disconnect(); reject(new Error('Source menu did not open')); }, 10000);
      const observer = new MutationObserver(check);
      function check() { const menu = document.querySelector('[role="menu"]'); if (!menu) return;
        const rect = menu.getBoundingClientRect(); if (!rect.width) return;
        observer.disconnect(); clearTimeout(deadline); resolve({x:rect.left,y:rect.top,right:rect.right,bottom:rect.bottom,width:innerWidth,height:innerHeight}); }
      observer.observe(document.body, {subtree:true,childList:true,attributes:true}); check();
    })`)
    assert.ok(menuBounds.x >= 0 && menuBounds.y >= 0 && menuBounds.right <= menuBounds.width && menuBounds.bottom <= menuBounds.height)
    await downloadContents.executeJavaScript(`document.querySelector('[role="menu"]').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}))`)
    nativeTheme.themeSource = 'light'
    const closedDownload = once(downloadContents, 'destroyed', { signal: AbortSignal.timeout(10_000) })
    dialogs.cancel()
    await downloadPrompt
    await closedDownload
    controlled.observe(() => {})
    controlled.coordinator.dispose()
    const f = await fixture()
    const available = await f.coordinator.check()
    await f.coordinator.download(available.version)
    assert.equal(f.installations.length, 0)
    for (const active of [false, true]) {
      const ready = desktopUpdateReadyConfirmation(messages, available.version, process.platform)
      const options = {
        title: messages.updateTitle,
        message: active ? messages.updateActiveTasks : ready.message,
        detail: active ? messages.updateActiveTasksDetail : ready.detail,
        buttons: active ? [messages.updateStopTasks, messages.updateLater] : [messages.installAndRestart], cancelId: 1,
      }
      f.restart(async () => (await dialogs.show(parent, options)).response === 0)
      const created = once(app, 'web-contents-created', { signal: AbortSignal.timeout(10_000) })
      const pending = f.coordinator.install(available.version)
      const [, contents] = await created
      const window = { webContents: contents, isDestroyed: () => contents.isDestroyed() }
      await once(window.webContents, 'did-finish-load', { signal: AbortSignal.timeout(10_000) })
      await rendered(window)
      const view = await window.webContents.executeJavaScript(`({
        title: document.getElementById('title').textContent,
        detail: document.getElementById('detail').textContent,
        buttons: [...document.querySelectorAll('#actions button')].map(button => button.textContent),
        width: document.querySelector('main').getBoundingClientRect().width,
        radius: getComputedStyle(document.querySelector('main')).borderRadius,
        primary: getComputedStyle(document.querySelector('.primary')).backgroundColor,
        focused: document.activeElement.id, isolated: typeof window.require === 'undefined',
      })`)
      assert.deepEqual(view, { title: options.message, detail: options.detail, buttons: options.buttons,
        width: 380, radius: '24px', primary: 'rgb(41, 41, 39)', focused: 'dialog', isolated: true })
      assert.equal(await parent.webContents.executeJavaScript('getComputedStyle(document.body).filter'), 'none')
      assert.equal(f.installations.length, 0)
      assert.equal(await window.webContents.executeJavaScript(`
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', cancelable: true }));
        document.activeElement.id`), 'close')
      assert.equal(await window.webContents.executeJavaScript(`
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, cancelable: true }));
        document.activeElement.textContent`), options.buttons.at(-1))
      await window.webContents.executeJavaScript("document.getElementById('dialog').focus()")
      const name = active ? 'update-active-tasks.png' : 'update-ready.png'
      await capture(window.webContents, name)
      const closed = once(window.webContents, 'destroyed', { signal: AbortSignal.timeout(10_000) })
      if (active) {
        await window.webContents.executeJavaScript("setTimeout(() => document.querySelector('.primary').click(), 0); undefined")
      } else {
        window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
      }
      const result = await pending
      await closed
      assert.equal(window.isDestroyed(), true)
      assert.equal(result.phase, active ? 'installing' : 'ready')
      assert.equal(f.installations.length, active ? 1 : 0)
    }
    assert.deepEqual(f.installations, [[true, true]])
    const created = once(app, 'web-contents-created', { signal: AbortSignal.timeout(10_000) })
    const diagnostics = 'exit 0; shutdown acknowledged false\n' + 'at internal/diagnostic/path\n'.repeat(1000)
    const pending = dialogs.show(parent, { title: messages.updateFailedTitle, message: messages.updateStopFailed,
      technicalDetails: diagnostics })
    const [, errorContents] = await created
    const errorWindow = { webContents: errorContents }
    await once(errorWindow.webContents, 'did-finish-load', { signal: AbortSignal.timeout(10_000) })
    await rendered(errorWindow)
    assert.equal(await errorWindow.webContents.executeJavaScript("document.getElementById('technical-details').open"), false)
    for (const expanded of [false, true]) {
      if (expanded) {
        assert.equal(await errorWindow.webContents.executeJavaScript("document.getElementById('technical-details-label').click(); document.getElementById('technical-details').open"), true)
        assert.equal(await errorWindow.webContents.executeJavaScript("document.getElementById('technical-details-content').textContent"), diagnostics)
        assert.equal(await errorWindow.webContents.executeJavaScript(`(() => {
          const detail = document.getElementById('technical-details-content');
          const button = document.querySelector('.primary').getBoundingClientRect();
          return detail.scrollHeight > detail.clientHeight && detail.getBoundingClientRect().height <= 180
            && button.top >= 0 && button.bottom <= innerHeight;
        })()`), true)
      }
      const name = expanded ? 'update-error-expanded.png' : 'update-error-collapsed.png'
      await capture(errorWindow.webContents, name)
    }
    assert.deepEqual(f.installations, [[true, true]])
    const closedError = once(errorWindow.webContents, 'destroyed', { signal: AbortSignal.timeout(10_000) })
    errorWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
    assert.equal((await pending).response, 0)
    dialogs.cancel()
    await closedError
    const markerPath = join(root, 'background-close-confirmed')
    const notice = new DesktopBackgroundNotice({ markerPath, locale: () => locale,
      show: options => dialogs.show(parent, options), focus: () => dialogs.focus() })
    try {
      for (const confirm of [false, true]) {
        parent.show()
        const createdNotice = once(app, 'web-contents-created', { signal: AbortSignal.timeout(10_000) })
        const hidden = Promise.withResolvers()
        notice.close(() => { parent.hide(); hidden.resolve() })
        const [, noticeContents] = await createdNotice
        const noticeWindow = { webContents: noticeContents }
        await once(noticeWindow.webContents, 'did-finish-load', { signal: AbortSignal.timeout(10_000) })
        await rendered(noticeWindow)
        assert.equal(parent.isVisible(), true)
        assert.deepEqual(await noticeWindow.webContents.executeJavaScript(`({
          message: document.getElementById('title').textContent,
          buttons: [...document.querySelectorAll('#actions button')].map(button => button.textContent),
          detailHidden: document.getElementById('detail').hidden,
        })`), JSON.parse(await readFile(new URL('../expected/background-close-confirmation.json', import.meta.url), 'utf8')))
        await assert.rejects(access(markerPath))
        const closedNotice = once(noticeWindow.webContents, 'destroyed', { signal: AbortSignal.timeout(10_000) })
        if (confirm) {
          const name = 'background-close-confirmation.png'
          await capture(noticeWindow.webContents, name)
          await noticeWindow.webContents.executeJavaScript("setTimeout(() => document.querySelector('.primary').click(), 0); undefined")
          await hidden.promise
        } else noticeWindow.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' })
        await closedNotice
        assert.equal(parent.isVisible(), !confirm)
      }
      await access(markerPath)
      parent.show()
      notice.close(() => { parent.hide() })
      assert.equal(parent.isVisible(), false)
      assert.equal(dialogs.isOpen, false)
    } finally { notice.dispose() }
    return { screenshots, captureFailures }
  } finally {
    dialogs.dispose()
    parent.destroy()
    protocol.unhandle('dsh-app')
    nativeTheme.themeSource = theme
  }
}
