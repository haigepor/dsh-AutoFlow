/** Fast, isolated local archives for independently released plugin bundles. */
import assert from 'node:assert/strict'
import { constants } from 'node:fs'
import { copyFile, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { isAbsolute, join, relative, resolve, sep } from 'node:path'
import { verifyPackedEntries } from './prepare-plugin-release.mjs'
import { verifyPackedEntries as verifyAfpEntries } from '../workspace/dsh-plugin-afp/scripts/prepare-release.mjs'

/** @param {string} base Stable source version. @param {Date} now UTC build time. @returns {string} Same-base local prerelease, below its official stable version. */
export function localVersion(base, now = new Date()) {
  assert.match(base, /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/, 'Local packaging requires a stable source base')
  return `${base}-local.${now.toISOString().replace(/\D/g, '').slice(0, 14)}.${now.getUTCMilliseconds()}`
}

/** @param {string} executable Process executable. @param {string[]} args Argument vector. @param {string} cwd Working directory. @param {boolean} verbose Stream output when true. @returns {Promise<string>} Bounded process output; throws on launch or exit failure. */
export async function runCommand(executable, args, cwd, verbose = false) {
  const child = spawn(executable, args, { cwd, windowsHide: true, stdio: verbose ? 'inherit' : ['ignore', 'pipe', 'pipe'] })
  let output = '', errors = ''
  child.stdout?.on('data', bytes => { output = (output + bytes.toString('utf8')).slice(-16 * 1024 * 1024) })
  child.stderr?.on('data', bytes => { errors = (errors + bytes.toString('utf8')).slice(-16 * 1024 * 1024) })
  await new Promise((accept, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => code === 0 ? accept() : reject(new Error(`Command failed (${code ?? signal}): ${args.join(' ')}\n${errors.slice(-6000)}\n${output.slice(-3000)}`)))
  })
  return output.trim()
}

/** @template T @param {string} label Visible stage name. @param {() => Promise<T>} work Stage operation. @returns {Promise<T>} Operation result with elapsed-time progress while pending. */
export async function progress(label, work) {
  const started = Date.now()
  console.log(`\n${label}`)
  const timer = setInterval(() => console.log(`  ${label} · ${Math.round((Date.now() - started) / 1000)} 秒`), 10_000)
  timer.unref()
  try { return await work() } finally { clearInterval(timer) }
}

/** Build one unique local archive without changing the source manifest or generated workspace files.
 * @param {object} options Package/repository directories, manifest, source commit/dirty flag, optional output root and fullChecks.
 * @returns {Promise<object>} Local-only receipt with an absolute archive path; no remote release metadata is produced.
 */
export async function packLocalPlugin({ packageRoot, repositoryRoot, manifest, sourceCommit, sourceDirty, outputRoot, fullChecks = false }) {
  const version = localVersion(manifest.version)
  const output = resolve(outputRoot ?? join(repositoryRoot, '.artifacts/plugins', manifest.name, 'local'), version)
  const pnpm = join(repositoryRoot, 'node_modules/pnpm/bin/pnpm.cjs')
  const command = (args, cwd = packageRoot, verbose = false) => runCommand(process.execPath, args, cwd, verbose)
  assert.match(sourceCommit, /^[a-f0-9]{40}$/)
  assert.equal(typeof sourceDirty, 'boolean')
  await mkdir(resolve(output, '..'), { recursive: true })
  await mkdir(output) // A local package path must never be reused by pnpm's archive cache.
  console.log(`[1/3] 准备本地构建\n  本地版本 ${version}\n  来源 ${sourceCommit}${sourceDirty ? '（含未提交修改）' : ''}`)
  if (fullChecks) await progress('执行插件完整检查', async () => {
    await command([pnpm, 'run', 'check'], packageRoot, true)
    await command([pnpm, 'run', 'test'], packageRoot, true)
  })
  else console.log('  快速模式：构建、包入口、依赖及 SHA256；不运行完整检查或 GitHub Actions')
  const receipt = await progress('[2/3] 构建并打包到隔离目录', async () => {
    const stage = await mkdtemp(join(output, 'stage-'))
    try {
      await command([pnpm, 'pack', '--config.ignore-scripts=true', '--pack-destination', stage])
      const initial = join(stage, `${manifest.name}-${manifest.version}.tgz`)
      const entries = (await runCommand('tar', ['-tzf', initial], packageRoot)).split(/\r?\n/)
      assert.ok(entries.every(path => path.startsWith('package/') && !path.split('/').includes('..') && !path.includes('\\')), 'Unsafe source archive paths')
      await runCommand('tar', ['-xzf', initial, '-C', stage], packageRoot)
      const staged = join(stage, 'package')
      if (manifest.name === 'dsh-boot-animation') {
        await command(['scripts/prepare.mjs', '--outdir', join(staged, 'lib')])
        await command([join(repositoryRoot, 'node_modules/tsdown/dist/run.mjs'), '--config-loader', 'native', '--out-dir', join(staged, 'lib')])
      } else {
        const builder = manifest.name === 'dsh-plugin-afp' ? 'scripts/build-client.mjs' : 'scripts/build.mjs'
        await command([builder, '--outdir', staged])
      }
      const packed = JSON.parse(await readFile(join(staged, 'package.json'), 'utf8'))
      assert.equal(packed.name, manifest.name)
      assert.equal(packed.version, manifest.version)
      assert.deepEqual(packed.dsh.bundle.update, manifest.dsh.bundle.update, 'Official update source changed')
      for (const section of ['dependencies', 'peerDependencies', 'optionalDependencies', 'devDependencies']) {
        assert.ok(Object.values(packed[section] ?? {}).every(value => !value.startsWith('workspace:')), `Unresolved workspace dependency in ${section}`)
      }
      packed.version = version
      await writeFile(join(staged, 'package.json'), JSON.stringify(packed, null, 2) + '\n', 'utf8')
      const name = `${manifest.name}-${version}.tgz`, temporary = join(stage, name), archive = join(output, name)
      await runCommand('tar', ['-czf', temporary, '-C', stage, 'package'], packageRoot)
      const verify = manifest.name === 'dsh-plugin-afp' ? verifyAfpEntries : verifyPackedEntries
      verify(packed, (await runCommand('tar', ['-tzf', temporary], packageRoot)).split(/\r?\n/))
      const bytes = await readFile(temporary), sha256 = createHash('sha256').update(bytes).digest('hex')
      await copyFile(temporary, archive, constants.COPYFILE_EXCL)
      return { schemaVersion: 1, channel: 'local', package: manifest.name, version, sourceVersion: manifest.version,
        sourceCommit, sourceDirty, checks: fullChecks ? 'full-plugin' : 'quick', archive, asset: { name, size: bytes.length, sha256 } }
    } finally {
      const absolute = await realpath(stage), parent = await realpath(output), child = relative(parent, absolute)
      assert.ok(child && child !== '..' && !child.startsWith(`..${sep}`) && !isAbsolute(child), 'Staging directory escaped the output directory')
      await rm(absolute, { recursive: true, force: false })
    }
  })
  await progress('[3/3] 保存本地构建记录', async () => {
    await writeFile(join(output, 'local-build.json'), JSON.stringify(receipt, null, 2) + '\n', { encoding: 'utf8', flag: 'wx' })
    await writeFile(join(output, 'SHA256SUMS'), `${receipt.asset.sha256}  ${receipt.asset.name}\n`, { encoding: 'utf8', flag: 'wx' })
  })
  console.log(`\n本地打包完成（未发布）\n${receipt.archive}\nSHA256 ${receipt.asset.sha256}\n桌面插件管理 → 安装插件 → 粘贴以上绝对路径 → 安装后重启。\n本地测试期间关闭该插件的“自动下载安装”；保留手动检查正式版更新。`)
  return receipt
}
