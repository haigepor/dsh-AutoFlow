/** Curated Chinese search aliases supplement the profile's English positive terms. */
const aliases = {
  cat: ['猫'], kitten: ['小猫', '幼猫'], dog: ['狗'], puppy: ['小狗', '幼犬'], rabbit: ['兔子'], horse: ['马'], panda: ['熊猫'], 'red panda': ['小熊猫'],
  ragdoll: ['布偶猫'], 'maine coon': ['缅因猫'], persian: ['波斯猫'], 'norwegian forest cat': ['挪威森林猫'],
  fox: ['狐狸'], otter: ['水獭'], deer: ['鹿'], elephant: ['大象'], giraffe: ['长颈鹿'], koala: ['考拉'], lion: ['狮子'], tiger: ['老虎'],
  penguin: ['企鹅'], owl: ['猫头鹰'], eagle: ['鹰'], swan: ['天鹅'], crane: ['鹤'], flamingo: ['火烈鸟'], dolphin: ['海豚'], seal: ['海豹'], whale: ['鲸鱼'],
  dish: ['菜肴'], cuisine: ['美食'], dessert: ['甜点'], pastry: ['糕点'], bakery: ['烘焙'], barbecue: ['烧烤'], seafood: ['海鲜'], food: ['食物'],
  bread: ['面包'], fruit: ['水果'], vegetable: ['蔬菜'], rice: ['米饭'], noodle: ['面条'], meal: ['餐食'],
  landscape: ['风景'], scenery: ['景色'], mountain: ['山脉'], glacier: ['冰川'], fjord: ['峡湾'], canyon: ['峡谷'], valley: ['山谷'],
  waterfall: ['瀑布'], lake: ['湖泊'], forest: ['森林'], desert: ['沙漠'], beach: ['海滩'], volcano: ['火山'], coastline: ['海岸线'],
  'city skyline': ['城市天际线'], 'national park': ['国家公园'], iceland: ['冰岛'], patagonia: ['巴塔哥尼亚'], banff: ['班夫'],
  'movie poster': ['电影海报'], 'film poster': ['影片海报'], poster: ['海报'],
  planet: ['行星'], earth: ['地球'], moon: ['月球'], galaxy: ['星系'], nebula: ['星云'], comet: ['彗星'], asteroid: ['小行星'],
  'black hole': ['黑洞'], supernova: ['超新星'], 'solar flare': ['太阳耀斑'], 'solar system': ['太阳系'],
  'orion nebula': ['猎户座星云'], 'milky way': ['银河'], hubble: ['哈勃'], 'james webb': ['韦布望远镜'],
}
const related = { cat: ['kitten', 'ragdoll', 'maine coon', 'persian', 'norwegian forest cat'], dog: ['puppy'],
  nebula: ['orion nebula', 'carina nebula', 'crab nebula', 'horsehead nebula'], landscape: ['mountain', 'lake', 'waterfall', 'forest'] }

/** Generate a credential-free catalog from positive profile evidence, preserving category ownership.
 * @param {Array} profiles Existing AFP category profiles.
 * @param {Array<string>} [landscapeExclusions] Exact landscape locations excluded by the source policy.
 * @returns {Array} Stable keyword rows for the generated client JSON.
 */
export function buildSearchCatalog(profiles, landscapeExclusions = []) {
  const rows = new Map(), excluded = new Set(landscapeExclusions.map(term => term.toLowerCase()))
  for (const profile of profiles) {
    const terms = [...(profile.metadataRequiredAny ?? []), ...(profile.sources ?? []).flatMap(source => source.positiveEvidence ?? [])]
    for (const value of terms) {
      const term = value.trim(), id = term.normalize('NFKC').toLowerCase()
      if (!id || profile.key === 'landscape' && excluded.has(id)) continue
      let row = rows.get(id)
      if (!row) { row = { id, term, categories: [], aliases: aliases[id] ?? [], related: related[id] ?? [] }; rows.set(id, row) }
      if (!row.categories.includes(profile.key)) row.categories.push(profile.key)
    }
  }
  return [...rows.values()]
}
