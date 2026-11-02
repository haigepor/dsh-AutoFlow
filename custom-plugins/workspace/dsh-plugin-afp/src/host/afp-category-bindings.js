import { CATEGORY_PROFILES } from '../vendor/auto-afp-img/afp-photo-search.mjs'
import { isPrivateSelection } from '../vendor/auto-afp-img/afp-collection-run.mjs'

/** Resolve one proposed binding for both previews and confirmed writes.
 * @param {Array<object>} selections Current account directory.
 * @param {object} values Saved category overrides.
 * @param {string} category Category receiving the binding.
 * @param {string|null} collectionId Private target ID, or null to unbind.
 * @returns {object} Valid target (null for unbinding), or an invalid-target/category-conflict kind.
 */
export function resolveCategoryBinding(selections, values, category, collectionId) {
  if (collectionId === null) return { kind: 'valid', target: null }
  const matches = selections.filter(item => item.id === collectionId), chosen = matches[0]
  if (matches.length !== 1 || !isPrivateSelection(chosen) || chosen.readOnly === true || typeof chosen.name !== 'string' || !chosen.name.trim()
    || chosen.name.length > 256 || /[\u0000-\u001f\u007f]/.test(chosen.name)
    || selections.filter(item => item.name === chosen.name).length !== 1) return { kind: 'invalid-target' }
  if (categoryTargets(selections, values).some(target => target.category !== category && target.id === collectionId)) return { kind: 'category-conflict' }
  return { kind: 'valid', target: chosen }
}

/** Resolve explicit account bindings, including deliberate detachment; absent entries retain legacy defaults.
 * @param {Array<object>} selections Current account collections.
 * @param {object} values Saved category overrides.
 * @returns {Array<object>} Category targets with availability states.
 */
export function categoryTargets(selections, values = {}) {
  const targets = CATEGORY_PROFILES.map(profile => {
    const explicit = Object.hasOwn(values, profile.key), binding = values[profile.key]
    if (explicit && binding === null) return { category: profile.key, name: null, id: null, status: 'unbound', explicit }
    const matches = selections.filter(item => explicit ? item.id === binding.id : item.name === profile.selectionName)
    const selection = matches[0]
    const valid = matches.length === 1 && isPrivateSelection(selection) && typeof selection.id === 'string'
      && Boolean(String(selection.name ?? '').trim()) && selections.filter(item => item.name === selection.name).length === 1
    return { category: profile.key, name: selection?.name ?? (explicit ? binding.name : profile.selectionName),
      id: valid ? selection.id : null, status: !matches.length ? 'missing' : valid ? 'private' : 'conflict', explicit }
  })
  for (const target of targets) if (target.id && targets.some(other => other !== target && other.id === target.id)) target.status = 'conflict'
  return targets.map(target => target.status === 'conflict' ? { ...target, id: null } : target)
}
