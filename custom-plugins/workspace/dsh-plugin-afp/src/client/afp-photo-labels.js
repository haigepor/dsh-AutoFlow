/** Choose a readable UI title without altering the original AFP record.
 * @param {object} photo Photo title and caption metadata.
 * @param {string} fallback Localized label for records without readable text.
 * @returns {string} Trimmed title, caption or localized fallback.
 */
export function photoDisplayTitle(photo, fallback) {
  const title = photo.title?.trim()
  return title && !/^[-–—]+$/.test(title) ? title : photo.caption?.trim() || fallback
}
