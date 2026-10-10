import { CATEGORY_PROFILES } from '../vendor/auto-afp-img/afp-photo-search.mjs'
import { isPrivateSelection } from '../vendor/auto-afp-img/afp-collection-run.mjs'

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
