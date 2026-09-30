import { createHttpClient } from './http-client.mjs';

export const VISION_CATEGORIES = Object.freeze(['animals', 'food', 'landscape', 'movie-poster', 'celestial-body-wallpaper', 'none']);
const CELESTIAL_SUBJECT_KINDS = new Set(['spherical-body', 'extended-formation', 'dense-star-field']);
const CELESTIAL_PRESENTATIONS = new Set(['wallpaper', 'scientific-observation', 'terrestrial-landscape', 'sparse-deep-field', 'other']);
const STAR_FIELD_DENSITIES = new Set(['dense', 'sparse', 'not-applicable']);
const CELESTIAL_SPACE_HARDWARE_ROLES = new Set(['none', 'secondary', 'dominant']);
const LANDSCAPE_PRESENTATIONS = new Set(['wallpaper', 'reportage', 'close-up', 'other']);
const LANDSCAPE_PRIMARY_FOCUSES = new Set([
  'natural-landscape',
  'city-panorama',
  'portrait',
  'crowd',
  'vehicle',
  'road',
  'single-building',
  'plant-closeup',
  'object',
  'event',
  'disaster',
  'other',
]);
const SPATIAL_DEPTHS = new Set(['strong', 'weak', 'not-applicable']);
const FOREGROUND_DISTRACTIONS = new Set(['none', 'minor', 'dominant']);
const LANDSCAPE_FRAME_ORIENTATIONS = new Set(['landscape', 'portrait', 'square', 'panoramic', 'other']);
const LANDSCAPE_COMPOSITION_SIGNALS = new Set([
  'wide-environment',
  'layered-depth',
  'clear-anchor',
  'balanced-off-center',
  'foreground-frame',
  'leading-lines',
  'minimalist',
  'symmetry',
  'aerial',
  'close-up',
  'news-reportage',
  'other',
]);
const LANDSCAPE_SUBJECT_CLARITIES = new Set(['clear', 'ambiguous']);
const LANDSCAPE_HORIZON_PLACEMENTS = new Set([
  'centered',
  'off-center-balanced',
  'off-center-unbalanced',
  'not-visible',
]);
const VISUAL_CALMNESS_LEVELS = new Set(['high', 'medium', 'low']);
const LANDSCAPE_VISUAL_BALANCES = new Set(['balanced', 'unbalanced']);
const HUMAN_PRESENCE_LEVELS = new Set(['none', 'secondary', 'dominant']);
const BUILT_ENVIRONMENT_ROLES = new Set(['none', 'secondary', 'dominant']);
const EXCLUDED_REGION_SIGNALS = new Set(['evident', 'likely', 'not-evident', 'uncertain']);
const LANDSCAPE_SCENE_TYPES = new Set([
  'natural-scenery',
  'open-city-panorama',
  'dense-cityscape',
  'maritime-infrastructure',
  'transport-waterfront',
  'daily-life-reportage',
  'crowd-event',
  'other',
]);
const LANDSCAPE_VESSEL_ROLES = new Set(['none', 'incidental', 'prominent', 'dominant']);
const LANDSCAPE_CROWD_SCALES = new Set(['none', 'sparse', 'clustered', 'crowd']);
const LANDSCAPE_EDITORIAL_CONTEXTS = new Set([
  'none',
  'daily-life',
  'event',
  'incident',
  'infrastructure-documentary',
]);
const LANDSCAPE_URBAN_OPENNESS = new Set(['not-applicable', 'open', 'insufficient']);
const LANDSCAPE_ANCHOR_STRENGTHS = new Set(['strong', 'medium', 'weak', 'none']);
const LANDSCAPE_NEGATIVE_SPACE_DOMINANCE = new Set(['balanced', 'dominant-empty', 'not-applicable']);
const LANDSCAPE_ARTIFICIAL_LIGHT_ROLES = new Set(['none', 'incidental', 'prominent', 'dominant']);
const LANDSCAPE_SKYLINE_PROMINENCE = new Set(['not-applicable', 'strong', 'medium', 'weak']);
const LANDSCAPE_CITY_INFRASTRUCTURE_ROLES = new Set(['not-applicable', 'none', 'incidental', 'prominent', 'dominant']);
const LANDSCAPE_COASTAL_STRUCTURE_ROLES = new Set(['none', 'incidental', 'prominent', 'dominant']);
const LANDSCAPE_TERRAIN_INFRASTRUCTURE_ROLES = new Set(['none', 'incidental', 'prominent', 'dominant']);
const LANDSCAPE_CITY_ANCHOR_TYPES = new Set(['skyline', 'landmark-cluster', 'bridge', 'waterfront-skyline', 'mountain-city', 'none']);
const LANDSCAPE_VISUAL_CLUTTER_LEVELS = new Set(['low', 'medium', 'high']);
const ANIMAL_BODY_COVERAGES = new Set(['full-body', 'near-full-body', 'partial', 'head-only', 'close-up', 'unknown']);
const ANIMAL_IMAGE_CLARITIES = new Set(['clear', 'soft', 'blurry', 'noisy', 'unknown']);
const ANIMAL_GRAPHIC_CONTENT = new Set(['none', 'blood', 'corpse', 'wound', 'disturbing', 'unknown']);
const ANIMAL_WELFARE_STATES = new Set(['natural', 'restrained', 'distressed', 'overly-staged', 'human-intervened', 'unknown']);
const ANIMAL_ENVIRONMENTS = new Set(['clean-natural', 'human-made', 'cage', 'fence', 'wire', 'people-dominant', 'dirty', 'unknown']);
const ANIMAL_COAT_COLORS = new Set(['not-black-cat', 'black-cat', 'not-applicable', 'unknown']);
const ANIMAL_COMFORT_LEVELS = new Set(['comfortable', 'neutral', 'uncomfortable', 'unknown']);
const ANIMAL_APPEAL_TIERS = new Set(['high', 'medium', 'low', 'unknown']);
const ANIMAL_INTERACTION_STATES = new Set(['peaceful', 'neutral', 'predation', 'aggression', 'distressed', 'unknown']);
const ANIMAL_OCCLUSION_LEVELS = new Set(['none', 'minor', 'major', 'unknown']);
const ANIMAL_GROUP_DENSITIES = new Set(['single', 'small-group', 'dense-group', 'unknown']);
const ANIMAL_FOREGROUND_CLARITIES = new Set(['clear', 'mixed', 'blurred', 'unknown']);
const ANIMAL_CLASSES = new Set(['mammal', 'bird', 'fish', 'reptile', 'amphibian', 'invertebrate', 'unknown']);
const ANIMAL_COMPOSITION_QUALITIES = new Set(['balanced', 'busy', 'awkward', 'unknown']);
const ANIMAL_SUBJECT_ROLES = new Set(['primary', 'secondary', 'background', 'ambiguous']);

function readEnvironment(name, environment = process.env) {
  const value = String(environment[name] ?? '').trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function readOptionalEnvironment(name, environment = process.env) {
  const value = String(environment[name] ?? '').trim();
  return value || undefined;
}

function stripFences(content) {
  const value = String(content ?? '').trim();
  const fenced = value.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return fenced ? fenced[1].trim() : value;
}

/** 解析模型的纯 JSON 输出；解析失败由调用方转换为可审计的不保留决策。 */
export function parseVisionJson(content) {
  return JSON.parse(stripFences(content));
}

function conciseReason(value, fallback) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim();
  return (text || fallback).slice(0, 240);
}

function normalizeAllowedList(value, allowed, limit = 4) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map((item) => String(item)).filter((item) => allowed.has(item)))].slice(0, limit);
}

/**
 * 按本地固定规则校验模型输出，避免模型把非目标类别或低置信判断带入收藏夹。
 */
export function normalizeVisionDecision(raw, targetCategory, threshold = 0.8) {
  let value;
  try {
    value = typeof raw === 'string' ? parseVisionJson(raw) : raw;
  } catch {
    return { category: 'none', confidence: 0, keep: false, reason: 'invalid model response' };
  }
  const category = VISION_CATEGORIES.includes(value?.category) ? value.category : 'none';
  const confidence = Number(value?.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
    return { category: 'none', confidence: 0, keep: false, reason: 'invalid model response' };
  }
  const keep = value?.keep === true && category === targetCategory && confidence >= threshold;
  const subjectKind = CELESTIAL_SUBJECT_KINDS.has(value?.subjectKind) ? value.subjectKind : null;
  const subjectCoverage = Number(value?.subjectCoverage);
  const emptyBlackCoverage = Number(value?.emptyBlackCoverage);
  const presentation = CELESTIAL_PRESENTATIONS.has(value?.presentation) ? value.presentation : null;
  const starFieldDensity = STAR_FIELD_DENSITIES.has(value?.starFieldDensity) ? value.starFieldDensity : null;
  const spaceHardwareRole = CELESTIAL_SPACE_HARDWARE_ROLES.has(value?.spaceHardwareRole) ? value.spaceHardwareRole : null;
  const landscapePresentation = LANDSCAPE_PRESENTATIONS.has(value?.presentation) ? value.presentation : null;
  const primaryFocus = LANDSCAPE_PRIMARY_FOCUSES.has(value?.primaryFocus) ? value.primaryFocus : null;
  const environmentCoverage = Number(value?.environmentCoverage);
  const spatialDepth = SPATIAL_DEPTHS.has(value?.spatialDepth) ? value.spatialDepth : null;
  const foregroundDistraction = FOREGROUND_DISTRACTIONS.has(value?.foregroundDistraction) ? value.foregroundDistraction : null;
  const sourceImageText = typeof value?.sourceImageText === 'boolean' ? value.sourceImageText : null;
  const frameOrientation = LANDSCAPE_FRAME_ORIENTATIONS.has(value?.frameOrientation) ? value.frameOrientation : null;
  const compositionSignals = normalizeAllowedList(value?.compositionSignals, LANDSCAPE_COMPOSITION_SIGNALS);
  const subjectClarity = LANDSCAPE_SUBJECT_CLARITIES.has(value?.subjectClarity) ? value.subjectClarity : null;
  const horizonPlacement = LANDSCAPE_HORIZON_PLACEMENTS.has(value?.horizonPlacement) ? value.horizonPlacement : null;
  const visualCalmness = VISUAL_CALMNESS_LEVELS.has(value?.visualCalmness) ? value.visualCalmness : null;
  const visualBalance = LANDSCAPE_VISUAL_BALANCES.has(value?.visualBalance) ? value.visualBalance : null;
  const humanPresence = HUMAN_PRESENCE_LEVELS.has(value?.humanPresence) ? value.humanPresence : null;
  const builtEnvironmentRole = BUILT_ENVIRONMENT_ROLES.has(value?.builtEnvironmentRole) ? value.builtEnvironmentRole : null;
  const aestheticScore = Number(value?.aestheticScore);
  const excludedRegionSignal = EXCLUDED_REGION_SIGNALS.has(value?.excludedRegionSignal) ? value.excludedRegionSignal : null;
  const sceneType = LANDSCAPE_SCENE_TYPES.has(value?.sceneType) ? value.sceneType : null;
  const vesselRole = LANDSCAPE_VESSEL_ROLES.has(value?.vesselRole) ? value.vesselRole : null;
  const crowdScale = LANDSCAPE_CROWD_SCALES.has(value?.crowdScale) ? value.crowdScale : null;
  const editorialContext = LANDSCAPE_EDITORIAL_CONTEXTS.has(value?.editorialContext) ? value.editorialContext : null;
  const urbanOpenness = LANDSCAPE_URBAN_OPENNESS.has(value?.urbanOpenness) ? value.urbanOpenness : null;
  const compositeImage = typeof value?.compositeImage === 'boolean' ? value.compositeImage : null;
  const anchorStrength = LANDSCAPE_ANCHOR_STRENGTHS.has(value?.anchorStrength) ? value.anchorStrength : null;
  const negativeSpaceDominance = LANDSCAPE_NEGATIVE_SPACE_DOMINANCE.has(value?.negativeSpaceDominance) ? value.negativeSpaceDominance : null;
  const artificialLightRole = LANDSCAPE_ARTIFICIAL_LIGHT_ROLES.has(value?.artificialLightRole) ? value.artificialLightRole : null;
  const skylineProminence = LANDSCAPE_SKYLINE_PROMINENCE.has(value?.skylineProminence) ? value.skylineProminence : null;
  const industrialDocumentary = typeof value?.industrialDocumentary === 'boolean' ? value.industrialDocumentary : null;
  const cityInfrastructureRole = LANDSCAPE_CITY_INFRASTRUCTURE_ROLES.has(value?.cityInfrastructureRole) ? value.cityInfrastructureRole : null;
  const coastalStructureRole = LANDSCAPE_COASTAL_STRUCTURE_ROLES.has(value?.coastalStructureRole) ? value.coastalStructureRole : null;
  const terrainInfrastructureRole = LANDSCAPE_TERRAIN_INFRASTRUCTURE_ROLES.has(value?.terrainInfrastructureRole) ? value.terrainInfrastructureRole : null;
  const cityAnchorType = LANDSCAPE_CITY_ANCHOR_TYPES.has(value?.cityAnchorType) ? value.cityAnchorType : null;
  const visualClutter = LANDSCAPE_VISUAL_CLUTTER_LEVELS.has(value?.visualClutter) ? value.visualClutter : null;
  const animalBodyCoverage = ANIMAL_BODY_COVERAGES.has(value?.bodyCoverage) ? value.bodyCoverage : null;
  const animalImageClarity = ANIMAL_IMAGE_CLARITIES.has(value?.imageClarity) ? value.imageClarity : null;
  const animalGraphicContent = ANIMAL_GRAPHIC_CONTENT.has(value?.graphicContent) ? value.graphicContent : null;
  const animalWelfareState = ANIMAL_WELFARE_STATES.has(value?.welfareState) ? value.welfareState : null;
  const animalEnvironment = ANIMAL_ENVIRONMENTS.has(value?.environment) ? value.environment : null;
  const animalCoatColor = ANIMAL_COAT_COLORS.has(value?.coatColor) ? value.coatColor : null;
  const animalComfortLevel = ANIMAL_COMFORT_LEVELS.has(value?.comfortLevel) ? value.comfortLevel : null;
  const animalAppealTier = ANIMAL_APPEAL_TIERS.has(value?.appealTier) ? value.appealTier : null;
  const animalInteractionState = ANIMAL_INTERACTION_STATES.has(value?.interactionState) ? value.interactionState : null;
  const animalOcclusionLevel = ANIMAL_OCCLUSION_LEVELS.has(value?.occlusionLevel) ? value.occlusionLevel : null;
  const animalGroupDensity = ANIMAL_GROUP_DENSITIES.has(value?.groupDensity) ? value.groupDensity : null;
  const animalForegroundClarity = ANIMAL_FOREGROUND_CLARITIES.has(value?.foregroundClarity) ? value.foregroundClarity : null;
  const animalClass = ANIMAL_CLASSES.has(value?.animalClass) ? value.animalClass : null;
  const animalCompositionQuality = ANIMAL_COMPOSITION_QUALITIES.has(value?.compositionQuality) ? value.compositionQuality : null;
  const animalSubjectRole = ANIMAL_SUBJECT_ROLES.has(value?.subjectRole) ? value.subjectRole : null;
  const animalAestheticScore = Number(value?.aestheticScore);
  const hasCityStructureFields = Object.prototype.hasOwnProperty.call(value ?? {}, 'cityAnchorType')
    || Object.prototype.hasOwnProperty.call(value ?? {}, 'visualClutter');
  return {
    category,
    confidence,
    keep,
    reason: conciseReason(value?.reason, keep ? 'target category confirmed' : 'did not meet local retention rules'),
    ...(targetCategory === 'animals' ? {
      subjectRole: animalSubjectRole,
      bodyCoverage: animalBodyCoverage,
      imageClarity: animalImageClarity,
      graphicContent: animalGraphicContent,
      welfareState: animalWelfareState,
      environment: animalEnvironment,
      coatColor: animalCoatColor,
      comfortLevel: animalComfortLevel,
      appealTier: animalAppealTier,
      interactionState: animalInteractionState,
      occlusionLevel: animalOcclusionLevel,
      groupDensity: animalGroupDensity,
      foregroundClarity: animalForegroundClarity,
      animalClass,
      compositionQuality: animalCompositionQuality,
      aestheticScore: Number.isFinite(animalAestheticScore) && animalAestheticScore >= 1 && animalAestheticScore <= 5
        ? animalAestheticScore
        : null,
    } : targetCategory === 'celestial-body-wallpaper' ? {
      subjectKind,
      subjectCoverage: Number.isFinite(subjectCoverage) && subjectCoverage >= 0 && subjectCoverage <= 1 ? subjectCoverage : null,
      emptyBlackCoverage: Number.isFinite(emptyBlackCoverage) && emptyBlackCoverage >= 0 && emptyBlackCoverage <= 1 ? emptyBlackCoverage : null,
      presentation,
      starFieldDensity,
      spaceHardwareRole,
    } : targetCategory === 'landscape' ? {
      presentation: landscapePresentation,
      primaryFocus,
      environmentCoverage: Number.isFinite(environmentCoverage) && environmentCoverage >= 0 && environmentCoverage <= 1 ? environmentCoverage : null,
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
      aestheticScore: Number.isInteger(aestheticScore) && aestheticScore >= 1 && aestheticScore <= 5 ? aestheticScore : null,
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
      ...(hasCityStructureFields ? { cityAnchorType, visualClutter } : {}),
    } : {}),
  };
}

function chatCompletionsUrl(baseUrl) {
  return `${baseUrl.replace(/\/+$/, '')}/chat/completions`;
}

/**
 * OpenAI-compatible Chat Completions 视觉客户端。
 * 预览字节会在本函数中即时转为 data URL，网络请求结束后不会写入任何运行时文件。
 */
export function createOpenAiCompatibleVisionClient({
  baseUrl = readEnvironment('VISION_BASE_URL'),
  apiKey = readEnvironment('VISION_API_KEY'),
  model = readEnvironment('VISION_MODEL'),
  reasoningModel = readOptionalEnvironment('VISION_REASONING_MODEL'),
  reasoningEffort = readOptionalEnvironment('VISION_REASONING_EFFORT'),
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = 120_000,
  retries = 2,
  sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
  maxResponseBytes = 4 * 1024 * 1024,
  logger,
} = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch implementation is required');
  if (!Number.isInteger(requestTimeoutMs) || requestTimeoutMs < 1) throw new Error('requestTimeoutMs must be a positive integer');
  if (!Number.isInteger(retries) || retries < 0) throw new Error('retries must be a non-negative integer');
  if (typeof sleep !== 'function') throw new Error('sleep must be a function');
  if (reasoningEffort && !['low', 'medium', 'high'].includes(reasoningEffort)) {
    throw new Error('VISION_REASONING_EFFORT must be low, medium, or high');
  }
  const httpClient = createHttpClient({
    fetchImpl,
    timeoutMs: requestTimeoutMs,
    retries,
    maxResponseBytes,
    sleep,
    logger,
    endpointCategory: 'vision-provider',
  });
  const selectedModel = reasoningModel ?? model;
  return {
    async classify({ prompt, bytes, contentType }) {
      return httpClient.retryOperation(async () => {
        const dataUrl = `data:${contentType};base64,${Buffer.from(bytes).toString('base64')}`;
        const response = await httpClient.request(chatCompletionsUrl(baseUrl), {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: selectedModel,
            temperature: 0,
            ...(reasoningEffort ? { reasoning_effort: reasoningEffort } : {}),
            messages: [{ role: 'user', content: [
              { type: 'text', text: prompt },
              { type: 'image_url', image_url: { url: dataUrl } },
            ] }],
          }),
        });
        const payload = await httpClient.readResponseJson(response);
        if (!response.ok) throw new Error(`vision request failed with HTTP ${response.status}`);
        const content = payload?.choices?.[0]?.message?.content;
        if (typeof content !== 'string') throw new Error('vision response content is unavailable');
        return parseVisionJson(content);
      });
    },
  };
}
