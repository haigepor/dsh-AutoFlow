import test from 'node:test'
import assert from 'node:assert/strict'
import { CATEGORY_PROFILES, LANDSCAPE_LOCATION_EXCLUSIONS } from '../src/vendor/auto-afp-img/afp-photo-search.mjs'
import { buildSearchCatalog } from '../src/shared/afp-search-catalog.js'
import { suggestKeywords, suggestionKey, placeSuggestions } from '../src/client/afp-search-suggestions.js'

test('keyword catalog uses positive terms, deduplicates categories and omits excluded destinations', () => {
  const catalog = buildSearchCatalog(CATEGORY_PROFILES, LANDSCAPE_LOCATION_EXCLUSIONS)
  assert.equal(new Set(catalog.map(row => row.id)).size, catalog.length)
  assert.ok(catalog.length > 400)
  assert.equal(catalog.filter(row => row.id === 'cat').length, 1)
  assert.ok(catalog.find(row => row.id === 'cat').aliases.includes('猫'))
  assert.ok(catalog.find(row => row.id === 'fish').categories.includes('food'))
  assert.equal(catalog.some(row => row.id === 'sossusvlei' && row.categories.includes('landscape')), false)
  assert.equal(catalog.some(row => /caption=|\bNOT\b/.test(row.term)), false)
  const combined = buildSearchCatalog([{key:'animals',metadataRequiredAny:['Cat','cat']},{key:'food',metadataRequiredAny:['CAT']}])
  assert.deepEqual(combined[0].categories, ['animals','food'])
})

test('suggestions match Chinese aliases and English prefixes with related cat breeds before incidental prefixes', () => {
  const catalog = buildSearchCatalog(CATEGORY_PROFILES, LANDSCAPE_LOCATION_EXCLUSIONS)
  assert.equal(suggestKeywords(catalog, '猫')[0].id, 'cat')
  assert.equal(suggestKeywords(catalog, ' CAT ')[0].id, 'cat')
  assert.ok(suggestKeywords(catalog, 'cat').some(row => row.id === 'ragdoll'))
  assert.equal(suggestKeywords(catalog, '星云')[0].id, 'nebula')
  assert.equal(suggestKeywords(catalog, '', 'food').every(row => row.categories.includes('food')), true)
  assert.equal(new Set(suggestKeywords(catalog, '').flatMap(row => row.categories)).size, 5)
  assert.deepEqual(suggestKeywords(catalog, 'zz-no-match'), [])
})

test('keyboard acceptance keeps search explicit and ignores composition', () => {
  assert.equal(suggestionKey({key:'Enter',isComposing:true},2,4,true).action, 'none')
  assert.equal(suggestionKey({key:'Enter',keyCode:229},2,4,true).action, 'none')
  assert.equal(suggestionKey({key:'Enter'},-1,4,true).action, 'submit')
  assert.equal(suggestionKey({key:'ArrowDown'},-1,4,true).index, 0)
  assert.equal(suggestionKey({key:'ArrowUp'},0,4,true).index, 3)
  assert.equal(suggestionKey({key:'Enter'},1,4,true).action, 'pick')
  assert.equal(suggestionKey({key:'Escape'},1,4,true).action, 'close')
})

test('suggestion placement flips above and clamps narrow windows without overflowing', () => {
  const rect={left:100,right:600,top:650,bottom:690,width:500}
  const placed=placeSuggestions(rect,800,720)
  assert.ok(placed.top + placed.maxHeight <= rect.top)
  const narrow=placeSuggestions({...rect,left:-10,width:500,top:80,bottom:120},320,500)
  assert.equal(narrow.left,8)
  assert.equal(narrow.width,304)
  assert.ok(narrow.top+narrow.maxHeight<=492)
  const short=placeSuggestions(rect,800,720,8,150)
  assert.equal(short.top,496)
  assert.equal(short.top+150,rect.top-4)
})
