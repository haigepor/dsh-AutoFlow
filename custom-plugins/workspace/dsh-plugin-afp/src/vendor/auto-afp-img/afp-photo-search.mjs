import { createHash } from 'node:crypto';
import { createAfpApiClient } from './afp-api-client.mjs';

const LANDSCAPE_QUERY_REGION_EXCLUSIONS = 'NOT China NOT Chinese NOT "Hong Kong" NOT Macau NOT Macao NOT Taiwan';
export const LANDSCAPE_LOCATION_EXCLUSIONS = Object.freeze(['namib desert', 'namib', 'sossusvlei']);

/** 风景候选发现预算：自然 70%，城市 20%，摄影师/Topshots 10%。 */
export const LANDSCAPE_DISCOVERY_BUDGET = Object.freeze([
  { key: 'natural', sourceTypes: Object.freeze(['destination']), share: 0.70 },
  { key: 'city', sourceTypes: Object.freeze(['city-panorama']), share: 0.20 },
  { key: 'photographer', sourceTypes: Object.freeze(['photographer']), share: 0.08 },
  { key: 'topshots', sourceTypes: Object.freeze(['topshots']), share: 0.02 },
]);

/**
 * 风景专项的地域排除词：覆盖用户确认的中国、香港、澳门和台湾及 AFP caption 常见地点别名。
 * 这是可审计的文本防线；没有明确地理文本的候选仍会交给后续像素级地域线索校验。
 */
export const LANDSCAPE_METADATA_REGION_EXCLUSIONS = Object.freeze([
  'china',
  'chinese',
  'people\'s republic of china',
  'mainland china',
  'hong kong',
  'hongkong',
  'hksar',
  'hong kong sar',
  'macau',
  'macao',
  'macau sar',
  'macao sar',
  'taiwan',
  'taipei',
  'jiangxi',
  'huichang',
  'new taipei',
  'kaohsiung',
  'taichung',
  'tainan',
  'hualien',
  'taroko',
  'alishan',
  'sun moon lake',
  'beijing',
  'shanghai',
  'guangzhou',
  'shenzhen',
  'chongqing',
  'chengdu',
  'wuhan',
  'hangzhou',
  'nanjing',
  'tianjin',
  'xiamen',
  'suzhou',
  'guilin',
  'yangshuo',
  'zhangjiajie',
  'huangshan',
  'jiuzhaigou',
  'yunnan',
  'xinjiang',
  'tibet',
  'inner mongolia',
  'hainan',
  'lijiang',
  'kunming',
  'sanya',
  'harbin',
  'qingdao',
  'sichuan',
]);

function landscapeCriteria(expression) {
  return `caption=(${expression}) ${LANDSCAPE_QUERY_REGION_EXCLUSIONS}`;
}

/**
 * 风景来源目录：自然地貌占主要发现预算，城市与摄影师只做补充入口。
 * queryVariants 保留旧字符串接口；实际新搜索优先消费此结构化来源目录。
 */
export const LANDSCAPE_SOURCES = Object.freeze([
  { id: 'patagonia-natural', sourceType: 'destination', region: 'latin-america', countryCode: 'ARG', mode: 'field-first', criteria: landscapeCriteria('Patagonia OR "Torres del Paine" OR "Paine Massif" OR "Fitz Roy"'), positiveEvidence: ['Patagonia', 'Torres del Paine', 'Fitz Roy'], priority: 1, budgetShare: 0.70 },
  { id: 'dolomites-natural', sourceType: 'destination', region: 'europe', countryCode: 'ITA', mode: 'field-first', criteria: landscapeCriteria('Dolomites OR "Italian Alps" OR mountain valley'), positiveEvidence: ['Dolomites', 'mountain', 'valley'], priority: 1, budgetShare: 0.70 },
  { id: 'iceland-natural', sourceType: 'destination', region: 'europe', countryCode: 'ISL', mode: 'field-first', criteria: landscapeCriteria('Iceland OR glacier OR waterfall OR "black sand beach"'), positiveEvidence: ['Iceland', 'glacier', 'waterfall'], priority: 1, budgetShare: 0.70 },
  { id: 'norway-fjords-natural', sourceType: 'destination', region: 'europe', countryCode: 'NOR', mode: 'field-first', criteria: landscapeCriteria('fjord OR Geirangerfjord OR Trolltunga OR Lofoten'), positiveEvidence: ['fjord', 'Geirangerfjord', 'Lofoten'], priority: 1, budgetShare: 0.70 },
  { id: 'alps-natural', sourceType: 'destination', region: 'europe', countryCode: 'CHE', mode: 'field-first', criteria: landscapeCriteria('Matterhorn OR "Swiss Alps" OR Lauterbrunnen OR "Lake Como"'), positiveEvidence: ['Matterhorn', 'Swiss Alps', 'Lauterbrunnen'], priority: 1, budgetShare: 0.70 },
  { id: 'north-america-parks', sourceType: 'destination', region: 'north-america', countryCode: 'USA', mode: 'field-first', criteria: landscapeCriteria('Yosemite OR Yellowstone OR Zion OR "Bryce Canyon" OR "Grand Canyon" OR "Denali National Park" OR "Grand Teton"'), positiveEvidence: ['Yosemite', 'Yellowstone', 'Bryce Canyon', 'Grand Canyon'], priority: 1, budgetShare: 0.70 },
  { id: 'canada-rockies', sourceType: 'destination', region: 'north-america', countryCode: 'CAN', mode: 'field-first', criteria: landscapeCriteria('Banff OR Jasper OR "Lake Louise" OR "Moraine Lake" OR Rockies'), positiveEvidence: ['Banff', 'Jasper', 'Lake Louise', 'Moraine Lake', 'Rockies'], priority: 1, budgetShare: 0.70 },
  { id: 'andes-altiplano', sourceType: 'destination', region: 'latin-america', countryCode: 'CHL', mode: 'field-first', criteria: landscapeCriteria('Atacama OR "Salar de Uyuni" OR "Mount Roraima" OR "Iguazu Falls"'), positiveEvidence: ['Atacama', 'Salar de Uyuni', 'Iguazu Falls'], priority: 1, budgetShare: 0.70 },
  { id: 'east-africa-savanna', sourceType: 'destination', region: 'africa', countryCode: 'TZA', mode: 'field-first', criteria: landscapeCriteria('Serengeti OR Ngorongoro OR Kilimanjaro'), positiveEvidence: ['Serengeti', 'Ngorongoro', 'Kilimanjaro'], priority: 1, budgetShare: 0.70 },
  { id: 'africa-waterfalls-mountains', sourceType: 'destination', region: 'africa', countryCode: 'ZMB', mode: 'field-first', criteria: landscapeCriteria('"Victoria Falls" OR Drakensberg OR "Table Mountain" OR "Blyde River Canyon"'), positiveEvidence: ['Victoria Falls', 'Drakensberg', 'Table Mountain'], priority: 1, budgetShare: 0.70 },
  { id: 'middle-east-landscapes', sourceType: 'destination', region: 'middle-east', countryCode: 'JOR', mode: 'field-first', criteria: landscapeCriteria('Wadi Rum OR Socotra OR "Atlas Mountains" OR Cappadocia'), positiveEvidence: ['Wadi Rum', 'Socotra', 'Atlas Mountains'], priority: 1, budgetShare: 0.70 },
  { id: 'south-asia-himalaya', sourceType: 'destination', region: 'south-asia', countryCode: 'NPL', mode: 'field-first', criteria: landscapeCriteria('Himalaya OR Annapurna OR Langtang OR Bhutan OR Ladakh'), positiveEvidence: ['Himalaya', 'Annapurna', 'Langtang'], priority: 1, budgetShare: 0.70 },
  { id: 'southeast-asia-natural', sourceType: 'destination', region: 'southeast-asia', countryCode: 'IDN', mode: 'field-first', criteria: landscapeCriteria('Komodo OR Bromo OR Rinjani OR Raja Ampat OR "Ha Long Bay"'), positiveEvidence: ['Komodo', 'Bromo', 'Raja Ampat'], priority: 1, budgetShare: 0.70 },
  { id: 'oceania-natural', sourceType: 'destination', region: 'oceania', countryCode: 'NZL', mode: 'field-first', criteria: landscapeCriteria('"Milford Sound" OR Fiordland OR "Lake Tekapo" OR Uluru OR Tasmania OR "Great Barrier Reef"'), positiveEvidence: ['Milford Sound', 'Fiordland', 'Lake Tekapo'], priority: 1, budgetShare: 0.70 },
  { id: 'city-new-york', sourceType: 'city-panorama', region: 'north-america', countryCode: 'USA', city: 'New York', mode: 'field-first', criteria: landscapeCriteria('"city skyline" OR Manhattan skyline OR waterfront skyline'), positiveEvidence: ['New York', 'skyline'], priority: 2, budgetShare: 0.20 },
  { id: 'city-paris', sourceType: 'city-panorama', region: 'europe', countryCode: 'FRA', city: 'Paris', mode: 'field-first', criteria: landscapeCriteria('"city panorama" OR Paris skyline OR landmark skyline'), positiveEvidence: ['Paris', 'skyline'], priority: 2, budgetShare: 0.20 },
  { id: 'city-london', sourceType: 'city-panorama', region: 'europe', countryCode: 'GBR', city: 'London', mode: 'field-first', criteria: landscapeCriteria('"city skyline" OR London panorama OR waterfront skyline'), positiveEvidence: ['London', 'skyline'], priority: 2, budgetShare: 0.20 },
  { id: 'city-rio', sourceType: 'city-panorama', region: 'latin-america', countryCode: 'BRA', city: 'Rio de Janeiro', mode: 'field-first', criteria: landscapeCriteria('Rio skyline OR waterfront skyline OR mountain city'), positiveEvidence: ['Rio de Janeiro', 'skyline'], priority: 2, budgetShare: 0.20 },
  { id: 'city-cape-town', sourceType: 'city-panorama', region: 'africa', countryCode: 'ZAF', city: 'Cape Town', mode: 'field-first', criteria: landscapeCriteria('Cape Town skyline OR waterfront skyline OR mountain city'), positiveEvidence: ['Cape Town', 'skyline'], priority: 2, budgetShare: 0.20 },
  { id: 'city-sydney', sourceType: 'city-panorama', region: 'oceania', countryCode: 'AUS', city: 'Sydney', mode: 'field-first', criteria: landscapeCriteria('Sydney skyline OR harbour skyline OR waterfront skyline'), positiveEvidence: ['Sydney', 'skyline'], priority: 2, budgetShare: 0.20 },
  { id: 'city-vancouver', sourceType: 'city-panorama', region: 'north-america', countryCode: 'CAN', city: 'Vancouver', mode: 'field-first', criteria: landscapeCriteria('Vancouver skyline OR mountain city OR waterfront skyline'), positiveEvidence: ['Vancouver', 'skyline'], priority: 2, budgetShare: 0.20 },
  { id: 'city-reykjavik', sourceType: 'city-panorama', region: 'europe', countryCode: 'ISL', city: 'Reykjavik', mode: 'field-first', criteria: landscapeCriteria('Reykjavik skyline OR waterfront skyline OR mountain city'), positiveEvidence: ['Reykjavik', 'skyline'], priority: 2, budgetShare: 0.20 },
  { id: 'creator-ansel-adams', sourceType: 'photographer', region: 'north-america', creator: 'Ansel Adams', mode: 'field-first', criteria: landscapeCriteria('landscape OR mountain OR valley OR canyon OR national park'), positiveEvidence: ['Ansel Adams', 'landscape'], priority: 3, budgetShare: 0.10 },
  { id: 'creator-galen-rowell', sourceType: 'photographer', region: 'north-america', creator: 'Galen Rowell', mode: 'field-first', criteria: landscapeCriteria('landscape OR mountain OR valley OR glacier'), positiveEvidence: ['Galen Rowell', 'landscape'], priority: 3, budgetShare: 0.10 },
  { id: 'creator-michael-kenna', sourceType: 'photographer', region: 'europe', creator: 'Michael Kenna', mode: 'field-first', criteria: landscapeCriteria('landscape OR seascape OR forest OR minimalism'), positiveEvidence: ['Michael Kenna', 'landscape'], priority: 3, budgetShare: 0.10 },
  { id: 'creator-david-muench', sourceType: 'photographer', region: 'north-america', creator: 'David Muench', mode: 'field-first', criteria: landscapeCriteria('landscape OR mountain OR national park'), positiveEvidence: ['David Muench', 'landscape'], priority: 3, budgetShare: 0.10 },
  { id: 'creator-art-wolfe', sourceType: 'photographer', region: 'global', creator: 'Art Wolfe', mode: 'field-first', criteria: landscapeCriteria('landscape OR mountain OR desert OR forest'), positiveEvidence: ['Art Wolfe', 'landscape'], priority: 3, budgetShare: 0.10 },
  { id: 'creator-frans-lanting', sourceType: 'photographer', region: 'global', creator: 'Frans Lanting', mode: 'field-first', criteria: landscapeCriteria('landscape OR forest OR desert OR coast'), positiveEvidence: ['Frans Lanting', 'landscape'], priority: 3, budgetShare: 0.10 },
  { id: 'creator-contemporary-landscape', sourceType: 'photographer', region: 'global', creator: 'Max Rive', mode: 'field-first', criteria: landscapeCriteria('landscape OR mountain OR valley OR glacier'), positiveEvidence: ['Max Rive', 'landscape'], priority: 3, budgetShare: 0.10 },
  { id: 'creator-marc-adamus', sourceType: 'photographer', region: 'north-america', creator: 'Marc Adamus', mode: 'field-first', criteria: landscapeCriteria('landscape OR mountain OR forest OR storm'), positiveEvidence: ['Marc Adamus', 'landscape'], priority: 3, budgetShare: 0.10 },
  { id: 'creator-chris-burkard', sourceType: 'photographer', region: 'global', creator: 'Chris Burkard', mode: 'field-first', criteria: landscapeCriteria('landscape OR coast OR glacier OR mountain'), positiveEvidence: ['Chris Burkard', 'landscape'], priority: 3, budgetShare: 0.10 },
  { id: 'creator-thomas-heaton', sourceType: 'photographer', region: 'europe', creator: 'Thomas Heaton', mode: 'field-first', criteria: landscapeCriteria('landscape OR coast OR mountain OR woodland'), positiveEvidence: ['Thomas Heaton', 'landscape'], priority: 3, budgetShare: 0.10 },
  { id: 'creator-peter-lik', sourceType: 'photographer', region: 'global', creator: 'Peter Lik', mode: 'field-first', criteria: landscapeCriteria('landscape OR canyon OR desert OR mountain'), positiveEvidence: ['Peter Lik', 'landscape'], priority: 3, budgetShare: 0.10 },
  { id: 'topshots-landscape-discovery', sourceType: 'topshots', region: 'global', mode: 'caption-fallback', criteria: landscapeCriteria('"wide landscape" OR "natural scenery" OR "mountain landscape" OR "coastal landscape" OR "valley panorama" OR "city skyline"'), positiveEvidence: ['landscape', 'scenery', 'mountain', 'coastal', 'valley', 'skyline'], priority: 4, budgetShare: 0.02 },
]);

const ANIMAL_SPECIALIST_EXCLUSIONS = 'NOT people NOT cage NOT fence NOT injured NOT dead NOT blood';
export const ANIMAL_APPEAL_TERMS = Object.freeze({
  high: Object.freeze([
    'cat', 'kitten', 'dog', 'puppy', 'rabbit', 'bunny', 'horse', 'pony', 'panda', 'red panda',
    'dolphin', 'seal', 'penguin', 'elephant', 'giraffe', 'fox', 'koala', 'otter', 'lion', 'tiger', 'deer',
    'red fox', 'polar bear', 'brown bear', 'capybara', 'meerkat', 'sloth', 'squirrel', 'raccoon',
    'quokka', 'fennec fox', 'red squirrel', 'shiba inu', 'golden retriever', 'ragdoll', 'maine coon',
  ]),
  medium: Object.freeze([
    'monkey', 'sheep', 'lamb', 'goat', 'cow', 'cattle', 'hippopotamus', 'hippo', 'rhinoceros', 'rhino',
    'zebra', 'whale', 'eagle', 'hawk', 'owl', 'falcon', 'crane', 'swan', 'flamingo', 'pelican', 'puffin',
    'parrot', 'macaw', 'toucan', 'kingfisher', 'gibbon', 'gorilla', 'chimpanzee', 'orangutan',
    'robin', 'blue jay', 'goldfinch', 'snowy owl', 'budgerigar', 'budgie', 'lovebird', 'okapi', 'bongo',
  ]),
});
export const ANIMAL_ALLOWED_SPECIES_TERMS = Object.freeze([
  ...ANIMAL_APPEAL_TERMS.high,
  ...ANIMAL_APPEAL_TERMS.medium,
  'cheetah', 'leopard', 'jaguar', 'lynx', 'bobcat', 'puma', 'cougar', 'serval',
  'hyena', 'mongoose', 'aardvark', 'warthog', 'armadillo', 'anteater',
  'tapir', 'camel', 'dromedary', 'llama', 'alpaca', 'lemur', 'tarsier', 'marmoset', 'tamarin', 'capuchin',
  'squirrel', 'chipmunk', 'marmot', 'prairie dog', 'groundhog', 'porcupine', 'beaver', 'mink', 'badger', 'skunk',
  'pika', 'vole', 'hamster', 'guinea pig', 'reindeer', 'caribou', 'ibex', 'chamois', 'gazelle', 'kudu', 'springbok',
  'yak', 'bison', 'buffalo', 'musk ox', 'wildebeest', 'hartebeest', 'orca', 'walrus', 'manatee', 'dugong',
  'albatross', 'tern', 'gull', 'cormorant', 'vulture', 'condor', 'kestrel', 'osprey', 'kite', 'buzzard',
  'woodpecker', 'nightjar', 'cuckoo', 'jay', 'magpie', 'parakeet', 'canary', 'finch', 'swallow', 'wagtail', 'warbler',
  'ostrich', 'emu', 'cassowary', 'kiwi', 'rhea', 'peacock', 'pheasant', 'turkey', 'quail', 'grouse', 'partridge',
  'ibis', 'spoonbill', 'egret', 'stork', 'calf', 'lamb', 'kid', 'piglet', 'fawn', 'pig', 'swine', 'donkey', 'mule',
  'British Shorthair', 'Scottish Fold', 'Norwegian Forest Cat', 'Turkish Angora', 'Birman', 'Russian Blue',
  'Shiba Inu', 'French bulldog', 'Dachshund', 'Beagle', 'Poodle', 'Holland lop', 'Netherland dwarf', 'Lionhead rabbit',
  'guinea pig', 'chinchilla', 'quokka', 'fennec fox', 'red squirrel', 'okapi', 'bongo', 'saiga', 'maned wolf',
  'robin', 'blue jay', 'goldfinch', 'snowy owl', 'budgerigar', 'budgie', 'lovebird',
]);
export const ANIMAL_DISCOMFORT_TERMS = Object.freeze([
  'spider', 'tarantula', 'scorpion', 'centipede', 'millipede', 'tick', 'mite', 'parasite', 'parasitic',
  'cockroach', 'roach', 'caterpillar', 'maggot', 'grub', 'larva', 'larvae', 'larval', 'earthworm', 'worm',
  'flatworm', 'leech', 'slug', 'slimy', 'slime', 'mucus', 'infestation', 'swarm', 'mating', 'copulation',
  'dense cluster', 'prey capture', 'eating a scorpion', 'black cat', 'black kitten',
  'predation', 'predator', 'prey', 'hunting', 'hunt', 'caught', 'catching', 'capture prey',
  'carrying prey', 'biting', 'attack', 'attacking', 'killing', 'kill', 'threatening',
  'dense colony', 'colony', 'crowded herd', 'large colony', 'large group', 'mixed species',
  'multiple species', 'foreground blur', 'blurred foreground',
  'fish', 'reptile', 'amphibian', 'snake', 'lizard', 'turtle', 'tortoise', 'frog', 'toad',
  'invertebrate', 'crustacean', 'shellfish', 'mollusk', 'mollusc', 'octopus', 'squid', 'jellyfish',
]);
const ANIMAL_SPECIALIST_EXPRESSIONS = Object.freeze([
  'cheetah OR leopard OR jaguar OR lynx OR bobcat OR puma OR cougar OR serval',
  'hyena OR meerkat OR mongoose OR aardvark OR warthog OR armadillo OR sloth OR anteater',
  'hippopotamus OR hippo OR rhinoceros OR tapir OR camel OR dromedary OR llama OR alpaca',
  'gorilla OR chimpanzee OR orangutan OR gibbon OR baboon OR mandrill OR macaque',
  'lemur OR tarsier OR marmoset OR tamarin OR capuchin OR howler monkey',
  'squirrel OR chipmunk OR marmot OR "prairie dog" OR groundhog OR porcupine',
  'beaver OR otter OR mink OR badger OR raccoon OR skunk',
  'rabbit OR hare OR pika OR vole OR hamster OR "guinea pig"',
  'reindeer OR caribou OR ibex OR chamois OR gazelle OR kudu OR springbok',
  'yak OR bison OR buffalo OR "musk ox" OR wildebeest OR hartebeest',
  'seal OR "sea lion" OR walrus OR manatee OR dugong OR dolphin OR orca OR whale',
  'penguin OR albatross OR puffin OR tern OR gull OR cormorant',
  'pelican OR puffin OR kingfisher OR "bee-eater" OR hornbill OR toucan',
  'vulture OR condor OR kestrel OR osprey OR kite OR buzzard',
  'woodpecker OR kingfisher OR nightjar OR cuckoo OR jay OR magpie',
  'parakeet OR canary OR finch OR swallow OR wagtail OR warbler',
  'ostrich OR emu OR cassowary OR kiwi OR rhea',
  'peacock OR pheasant OR turkey OR quail OR grouse OR partridge',
  'flamingo OR ibis OR spoonbill OR egret OR crane OR stork',
  'capybara OR red panda OR prairie dog OR meerkat',
  'foal OR calf OR lamb OR kid OR piglet OR fawn',
  'sheep OR goat OR cow OR cattle OR pig OR swine',
  'horse OR pony OR donkey OR mule OR draft horse',
  'dog OR puppy OR cat OR kitten OR rabbit OR guinea pig',
]);
/**
 * 第二轮动物扩展召回：品种、熟悉动物别名、自然状态、栖息地与自然光分开覆盖。
 * 这些查询只负责扩大召回；是否真实可见、身体是否完整和是否舒适仍由像素级视觉门禁决定。
 */
const ANIMAL_DIVERSIFIED_EXPRESSIONS = Object.freeze([
  '"Maine Coon" OR Persian OR Siamese OR Bengal OR Ragdoll OR "British Shorthair"',
  '"Norwegian Forest Cat" OR "Turkish Angora" OR Birman OR "Russian Blue" OR "Abyssinian cat"',
  '"golden retriever" OR Labrador OR "border collie" OR corgi OR husky OR Samoyed',
  '"Cavalier King Charles" OR "Bernese Mountain Dog" OR "Australian Shepherd" OR "French bulldog" OR "Shiba Inu"',
  'beagle OR dachshund OR Dalmatian OR poodle OR spaniel OR terrier',
  '"lop rabbit" OR "Angora rabbit" OR "Dutch rabbit" OR hare OR bunny OR rabbit',
  '"Arabian horse" OR "Icelandic horse" OR "Shetland pony" OR thoroughbred OR foal OR pony',
  '"snow leopard" OR cheetah OR leopard OR jaguar OR lynx OR puma',
  '"arctic fox" OR "red fox" OR fox OR wolf OR coyote OR jackal',
  'panda OR "red panda" OR koala OR "polar bear" OR "brown bear" OR sloth',
  '"sea otter" OR otter OR seal OR dolphin OR orca OR "sea lion"',
  'elephant OR giraffe OR zebra OR rhino OR hippopotamus OR bison',
  'deer OR fawn OR reindeer OR gazelle OR antelope OR ibex',
  'gorilla OR chimpanzee OR orangutan OR lemur OR capuchin OR macaque',
  'parrot OR macaw OR cockatoo OR budgerigar OR canary OR cockatiel',
  'kingfisher OR flamingo OR peacock OR toucan OR hornbill OR "bee-eater"',
  'eagle OR owl OR hawk OR falcon OR osprey OR kestrel',
  'swan OR crane OR stork OR egret OR pelican OR puffin',
  '((cat OR dog OR rabbit OR horse) AND (resting OR sitting OR standing OR walking OR sleeping))',
  '((fox OR deer OR otter OR panda OR koala) AND ("golden hour" OR sunrise OR sunset OR "soft light" OR "morning light"))',
  '((horse OR deer OR rabbit OR sheep OR lamb) AND (meadow OR pasture OR grassland OR field))',
  '((fox OR squirrel OR owl OR deer OR bear) AND (forest OR woodland OR autumn OR snow))',
  '((eagle OR owl OR kingfisher OR flamingo OR swan) AND ("natural light" OR perched OR flying OR wildlife))',
  '((seal OR dolphin OR otter OR penguin OR whale) AND (swimming OR water OR coast OR ocean OR ice))',
  '((puppy OR kitten OR foal OR lamb OR calf OR fawn) AND (standing OR walking OR resting OR meadow))',
  '((dog OR cat OR rabbit) AND (garden OR meadow OR park OR outdoors OR sunlight))',
  '((panda OR "red panda" OR koala OR sloth) AND (tree OR forest OR bamboo OR natural))',
  '((horse OR cow OR sheep OR goat) AND (pasture OR mountain OR meadow OR countryside))',
  '((flamingo OR swan OR crane OR egret OR stork) AND (wetland OR lake OR water OR dawn))',
  '((fox OR leopard OR cheetah OR wolf) AND (snow OR winter OR mountain OR woodland))',
  '((parrot OR macaw OR toucan OR kingfisher) AND (rainforest OR jungle OR branch OR canopy))',
  '(("British Shorthair" OR "Scottish Fold" OR "Norwegian Forest Cat" OR "Turkish Angora" OR Birman OR "Russian Blue") AND (garden OR meadow OR outdoors OR sunlight OR "natural light"))',
  '(("golden retriever" OR Labrador OR "border collie" OR corgi OR husky OR Samoyed) AND (standing OR walking OR sitting OR resting) AND (park OR field OR meadow OR garden))',
  '(("Holland lop" OR "Lionhead rabbit" OR "guinea pig" OR chinchilla OR hamster) AND (meadow OR grass OR garden OR outdoors) AND (resting OR sitting OR standing))',
  '((owl OR eagle OR kingfisher OR flamingo OR swan OR crane) AND (perched OR flying OR standing) AND (wetland OR forest OR branch OR lake OR meadow))',
  '"British Shorthair" OR "Scottish Fold" OR "Norwegian Forest Cat" OR "Turkish Angora" OR Birman OR "Russian Blue"',
  '"Shiba Inu" OR "French bulldog" OR Dachshund OR Beagle OR Poodle OR spaniel OR terrier',
  '"Holland lop" OR "Netherland dwarf" OR "Lionhead rabbit" OR "guinea pig" OR chinchilla',
  'quokka OR capybara OR "fennec fox" OR "red squirrel" OR okapi OR bongo OR saiga OR "maned wolf"',
  'robin OR "blue jay" OR goldfinch OR "snowy owl" OR budgerigar OR budgie OR lovebird',
  'cockatoo OR cockatiel OR budgerigar OR lovebird OR kingfisher OR hornbill OR "bee-eater"',
  'quokka OR capybara OR "red panda" OR "fennec fox" OR koala OR sloth OR meerkat',
  '((cat OR kitten OR dog OR puppy OR rabbit OR bunny) AND (standing OR walking OR sitting OR resting) AND (garden OR meadow OR park OR outdoors))',
  '((quokka OR capybara OR meerkat OR "red panda" OR "fennec fox") AND (meadow OR grassland OR woodland OR "natural habitat"))',
  '((robin OR "blue jay" OR goldfinch OR "snowy owl" OR budgerigar OR lovebird) AND (perched OR flying OR branch OR woodland OR garden))',
  '((horse OR pony OR donkey OR cow OR sheep OR goat) AND (pasture OR meadow OR countryside OR mountain) AND (standing OR grazing OR walking))',
  '((cat OR kitten OR dog OR puppy OR rabbit OR bunny) AND ("full body" OR "whole body" OR "side view" OR "profile view") AND ("natural light" OR outdoors OR meadow OR garden))',
  '((Maine Coon OR Ragdoll OR "British Shorthair" OR "Scottish Fold" OR "Norwegian Forest Cat") AND (standing OR sitting OR resting) AND ("full body" OR "side view" OR "profile view"))',
  '((golden retriever OR Labrador OR corgi OR husky OR Samoyed OR "Shiba Inu") AND (standing OR walking OR sitting OR resting) AND ("full body" OR "whole body") AND (park OR field OR meadow OR garden))',
  '((horse OR deer OR fox OR otter OR panda OR koala) AND (standing OR walking OR resting) AND ("side view" OR "profile view" OR "full body") AND (meadow OR forest OR woodland OR "natural habitat"))',
  '((owl OR eagle OR kingfisher OR flamingo OR swan OR crane OR cockatiel) AND (perched OR standing OR flying) AND ("full body" OR "side view" OR "profile view") AND (branch OR wetland OR lake OR garden))',
  '((cat OR kitten OR dog OR puppy OR rabbit OR horse) AND ("side view" OR profile OR "standing profile") AND (resting OR standing OR walking OR sitting))',
  '((Maine Coon OR Ragdoll OR "British Shorthair" OR "golden retriever" OR Labrador OR corgi) AND ("side view" OR profile OR "standing profile"))',
  '((fox OR deer OR otter OR panda OR koala OR capybara) AND ("side view" OR profile OR "standing profile") AND (wildlife OR natural OR habitat))',
  '((owl OR eagle OR kingfisher OR swan OR crane OR cockatiel) AND (profile OR "side view" OR perched) AND wildlife)',
  '((horse OR deer OR sheep OR goat OR cow OR rabbit) AND ("side view" OR profile OR "standing profile") AND (meadow OR pasture OR field OR countryside))',
  '(("Persian cat" OR Siamese OR Bengal OR Ragdoll OR "British Shorthair") AND (standing OR sitting OR resting) AND (garden OR meadow OR outdoors))',
  '(("golden retriever" OR Labrador OR corgi OR husky OR Samoyed) AND (standing OR walking OR resting) AND (park OR field OR meadow))',
  '(("Holland lop" OR "Lionhead rabbit" OR "Angora rabbit" OR "Netherland dwarf") AND (sitting OR resting OR standing) AND (grass OR garden OR meadow))',
  '(("Arabian horse" OR "Icelandic horse" OR "Shetland pony" OR thoroughbred) AND (standing OR grazing OR walking) AND (pasture OR meadow OR countryside))',
  '(("red panda" OR capybara OR quokka OR "fennec fox" OR meerkat) AND (standing OR resting OR walking) AND (woodland OR grassland OR "natural habitat"))',
  '((cockatiel OR cockatoo OR budgerigar OR lovebird OR parrot) AND (perched OR standing OR flying) AND (branch OR garden OR woodland))',
  '((kingfisher OR hornbill OR toucan OR flamingo OR swan) AND (perched OR standing OR flying) AND (wetland OR lake OR branch))',
  '((penguin OR seal OR otter OR dolphin OR "sea lion") AND (standing OR swimming OR resting) AND (coast OR ocean OR ice OR shore))',
]);
const ANIMAL_DIVERSIFIED_TERMS = Object.freeze([
  'Maine Coon', 'Persian', 'Siamese', 'Bengal', 'Ragdoll', 'British Shorthair',
  'golden retriever', 'Labrador', 'border collie', 'corgi', 'husky', 'Samoyed',
  'beagle', 'dachshund', 'Dalmatian', 'poodle', 'spaniel', 'terrier',
  'lop rabbit', 'Angora rabbit', 'Dutch rabbit', 'Arabian horse', 'Icelandic horse', 'Shetland pony', 'thoroughbred',
  'snow leopard', 'arctic fox', 'wolf', 'coyote', 'jackal', 'polar bear', 'brown bear', 'sea otter', 'sea lion',
  'rhino', 'hippopotamus', 'bison', 'antelope', 'cockatoo', 'budgerigar', 'cockatiel', 'hornbill', 'bee-eater',
  'sunrise', 'sunset', 'golden hour', 'soft light', 'morning light', 'meadow', 'pasture', 'grassland', 'field',
  'forest', 'woodland', 'autumn', 'snow', 'wetland', 'rainforest', 'jungle', 'canopy', 'countryside',
  'British Shorthair', 'Scottish Fold', 'Norwegian Forest Cat', 'Turkish Angora', 'Birman', 'Russian Blue',
  'Shiba Inu', 'French bulldog', 'Dachshund', 'Beagle', 'Poodle', 'Holland lop', 'Netherland dwarf', 'Lionhead rabbit',
  'guinea pig', 'chinchilla', 'quokka', 'fennec fox', 'red squirrel', 'okapi', 'bongo', 'saiga', 'maned wolf',
  'robin', 'blue jay', 'goldfinch', 'snowy owl', 'budgerigar', 'budgie', 'lovebird',
  'full body', 'whole body', 'side view', 'profile view',
]);
const ANIMAL_SPECIALIST_QUERY_VARIANTS = Object.freeze(
  ANIMAL_SPECIALIST_EXPRESSIONS.map((expression) => `caption=(${expression}) ${ANIMAL_SPECIALIST_EXCLUSIONS}`),
);
const ANIMAL_DIVERSIFIED_QUERY_VARIANTS = Object.freeze(
  ANIMAL_DIVERSIFIED_EXPRESSIONS.map((expression) => `caption=(${expression}) ${ANIMAL_SPECIALIST_EXCLUSIONS}`),
);
const ANIMAL_SPECIALIST_TERMS = Object.freeze(
  [...new Set(ANIMAL_SPECIALIST_EXPRESSIONS.flatMap((expression) => expression.split(' OR ').map((term) => term.replaceAll('"', ''))))],
);

export const CATEGORY_PROFILES = Object.freeze([
  {
    key: 'animals',
    selectionName: 'AutoFlow_动物',
    criteria: 'caption=(cat OR dog OR rabbit OR horse OR panda OR fox OR otter OR deer OR elephant OR giraffe OR penguin OR owl OR eagle OR crane OR swan) NOT wildfire NOT insect NOT spider NOT fish NOT reptile NOT amphibian NOT mascot NOT costume NOT people NOT crowd',
    queryVariants: [
      'caption=(cat OR kitten OR dog OR puppy OR rabbit OR bunny OR horse OR pony OR panda OR "red panda" OR koala OR otter OR fox OR deer OR seal OR dolphin OR penguin) NOT insect NOT spider NOT fish NOT reptile NOT amphibian NOT people',
      'caption=(cat OR kitten OR dog OR puppy OR rabbit OR bunny OR guinea pig OR hamster) NOT "black cat" NOT "black kitten" NOT clinic NOT surgery NOT injured NOT dead NOT blood',
      'caption=((cat OR kitten OR dog OR puppy OR rabbit OR bunny OR horse OR pony OR panda OR fox OR otter) AND (resting OR standing OR walking OR grazing OR swimming OR peaceful OR calm OR "natural light" OR "wildlife photography")) NOT "black cat" NOT "black kitten" NOT injured NOT dead NOT blood NOT people NOT cage',
      'caption=(panda OR "red panda" OR koala OR otter OR fox OR elephant OR giraffe OR lion OR tiger OR deer OR bear OR capybara) NOT hunting NOT predation NOT prey NOT people NOT cage NOT fence',
      'caption=(horse OR pony OR foal OR rabbit OR hare OR squirrel OR beaver OR raccoon OR meerkat OR sloth) NOT people NOT cage NOT fence NOT rescue NOT injured NOT dead',
      'caption=((elephant OR giraffe OR panda OR "red panda" OR koala OR fox OR otter OR deer OR seal OR penguin) AND (standing OR walking OR resting OR swimming OR "natural habitat" OR "golden hour")) NOT hunting NOT predation NOT prey NOT people NOT cage NOT fence',
      'caption=(seal OR dolphin OR orca OR whale OR penguin OR "sea lion" OR walrus OR manatee) NOT aquarium NOT tank NOT people NOT hunting NOT prey NOT injured',
      'caption=(owl OR eagle OR hawk OR falcon OR kingfisher OR pelican OR crane OR swan OR flamingo OR parrot OR macaw OR toucan OR puffin OR penguin) NOT nestling NOT dead NOT injured NOT people NOT cage NOT fence',
      'caption=(cheetah OR leopard OR jaguar OR lynx OR puma OR gorilla OR chimpanzee OR orangutan OR zebra OR rhinoceros OR hippopotamus) NOT people NOT cage NOT fence NOT hunting NOT predation NOT prey',
      'caption=(sheep OR goat OR cow OR cattle OR pig OR calf OR lamb OR kid OR fawn) NOT people NOT cage NOT fence NOT handler NOT leash NOT injured',
      ...ANIMAL_SPECIALIST_QUERY_VARIANTS,
      ...ANIMAL_DIVERSIFIED_QUERY_VARIANTS,
    ],
    metadataRequiredAny: [
      ...ANIMAL_ALLOWED_SPECIES_TERMS,
      ...ANIMAL_SPECIALIST_TERMS,
      ...ANIMAL_DIVERSIFIED_TERMS,
    ],
    metadataExclusions: [
      'insect', 'insects', 'spider', 'spiders', 'arachnid', 'tarantula', 'scorpion', 'centipede', 'millipede',
      'tick', 'mite', 'parasite', 'cockroach', 'roach', 'caterpillar', 'moth', 'bee', 'wasp', 'hornet',
      'beetle', 'dragonfly', 'damselfly', 'ant', 'termite', 'worm', 'earthworm', 'leech', 'slug', 'snail',
      'fish', 'reptile', 'reptiles', 'amphibian', 'amphibians', 'snake', 'lizard', 'turtle', 'tortoise',
      'frog', 'toad', 'newt', 'salamander', 'octopus', 'squid', 'jellyfish', 'crab', 'lobster', 'shrimp',
      'crustacean', 'shellfish', 'mollusk', 'mollusc', 'invertebrate', 'mating', 'swarm', 'infestation',
      'close-up', 'closeup', 'headshot', 'face only', 'eyes only', 'nose only', 'macro detail',
      'mascot', 'costume', 'cosplay', 'cartoon', 'toy', 'puppet', 'logo', 'poster', 'screen', 'drawing', 'illustration',
      'cage', 'caged', 'enclosure', 'fence', 'fenced', 'wire', 'wire mesh', 'aviary', 'aquarium', 'tank', 'zoo',
      'people', 'person', 'human', 'crowd', 'event', 'festival', 'parade', 'protest', 'rally', 'campaign', 'conference',
      'handler', 'keeper', 'trainer', 'leash', 'harness', 'tethered', 'restrained', 'held', 'handling', 'blindfolded',
      'rescue', 'translocation', 'tranquilized', 'capture', 'clinical', 'clinic', 'surgery', 'laboratory',
      'injured', 'injury', 'wound', 'blood', 'bloody', 'dead', 'death', 'corpse', 'carcass', 'skeleton', 'killed',
      'birthday', 'cake', 'feeding', 'ceremony', 'performance', 'photocall', 'photo op', 'display', 'exhibit', 'runway', 'contest', 'show',
      'golfer', 'golf', 'soccer', 'football', 'player', 'players', 'athlete', 'stadium', 'sports', 'match', 'tournament', 'pitch',
      'sliced kiwi', 'kiwi fruit', 'fruit still life', 'food still life', 'food photography',
      'podium', 'speaker', 'meeting', 'hockey', 'red carpet', 'yoga', 'museum', 'sculpture', 'mural', 'anatomical', 'human skull',
      'rocket launch', 'staircase', 'capitol', 'police', 'studio portrait', 'studio backdrop', 'photo studio', 'staged portrait',
      'predation', 'predator', 'prey', 'hunting', 'hunt', 'caught', 'catching', 'capture prey', 'carrying prey', 'biting', 'attack', 'attacking', 'killing', 'kill', 'threatening',
      'dense colony', 'colony', 'crowded herd', 'large colony', 'large group', 'mixed species', 'multiple species', 'foreground blur', 'blurred foreground',
      'black cat', 'black kitten', 'wildfire', 'smoke', 'storefront', 'signage', 'concrete area', 'pile of material',
    ],

  },
  {
    key: 'food',
    selectionName: 'AutoFlow_食物',
    criteria: 'caption=(dish OR cuisine OR dessert OR pastry OR bakery OR barbecue OR seafood) NOT delivery NOT menu NOT restaurant NOT factory NOT processing',
    queryVariants: [
      'caption=(dish OR cuisine OR dessert OR pastry OR bakery OR barbecue OR seafood) NOT delivery NOT menu NOT restaurant NOT factory NOT processing',
      'caption=(chef AND dish) NOT delivery NOT menu NOT restaurant NOT factory NOT processing',
      'caption=(food AND plate) NOT delivery NOT menu NOT restaurant NOT factory NOT processing',
    ],
    metadataRequiredAny: ['dish', 'cuisine', 'dessert', 'pastry', 'bakery', 'barbecue', 'seafood', 'food', 'plate', 'meal', 'bread', 'fish', 'fruit', 'vegetable', 'rice', 'noodle', 'served', 'loaf'],
    metadataExclusions: ['animal', 'panda', 'zoo', 'festival', 'offering', 'food stall', 'food truck', 'delivery', 'restaurant', 'menu', 'signage', 'factory', 'processing', 'laboratory', 'packaging', 'railway', 'train', 'campaign', 'rally', 'candidate', 'football', 'soccer', 'match', 'moped', 'antenna dish', 'observatory', 'satellite dish'],
  },
  {
    key: 'landscape',
    selectionName: 'AutoFlow_风景',
    maxPerTitle: 1,
    sources: LANDSCAPE_SOURCES,
    criteria: `caption=(landscape OR scenery OR scenic OR seascape OR panorama OR "city skyline") ${LANDSCAPE_QUERY_REGION_EXCLUSIONS}`,
    queryVariants: [
      `caption=("mountain landscape" OR "mountain range" OR glacier OR fjord OR canyon OR valley) ${LANDSCAPE_QUERY_REGION_EXCLUSIONS}`,
      `caption=(coastline OR seascape OR "coastal landscape" OR beach OR waterfall OR "river valley" OR lake) ${LANDSCAPE_QUERY_REGION_EXCLUSIONS}`,
      `caption=(iceberg OR "snow landscape" OR "ice field" OR "polar landscape" OR desert OR dune OR badlands) ${LANDSCAPE_QUERY_REGION_EXCLUSIONS}`,
      `caption=(forest OR woodland OR "autumn landscape" OR "national park") ${LANDSCAPE_QUERY_REGION_EXCLUSIONS}`,
      `caption=("sunrise landscape" OR "sunset landscape" OR "sunrise mountain" OR "sunset mountain" OR "sunrise coast" OR "sunset coast") ${LANDSCAPE_QUERY_REGION_EXCLUSIONS}`,
      `caption=("city skyline" OR "city panorama" OR "urban skyline") NOT street NOT traffic NOT crowd NOT event ${LANDSCAPE_QUERY_REGION_EXCLUSIONS}`,
      `caption=(Patagonia OR Yosemite OR Yellowstone OR Banff OR "Torres del Paine" OR "Milford Sound" OR Matterhorn OR "Swiss Alps" OR "Grand Canyon") ${LANDSCAPE_QUERY_REGION_EXCLUSIONS}`,
      `caption=(Iceland OR "Lofoten Islands" OR "Faroe Islands" OR Serengeti OR Sahara OR "Great Barrier Reef" OR "Lake Baikal") ${LANDSCAPE_QUERY_REGION_EXCLUSIONS}`,
      `caption=(Dolomites OR "Lake Bled" OR "Plitvice Lakes" OR "Mount Roraima" OR "Aoraki" OR "Mount Cook" OR "Fiordland" OR "Kilimanjaro" OR "Table Mountain") ${LANDSCAPE_QUERY_REGION_EXCLUSIONS}`,
      `caption=(Zion OR "Bryce Canyon" OR Arches OR "Glacier National Park" OR "Olympic National Park" OR Acadia OR "Denali National Park" OR "Rocky Mountain National Park" OR "Great Smoky Mountains") ${LANDSCAPE_QUERY_REGION_EXCLUSIONS}`,
      `caption=("Scottish Highlands" OR "Lake District" OR "French Alps" OR "Pyrenees" OR "Black Forest" OR "Saxon Switzerland" OR "Lauterbrunnen" OR "Lake Como" OR "Amalfi Coast") ${LANDSCAPE_QUERY_REGION_EXCLUSIONS}`,
      `caption=("Salar de Uyuni" OR Atacama OR "Iguazu Falls" OR "Lençóis Maranhenses" OR Galapagos OR "Blyde River Canyon" OR Drakensberg OR "Fish River Canyon" OR Okavango) ${LANDSCAPE_QUERY_REGION_EXCLUSIONS}`,
      `caption=(Hokkaido OR "Mount Fuji" OR Jeju OR Himalaya OR Nepal OR Bhutan OR Ladakh OR "Lake Tekapo" OR "Milford Track") ${LANDSCAPE_QUERY_REGION_EXCLUSIONS}`,
      `caption=("Joshua Tree" OR "Death Valley" OR "Capitol Reef" OR "Canyonlands" OR "Sequoia National Park" OR "Kings Canyon" OR "Badlands National Park" OR "Mount Rainier") ${LANDSCAPE_QUERY_REGION_EXCLUSIONS}`,
      `caption=("Isle of Skye" OR Glencoe OR Snowdonia OR Connemara OR "Cliffs of Moher" OR Provence OR Tuscany OR "Picos de Europa" OR "Madeira") ${LANDSCAPE_QUERY_REGION_EXCLUSIONS}`,
      `caption=("Paine Massif" OR "Fitz Roy" OR "Perito Moreno" OR Patagonia OR "Chapada Diamantina" OR Pantanal OR "Victoria Falls" OR "Simien Mountains" OR "Ngorongoro") ${LANDSCAPE_QUERY_REGION_EXCLUSIONS}`,
      `caption=("Kerala backwaters" OR "Ha Long Bay" OR Komodo OR Bromo OR Rinjani OR "Khao Sok" OR "Karakoram" OR Pamir OR Tien Shan) ${LANDSCAPE_QUERY_REGION_EXCLUSIONS}`,
      `caption=("Skeleton Coast" OR "Wadi Rum" OR Socotra OR Danakil OR Dallol OR "Rwenzori Mountains" OR "Mount Kenya" OR "Atlas Mountains") ${LANDSCAPE_QUERY_REGION_EXCLUSIONS}`,
      `caption=(Geirangerfjord OR Trolltunga OR Jotunheimen OR Vatnajokull OR Landmannalaugar OR "Lake Louise" OR "Moraine Lake" OR Jasper OR "Grand Teton") ${LANDSCAPE_QUERY_REGION_EXCLUSIONS}`,
      `caption=("White Sands" OR "Monument Valley" OR "Antelope Canyon" OR "Crater Lake" OR "Big Sur" OR "Redwood National Park" OR "Everglades National Park" OR "Lake Powell") ${LANDSCAPE_QUERY_REGION_EXCLUSIONS}`,
      `caption=(Azores OR Madeira OR Tenerife OR Teide OR "Canary Islands" OR Caucasus OR Kazbegi OR Svaneti OR Annapurna OR Langtang OR Hunza) ${LANDSCAPE_QUERY_REGION_EXCLUSIONS}`,
      `caption=(Uluru OR Kakadu OR "Blue Mountains" OR "Great Ocean Road" OR Tasmania OR "Cradle Mountain" OR Tongariro OR "Abel Tasman" OR "Doubtful Sound") ${LANDSCAPE_QUERY_REGION_EXCLUSIONS}`,
      `caption=(Shiretoko OR Yakushima OR Kamikochi OR "Aso Kuju" OR "Kerinci Seblat" OR Raja Ampat OR Palawan OR Batanes OR "Phong Nha") ${LANDSCAPE_QUERY_REGION_EXCLUSIONS}`,
      `caption=("Ansel Adams" OR "Galen Rowell" OR "Michael Kenna" OR "David Muench" OR "Art Wolfe" OR "Frans Lanting") ${LANDSCAPE_QUERY_REGION_EXCLUSIONS}`,
      `caption=("Sebastiao Salgado" OR "Sebastião Salgado" OR "Peter Lik" OR "Marc Adamus" OR "Max Rive" OR "Chris Burkard" OR "Thomas Heaton") ${LANDSCAPE_QUERY_REGION_EXCLUSIONS}`,
    ],
    metadataRequiredAny: [
      'landscape', 'scenery', 'scenic', 'seascape', 'coastal landscape', 'panorama', 'mountain', 'mountain range', 'glacier', 'fjord', 'canyon', 'valley', 'river valley', 'volcano', 'desert', 'dune', 'beach', 'coastline', 'waterfall', 'sunset', 'sunrise', 'lake', 'river', 'forest', 'woodland', 'iceberg', 'ice field', 'polar landscape', 'national park', 'city skyline', 'city panorama', 'urban skyline',
      'Patagonia', 'Yosemite', 'Yellowstone', 'Banff', 'Torres del Paine', 'Milford Sound', 'Matterhorn', 'Swiss Alps', 'Grand Canyon', 'Iceland', 'Lofoten Islands', 'Faroe Islands', 'Serengeti', 'Sahara', 'Great Barrier Reef', 'Lake Baikal', 'Dolomites', 'Lake Bled', 'Plitvice Lakes', 'Mount Roraima', 'Aoraki', 'Mount Cook', 'Fiordland', 'Kilimanjaro', 'Table Mountain',
      'Zion', 'Bryce Canyon', 'Arches', 'Glacier National Park', 'Olympic National Park', 'Acadia', 'Denali National Park', 'Rocky Mountain National Park', 'Great Smoky Mountains', 'Scottish Highlands', 'Lake District', 'French Alps', 'Pyrenees', 'Black Forest', 'Saxon Switzerland', 'Lauterbrunnen', 'Lake Como', 'Amalfi Coast', 'Salar de Uyuni', 'Atacama', 'Iguazu Falls', 'Lençóis Maranhenses', 'Galapagos', 'Blyde River Canyon', 'Drakensberg', 'Fish River Canyon', 'Okavango',
      'Hokkaido', 'Mount Fuji', 'Jeju', 'Himalaya', 'Nepal', 'Bhutan', 'Ladakh', 'Lake Tekapo', 'Milford Track', 'Joshua Tree', 'Death Valley', 'Capitol Reef', 'Canyonlands', 'Sequoia National Park', 'Kings Canyon', 'Badlands National Park', 'Mount Rainier', 'Isle of Skye', 'Glencoe', 'Snowdonia', 'Connemara', 'Cliffs of Moher', 'Provence', 'Tuscany', 'Picos de Europa', 'Madeira',
      'Paine Massif', 'Fitz Roy', 'Perito Moreno', 'Chapada Diamantina', 'Pantanal', 'Victoria Falls', 'Simien Mountains', 'Ngorongoro', 'Kerala backwaters', 'Ha Long Bay', 'Komodo', 'Bromo', 'Rinjani', 'Khao Sok', 'Karakoram', 'Pamir', 'Tien Shan', 'Skeleton Coast', 'Wadi Rum', 'Socotra', 'Danakil', 'Dallol', 'Rwenzori Mountains', 'Mount Kenya', 'Atlas Mountains',
      'Geirangerfjord', 'Trolltunga', 'Jotunheimen', 'Vatnajokull', 'Landmannalaugar', 'Lake Louise', 'Moraine Lake', 'Jasper', 'Grand Teton', 'White Sands', 'Monument Valley', 'Antelope Canyon', 'Crater Lake', 'Big Sur', 'Redwood National Park', 'Everglades National Park', 'Lake Powell', 'Azores', 'Tenerife', 'Teide', 'Canary Islands', 'Caucasus', 'Kazbegi', 'Svaneti', 'Annapurna', 'Langtang', 'Hunza',
      'Uluru', 'Kakadu', 'Blue Mountains', 'Great Ocean Road', 'Tasmania', 'Cradle Mountain', 'Tongariro', 'Abel Tasman', 'Doubtful Sound', 'Shiretoko', 'Yakushima', 'Kamikochi', 'Aso Kuju', 'Kerinci Seblat', 'Raja Ampat', 'Palawan', 'Batanes', 'Phong Nha',
      'Ansel Adams', 'Galen Rowell', 'Michael Kenna', 'David Muench', 'Art Wolfe', 'Frans Lanting', 'Sebastiao Salgado', 'Sebastião Salgado', 'Peter Lik', 'Marc Adamus', 'Max Rive', 'Chris Burkard', 'Thomas Heaton',
    ],
    metadataExclusions: [
      ...LANDSCAPE_LOCATION_EXCLUSIONS,
      'flower',
      'flowers',
      'garden',
      'close-up',
      'portrait',
      'harbour', 'harbor', 'port', 'church', 'chapel', 'cathedral', 'interior', 'indoors', 'president', 'politician', 'anniversary', 'attack', 'terror', 'damaged', 'storm damage', 'fallen tree',
      'wildfire',
      'fire',
      'traffic',
      'road',
      'highway',
      'daily life',
      'cost of living',
      'tourist',
      'marathon',
      'trail race',
      'race',
      'visitor center',
      'tourism campaign',
      'exhibition',
      'gallery',
      'interview',
      'memorial',
      'family',
      'girl',
      'choir',
      'worker',
      'workers',
      'photographic print',
      'expo',
      'museum',
      'on display',
      'photographers',
      'movie',
      'film',
      'cinema',
      'premiere',
      'actor',
      'actress',
      'red carpet',
      'screening',
      'film festival',
      'movie poster',
      'film poster',
      'hiker',
      'hikers',
      'climber',
      'climbers',
      'trekker',
      'trekkers',
      'skiers',
      'ski event',
      'skiing',
      'snowboarding',
      'slalom',
      'freeride',
      'world tour',
      'sporting event',
      'sports event',
      'baseball',
      'pitcher',
      'players',
      'stadium',
      'tournament',
      'tennis',
      'nascar',
      'rally',
      'race car',
      'race track',
      'podium',
      'award',
      'musician',
      'instrument',
      'event stage',
      'sponsor',
      'sponsors',
      'logo',
      'logos',
      'embedded text',
      'golf',
      'championship',
      'tee',
      'festival',
      'crowd',
      'people',
      'woman',
      'women',
      'man',
      'men',
      'child',
      'children',
      'residents',
      'protest',
      'parade',
      'migrant',
      'migrants',
      'migration',
      'rescue',
      'ritual',
      'bathing',
      'riverbank',
      'flood',
      'animal',
      'wildlife',
      'typhoon',
      'storm',
      'war',
      'conflict',
      'military',
      'debris',
      'temporary closure',
      'water is rapidly released',
      'vehicle',
      'car',
      'bus',
      'train',
      'marina',
      'dock',
      'docked',
      'shipyard',
      'yacht',
      'yachts',
      'ferry',
      'ferries',
      'passenger launch',
      'patrol vessel',
      'gondola',
      'cable car',
      'transport cables',
      'overhead wires',
      'power lines',
      'utility wires',
      'radio telescope',
      'telescope antennas',
      'satellite image',
      'satellite view',
      'aerial image',
      'boats',
      'single building',
      'solar eclipse',
      'partial eclipse',
      'perseid meteor',
      'astronomy event',
      'campsite',
      'camping',
      'football',
      'soccer',
      'pre-season friendly',
      'fish market',
      'underwater',
      'fish',
      'whale',
      'seagull',
      'turtle',
      'manta ray',
      'lionfish',
      'pipefish',
      'coral reef',
      'school of fish',
      'flamingo',
      'cruise ship',
      'zoo',
      'lynx',
      'elephant',
      'bird',
      'birds',
      'wind turbine',
      'wind turbines',
      'energy facility',
      'power plant',
      'landslide',
      'hurricane',
      'severe weather',
      'disaster',
      'lava eruption',
      'volcanic eruption',
      'air show',
      'aircraft formation',
      'handout picture',
      'file photo',
      'kefm',
      ...LANDSCAPE_METADATA_REGION_EXCLUSIONS,
    ],
  },
  {
    key: 'movie-poster',
    selectionName: 'AutoFlow_电影海报',
    criteria: 'caption="movie poster" NOT political NOT election NOT campaign NOT memorial NOT concert NOT stage NOT interview',
    queryVariants: [
      'caption="movie poster" NOT political NOT election NOT campaign NOT memorial NOT concert NOT stage NOT interview',
      'caption="film poster" NOT political NOT election NOT campaign NOT memorial NOT concert NOT stage NOT interview',
      'caption=(movie AND poster) NOT political NOT election NOT campaign NOT memorial NOT concert NOT stage NOT interview',
      'caption=(film AND poster) NOT political NOT election NOT campaign NOT memorial NOT concert NOT stage NOT interview',
      'caption=poster NOT political NOT election NOT campaign NOT memorial NOT concert NOT stage NOT interview',
    ],
    metadataRequiredAny: ['movie poster', 'film poster', 'poster', 'promotional poster', 'theatrical poster'],
    metadataExclusions: ['political', 'election', 'campaign', 'memorial', 'tribute', 'concert', 'stage', 'red carpet', 'interview', 'actor', 'guests', 'attends', 'audience', 'passes by', 'screening', 'forum', 'awards', 'festival', 'cinema', 'director holds'],
  },
  {
    key: 'celestial-body-wallpaper',
    selectionName: 'AutoFlow_宇宙恒星球体',
    maxPerTitle: 1,
    criteria: 'caption=(planet OR moon OR lunar OR "solar flare" OR galaxy OR nebula OR comet OR asteroid OR meteorite OR "black hole" OR supernova OR quasar OR "star field" OR "star cluster" OR "starry sky") NOT aircraft NOT airplane NOT airport NOT stadium NOT festival NOT telescope NOT sunrise NOT sunset',
    queryVariants: [
      'caption=(planet OR Earth OR moon OR lunar) NOT aircraft NOT airplane NOT airport NOT stadium NOT festival NOT telescope',
      'caption=("solar flare" OR "solar corona" OR "solar prominence") NOT aircraft NOT airplane NOT airport NOT stadium NOT festival NOT telescope NOT sunrise',
      'caption=("planet Mercury" OR "planet Mars" OR "planet Jupiter" OR "planet Saturn" OR "planet Venus" OR "planet Neptune" OR "planet Uranus" OR "solar system") NOT aircraft NOT airplane NOT airport NOT stadium NOT festival NOT telescope',
      'caption=(galaxy OR nebula OR comet OR asteroid OR meteorite OR "black hole" OR "star field" OR "star cluster" OR "starry sky") NOT aircraft NOT airplane NOT airport NOT stadium NOT festival NOT telescope NOT "gravitational waves"',
      'caption=("Orion Nebula" OR "Carina Nebula" OR "Crab Nebula" OR "Tarantula Nebula" OR "Vela supernova remnant" OR "Cygnus Loop" OR "Magellanic Cloud") NOT museum NOT exhibition NOT model NOT poster',
      'caption=("Horsehead Nebula" OR "Flame Nebula" OR "Pillars of Creation" OR "Eagle Nebula" OR "Helix Nebula" OR "Ring Nebula" OR "Rosette Nebula" OR "Lagoon Nebula" OR "Eta Carinae" OR "Centaurus A") NOT museum NOT exhibition NOT model NOT poster',
      'caption=("James Webb Space Telescope" OR "Hubble Space Telescope") NOT museum NOT gallery NOT model',
      'caption=(supernova OR quasar OR "spiral galaxy" OR "star forming region") NOT pride',
      'caption=("black hole" OR "event horizon" OR "accretion disk") NOT spaceship',
      'caption=(("artist impression" OR "artist\'s impression" OR "digital illustration") AND (exoplanet OR galaxy OR nebula OR "black hole")) NOT infographic NOT diagram NOT poster NOT exhibition',
    ],
    metadataRequiredAny: ['planet', 'earth', 'moon', 'lunar', 'solar flare', 'solar corona', 'solar prominence', 'solar system', 'galaxy', 'nebula', 'comet', 'asteroid', 'meteorite', 'black hole', 'event horizon', 'accretion disk', 'supernova', 'quasar', 'spiral galaxy', 'star forming region', 'orion nebula', 'carina nebula', 'crab nebula', 'tarantula nebula', 'vela supernova remnant', 'cygnus loop', 'magellanic cloud', 'horsehead nebula', 'flame nebula', 'pillars of creation', 'eagle nebula', 'helix nebula', 'ring nebula', 'rosette nebula', 'lagoon nebula', 'eta carinae', 'centaurus a', 'james webb', 'hubble', 'star field', 'star cluster', 'starry sky', 'star trails', 'milky way', 'exoplanet', 'artist impression', 'artist\'s impression', 'digital illustration'],
    metadataExclusions: ['football', 'los angeles galaxy', 'sports', 'celebrity', 'concert', 'stage', 'aircraft', 'airplane', 'airport', 'stadium', 'mural', 'festival', 'star wars', 'cosplay', 'costume', 'astronomy session', 'astronomy books', 'science outreach', 'city', 'street', 'flood', 'rain', 'fireworks', 'spectators', 'port', 'salt lake', 'milky white', 'drone', 'movie', 'light show', 'building', 'screen', 'poster', 'book', 'stork', 'bird', 'garden', 'sunrise', 'sunset', 'solar term', 'lunar calendar', 'basketball', 'players', 'court', 'team', 'league', 'match', 'spacetime', 'gravitational waves', 'glasses', 'eyewear', 'hands', 'packaged', 'cattle', 'forest', 'woodland', 'solar panel', 'solar panels', 'confectioner', 'cake', 'drawing', 'chalk', 'infographic', 'diagram', 'farming', 'drought', 'migration', 'museum', 'gallery', 'model', 'display', 'exhibition', 'pride', 'parade', 'flag', 'launch', 'rocket', 'satellite dish'],
  },
]);

/** 仅返回一个已知类别，供高成本视觉复核做小批量迭代而不触碰其他收藏夹。 */
export function selectCategoryProfiles(category, profiles = CATEGORY_PROFILES) {
  if (!category) return profiles;
  const profile = profiles.find(({ key }) => key === category);
  if (!profile) throw new Error(`unknown photo category: ${category}`);
  return [profile];
}

const PHOTO_QUERY = `query getPhotos($input: PhotoQueryInput) {
  photos: photos(input: $input) {
    hasMore
    cursor(direction: next)
    docs: photos {
      id: uno
      guid title caption
      afpEntityKeyword { keyword }
      partner { gcp { provider_code } }
      mockup: medias(query:{role:Mockup}) { href type width height role }
    }
  }
}`;

export const DEFAULT_MAX_PAGES = 3;
const MAX_MAX_PAGES = 10;

function queryHash(criteria) {
  return createHash('sha256').update(String(criteria)).digest('hex').slice(0, 16);
}

function normalizeSearchSource(source, profile, index) {
  if (typeof source === 'string') return { criteria: source, sourceId: undefined, sourceType: undefined, sourceIndex: index };
  return {
    ...source,
    criteria: source?.criteria ?? profile?.criteria,
    sourceId: source?.id ?? `${profile?.key ?? 'photo'}-source-${index + 1}`,
    sourceType: source?.sourceType ?? 'destination',
    sourceIndex: index,
  };
}

export function getSearchSources(profile) {
  const sources = Array.isArray(profile?.sources) && profile.sources.length
    ? profile.sources
    : (profile?.queryVariants ?? [profile?.criteria]);
  return sources.map((source, index) => normalizeSearchSource(source, profile, index));
}

function sourceQuery(source, fieldMode) {
  const criteria = source.criteria;
  if (fieldMode === 'creator') return `creator="${source.creator}" AND ${criteria}`;
  if (fieldMode === 'country') return `country=${source.countryCode} AND ${criteria}`;
  if (fieldMode === 'city') return `city="${source.city}" AND ${criteria}`;
  if (fieldMode === 'all_keywords') {
    const evidence = (source.positiveEvidence ?? []).join(' OR ');
    return `all_keywords=(${evidence || criteria}) ${LANDSCAPE_QUERY_REGION_EXCLUSIONS}`;
  }
  return criteria;
}

/** 为每个结构化来源生成字段优先、无结果/字段错误时可回退的查询计划。 */
export function buildSearchQueryPlans(profile) {
  return getSearchSources(profile).flatMap((source) => {
    const modes = [];
    const creatorAnchored = source.sourceType === 'photographer' && Boolean(source.creator);
    if (source.mode !== 'caption-fallback') {
      if (source.creator) modes.push('creator');
      if (source.countryCode) modes.push('country');
      if (source.city) modes.push('city');
      if (!creatorAnchored && (source.positiveEvidence ?? []).length) modes.push('all_keywords');
    }
    // 摄影师字段失效时禁止退化为宽泛 caption，避免把同名体育/事件图集灌入风景候选。
    if (!creatorAnchored) modes.push('caption-fallback');
    return modes.map((fieldMode, rank) => {
      const criteria = sourceQuery(source, fieldMode);
      return {
        ...source,
        fieldMode,
        fallbackRank: rank,
        fallbackGroup: source.sourceId,
        criteria,
        query: criteria,
        queryHash: queryHash(criteria),
      };
    });
  });
}

function sourceMetadata(sourcePlan) {
  if (!sourcePlan?.sourceId) return undefined;
  return {
    sourceId: sourcePlan.sourceId,
    sourceType: sourcePlan.sourceType,
    fieldMode: sourcePlan.fieldMode,
    countryCode: sourcePlan.countryCode,
    city: sourcePlan.city,
    creator: sourcePlan.creator,
    query: sourcePlan.query,
    queryHash: sourcePlan.queryHash,
    priority: sourcePlan.priority,
  };
}

/** 构造 AFP 图片查询；mockup 仅用于本次响应，绝不写进候选清单。 */
export function buildPhotoSearchRequest(profile, maxRows = 60, criteria = profile?.criteria, cursor = null) {
  if (!criteria) throw new Error('profile criteria is required');
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 120) throw new Error('maxRows must be between 1 and 120');
  const input = {
    dateRange: { targetField: 'contentCreated' },
    sort: [
      { sortOrder: 'desc', sortField: 'contentCreated' },
      { sortOrder: 'desc', sortField: 'timestamp' },
    ],
    query: criteria,
    lang: 'en',
    maxRows,
  };
  if (cursor) input.cursor = cursor;
  return {
    operationName: 'getPhotos',
    variables: {
      input,
    },
    query: PHOTO_QUERY,
  };
}

function text(value) {
  return Array.isArray(value) ? value.filter(Boolean).join(' ') : String(value ?? '');
}

function entityKeywords(value) {
  const raw = Array.isArray(value) ? value : [];
  return raw.map((entry) => String(entry?.keyword ?? entry ?? '').trim()).filter(Boolean);
}

/**
 * 归一化 FAR 图片为可落盘候选；仅保留后续复查所需的身份和文本元数据。
 * 特意忽略 mockup/medias，避免把临时签名资源写入运行时文件。
 */
export function mapPhotoCandidate(photo, profile, originalIndex, sourcePlan = null) {
  const id = String(photo?.id ?? photo?.uno ?? '').trim();
  const guid = String(photo?.guid ?? '').trim();
  if (!id || !guid) throw new Error('photo id and guid are required');
  const metadata = sourceMetadata(sourcePlan);
  return {
    id,
    guid,
    title: text(photo?.title),
    caption: text(photo?.caption),
    entityKeywords: entityKeywords(photo?.afpEntityKeyword),
    provider: String(photo?.partner?.gcp?.provider_code ?? '').trim(),
    originalIndex,
    category: profile.key,
    metadataCandidate: true,
    ...(metadata ? { sourceMetadata: metadata } : {}),
  };
}

function normalizeForComparison(value) {
  return text(value)
    .normalize('NFKC')
    .toLocaleLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function candidateText(candidate) {
  return normalizeForComparison([candidate.title, candidate.caption, candidate.entityKeywords]);
}

function titleKey(candidate) {
  return normalizeForComparison(candidate.title).replace(/[^\p{L}\p{N}]+/gu, ' ').trim() || candidate.id;
}

/** 将历史候选标题归一化为跨阶段排重键，防止同一图集在多个补量阶段重复入选。 */
export function candidateTitleKey(candidate) {
  return titleKey(candidate);
}

function containsTerm(source, term) {
  const normalizedTerm = normalizeForComparison(term);
  return Boolean(normalizedTerm) && (` ${source} `).includes(` ${normalizedTerm} `);
}

/**
 * 只按已知文字语境预筛候选，降低视觉模型面对明显误召回的比例。
 * 此函数不根据元数据宣称图片属于目标类别；通过的项目仍然只是 metadataCandidate。
 */
export function assessMetadataCandidate(candidate, profile) {
  const source = candidateText(candidate);
  const matches = (profile?.metadataExclusions ?? []).filter((term) => containsTerm(source, term));
  const hasRequiredEvidence = !(profile?.metadataRequiredAny?.length)
    || profile.metadataRequiredAny.some((term) => containsTerm(source, term));
  const reasons = matches.map((term) => `metadata exclusion: ${term}`);
  if (!hasRequiredEvidence) reasons.push('metadata evidence: no category-specific positive term');
  return {
    keep: reasons.length === 0,
    reasons,
  };
}

/**
 * 合并多个精确查询的结果，保留每个原始文档 ID 一次，并限制同标题图集占满候选池。
 * 被文本规则剔除的候选单独记录，确保调试时仍能审计召回与预筛差异。
 */
export function curatePhotoCandidates(rawCandidates, profile, maxRows = 60, maxPerTitle = 3) {
  const accepted = [];
  const rejectedMetadataCandidates = [];
  const duplicateExcludedCandidates = [];
  const duplicateExclusionReasons = new Set();
  const seenIds = new Set();
  const titleCounts = new Map();
  const titleLimit = profileTitleLimit(profile, maxPerTitle);
  for (const candidate of rawCandidates ?? []) {
    if (seenIds.has(candidate.id)) {
      duplicateExcludedCandidates.push({ ...candidate, duplicateExclusion: 'repeated-photo-id-across-query-variants' });
      duplicateExclusionReasons.add('repeated-photo-id-across-query-variants');
      continue;
    }
    seenIds.add(candidate.id);
    const assessment = assessMetadataCandidate(candidate, profile);
    if (!assessment.keep) {
      rejectedMetadataCandidates.push({ ...candidate, metadataPreFilter: assessment });
      continue;
    }
    const key = titleKey(candidate);
    const currentCount = titleCounts.get(key) ?? 0;
    if (currentCount >= titleLimit) {
      duplicateExcludedCandidates.push({
        ...candidate,
        duplicateExclusion: 'repeated-title-cluster',
      });
      duplicateExclusionReasons.add('repeated-title-cluster');
      continue;
    }
    titleCounts.set(key, currentCount + 1);
    accepted.push(candidate);
    if (accepted.length >= maxRows) break;
  }
  return {
    candidates: accepted,
    rejectedMetadataCandidates,
    duplicateExcludedCandidates,
    duplicateExclusionCount: duplicateExcludedCandidates.length,
    duplicateExclusionReasons: [...duplicateExclusionReasons],
  };
}

function landscapeBudgetKey(candidate) {
  const sourceType = candidate?.sourceMetadata?.sourceType;
  return LANDSCAPE_DISCOVERY_BUDGET.find(({ sourceTypes }) => sourceTypes.includes(sourceType))?.key ?? 'natural';
}

function landscapeBudgetTargets(batchSize) {
  const raw = LANDSCAPE_DISCOVERY_BUDGET.map(({ key, share }) => ({
    key,
    exact: batchSize * share,
    count: Math.floor(batchSize * share),
  }));
  let remainder = batchSize - raw.reduce((sum, item) => sum + item.count, 0);
  raw.sort((left, right) => (right.exact - right.count) - (left.exact - left.count));
  for (let index = 0; index < raw.length && remainder > 0; index += 1, remainder -= 1) raw[index].count += 1;
  return Object.fromEntries(raw.map(({ key, count }) => [key, count]));
}

/** 在已召回候选中优先满足 70/20/8/2 预算；缺口由其他来源稳定补齐。 */
export function allocateLandscapeDiscoveryBatch(candidates, batchSize) {
  if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('batchSize must be a positive integer');
  const targets = landscapeBudgetTargets(batchSize);
  const selected = [];
  const selectedIds = new Set();
  for (const { key } of LANDSCAPE_DISCOVERY_BUDGET) {
    for (const candidate of candidates ?? []) {
      if (selected.length >= batchSize || selectedIds.has(candidate?.id) || landscapeBudgetKey(candidate) !== key) continue;
      const used = selected.reduce((count, item) => count + (landscapeBudgetKey(item) === key ? 1 : 0), 0);
      if (used >= targets[key]) break;
      selected.push(candidate);
      selectedIds.add(candidate.id);
    }
  }
  for (const candidate of candidates ?? []) {
    if (selected.length >= batchSize) break;
    if (selectedIds.has(candidate?.id)) continue;
    selected.push(candidate);
    selectedIds.add(candidate.id);
  }
  const selectedCounts = Object.fromEntries(LANDSCAPE_DISCOVERY_BUDGET.map(({ key }) => [key, 0]));
  for (const candidate of selected) selectedCounts[landscapeBudgetKey(candidate)] += 1;
  return {
    candidates: selected,
    deferred: (candidates ?? []).filter((candidate) => !selectedIds.has(candidate?.id)),
    targets,
    selectedCounts,
  };
}

function profileTitleLimit(profile, fallback) {
  const value = Number(profile?.maxPerTitle);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

const SEARCH_STATE_VERSION = 2;

function persistedCategoryState(searchState, category) {
  const categoryState = searchState?.categories?.[category];
  if (!categoryState || typeof categoryState !== 'object') return {};
  return categoryState;
}

function persistedVariantState(searchState, category, queryHashValue, criteria) {
  const variants = persistedCategoryState(searchState, category).variants;
  if (!Array.isArray(variants)) return null;
  return variants.find((variant) => (
    variant?.queryHash === queryHashValue && variant?.criteria === criteria
  )) ?? null;
}

/**
 * 恢复跨进程 checkpoint 中尚未送审的候选队列。
 *
 * 翻页会一次取得整页，但一批只消费其中一部分；如果只保存 cursor 和
 * knownIds，下一进程会跳过这些已见 ID，造成“翻过但丢失”的候选。队列是
 * 本地元数据快照，不含 mockup、签名 URL 或图片字节。
 */
function restoreQueuedCandidates(values, category) {
  if (!Array.isArray(values)) return [];
  return values
    .filter((candidate) => candidate && String(candidate.id ?? '').trim() && String(candidate.guid ?? '').trim())
    .map((candidate) => ({
      ...candidate,
      id: String(candidate.id).trim(),
      guid: String(candidate.guid).trim(),
      category: String(candidate.category ?? category),
      title: String(candidate.title ?? ''),
      caption: String(candidate.caption ?? ''),
      entityKeywords: Array.isArray(candidate.entityKeywords) ? candidate.entityKeywords.map(String) : [],
      ...(candidate.sourceMetadata && typeof candidate.sourceMetadata === 'object'
        ? { sourceMetadata: { ...candidate.sourceMetadata } }
        : {}),
    }));
}

function restoreVariantState(variant, persisted) {
  if (!persisted) return variant;
  const savedSeenCursors = Array.isArray(persisted.seenCursors)
    ? persisted.seenCursors.map((cursor) => String(cursor ?? '').trim()).filter(Boolean)
    : [];
  const savedExhausted = persisted.exhausted === true;
  const resumable = persisted.stoppedBecause === 'max-pages-reached' && persisted.cursor;
  return {
    ...variant,
    cursor: String(persisted.cursor ?? '').trim() || null,
    pagesFetched: Number.isInteger(persisted.pagesFetched) && persisted.pagesFetched >= 0 ? persisted.pagesFetched : 0,
    pagesFetchedInRun: 0,
    rawRecallCount: Number.isInteger(persisted.rawRecallCount) && persisted.rawRecallCount >= 0 ? persisted.rawRecallCount : 0,
    metadataRejectedCount: Number.isInteger(persisted.metadataRejectedCount) && persisted.metadataRejectedCount >= 0 ? persisted.metadataRejectedCount : 0,
    duplicateExcludedCount: Number.isInteger(persisted.duplicateExcludedCount) && persisted.duplicateExcludedCount >= 0 ? persisted.duplicateExcludedCount : 0,
    duplicateExclusionReasons: new Set(Array.isArray(persisted.duplicateExclusionReasons) ? persisted.duplicateExclusionReasons : []),
    exhausted: resumable ? false : savedExhausted,
    stoppedBecause: resumable ? 'resumed-from-checkpoint' : String(persisted.stoppedBecause ?? 'not-started'),
    seenCursors: new Set(savedSeenCursors),
    fallbackSucceeded: persisted.fallbackSucceeded === true,
    fallbackSkipped: persisted.fallbackSkipped === true,
    fallbackError: String(persisted.fallbackError ?? '').trim() || null,
  };
}

function addVariantCounter(state, candidate, field, reason) {
  const queryHashValue = candidate?.sourceMetadata?.queryHash;
  const variant = queryHashValue
    ? state.variants.find((item) => item.queryHash === queryHashValue)
    : null;
  if (!variant) return;
  variant[field] += 1;
  if (reason) variant.duplicateExclusionReasons.add(reason);
}

function recordDuplicateExclusion(state, candidate, reason, stats) {
  const record = { ...candidate, duplicateExclusion: reason };
  state.duplicateExcludedCandidates.push(record);
  state.duplicateExclusionCount += 1;
  addVariantCounter(state, candidate, 'duplicateExcludedCount', reason);
  stats.duplicateExclusionCount += 1;
  stats.duplicateExclusionReasons.add(reason);
  stats.duplicateExcludedCandidates.push(record);
}

function snapshotSearchState(stateByCategory, preservedState = null) {
  return {
    version: SEARCH_STATE_VERSION,
    updatedAt: new Date().toISOString(),
    categories: {
      ...(preservedState?.categories && typeof preservedState.categories === 'object' ? preservedState.categories : {}),
      ...Object.fromEntries(
        [...stateByCategory.entries()].map(([category, state]) => [category, {
          rawCandidateCount: state.rawCandidateCount,
          metadataRejectedCount: state.metadataRejectedCount,
          duplicateExclusionCount: state.duplicateExclusionCount,
          knownIds: [...state.knownIds],
          titleKeys: [...state.historicalTitleKeys],
          pending: state.pending,
          deferred: state.deferred,
          variants: state.variants.map((variant) => ({
            queryHash: variant.queryHash,
            criteria: variant.criteria,
            cursor: variant.cursor,
            pagesFetched: variant.pagesFetched,
            rawRecallCount: variant.rawRecallCount,
            metadataRejectedCount: variant.metadataRejectedCount,
            duplicateExcludedCount: variant.duplicateExcludedCount,
            duplicateExclusionReasons: [...variant.duplicateExclusionReasons],
            exhausted: variant.exhausted,
            stoppedBecause: variant.stoppedBecause,
            seenCursors: [...variant.seenCursors],
            fallbackSucceeded: variant.fallbackSucceeded,
            fallbackSkipped: variant.fallbackSkipped,
            ...(variant.fallbackError ? { fallbackError: variant.fallbackError } : {}),
          })),
        }]),
      ),
    },
  };
}

/**
 * 创建可持续翻页的检索会话。每个 query variant 独立保存 FAR cursor，
 * 视觉复核淘汰一批后可以从上次 cursor 继续取下一批，而不是重复首页。
 */
export function createPhotoSearchSession({
  client = null,
  profiles = CATEGORY_PROFILES,
  pageSize = 60,
  maxPages = 10,
  searchConcurrency = 3,
  maxSearchRequests = 1000,
  signal,
  maxPerTitle = 3,
  readRetries = 2,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  searchState = null,
  onStateChange = async () => {},
} = {}) {
  if (!Number.isInteger(pageSize) || pageSize < 1 || pageSize > 120) throw new Error('pageSize must be between 1 and 120');
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > 10) throw new Error('maxPages must be between 1 and 10');
  if (!Number.isSafeInteger(searchConcurrency) || searchConcurrency < 1 || searchConcurrency > 16) throw new Error('Invalid searchConcurrency');
  if (!Number.isSafeInteger(maxSearchRequests) || maxSearchRequests < 1) throw new Error('Invalid maxSearchRequests');
  if (!Number.isInteger(readRetries) || readRetries < 0) throw new Error('readRetries must be a non-negative integer');
  if (typeof sleep !== 'function') throw new Error('sleep must be a function');
  if (typeof onStateChange !== 'function') throw new Error('onStateChange must be a function');
  // 调用方提供的 client 独占传输重试；搜索策略不再重复包装其预算。
  client ??= createAfpApiClient({ retries: readRetries, sleep });
  const stateByCategory = new Map((profiles ?? []).map((profile) => [profile.key, {
    profile,
    variants: buildSearchQueryPlans(profile).map((plan, queryIndex) => restoreVariantState({
      ...plan,
      queryIndex,
      cursor: null,
      pagesFetched: 0,
      pagesFetchedInRun: 0,
      rawRecallCount: 0,
      metadataRejectedCount: 0,
      duplicateExcludedCount: 0,
      duplicateExclusionReasons: new Set(),
      exhausted: false,
      stoppedBecause: 'not-started',
      seenCursors: new Set(),
      fallbackSucceeded: false,
      fallbackSkipped: false,
      fallbackError: null,
    }, persistedVariantState(searchState, profile.key, plan.queryHash, plan.criteria))),
    pending: restoreQueuedCandidates(persistedCategoryState(searchState, profile.key).pending, profile.key),
    deferred: restoreQueuedCandidates(persistedCategoryState(searchState, profile.key).deferred, profile.key),
    knownIds: new Set((persistedCategoryState(searchState, profile.key).knownIds ?? []).map((id) => String(id ?? '').trim()).filter(Boolean)),
    historicalTitleKeys: new Set((persistedCategoryState(searchState, profile.key).titleKeys ?? []).map((key) => String(key ?? '').trim()).filter(Boolean)),
    titleCounts: new Map(),
    rejectedMetadataCandidates: [],
    duplicateExcludedCandidates: [],
    rawCandidateCount: 0,
    metadataRejectedCount: 0,
    duplicateExclusionCount: 0,
    requestsThisStart: 0,
  }]));

  for (const [category, state] of stateByCategory) {
    const persisted = persistedCategoryState(searchState, category);
    if (Number.isInteger(persisted.rawCandidateCount) && persisted.rawCandidateCount >= 0) state.rawCandidateCount = persisted.rawCandidateCount;
    if (Number.isInteger(persisted.metadataRejectedCount) && persisted.metadataRejectedCount >= 0) state.metadataRejectedCount = persisted.metadataRejectedCount;
    if (Number.isInteger(persisted.duplicateExclusionCount) && persisted.duplicateExclusionCount >= 0) state.duplicateExclusionCount = persisted.duplicateExclusionCount;
  }

  async function fetchVariantPage(state, variant) {
    if (variant.exhausted) return [];
    const pageIndex = variant.pagesFetched;
    signal?.throwIfAborted();
    state.requestsThisStart++;
    const response = await client.searchPhotos(buildPhotoSearchRequest(
      state.profile, pageSize, variant.criteria, variant.cursor,
    ));
    variant.pagesFetched += 1;
    variant.pagesFetchedInRun += 1;
    const docs = Array.isArray(response?.docs) ? response.docs : [];
    state.rawCandidateCount += docs.length;
    variant.rawRecallCount += docs.length;
    const candidates = docs.map((photo, index) => mapPhotoCandidate(
      photo,
      state.profile,
      variant.queryIndex * pageSize * 10 + pageIndex * pageSize + index,
      variant,
    ));
    const nextCursor = String(response?.cursor ?? '').trim();
    if (!response?.hasMore) {
      variant.exhausted = true;
      variant.stoppedBecause = 'no-more-results';
    } else if (!nextCursor) {
      variant.exhausted = true;
      variant.stoppedBecause = 'missing-next-cursor';
    } else if (nextCursor === variant.cursor || variant.seenCursors.has(nextCursor)) {
      variant.exhausted = true;
      variant.stoppedBecause = 'repeated-cursor';
    } else {
      variant.seenCursors.add(nextCursor);
      variant.cursor = nextCursor;
      if (variant.pagesFetchedInRun >= maxPages) {
        // max-pages-reached 只是本轮暂停；保留 cursor，下一批/进程必须继续翻页。
        variant.exhausted = false;
        variant.stoppedBecause = 'max-pages-reached';
      } else {
        variant.stoppedBecause = 'has-more';
      }
    }
    return candidates;
  }

  function consumePending(state, batchSize, excludedIds, excludedTitleKeys, candidates, rejectedMetadataCandidates, stats) {
    const titleLimit = profileTitleLimit(state.profile, maxPerTitle);
    while ((state.deferred.length || state.pending.length) && candidates.length < batchSize) {
      const fromDeferred = state.deferred.length > 0;
      const candidate = fromDeferred ? state.deferred.shift() : state.pending.shift();
      if (excludedIds.has(candidate.id)) {
        stats.globallyExcludedCount += 1;
        recordDuplicateExclusion(state, candidate, 'reserved-or-historical-id', stats);
        continue;
      }
      if (fromDeferred) {
        const deferredTitle = titleKey(candidate);
        if (excludedTitleKeys.has(deferredTitle)) {
          const rejected = {
            ...candidate,
            metadataPreFilter: { keep: false, reasons: ['metadata diversity limit: title already reviewed in an earlier stage'] },
          };
          recordDuplicateExclusion(state, rejected, 'historical-title-cluster', stats);
          continue;
        }
        const currentDeferredTitleCount = state.titleCounts.get(deferredTitle) ?? 0;
        if (currentDeferredTitleCount >= titleLimit) {
          const rejected = {
            ...candidate,
            metadataPreFilter: { keep: false, reasons: ['metadata diversity limit: repeated title cluster'] },
          };
          recordDuplicateExclusion(state, rejected, 'repeated-title-cluster', stats);
          continue;
        }
        state.titleCounts.set(deferredTitle, currentDeferredTitleCount + 1);
        candidates.push(candidate);
        continue;
      }
      const assessment = assessMetadataCandidate(candidate, state.profile);
      if (!assessment.keep) {
        const rejected = { ...candidate, metadataPreFilter: assessment };
        state.rejectedMetadataCandidates.push(rejected);
        rejectedMetadataCandidates.push(rejected);
        stats.metadataRejectedCount += 1;
        state.metadataRejectedCount += 1;
        addVariantCounter(state, candidate, 'metadataRejectedCount');
        continue;
      }
      const key = titleKey(candidate);
      if (excludedTitleKeys.has(key)) {
        const rejected = {
          ...candidate,
          metadataPreFilter: { keep: false, reasons: ['metadata diversity limit: title already reviewed in an earlier stage'] },
        };
        recordDuplicateExclusion(state, rejected, 'historical-title-cluster', stats);
        continue;
      }
      const currentCount = state.titleCounts.get(key) ?? 0;
      if (currentCount >= titleLimit) {
        const rejected = {
          ...candidate,
          metadataPreFilter: { keep: false, reasons: ['metadata diversity limit: repeated title cluster'] },
        };
        recordDuplicateExclusion(state, rejected, 'repeated-title-cluster', stats);
        continue;
      }
      state.titleCounts.set(key, currentCount + 1);
      candidates.push(candidate);
    }
  }

  return {
    /** 取得某类别下一批未被元数据预筛淘汰、且未被排除 ID 命中的候选。 */
    async nextBatch(category, { batchSize = 100, excludedIds = new Set(), excludedTitleKeys = new Set() } = {}) {
      if (!Number.isInteger(batchSize) || batchSize < 1) throw new Error('batchSize must be a positive integer');
      const state = stateByCategory.get(category);
      if (!state) throw new Error(`unknown photo category: ${category}`);
      const excluded = excludedIds instanceof Set ? excludedIds : new Set(excludedIds);
      const excludedTitles = excludedTitleKeys instanceof Set ? excludedTitleKeys : new Set(excludedTitleKeys);
      const candidates = [];
      const rejectedMetadataCandidates = [];
      const stats = {
        globallyExcludedCount: 0,
        duplicateExclusionCount: 0,
        duplicateExclusionReasons: new Set(),
        duplicateExcludedCandidates: [],
        rawRecallCount: 0,
        metadataRejectedCount: 0,
        pagesFetched: 0,
      };
      const historicTitles = new Set([...state.historicalTitleKeys, ...excludedTitles]);

      const isLandscape = state.profile.key === 'landscape';
      const bufferTarget = isLandscape ? Math.max(batchSize, Math.ceil(batchSize / 0.70)) : batchSize;
      let stoppedForBudget = false;
      const checkpoint = async (allocated) => {
        const saved = snapshotSearchState(stateByCategory, searchState);
        // 搜索页的 cursor、knownIds 与已消费但尚未交付的候选一起保存。
        if (!allocated) saved.categories[category].deferred = [...candidates, ...state.deferred];
        await onStateChange(saved, allocated);
      };
      while (candidates.length < bufferTarget) {
        signal?.throwIfAborted();
        consumePending(state, bufferTarget, excluded, historicTitles, candidates, rejectedMetadataCandidates, stats);
        if (candidates.length >= bufferTarget) break;
        const activeVariants = state.variants.filter((variant) => {
          if (variant.exhausted || variant.fallbackSkipped || variant.pagesFetchedInRun >= maxPages) return false;
          if (!variant.sourceId) return true;
          const sameGroup = state.variants.filter((item) => item.fallbackGroup === variant.fallbackGroup);
          // 已成功的字段变体耗尽后，继续推进到同组的下一个未耗尽回退变体。
          const succeeded = sameGroup.find((item) => item.fallbackSucceeded && !item.exhausted && !item.fallbackSkipped);
          if (succeeded) return succeeded === variant;
          return variant === sameGroup.find((item) => !item.exhausted && !item.fallbackSkipped);
        }).sort((a, b) => a.pagesFetchedInRun - b.pagesFetchedInRun || a.queryIndex - b.queryIndex)
          .slice(0, Math.min(searchConcurrency, maxSearchRequests - state.requestsThisStart));
        if (activeVariants.length === 0) {
          // 成功字段达到页数上限时，其未启用的回退字段不代表还能继续搜索。
          stoppedForBudget = state.variants.some(variant => !variant.exhausted && !variant.fallbackSkipped);
          break;
        }
        const outcomes = await Promise.allSettled(activeVariants.map(async (variant) => {
          try {
            const page = await fetchVariantPage(state, variant);
            if (variant.sourceId && page.length > 0) variant.fallbackSucceeded = true;
            if (variant.sourceId && page.length === 0 && variant.fieldMode !== 'caption-fallback') {
              variant.fallbackSkipped = true;
            }
            return page;
          } catch (error) {
            if (variant.sourceId && variant.fieldMode !== 'caption-fallback'
              && ['schema', 'query'].includes(error?.afpFailure?.category)) {
              variant.fallbackSkipped = true;
              variant.fallbackError = 'query-failed';
              return [];
            }
            throw error;
          }
        }));
        const pageResults = outcomes.map(item => item.status === 'fulfilled' ? item.value : []);
        stats.pagesFetched += outcomes.filter(item => item.status === 'fulfilled').length;
        stats.rawRecallCount += pageResults.reduce((sum, items) => sum + items.length, 0);
        // 多个窄查询同时翻页时交错入队，避免第一个查询的整页结果抢占一整批视觉额度。
        const longestPage = Math.max(0, ...pageResults.map((items) => items.length));
        for (let index = 0; index < longestPage; index += 1) {
          for (const pageCandidates of pageResults) {
            const candidate = pageCandidates[index];
            if (!candidate) continue;
            if (state.knownIds.has(candidate.id)) {
              recordDuplicateExclusion(state, candidate, 'repeated-photo-id-across-query-variants', stats);
              continue;
            }
            state.knownIds.add(candidate.id);
            state.pending.push(candidate);
          }
        }
        await checkpoint();
        const failure = outcomes.find(item => item.status === 'rejected');
        if (failure) throw failure.reason;
      }

      const allocation = isLandscape
        ? allocateLandscapeDiscoveryBatch(candidates, batchSize)
        : { candidates: candidates.slice(0, batchSize), deferred: candidates.slice(batchSize), targets: null, selectedCounts: null };
      if (allocation.deferred.length) state.deferred.unshift(...allocation.deferred);
      for (const candidate of allocation.candidates) state.historicalTitleKeys.add(titleKey(candidate));
      if (allocation.selectedCounts) stats.discoveryBudget = {
        targets: allocation.targets,
        selected: allocation.selectedCounts,
      };
      const exhausted = state.variants.every(variant => variant.exhausted || variant.fallbackSkipped) && !state.pending.length && !state.deferred.length;
      const budgetReached = !exhausted && (stoppedForBudget || state.requestsThisStart >= maxSearchRequests
        || state.variants.every(variant => variant.exhausted || variant.fallbackSkipped || variant.pagesFetchedInRun >= maxPages));
      await checkpoint({ category, candidates: allocation.candidates, exhausted, budgetReached });
      return {
        category,
        candidates: allocation.candidates,
        rejectedMetadataCandidates,
        duplicateExcludedCandidates: stats.duplicateExcludedCandidates,
        rawCandidateCount: state.rawCandidateCount,
        stats: {
          ...stats,
          duplicateExclusionReasons: [...stats.duplicateExclusionReasons],
        },
        exhausted, budgetReached,
      };
    },
    getStatus(category) {
      const state = stateByCategory.get(category);
      if (!state) throw new Error(`unknown photo category: ${category}`);
      const sourceStatsById = new Map();
      for (const variant of state.variants) {
        if (!variant.sourceId) continue;
        const stats = sourceStatsById.get(variant.sourceId) ?? {
          sourceId: variant.sourceId,
          sourceType: variant.sourceType,
          fieldMode: variant.fieldMode,
          countryCode: variant.countryCode,
          city: variant.city,
          creator: variant.creator,
          query: variant.criteria,
          queryHash: variant.queryHash,
          rawRecallCount: 0,
          metadataRejectedCount: 0,
          duplicateExclusionCount: 0,
          visualKeptCount: 0,
          pagesFetched: 0,
          rejectionReasons: [],
        };
        stats.rawRecallCount += variant.rawRecallCount;
        stats.metadataRejectedCount += variant.metadataRejectedCount;
        stats.duplicateExclusionCount += variant.duplicateExcludedCount;
        for (const reason of variant.duplicateExclusionReasons) {
          if (!stats.rejectionReasons.includes(`duplicate: ${reason}`)) stats.rejectionReasons.push(`duplicate: ${reason}`);
        }
        stats.pagesFetched += variant.pagesFetched;
        if (variant.fallbackError && !stats.rejectionReasons.includes(`fallback: ${variant.fallbackError}`)) {
          stats.rejectionReasons.push(`fallback: ${variant.fallbackError}`);
        } else if (variant.fallbackSkipped && variant.rawRecallCount === 0 && !stats.rejectionReasons.includes('fallback: no-results')) {
          stats.rejectionReasons.push('fallback: no-results');
        }
        const preferred = variant.fallbackSucceeded
          || (!stats._preferredVariant && variant.rawRecallCount > 0);
        if (preferred) {
          stats._preferredVariant = variant;
          stats.fieldMode = variant.fieldMode;
          stats.query = variant.query;
          stats.queryHash = variant.queryHash;
        }
        sourceStatsById.set(variant.sourceId, stats);
      }
      for (const stats of sourceStatsById.values()) delete stats._preferredVariant;
      for (const candidate of state.rejectedMetadataCandidates) {
        if (candidate.duplicateExclusion) continue;
        const sourceId = candidate.sourceMetadata?.sourceId;
        const stats = sourceId && sourceStatsById.get(sourceId);
        if (!stats) continue;
        for (const reason of candidate.metadataPreFilter?.reasons ?? []) {
          if (!stats.rejectionReasons.includes(reason)) stats.rejectionReasons.push(reason);
        }
      }
      return {
        rawCandidateCount: state.rawCandidateCount,
        metadataRejectedCount: state.metadataRejectedCount,
        duplicateExclusionCount: state.duplicateExclusionCount,
        pendingCount: state.pending.length,
        deferredCount: state.deferred.length,
        rejectedMetadataCandidates: [...state.rejectedMetadataCandidates],
        duplicateExcludedCandidates: [...state.duplicateExcludedCandidates],
        sourceStats: [...sourceStatsById.values()],
        pagination: {
          pageSize,
          maxPagesPerVariant: maxPages,
          totalPagesFetched: state.variants.reduce((sum, variant) => sum + variant.pagesFetched, 0),
          variants: state.variants.map((variant) => ({
            criteria: variant.criteria,
            pagesFetched: variant.pagesFetched,
            stoppedBecause: variant.stoppedBecause,
            cursor: variant.cursor,
            exhausted: variant.exhausted,
            seenCursors: [...variant.seenCursors],
            fallbackSucceeded: variant.fallbackSucceeded,
            fallbackSkipped: variant.fallbackSkipped,
            ...(variant.fallbackError ? { fallbackError: variant.fallbackError } : {}),
            ...(variant.sourceId ? {
              sourceId: variant.sourceId,
              sourceType: variant.sourceType,
              fieldMode: variant.fieldMode,
              queryHash: variant.queryHash,
            } : {}),
          })),
        },
      };
    },
    exportState() {
      return snapshotSearchState(stateByCategory, searchState);
    },
  };
}

/** 生成仅含元数据的候选清单，供视觉 Skill 在另一进程中安全接力。 */
export function createCandidateManifest(results, createdAt = new Date().toISOString()) {
  return {
    version: 1,
    createdAt,
    categories: results.map(({ profile, candidates, rawCandidateCount, pagination, rejectedMetadataCandidates, duplicateExcludedCandidates, duplicateExclusionCount, sourceStats, queryPlans }) => ({
      category: profile.key,
      selectionName: profile.selectionName,
      criteria: profile.criteria,
      criteriaVariants: profile.queryVariants ?? [profile.criteria],
      rawCandidateCount: rawCandidateCount ?? candidates.length,
      ...(Number.isInteger(duplicateExclusionCount) ? { duplicateExclusionCount } : {}),
      pagination,
      rejectedMetadataCandidates: rejectedMetadataCandidates ?? [],
      ...(Array.isArray(duplicateExcludedCandidates) ? { duplicateExcludedCandidates } : {}),
      ...(Array.isArray(profile.sources) ? {
        sources: profile.sources,
        queryPlans: queryPlans ?? [],
        sourceStats: sourceStats ?? [],
      } : {}),
      candidates,
    })),
  };
}

/**
 * 逐类执行多个窄查询并合并为候选清单。结构化来源按字段优先顺序执行，
 * 字段无结果或失败时回退到 caption；legacy queryVariants 仍按原有并列方式工作。
 */
export async function collectPhotoCandidates({
  client = createAfpApiClient(),
  profiles = CATEGORY_PROFILES,
  maxRows = 100,
  maxPages = DEFAULT_MAX_PAGES,
  searchState = null,
  excludedIds = new Set(),
  excludedTitleKeys = new Set(),
  onStateChange,
} = {}) {
  if (!Number.isInteger(maxRows) || maxRows < 1 || maxRows > 100) {
    throw new Error('maxRows must be between 1 and 100');
  }
  if (!Number.isInteger(maxPages) || maxPages < 1 || maxPages > MAX_MAX_PAGES) {
    throw new Error(`maxPages must be between 1 and ${MAX_MAX_PAGES}`);
  }
  if (searchState !== null || typeof onStateChange === 'function') {
    const session = createPhotoSearchSession({
      client,
      profiles,
      pageSize: Math.min(120, Math.max(20, maxRows)),
      maxPages,
      searchState,
      onStateChange: onStateChange ?? (async () => {}),
    });
    const results = [];
    for (const profile of profiles) {
      const batch = await session.nextBatch(profile.key, { batchSize: maxRows, excludedIds, excludedTitleKeys });
      const status = session.getStatus(profile.key);
      results.push({
        profile,
        candidates: batch.candidates,
        rawCandidateCount: status.rawCandidateCount,
        rejectedMetadataCandidates: status.rejectedMetadataCandidates,
        duplicateExcludedCandidates: status.duplicateExcludedCandidates,
        duplicateExclusionCount: status.duplicateExclusionCount,
        pagination: status.pagination,
        sourceStats: status.sourceStats,
        queryPlans: status.pagination.variants,
      });
    }
    return createCandidateManifest(results);
  }
  const results = [];
  for (const profile of profiles) {
    const queryPlans = buildSearchQueryPlans(profile);
    const rowsPerVariant = Math.max(20, Math.ceil((maxRows * 2) / Math.max(1, queryPlans.length)));
    const groups = new Map();
    queryPlans.forEach((plan, index) => {
      const key = plan.fallbackGroup ?? `legacy-${index}`;
      const group = groups.get(key) ?? [];
      group.push(plan);
      groups.set(key, group);
    });
    const variantResults = [];
    for (const plans of groups.values()) {
      let selected = false;
      for (const plan of plans) {
        const queryIndex = queryPlans.indexOf(plan);
        const result = await (async () => {
          const candidates = [];
          let cursor = null;
          let pagesFetched = 0;
          let stoppedBecause = 'max-pages-reached';
          const seenCursors = new Set();
          let errorCategory = null;
          try {
            for (let page = 0; page < maxPages; page += 1) {
              const response = await client.searchPhotos(buildPhotoSearchRequest(profile, rowsPerVariant, plan.criteria, cursor));
              pagesFetched += 1;
              const docs = Array.isArray(response?.docs) ? response.docs : [];
              candidates.push(...docs.map((photo, index) => mapPhotoCandidate(
                photo,
                profile,
                queryIndex * rowsPerVariant * maxPages + page * rowsPerVariant + index,
                plan,
              )));
              const nextCursor = String(response?.cursor ?? '').trim();
              if (!response?.hasMore) {
                stoppedBecause = 'no-more-results';
                break;
              }
              if (!nextCursor) {
                stoppedBecause = 'missing-next-cursor';
                break;
              }
              if (nextCursor === cursor || seenCursors.has(nextCursor)) {
                stoppedBecause = 'repeated-cursor';
                break;
              }
              seenCursors.add(nextCursor);
              cursor = nextCursor;
            }
          } catch {
            errorCategory = 'query-failed';
            stoppedBecause = 'not-started';
          }
          return {
            plan,
            candidates,
            pagination: {
              criteria: plan.criteria,
              pagesFetched,
              rawCandidateCount: candidates.length,
              stoppedBecause,
              cursor,
              seenCursors: [...seenCursors],
              exhausted: ['no-more-results', 'missing-next-cursor', 'repeated-cursor'].includes(stoppedBecause),
              fallbackSucceeded: candidates.length > 0,
              ...(plan.sourceId ? {
                sourceId: plan.sourceId,
                sourceType: plan.sourceType,
                fieldMode: plan.fieldMode,
                queryHash: plan.queryHash,
              } : {}),
            },
            errorCategory,
            usedForRecall: false,
          };
        })();
        variantResults.push(result);
        if (result.candidates.length > 0 || plan.fieldMode === 'caption-fallback') {
          result.usedForRecall = result.candidates.length > 0;
          selected = true;
          break;
        }
      }
      if (!selected && plans.length) {
        const last = variantResults[variantResults.length - 1];
        if (last) last.usedForRecall = false;
      }
    }
    const recallResults = variantResults.filter(({ usedForRecall }) => usedForRecall);
    const rawCandidates = [];
    const longestVariant = Math.max(0, ...recallResults.map(({ candidates }) => candidates.length));
    for (let index = 0; index < longestVariant; index += 1) {
      for (const result of recallResults) {
        const candidate = result.candidates[index];
        if (candidate) rawCandidates.push(candidate);
      }
    }
    const curated = curatePhotoCandidates(rawCandidates, profile, maxRows);
    const sourceStatsById = new Map();
    for (const result of variantResults) {
      const sourceId = result.plan.sourceId;
      if (!sourceId) continue;
      const stats = sourceStatsById.get(sourceId) ?? {
        sourceId,
        sourceType: result.plan.sourceType,
        fieldMode: result.plan.fieldMode,
        countryCode: result.plan.countryCode,
        city: result.plan.city,
        creator: result.plan.creator,
        query: result.plan.query,
        queryHash: result.plan.queryHash,
        rawRecallCount: 0,
        metadataRejectedCount: 0,
        duplicateExclusionCount: 0,
        visualKeptCount: 0,
        pagesFetched: 0,
        rejectionReasons: [],
      };
      stats.rawRecallCount += result.candidates.length;
      stats.pagesFetched += result.pagination.pagesFetched;
      if (result.errorCategory) stats.rejectionReasons.push(result.errorCategory);
      sourceStatsById.set(sourceId, stats);
    }
    for (const candidate of curated.rejectedMetadataCandidates) {
      const sourceId = candidate.sourceMetadata?.sourceId;
      const stats = sourceId && sourceStatsById.get(sourceId);
      if (!stats) continue;
      stats.metadataRejectedCount += 1;
      for (const reason of candidate.metadataPreFilter?.reasons ?? []) {
        if (!stats.rejectionReasons.includes(reason)) stats.rejectionReasons.push(reason);
      }
    }
    for (const candidate of curated.duplicateExcludedCandidates) {
      const sourceId = candidate.sourceMetadata?.sourceId;
      const stats = sourceId && sourceStatsById.get(sourceId);
      if (!stats) continue;
      stats.duplicateExclusionCount += 1;
      const reason = candidate.duplicateExclusion ? `duplicate: ${candidate.duplicateExclusion}` : 'duplicate: unspecified';
      if (!stats.rejectionReasons.includes(reason)) stats.rejectionReasons.push(reason);
    }
    results.push({
      profile,
      rawCandidateCount: rawCandidates.length,
      duplicateExcludedCandidates: curated.duplicateExcludedCandidates,
      duplicateExclusionCount: curated.duplicateExclusionCount,
      pagination: {
        maxPagesPerVariant: maxPages,
        rowsPerVariant,
        totalPagesFetched: variantResults.reduce((total, { pagination }) => total + pagination.pagesFetched, 0),
        variants: variantResults.map(({ pagination }) => pagination),
      },
      queryPlans,
      sourceStats: [...sourceStatsById.values()],
      ...curated,
    });
  }
      return createCandidateManifest(results);
}
