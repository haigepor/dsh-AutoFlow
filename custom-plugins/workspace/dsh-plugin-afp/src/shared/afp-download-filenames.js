/** Clean a filename part for Windows and the Host filesystem.
 * @param {string} value Filename text or optional affix.
 * @param {number} limit Maximum retained characters.
 * @returns {string} Filename-safe text without trailing dots or spaces.
 */
export function cleanFilenamePart(value, limit = 100) {
  return String(value ?? '').normalize('NFKC').replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, '_')
    .trim().slice(0, limit).replace(/[. ]+$/g, '')
}

/** Build the same filename stem for the dialog preview and streamed file saving.
 * @param {object} source Delivered filename or stable GUID/photo ID; titles never name files.
 * @param {string} prefix Optional custom prefix.
 * @param {string} suffix Optional custom suffix.
 * @returns {string} Portable filename stem; the received image signature supplies its extension.
 */
export function downloadFilenameBase(source, prefix = '', suffix = '') {
  const before = cleanFilenamePart(prefix, 80), after = cleanFilenamePart(suffix, 80)
  const delivered = source.fileName ? String(source.fileName).split(/[\\/]/).at(-1) : null
  // 只有已交付文件名才有扩展名；GUID 和图片 ID 中的点属于标识本身。
  const original = delivered ? delivered.replace(/\.[^.]+$/, '') : source.guid || source.photoId
  const stem = cleanFilenamePart(original, 200 - before.length - after.length) || 'AFP-image'
  const base = `${before}${stem}${after}`.replace(/[. ]+$/g, '')
  return /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(base) ? `_${base}` : base
}
