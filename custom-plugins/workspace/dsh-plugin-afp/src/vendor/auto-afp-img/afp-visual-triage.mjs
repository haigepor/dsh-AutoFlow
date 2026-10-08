import { createAfpApiClient } from './afp-api-client.mjs';
import { collectExistingSelectionDocIds } from './afp-collection-run.mjs';
import { createAfpPreviewClient } from './afp-preview-client.mjs';
import { createOpenAiCompatibleVisionClient, normalizeVisionDecision } from './openai-compatible-vision.mjs';


export const CATEGORY_VISUAL_RULES = Object.freeze({
  animals: {
    positive: 'A real, visually identifiable mammal or bird is clearly visible as the primary subject in a calm, attractive, natural-looking photograph. Prioritize companion and charismatic animals such as cats, dogs, rabbits, horses, pandas, red pandas, foxes, otters, elephants, deer, seals, dolphins, penguins, and aesthetically pleasing birds.',
    required: 'First confirm the visible species/class from pixels; if the animal is ambiguous, tiny, disguised, or only metadata-supported, return unknown and reject. Do not infer breed, species, body coverage, comfort, or quality from caption, title, metadata, or external knowledge; breed labels may guide search recall but are not visual evidence. pixel evidence must show the real animal, and the primary subject occupies enough of the frame for anatomy and texture to be judged. The real animal must dominate the composition. If the visible subject is a person, athlete, golfer, football/soccer player, stadium activity, food/fruit still life, or scenery with no clearly visible animal, reject even when the caption contains an animal keyword. Require animalClass=mammal or bird; reject fish, reptiles, amphibians, insects, arachnids, worms, mollusks, crustaceans, and other invertebrates even when technically clear. Require bodyCoverage=full-body or near-full-body: every important anatomical part that defines the pose must be visible; reject face-only, eye-only, nose-only, head-only, head-and-shoulders portraits, paw/hoof/wing-only, extreme macro, tight close-ups, and any frame with cropped feet, tail, wings, ears, muzzle, or other important body parts. A visible head plus a small portion of torso is still a partial close-up, not a full-body animal image. Require imageClarity=clear, compositionQuality=balanced, and aestheticScore>=4 so fur, feathers, skin, and natural texture details are readable in a calm, pleasing composition. Require graphicContent=none, welfareState=natural, environment=clean-natural, coatColor=not-black-cat, comfortLevel=comfortable, appealTier=high or medium, interactionState=peaceful or neutral, occlusionLevel=none or minor, groupDensity=single or small-group, and foregroundClarity=clear. Treat birthday cakes, feeding props, ceremonial displays, toys, performance setups, grooming tables, studio backdrops, and staged photo-op arrangements as human intervention or overly staged presentation. Reject scenes where a prey animal is being caught, carried, bitten, attacked, hunted, or visibly threatened. Reject dense colonies, crowded herds, mixed-species scenes without one clear primary subject, and foreground animals that are blurred or partially visible.',
    exclude: 'Reject reptiles, amphibians, fish, insects, arachnids, spiders, tarantulas, scorpions, centipedes, millipedes, ticks, mites, parasites, cockroaches, caterpillars, moths, bees, wasps, beetles, dragonflies, maggots, larvae, earthworms, worms, leeches, slugs, snails, shellfish, crustaceans, uncomfortable macro subjects, dense insect clusters, mating, mucus-heavy frames, and other invertebrates. Also reject ambiguous species, costumes, mascots, cosplay, toys, stuffed animals, logos, drawings, screens, text-only mentions, human skulls or anatomical subjects, museum sculptures, murals, cages, fences, wire mesh, people-dominant scenes, podiums, meetings, red-carpet events, yoga, hockey, sports or stadium activity, golfers, football/soccer players, food or fruit still lifes, rocket launches, stairs or architecture without an animal, studio portraits, landscape-only frames, dirty or artificial environments, visible enclosure barriers, staged displays, birthday or feeding props, restrained or distressed animals, blood, corpses, wounds, disturbing scenes, blurry or noisy images, black cats, predation, hunting, catching prey, biting prey, attacking, killing, dense colonies, crowded groups, and mixed-species frames without a clear primary subject.',
  },
  food: {
    positive: 'Clearly edible food or a drink is visible as the primary subject: a dish, ingredients, prepared food, bakery item, fruit, vegetable, seafood, or cooking process with identifiable food.',
    required: 'The food must be visible in pixels and occupy the visual focus; the model must not infer food from a restaurant, delivery, brand, menu, caption, or a person merely eating.',
    exclude: 'Reject animals eating food, empty restaurants, restaurant exteriors, menus, signs, delivery workers, food stalls viewed as an event, packaging-only shots, vehicles, people-only scenes, offerings, and factory machinery when the food is not clearly identifiable.',
  },
  landscape: {
    positive: 'Wallpaper-first: a clean finished desktop wallpaper must already work at thumbnail scale. The unmistakable primary subject is either a wide natural environment or an open city panorama, with readable depth, horizon, terrain, water, sky, or a separated skyline. A location name, famous destination, or attractive color palette never substitutes for a clear pixel-level subject and balanced composition.',
    required: 'Use this order: (1) identify the dominant visible subject from pixels; (2) reject if the frame is not immediately usable as a calm desktop wallpaper; (3) classify sceneType conservatively, accepting only natural-scenery or open-city-panorama; (4) apply hard exclusions. Never promote background scenery behind a vessel, marina, activity, crowd, landmark cluster, or news scene. Classify primaryFocus as natural-landscape or city-panorama only when the environment covers at least 75% of the frame and spatialDepth is strong. Accept only landscape or panoramic frameOrientation for this desktop landscape collection; portrait and square images must be rejected even when their scenery is attractive. Require compositionSignals including layered-depth, visualCalmness high or medium, visualBalance=balanced, no dominant human presence, and aestheticScore=5 for final retention. Require subjectClarity=clear and anchorStrength=strong or medium: the landscape or skyline must be immediately readable from pixels without relying on the title or place identity. Mark humanPresence=dominant whenever one or more recognizable people form a central silhouette, foreground anchor, pose, interaction, or storytelling subject, even if the environment covers most of the frame; secondary is reserved for tiny incidental figures that do not attract the eye. Mark vesselRole=prominent or dominant whenever a boat, canoe, yacht, ferry, or ship is a clearly readable central/foreground anchor, even when physically small; incidental is reserved for a distant vessel that does not drive the composition. Mark negativeSpaceDominance=dominant-empty when bland sky, water, fog, or ground occupies most of the frame and the remaining subject is weak; such an image is not layered-depth. Mark compositeImage=true for multiple-exposure, time-sequence, stitched, or repeated-object compositions such as eclipse trails. Mark artificialLightRole=prominent or dominant when vehicles, tents, campsite lighting, streets, or other artificial lights form a significant lower-frame subject. Mark coastalStructureRole=prominent or dominant when a lighthouse, breakwater, pier, seawall, harbor wall, offshore wind turbine array, or coastal utility/energy structure becomes a major subject or a repeated horizon band instead of a small landscape accent. Mark terrainInfrastructureRole=prominent or dominant when roads, tracks, earthworks, trenches, cut slopes, energy facilities, or utility corridors visibly divide a natural landform and become a major compositional structure; use incidental for a small distant path that does not compete with the landscape. Assess horizonPlacement from the dominant stable horizontal division (horizon, shore, waterline, or skyline mass). centered is the normal safe layout. off-center-balanced is allowed only when a clear visual anchor and layered counterweight make the offset intentional; emit clear-anchor and balanced-off-center in compositionSignals. Use off-center-unbalanced when a large bland sky, water, or ground leaves the scene top- or bottom-heavy without a readable subject; reject it. Use not-visible only when no meaningful horizon exists and a clear anchor still balances the composition. For natural-scenery, always emit urbanOpenness=not-applicable, skylineProminence=not-applicable, cityInfrastructureRole=not-applicable, and cityAnchorType=none; for city panoramas, emit urbanOpenness=open, skylineProminence=strong or medium, and a non-none cityAnchorType. For natural scenery, vesselRole must be none or incidental, crowdScale must be none or sparse, and editorialContext must be none. For city panoramas, urbanOpenness must be open and skylineProminence must be strong or medium. Mark cityInfrastructureRole=prominent or dominant when railways, highways, factories, chimneys, utility plants, bridge machinery, or transport infrastructure occupy a significant foreground or compete with the skyline. Mark industrialDocumentary=true when factories, transport infrastructure, utility structures, dense roads, or an economic-news city record dominate. Return excludedRegionSignal=evident or likely only for directly visible, specific visual evidence that the underlying scene is in China, Hong Kong, Macau, or Taiwan; never infer it from ethnicity, generic Asian-looking scenery, vague architecture, captions, OCR, metadata, or a location name. Return sourceImageText=false only when the underlying source image has no embedded text, logo, border, or collage panel. Ignore AFP preview watermarks, agency credit strips, IDs, viewer chrome, and metadata panels when judging the underlying image content.',
    exclude: 'Reject flower or foliage close-ups, portraits, crowds, events, products, isolated objects, animals, traffic-only images, a road or vehicle as the main focus, a single building, flood or disaster reportage, wildfire scenes, and source-image text, logos, borders, posters, collage layouts, multiple-exposure sequences, or stitched time-series images. Reject a marina, harbor, dock, shipyard, ferry, prominent boat, yacht, cruise ship, or other working-waterfront image when vessels or infrastructure are visually prominent. Reject campsites, vehicles, tents, or artificial light bands when they form a significant foreground subject. Reject daily-life, migration, rescue, ritual, tourism-activity, or other editorial scenes when people, activity, or documentary context forms the story. Reject a city image that is a compressed dense roofscape, industrial or infrastructure record, or weak skyline silhouette rather than an open skyline wallpaper. Reject a visually empty sky/water/fog field with no strong anchor even when the colors are attractive. Reject any frame that needs a caption, title, or famous-location knowledge to establish that it is a landscape. Reject an image when China, Hong Kong, Macau, or Taiwan is visually evident or likely under the strict regional-evidence rule.',
  },
  'movie-poster': {
    positive: 'A genuine movie or film promotional poster is the primary visible subject, with a poster layout, film artwork or characters, and recognizable theatrical title or credit design.',
    required: 'The poster itself must occupy a substantial, unobstructed part of the frame (roughly half or more when it is the only candidate); a person standing near a poster, a distant wall poster, or a poster edge is not enough.',
    exclude: 'Reject political, election, commercial, memorial, tribute, mountaineering, or generic advertisement posters; actor portraits, red-carpet photos, interviews, live stages, film-score events, cinema buildings, ordinary movie stills, event backdrops, and posters whose movie identity cannot be visually distinguished.',
  },
  'celestial-body-wallpaper': {
    positive: 'A clean finished cosmic wallpaper fills the frame. Accept a large spherical celestial body, a frame-filling nebula/galaxy/comet/black-hole formation, or a dense star field with continuous cosmic texture. A space station or satellite is allowed only as a secondary object inside a clearly space-based composition.',
    required: 'Return presentation=wallpaper only for a visually usable wallpaper composition. Classify subjectKind as spherical-body, extended-formation, or dense-star-field. For a spherical body, visible diameter or span must reach at least 80% of the shorter image edge; reject a flat monochrome scientific solar-disc observation even when it reaches 80%. For extended formations, astronomical content must cover at least 60% and empty near-black background must not exceed 40%. For dense-star-field, starFieldDensity must be dense and astronomical texture must cover at least 75%; isolated galaxies, sparse stars, or a night landscape with a terrestrial horizon do not qualify. Ignore AFP preview watermarks, agency credit strips, IDs, viewer chrome, and metadata panels when judging the underlying image content.',
    exclude: 'Reject scientific-observation solar discs, sparse deep-field/catalog images, a small moon or planet surrounded by mostly empty black sky, a single distant point of light, plain dark sky, city lights, aurora-only scenes, meteors-only scenes, a terrestrial night landscape, foreground trees/rocks/buildings/horizon as a major composition, a dominant spacecraft/space-station/satellite device, aircraft, airports, stadium or concert lights, telescopes, observatories, books, posters, screens, murals, collage layouts, non-overlay text embedded in the source image, logos, borders, people, hands, eclipse glasses or other viewing gear, product packaging, animals, sci-fi costumes, and astronomy events. Treat AFP watermark/credit/ID overlays and the surrounding AFP webpage UI as preview artifacts: ignore them and never use them as evidence for or against the underlying image.',
  },
});

/** 类别越容易被文字语境污染，保留所需的视觉置信度越高；全局阈值仍是最低门槛。 */
export const CATEGORY_MIN_CONFIDENCE = Object.freeze({
  animals: 0.82,
  food: 0.85,
  landscape: 0.82,
  'movie-poster': 0.90,
  'celestial-body-wallpaper': 0.92,
});

/** 根据原图画幅标记可用终端；竖幅保留为移动端/锁屏并允许后续智能横裁。 */
export function classifyLandscapeWallpaperFit(frameOrientation) {
  if (frameOrientation === 'landscape' || frameOrientation === 'panoramic') return 'desktop';
  if (frameOrientation === 'portrait' || frameOrientation === 'square') return 'smart-crop';
  return null;
}

/** 为审核包补充画幅标签；不把竖幅或方幅重新提升为可收藏风景。 */
export function reassessLandscapeDecisionForWallpaperFit(decision = {}) {
  const wallpaperFit = classifyLandscapeWallpaperFit(decision.frameOrientation);
  return { ...decision, wallpaperFit };
}

export function effectiveThreshold(targetCategory, threshold = 0.8) {
  return Math.max(Number(threshold), CATEGORY_MIN_CONFIDENCE[targetCategory] ?? 0.8);
}

/** 动物专项本地硬门槛；模型漏填或含糊时默认拒绝，避免局部、低清和不适内容进入收藏。 */
export function validateAnimalDecision({
  animalClass,
  subjectRole,
  bodyCoverage,
  imageClarity,
  graphicContent,
  welfareState,
  environment,
  coatColor,
  comfortLevel,
  appealTier,
  interactionState,
  occlusionLevel,
  groupDensity,
  foregroundClarity,
  compositionQuality,
  aestheticScore,
} = {}) {
  if (!['mammal', 'bird'].includes(animalClass)) {
    return { keep: false, reason: 'animal class is not an allowed mammal or bird' };
  }
  if (subjectRole !== 'primary') {
    return { keep: false, reason: 'animal is not the primary visual subject' };
  }
  if (!['full-body', 'near-full-body'].includes(bodyCoverage)) {
    return { keep: false, reason: 'animal body is cropped or only a partial close-up' };
  }
  if (imageClarity !== 'clear') {
    return { keep: false, reason: 'animal image is not sufficiently clear for texture inspection' };
  }
  if (graphicContent !== 'none') {
    return { keep: false, reason: 'animal image contains blood, injury, death, or disturbing content' };
  }
  if (welfareState !== 'natural') {
    return { keep: false, reason: 'animal state shows restraint, distress, staging, or heavy human intervention' };
  }
  if (environment !== 'clean-natural') {
    return { keep: false, reason: 'environment contains people, cages, fences, wire, dirt, or dominant artificial setting' };
  }
  if (coatColor === 'black-cat') {
    return { keep: false, reason: 'black cats are excluded' };
  }
  if (!['not-black-cat', 'not-applicable'].includes(coatColor)) {
    return { keep: false, reason: 'animal coat color is unknown or invalid' };
  }
  if (comfortLevel !== 'comfortable') {
    return { keep: false, reason: 'animal frame is uncomfortable or comfort is unknown' };
  }
  if (!['high', 'medium'].includes(appealTier)) {
    return { keep: false, reason: 'animal appeal tier is missing or unknown' };
  }
  if (!['peaceful', 'neutral'].includes(interactionState)) {
    return { keep: false, reason: 'animal interaction is predatory, aggressive, distressed, or unknown' };
  }
  if (!['none', 'minor'].includes(occlusionLevel)) {
    return { keep: false, reason: 'important animal body parts are occluded or occlusion is unknown' };
  }
  if (!['single', 'small-group'].includes(groupDensity)) {
    return { keep: false, reason: 'animal group is too dense or group density is unknown' };
  }
  if (foregroundClarity !== 'clear') {
    return { keep: false, reason: 'foreground animal detail is mixed, blurred, or unknown' };
  }
  if (compositionQuality !== 'balanced') {
    return { keep: false, reason: 'animal composition is busy, awkward, or unknown' };
  }
  if (!Number.isFinite(Number(aestheticScore)) || Number(aestheticScore) < 4 || Number(aestheticScore) > 5) {
    return { keep: false, reason: 'animal image does not meet the aesthetic quality floor' };
  }
  return { keep: true, reason: 'animal meets full-body, comfort, clarity, and welfare rules' };
}

/**
 * 对宇宙壁纸补充模型置信度之外的构图硬门槛。
 * 黑洞本体和带有星点纹理的深色区域不计入空黑背景，避免误杀参考图中的黑洞与密集星空。
 */
export function validateCelestialWallpaperComposition({ subjectKind, subjectCoverage, emptyBlackCoverage, presentation, starFieldDensity, spaceHardwareRole } = {}) {
  const coverage = Number(subjectCoverage);
  const black = Number(emptyBlackCoverage);
  if (!Number.isFinite(coverage) || !Number.isFinite(black)) {
    return { keep: false, reason: 'missing celestial composition measurements' };
  }
  if (presentation !== 'wallpaper') {
    return { keep: false, reason: 'composition is scientific observation, terrestrial landscape, sparse deep field, or otherwise not wallpaper-ready' };
  }
  if (spaceHardwareRole === 'dominant') {
    return { keep: false, reason: 'spacecraft, space station, satellite, or telescope dominates the composition' };
  }
  if (subjectKind === 'spherical-body') {
    return coverage >= 0.8
      ? { keep: true, reason: 'large spherical celestial body' }
      : { keep: false, reason: 'spherical celestial body is too small' };
  }
  if (subjectKind === 'extended-formation') {
    if (coverage < 0.6) return { keep: false, reason: 'extended astronomical formation is too small' };
    return black <= 0.4
      ? { keep: true, reason: 'full-frame extended astronomical formation' }
      : { keep: false, reason: 'empty black background exceeds limit' };
  }
  if (subjectKind === 'dense-star-field') {
    if (starFieldDensity !== 'dense') return { keep: false, reason: 'star field is sparse or catalog-like' };
    if (coverage < 0.75) return { keep: false, reason: 'star field is too sparse' };
    return black <= 0.4
      ? { keep: true, reason: 'dense star field fills the composition' }
      : { keep: false, reason: 'empty black background exceeds limit' };
  }
  return { keep: false, reason: 'unsupported celestial composition' };
}

/**
 * 对风景壁纸补充模型置信度之外的构图硬门槛。
 * 只接受自然环境或广阔城市全景，避免“画面有风景背景”的新闻或近景误入收藏夹。
 */
export function validateLandscapeWallpaperComposition({
  presentation,
  primaryFocus,
  environmentCoverage,
  spatialDepth,
  foregroundDistraction,
  sourceImageText,
  frameOrientation,
  compositionSignals,
  subjectClarity,
  horizonPlacement,
  visualCalmness,
  visualBalance,
  humanPresence,
  builtEnvironmentRole,
  aestheticScore,
  excludedRegionSignal,
  sceneType,
  vesselRole,
  crowdScale,
  editorialContext,
  urbanOpenness,
  compositeImage,
  anchorStrength,
  negativeSpaceDominance,
  artificialLightRole,
  skylineProminence,
  industrialDocumentary,
  cityInfrastructureRole,
  coastalStructureRole,
  terrainInfrastructureRole,
  cityAnchorType,
  visualClutter,
} = {}) {
  const coverage = Number(environmentCoverage);
  const score = Number(aestheticScore);
  if (!Number.isFinite(coverage)) {
    return { keep: false, reason: 'missing landscape composition measurements' };
  }
  if (presentation !== 'wallpaper') {
    return { keep: false, reason: 'composition is not wallpaper-ready' };
  }
  if (!['natural-landscape', 'city-panorama'].includes(primaryFocus)) {
    return { keep: false, reason: 'primary focus is not a natural landscape or city panorama' };
  }
  if (coverage < 0.75) {
    return { keep: false, reason: 'landscape environment coverage is too small' };
  }
  if (spatialDepth !== 'strong') {
    return { keep: false, reason: 'landscape lacks strong spatial depth' };
  }
  if (sourceImageText !== false) {
    return { keep: false, reason: 'source image contains text, logo, border, or collage content' };
  }
  if (compositeImage === true) {
    return { keep: false, reason: 'source image is a composite, sequence, or multiple-exposure image' };
  }
  if (foregroundDistraction === 'dominant') {
    return { keep: false, reason: 'foreground distraction dominates the composition' };
  }
  if (!['none', 'minor'].includes(foregroundDistraction)) {
    return { keep: false, reason: 'missing landscape foreground assessment' };
  }
  if (!['landscape', 'panoramic'].includes(frameOrientation)) {
    return { keep: false, reason: 'landscape wallpaper requires a landscape or panoramic frame' };
  }
  if (!Array.isArray(compositionSignals) || !compositionSignals.includes('layered-depth')) {
    return { keep: false, reason: 'landscape lacks layered-depth composition' };
  }
  if (subjectClarity !== 'clear') {
    return { keep: false, reason: 'landscape lacks a clear, readable visual subject' };
  }
  if (negativeSpaceDominance === 'dominant-empty') {
    return { keep: false, reason: 'large empty sky, water, or ground overwhelms a weak landscape anchor' };
  }
  if (anchorStrength === 'weak' || anchorStrength === 'none') {
    return { keep: false, reason: 'landscape lacks a strong visual anchor' };
  }
  if (artificialLightRole === 'prominent' || artificialLightRole === 'dominant') {
    return { keep: false, reason: 'vehicles, campsite lights, or artificial light dominate the lower frame' };
  }
  if (coastalStructureRole === 'prominent' || coastalStructureRole === 'dominant') {
    return { keep: false, reason: 'lighthouse, breakwater, pier, seawall, or coastal infrastructure dominates the seascape' };
  }
  if (terrainInfrastructureRole === 'prominent' || terrainInfrastructureRole === 'dominant') {
    return { keep: false, reason: 'roads, tracks, earthworks, or utility corridors visibly dissect the natural terrain' };
  }
  if (!['centered', 'off-center-balanced', 'off-center-unbalanced', 'not-visible'].includes(horizonPlacement)) {
    return { keep: false, reason: 'missing landscape horizon-placement assessment' };
  }
  if (horizonPlacement === 'off-center-unbalanced') {
    return { keep: false, reason: 'horizon and negative space leave the composition visually unbalanced' };
  }
  if (horizonPlacement === 'off-center-balanced'
    && (!compositionSignals.includes('clear-anchor') || !compositionSignals.includes('balanced-off-center'))) {
    return { keep: false, reason: 'off-center horizon lacks a clear anchored composition' };
  }
  if (!['high', 'medium'].includes(visualCalmness)) {
    return { keep: false, reason: 'landscape lacks a calm wallpaper visual mood' };
  }
  if (visualBalance !== 'balanced') {
    return { keep: false, reason: 'landscape lacks overall visual balance' };
  }
  if (horizonPlacement === 'not-visible' && !compositionSignals.includes('clear-anchor')) {
    return { keep: false, reason: 'horizonless landscape lacks a clear visual anchor' };
  }
  if (humanPresence === 'dominant') {
    return { keep: false, reason: 'people dominate the landscape composition' };
  }
  if (!['none', 'secondary'].includes(humanPresence)) {
    return { keep: false, reason: 'missing landscape human-presence assessment' };
  }
  if (!['none', 'secondary', 'dominant'].includes(builtEnvironmentRole)) {
    return { keep: false, reason: 'missing landscape built-environment assessment' };
  }
  if (primaryFocus === 'natural-landscape' && builtEnvironmentRole === 'dominant') {
    return { keep: false, reason: 'built structures dominate a natural landscape composition' };
  }
  if (!Number.isInteger(score) || score < 5 || score > 5) {
    return { keep: false, reason: 'landscape aesthetic score is below the reference standard' };
  }
  if (['evident', 'likely'].includes(excludedRegionSignal)) {
    return { keep: false, reason: 'image has visual evidence of an excluded China, Hong Kong, Macau, or Taiwan region' };
  }
  if (!['not-evident', 'uncertain'].includes(excludedRegionSignal)) {
    return { keep: false, reason: 'missing landscape regional-evidence assessment' };
  }
  if (!['natural-scenery', 'open-city-panorama'].includes(sceneType)) {
    return { keep: false, reason: 'scene is not a clean natural landscape or open city panorama' };
  }
  if (primaryFocus === 'natural-landscape' && sceneType !== 'natural-scenery') {
    return { keep: false, reason: 'natural landscape has conflicting visual scene classification' };
  }
  if (primaryFocus === 'city-panorama' && sceneType !== 'open-city-panorama') {
    return { keep: false, reason: 'city panorama has conflicting visual scene classification' };
  }
  if (!['none', 'incidental'].includes(vesselRole)) {
    return { keep: false, reason: 'vessels, marina, or waterfront infrastructure are visually prominent' };
  }
  if (!['none', 'sparse'].includes(crowdScale)) {
    return { keep: false, reason: 'people form a group, crowd, or activity scene' };
  }
  if (editorialContext !== 'none') {
    return { keep: false, reason: 'image is an editorial activity, event, incident, or infrastructure record' };
  }
  if (primaryFocus === 'city-panorama' && urbanOpenness !== 'open') {
    return { keep: false, reason: 'city panorama lacks open visual breathing room for wallpaper use' };
  }
  if (primaryFocus === 'city-panorama' && industrialDocumentary === true) {
    return { keep: false, reason: 'city image is an industrial or infrastructure documentary view' };
  }
  if (primaryFocus === 'city-panorama' && ['prominent', 'dominant'].includes(cityInfrastructureRole)) {
    return { keep: false, reason: 'railways, highways, factories, chimneys, or utility infrastructure dominate the city foreground' };
  }
  if (primaryFocus === 'city-panorama' && skylineProminence === 'weak') {
    return { keep: false, reason: 'city skyline is too small or weak to anchor the panorama' };
  }
  if (primaryFocus === 'city-panorama' && !['skyline', 'landmark-cluster', 'bridge', 'waterfront-skyline', 'mountain-city'].includes(cityAnchorType)) {
    return { keep: false, reason: 'city panorama lacks a clear city anchor type' };
  }
  if (primaryFocus === 'city-panorama' && visualClutter !== 'low') {
    return { keep: false, reason: 'city panorama visual clutter is not low' };
  }
  if (primaryFocus === 'natural-landscape' && urbanOpenness !== 'not-applicable') {
    return { keep: false, reason: 'natural landscape has invalid urban-openness assessment' };
  }
  if (primaryFocus === 'natural-landscape' && skylineProminence !== 'not-applicable') {
    if (skylineProminence !== null && skylineProminence !== undefined) {
      return { keep: false, reason: 'natural landscape has invalid skyline-prominence assessment' };
    }
  }
  if (compositeImage !== false) {
    return { keep: false, reason: 'missing landscape composite-image assessment' };
  }
  if (!['strong', 'medium'].includes(anchorStrength)) {
    return { keep: false, reason: 'missing landscape anchor-strength assessment' };
  }
  if (!['balanced', 'not-applicable'].includes(negativeSpaceDominance)) {
    return { keep: false, reason: 'missing landscape negative-space assessment' };
  }
  if (!['none', 'incidental'].includes(artificialLightRole)) {
    return { keep: false, reason: 'missing landscape artificial-light assessment' };
  }
  if (industrialDocumentary !== false) {
    return { keep: false, reason: 'missing city industrial-documentary assessment' };
  }
  if (primaryFocus === 'city-panorama' && !['none', 'incidental'].includes(cityInfrastructureRole)) {
    return { keep: false, reason: 'missing city infrastructure-role assessment' };
  }
  if (primaryFocus === 'natural-landscape' && cityInfrastructureRole !== 'not-applicable') {
    return { keep: false, reason: 'missing natural-landscape infrastructure assessment' };
  }
  if (!['none', 'incidental'].includes(coastalStructureRole)) {
    return { keep: false, reason: 'missing landscape coastal-structure assessment' };
  }
  if (!['none', 'incidental'].includes(terrainInfrastructureRole)) {
    return { keep: false, reason: 'missing landscape terrain-infrastructure assessment' };
  }
  if (primaryFocus === 'city-panorama' && !['strong', 'medium'].includes(skylineProminence)) {
    return { keep: false, reason: 'missing city skyline-prominence assessment' };
  }
  if (primaryFocus === 'natural-landscape' && skylineProminence !== 'not-applicable') {
    return { keep: false, reason: 'missing natural-landscape skyline assessment' };
  }
  return { keep: true, reason: 'wallpaper-ready landscape composition' };
}

/** 为视觉模型构造严格的像素判定指令，防止“出现相关词/场景”被误当作目标图片。 */
export function buildVisionPrompt(targetCategory, { confirmation = false } = {}) {
  const rules = CATEGORY_VISUAL_RULES[targetCategory];
  if (!rules) throw new Error(`unsupported visual category: ${targetCategory}`);
  const celestialOutput = targetCategory === 'celestial-body-wallpaper'
    ? ',"subjectKind":"spherical-body|extended-formation|dense-star-field","subjectCoverage":0.0,"emptyBlackCoverage":0.0,"presentation":"wallpaper|scientific-observation|terrestrial-landscape|sparse-deep-field|other","starFieldDensity":"dense|sparse|not-applicable","spaceHardwareRole":"none|secondary|dominant"'
    : '';
  const animalOutput = targetCategory === 'animals'
    ? ',"animalClass":"mammal|bird|fish|reptile|amphibian|invertebrate|unknown","subjectRole":"primary|secondary|background|ambiguous","bodyCoverage":"full-body|near-full-body|partial|head-only|close-up|unknown","imageClarity":"clear|soft|blurry|noisy|unknown","graphicContent":"none|blood|corpse|wound|disturbing|unknown","welfareState":"natural|restrained|distressed|overly-staged|human-intervened|unknown","environment":"clean-natural|human-made|cage|fence|wire|people-dominant|dirty|unknown","coatColor":"not-black-cat|black-cat|not-applicable|unknown","comfortLevel":"comfortable|neutral|uncomfortable|unknown","appealTier":"high|medium|low|unknown","interactionState":"peaceful|neutral|predation|aggression|distressed|unknown","occlusionLevel":"none|minor|major|unknown","groupDensity":"single|small-group|dense-group|unknown","foregroundClarity":"clear|mixed|blurred|unknown","compositionQuality":"balanced|busy|awkward|unknown","aestheticScore":4'
    : '';
  const animalFieldChecklist = targetCategory === 'animals'
    ? 'Animal field checklist: always output all sixteen animal fields; never omit, null, or rename a field. Perform a dominant-subject and species/class checkpoint before scoring aesthetics. Use subjectRole=primary only when one allowed animal clearly dominates the frame and is the immediate visual focal point; use secondary or background when the animal is incidental, tiny, or behind a person/object, and use ambiguous when the focal point cannot be established; any value other than primary must be rejected. Use animalClass=mammal or bird only for the allowed classes; use fish, reptile, amphibian, or invertebrate for excluded classes. If a person, sports scene, stadium, food/fruit still life, or animal-free landscape is visually dominant, reject before considering metadata. Use bodyCoverage=full-body only when the entire animal is visible, near-full-body only when no important body part is cropped, and partial/head-only/close-up whenever any important body part is cropped or the frame is a detail shot. Use imageClarity=clear only when fur or feathers and other visible texture are readable at the displayed scale. Use welfareState=natural only when no visible restraint, distress, feeding, handling, birthday/display prop, performance, or staged photo-op is present. Use environment=clean-natural only when no person, cage, fence, wire mesh, or dominant artificial setting is visible. Use coatColor=not-applicable for non-cats and not-black-cat for cats that are not black; use black-cat for black cats. Use comfortLevel=uncomfortable for any excluded animal type or disturbing content; otherwise use comfortable only for a visually pleasant, non-graphic frame. Use appealTier=high for companion animals and charismatic species, medium for familiar wildlife and birds, and low for neutral species; low is rejected. Use interactionState=predation for catching, carrying, biting, hunting, attacking, or threatening prey; use peaceful or neutral only for calm non-predatory scenes. Use occlusionLevel=major when leaves, another animal, foreground blur, water, or darkness hides an important body part. Use groupDensity=dense-group for colonies, crowded herds, or many overlapping animals. Use foregroundClarity=blurred or mixed when the foreground animals are out of focus or the image has no single clear primary subject. Use compositionQuality=balanced only when the frame has a calm, coherent, aesthetically pleasing arrangement without awkward crop or clutter. Score aestheticScore from 1 to 5; keep only 4 or 5. If any field cannot be decided from pixels, output unknown and keep=false.'
    : '';
  const landscapeOutput = targetCategory === 'landscape'
    ? ',"presentation":"wallpaper|reportage|close-up|other","primaryFocus":"natural-landscape|city-panorama|portrait|crowd|vehicle|road|single-building|plant-closeup|object|event|disaster|other","environmentCoverage":0.0,"spatialDepth":"strong|weak|not-applicable","foregroundDistraction":"none|minor|dominant","sourceImageText":false,"frameOrientation":"landscape|portrait|square|panoramic|other","compositionSignals":["wide-environment|layered-depth|clear-anchor|balanced-off-center|foreground-frame|leading-lines|minimalist|symmetry|aerial|close-up|news-reportage|other"],"subjectClarity":"clear|ambiguous","horizonPlacement":"centered|off-center-balanced|off-center-unbalanced|not-visible","visualCalmness":"high|medium|low","visualBalance":"balanced|unbalanced","humanPresence":"none|secondary|dominant","builtEnvironmentRole":"none|secondary|dominant","aestheticScore":1,"excludedRegionSignal":"evident|likely|not-evident|uncertain","sceneType":"natural-scenery|open-city-panorama|dense-cityscape|maritime-infrastructure|transport-waterfront|daily-life-reportage|crowd-event|other","vesselRole":"none|incidental|prominent|dominant","crowdScale":"none|sparse|clustered|crowd","editorialContext":"none|daily-life|event|incident|infrastructure-documentary","urbanOpenness":"not-applicable|open|insufficient","compositeImage":false,"anchorStrength":"strong|medium|weak|none","negativeSpaceDominance":"balanced|dominant-empty|not-applicable","artificialLightRole":"none|incidental|prominent|dominant","skylineProminence":"not-applicable|strong|medium|weak","industrialDocumentary":false,"cityInfrastructureRole":"not-applicable|none|incidental|prominent|dominant","coastalStructureRole":"none|incidental|prominent|dominant","terrainInfrastructureRole":"none|incidental|prominent|dominant","cityAnchorType":"skyline|landmark-cluster|bridge|waterfront-skyline|mountain-city|none","visualClutter":"low|medium|high"'
    : '';
  return [
    'You are a strict AFP image curator. Inspect only the image pixels.',
    ...(confirmation ? ['Confirmation pass: challenge the previous keep decision. Actively search for any hard exclusion, weak anchor, empty negative space, composite sequence, artificial lighting, coastal structure, transport infrastructure, industrial foreground, activity, or reportage evidence. Keep only if the image still clearly passes every rule.'] : []),
    `Target category: ${targetCategory}.`,
    'Decision order: first identify the dominant visual subject and composition; then apply the target test; finally apply every hard exclusion.',
    `Positive visual test: ${rules.positive}`,
    `Mandatory evidence: ${rules.required}`,
    `Hard exclusions: ${rules.exclude}`,
    animalFieldChecklist,
    'Keep the image only when every positive and mandatory condition is satisfied and no hard exclusion applies. Popularity is a ranking signal after hard comfort filtering, not a substitute for visual acceptance.',
    'Confidence means confidence that the target category is the primary visual subject, not confidence that any related object or word exists.',
    `The local retention floor for ${targetCategory} is ${effectiveThreshold(targetCategory).toFixed(2)}; do not return keep=true below it.`,
    'When uncertain, partially occluded, metadata-dependent, or context-dependent, return category="none", keep=false, and confidence below 0.80.',
    'For celestial wallpaper, ignore AFP watermarks, agency credit bars, embedded AFP IDs, viewer controls, and metadata-page UI as preview artifacts; judge the underlying image behind those overlays. Reject source-image text, logos, labels, borders, or collage panels that are part of the image itself.',
    'Never use caption, title, keywords, OCR, filename, or external knowledge as evidence.',
    `Return JSON only with exactly this shape: {"category":"animals|food|landscape|movie-poster|celestial-body-wallpaper|none","confidence":0.0,"keep":true${animalOutput}${celestialOutput}${landscapeOutput},"reason":"short pixel-based reason"}.`,
    'The reason must name the visible subject or the decisive exclusion in one short sentence; do not reveal hidden reasoning.',
  ].join('\n');
}

async function mapWithConcurrency(items, concurrency, worker) {
  const results = new Array(items.length);
  let nextIndex = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (nextIndex < items.length) {
      const current = nextIndex;
      nextIndex += 1;
      results[current] = await worker(items[current]);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * 对候选清单做真实预览复核；失败候选默认不保留，避免错误写入收藏夹。
 */
function candidateId(value) {
  const id = String(value ?? '').trim();
  return id || null;
}

export function normalizedCandidateTitle(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * 在预览前执行轻量候选去重。远端/历史 ID 由调用方传入；同批跨类别 ID
 * 与规范化标题簇在这里再次拦截，避免视觉 CLI 被重复候选绕过。
 */
export function dedupeCandidateManifest(candidateManifest, {
  excludedIds = new Set(),
  excludedTitleKeys = new Set(),
} = {}) {
  const blockedIds = excludedIds instanceof Set ? new Set(excludedIds) : new Set(excludedIds);
  const blockedTitles = excludedTitleKeys instanceof Set ? new Set(excludedTitleKeys) : new Set(excludedTitleKeys);
  const duplicateExcludedCandidates = [];
  const categories = (candidateManifest?.categories ?? []).map((group) => {
    const groupExcluded = [];
    const candidates = [];
    for (const candidate of group.candidates ?? []) {
      const id = candidateId(candidate?.id);
      const titleKey = normalizedCandidateTitle(candidate?.title);
      let reason = null;
      if (id && blockedIds.has(id)) reason = 'reserved-or-historical-id';
      else if (titleKey && blockedTitles.has(titleKey)) reason = 'historical-title-cluster';
      if (reason) {
        const record = { ...candidate, duplicateExclusion: reason };
        groupExcluded.push(record);
        duplicateExcludedCandidates.push(record);
        continue;
      }
      if (id) blockedIds.add(id);
      if (titleKey) blockedTitles.add(titleKey);
      candidates.push(candidate);
    }
    return {
      ...group,
      candidates,
      duplicateExclusionCount: Number(group.duplicateExclusionCount ?? 0) + groupExcluded.length,
      ...(groupExcluded.length ? {
        duplicateExcludedCandidates: [...(group.duplicateExcludedCandidates ?? []), ...groupExcluded],
      } : {}),
    };
  });
  return {
    ...candidateManifest,
    categories,
    duplicateExclusionCount: Number(candidateManifest?.duplicateExclusionCount ?? 0) + duplicateExcludedCandidates.length,
    ...(duplicateExcludedCandidates.length ? {
      duplicateExcludedCandidates: [...(candidateManifest?.duplicateExcludedCandidates ?? []), ...duplicateExcludedCandidates],
    } : {}),
  };
}

export async function triageCandidates({
  candidateManifest,
  previewClient,
  visionClient,
  threshold = 0.8,
  concurrency = 2,
  onProgress = () => {},
  excludedIds = new Set(),
  excludedTitleKeys = new Set(),
} = {}) {
  if (!Array.isArray(candidateManifest?.categories)) throw new Error('candidate manifest categories are required');
  if (!Number.isInteger(concurrency) || concurrency < 1) throw new Error('concurrency must be a positive integer');
  const dedupedManifest = dedupeCandidateManifest(candidateManifest, { excludedIds, excludedTitleKeys });
  const tasks = dedupedManifest.categories.flatMap((group) => (group.candidates ?? []).map((candidate) => ({
    candidate,
    category: group.category,
  })));
  let completed = 0;
  return mapWithConcurrency(tasks, concurrency, async ({ candidate, category }) => {
    try {
      const preview = await previewClient.getPreviewBytes(candidate.id);
      const raw = await visionClient.classify({
        prompt: buildVisionPrompt(category),
        bytes: preview.bytes,
        contentType: preview.contentType,
      });
      const appliedThreshold = effectiveThreshold(category, threshold);
      let normalized = normalizeVisionDecision(raw, category, appliedThreshold);
      let composition = category === 'celestial-body-wallpaper'
        ? validateCelestialWallpaperComposition(normalized)
        : category === 'animals'
          ? validateAnimalDecision(normalized)
        : category === 'landscape'
          ? validateLandscapeWallpaperComposition(normalized)
          : { keep: true, reason: null };
      if (category === 'landscape' && normalized.keep && composition.keep) {
        const confirmationRaw = await visionClient.classify({
          prompt: buildVisionPrompt(category, { confirmation: true }),
          bytes: preview.bytes,
          contentType: preview.contentType,
        });
        normalized = normalizeVisionDecision(confirmationRaw, category, appliedThreshold);
        composition = validateLandscapeWallpaperComposition(normalized);
      }
      const keep = normalized.keep && composition.keep;
      const sourceFields = candidate.sourceMetadata ? {
        sourceId: candidate.sourceMetadata.sourceId,
        sourceType: candidate.sourceMetadata.sourceType,
        fieldMode: candidate.sourceMetadata.fieldMode,
        countryCode: candidate.sourceMetadata.countryCode,
        city: candidate.sourceMetadata.city,
        creator: candidate.sourceMetadata.creator,
        queryHash: candidate.sourceMetadata.queryHash,
      } : {};
      return {
        id: candidate.id,
        guid: candidate.guid,
        category,
        predictedCategory: normalized.category,
        confidence: normalized.confidence,
        keep,
        reason: keep ? normalized.reason : (normalized.keep ? composition.reason : normalized.reason),
        ...(category === 'celestial-body-wallpaper' ? {
          subjectKind: normalized.subjectKind,
          subjectCoverage: normalized.subjectCoverage,
          emptyBlackCoverage: normalized.emptyBlackCoverage,
          presentation: normalized.presentation,
          starFieldDensity: normalized.starFieldDensity,
          spaceHardwareRole: normalized.spaceHardwareRole,
        } : category === 'animals' ? {
          subjectRole: normalized.subjectRole,
          animalClass: normalized.animalClass,
          bodyCoverage: normalized.bodyCoverage,
          imageClarity: normalized.imageClarity,
          graphicContent: normalized.graphicContent,
          welfareState: normalized.welfareState,
          environment: normalized.environment,
          coatColor: normalized.coatColor,
          comfortLevel: normalized.comfortLevel,
          appealTier: normalized.appealTier,
          interactionState: normalized.interactionState,
          occlusionLevel: normalized.occlusionLevel,
          groupDensity: normalized.groupDensity,
          foregroundClarity: normalized.foregroundClarity,
          compositionQuality: normalized.compositionQuality,
          aestheticScore: normalized.aestheticScore,
        } : category === 'landscape' ? {
          presentation: normalized.presentation,
          primaryFocus: normalized.primaryFocus,
          environmentCoverage: normalized.environmentCoverage,
          spatialDepth: normalized.spatialDepth,
          foregroundDistraction: normalized.foregroundDistraction,
          sourceImageText: normalized.sourceImageText,
          frameOrientation: normalized.frameOrientation,
          wallpaperFit: classifyLandscapeWallpaperFit(normalized.frameOrientation),
          compositionSignals: normalized.compositionSignals,
          subjectClarity: normalized.subjectClarity,
          horizonPlacement: normalized.horizonPlacement,
          visualCalmness: normalized.visualCalmness,
          visualBalance: normalized.visualBalance,
          humanPresence: normalized.humanPresence,
          builtEnvironmentRole: normalized.builtEnvironmentRole,
          aestheticScore: normalized.aestheticScore,
          excludedRegionSignal: normalized.excludedRegionSignal,
          sceneType: normalized.sceneType,
          vesselRole: normalized.vesselRole,
          crowdScale: normalized.crowdScale,
          editorialContext: normalized.editorialContext,
          urbanOpenness: normalized.urbanOpenness,
          compositeImage: normalized.compositeImage,
          anchorStrength: normalized.anchorStrength,
          negativeSpaceDominance: normalized.negativeSpaceDominance,
          artificialLightRole: normalized.artificialLightRole,
          skylineProminence: normalized.skylineProminence,
          industrialDocumentary: normalized.industrialDocumentary,
          cityInfrastructureRole: normalized.cityInfrastructureRole,
          coastalStructureRole: normalized.coastalStructureRole,
          terrainInfrastructureRole: normalized.terrainInfrastructureRole,
          ...(Object.prototype.hasOwnProperty.call(normalized, 'cityAnchorType') ? {
            cityAnchorType: normalized.cityAnchorType,
            visualClutter: normalized.visualClutter,
          } : {}),
        } : {}),
        ...sourceFields,
        originalIndex: candidate.originalIndex,
        appliedThreshold,
      };
    } catch {
      return {
        id: candidate.id,
        guid: candidate.guid,
        category,
        predictedCategory: 'none',
        confidence: 0,
        keep: false,
        reason: 'preview or vision request failed',
        ...(candidate.sourceMetadata ? {
          sourceId: candidate.sourceMetadata.sourceId,
          sourceType: candidate.sourceMetadata.sourceType,
          fieldMode: candidate.sourceMetadata.fieldMode,
          countryCode: candidate.sourceMetadata.countryCode,
          city: candidate.sourceMetadata.city,
          creator: candidate.sourceMetadata.creator,
          queryHash: candidate.sourceMetadata.queryHash,
        } : {}),
        originalIndex: candidate.originalIndex,
        appliedThreshold: effectiveThreshold(category, threshold),
      };
    } finally {
      // 每个图片任务只计一次；风景二次视觉确认不能重复增加进度。
      onProgress({ completed: ++completed, total: tasks.length });
    }
  });
}

/**
 * 对每类复核结果执行本地排序和数量上限；输出中只有身份与决策，不含图片或临时媒体地址。
 */
export function finalizeDecisionManifest(candidateManifest, decisions, {
  threshold = 0.8,
  limitPerCategory = 100,
  createdAt = new Date().toISOString(),
} = {}) {
  const byCategory = new Map();
  for (const decision of decisions ?? []) {
    const list = byCategory.get(decision.category) ?? [];
    list.push({ ...decision });
    byCategory.set(decision.category, list);
  }
  const finalDecisions = [];
  for (const group of candidateManifest?.categories ?? []) {
    const categoryDecisions = byCategory.get(group.category) ?? [];
    const approved = categoryDecisions
      .filter((decision) => decision.keep === true && Number(decision.confidence) >= effectiveThreshold(group.category, threshold))
      .sort((left, right) => Number(right.confidence) - Number(left.confidence) || Number(left.originalIndex) - Number(right.originalIndex));
    const approvedIds = new Set(approved.slice(0, limitPerCategory).map((decision) => decision.id));
    for (const decision of categoryDecisions) {
      if (decision.keep && !approvedIds.has(decision.id)) {
        decision.keep = false;
        decision.reason = 'category limit reached';
      }
      finalDecisions.push(decision);
    }
  }
  const candidateById = new Map((candidateManifest?.categories ?? []).flatMap((group) => (
    (group.candidates ?? []).map((candidate) => [candidate.id, candidate])
  )));
  const sourceMetrics = new Map();
  for (const group of candidateManifest?.categories ?? []) {
    for (const source of group.sourceStats ?? []) sourceMetrics.set(source.sourceId, { ...source, visualKeptCount: 0 });
  }
  for (const decision of finalDecisions) {
    const metadata = candidateById.get(decision.id)?.sourceMetadata ?? decision;
    const sourceId = metadata?.sourceId;
    if (!sourceId) continue;
    const metric = sourceMetrics.get(sourceId) ?? {
      sourceId,
      sourceType: metadata.sourceType,
      fieldMode: metadata.fieldMode,
      countryCode: metadata.countryCode,
      city: metadata.city,
      creator: metadata.creator,
      query: metadata.query,
      queryHash: metadata.queryHash,
      rawRecallCount: 0,
      metadataRejectedCount: 0,
      visualKeptCount: 0,
      pagesFetched: 0,
      rejectionReasons: [],
    };
    if (decision.keep === true) metric.visualKeptCount += 1;
    sourceMetrics.set(sourceId, metric);
  }
  return {
    version: 1,
    createdAt,
    threshold,
    limitPerCategory,
    duplicateExclusionCount: Number(candidateManifest?.duplicateExclusionCount ?? 0),
    ...(Array.isArray(candidateManifest?.duplicateExcludedCandidates) ? {
      duplicateExcludedCandidates: candidateManifest.duplicateExcludedCandidates,
    } : {}),
    decisions: finalDecisions,
    ...(sourceMetrics.size ? { sourceMetrics: [...sourceMetrics.values()] } : {}),
  };
}
