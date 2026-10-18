/** Read bounded, explicitly configured image descriptions from the current article's executed page data. */

/** Read own data fields in the browser main world without evaluating publisher source or following recommendation trees. No URLs are fetched. @param {object} page Owned browser page. @param {string} url Current article URL. @param {object} config Resolved capture settings. @returns {Promise<object[]>} Published source URLs and original alternative descriptions. */
export async function readImageDescriptions(page, url, config) {
  const rules = config.imageMetadataSources.filter(rule => rule.hosts.some(host => host.toLowerCase() === new URL(url).hostname.toLowerCase()))
  if (!rules.length) return []
  return page.evaluate(({ rules, url, maxItems, maxImages }) => {
    const own = (value, key) => value && (typeof value === 'object' || typeof value === 'function') ? Object.getOwnPropertyDescriptor(value, key)?.value : undefined
    const get = (value, path) => path.reduce(own, value)
    const cleanUrl = source => {
      if (typeof source !== 'string' || !source || source.length > 16384) return null
      try { const target = new URL(source, url); return ['http:', 'https:'].includes(target.protocol) && !target.username && !target.password ? target.href : null } catch (error) { void error; return null }
    }
    const descriptions = new Map()
    let scanned = 0
    for (const rule of rules) {
      const value = get(window, rule.globalPath), identity = cleanUrl(get(value, rule.identityPath))
      if (!identity || identity.split('#')[0] !== url.split('#')[0]) continue
      const items = get(value, rule.itemsPath), length = own(items, 'length')
      if (!Array.isArray(items) || !Number.isInteger(length)) continue
      if (length + scanned > maxItems) return []
      for (let index = 0; index < length && scanned < maxItems; index++, scanned++) {
        const item = own(items, String(index))
        if (own(item, rule.typeKey) !== rule.typeValue) continue
        const source = cleanUrl(get(item, rule.sourcePath)), alt = get(item, rule.altPath)
        if (!source || typeof alt !== 'string' || !alt.trim() || alt.length > 2000) continue
        // 精确 URL 冲突拒绝整组，避免丢弃冲突声明后由另一尺寸变体错误补写。
        if (descriptions.has(source)) {
          if (descriptions.get(source) !== alt) return []
        } else {
          // 超限时不截断声明，避免尺寸变体的冲突在 Node 身份校验前被丢弃。
          if (descriptions.size >= maxImages) return []
          descriptions.set(source, alt)
        }
      }
    }
    return [...descriptions].map(([url, alt]) => ({ url, alt }))
  }, { rules, url, maxItems: config.maxArticleElements, maxImages: config.maxImages }, undefined, false)
}
