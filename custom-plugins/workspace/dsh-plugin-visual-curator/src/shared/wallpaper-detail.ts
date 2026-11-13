/** Bounded source-detail evidence can resolve a planning hold without weakening protection or final review. */
import {z} from 'zod'
import {wallpaperEdgeRepairSchema,wallpaperObservationPlanSchema,type WallpaperPlan,type WallpaperObjectRole} from './wallpaper.ts'
import { wallpaperEdgeRepairEvidenceSchema, wallpaperFindingSchema, wallpaperFindingBlocksEditing, wallpaperRetainedUncertaintySchema, wallpaperNativeDetailCovers, type WallpaperNativeDetail } from './wallpaper-evidence.ts'
const text=z.string().trim().min(1).max(4096),id=z.string().min(1).max(256)
/** A second observation reports every prior concern and cites actual saved source crops. */
export const wallpaperPlanDetailSchema=z.strictObject({
 version:z.enum(['wallpaper-plan-detail-v1','wallpaper-plan-detail-v2']),imageVersionId:id,
 sourceExtent:z.strictObject({extent:z.enum(['complete','cut-off','occluded','unknown','not-applicable']),reason:text}),
 findings:z.array(z.strictObject({concernId:id,result:z.enum(['resolved','unresolved','violated']),reason:text,evidenceImageVersionIds:z.array(id).min(1).max(8)})).max(19),
 observation:wallpaperObservationPlanSchema,
})
const scopedDetailSchema = wallpaperPlanDetailSchema.omit({ sourceExtent: true }).extend({
 version: z.literal('wallpaper-plan-detail-v3'),
 protectedSubjectExtent: wallpaperPlanDetailSchema.shape.sourceExtent.extend({ evidenceImageVersionIds: z.array(id).min(1).max(8).optional() }),
 backgroundTruncations: wallpaperObservationPlanSchema.shape.truncations.describe('Secondary scenery actually cut by the original frame. Empty when none; never include a protected subject or critical structure.'),
 observation: wallpaperObservationPlanSchema.omit({ truncations: true }),
})
const edgeDetailSchema = scopedDetailSchema.extend({ version: z.literal('wallpaper-plan-detail-v4'), edgeRepair: wallpaperEdgeRepairSchema })
const readinessDetailSchema = scopedDetailSchema.extend({
 version: z.literal('wallpaper-plan-detail-v5'), edgeRepair: wallpaperEdgeRepairEvidenceSchema,
 findings: z.array(wallpaperFindingSchema.extend({ result: z.enum(['resolved', 'unresolved', 'violated']) })).max(35),
 retainedUncertainties: z.array(wallpaperRetainedUncertaintySchema).max(16).describe('Each text must exactly match observation.uncertainties and reference a finding with result=unresolved, blocking=false and classification=normal-occlusion, background-crop or unseen-detail. Never reference a resolved edge-continuation finding. Split remaining unseen facts into a separate observation:i finding, where i is their index in observation.uncertainties.'),
})
/** Independently addressed concerns retain their exact first-pass text. */
export type WallpaperPlanDetail=z.infer<typeof wallpaperPlanDetailSchema> | z.infer<typeof scopedDetailSchema> | z.infer<typeof edgeDetailSchema> | z.infer<typeof readinessDetailSchema>
/** @param plan Saved first-pass evidence. @returns Stable concern identities without treating generic prose as resolved. */
export function wallpaperPlanConcerns(plan:WallpaperPlan):{id:string;text:string}[]{
 const concerns=plan.uncertainties.map((text,index)=>({id:'uncertainty:'+index,text}))
 if(plan.truncations.length)concerns.push({id:'source-extent',text:'Verify the complete subject against the whole original frame before any rendering or expansion. Distinguish actual frame truncation from normal perspective or self-occlusion: '+plan.truncations.join('；')})
 if(plan.mode==='uncertain')concerns.push({id:'subject-mode',text:'Identify the visible main subject and its complete source-frame extent.'})
 const requiresCritical = plan.objectRoles ? plan.objectRoles.some(object => object.role === 'critical-part') : plan.mode === 'single' || plan.mode === 'group'
 if (!plan.regions.length || (plan.mode === 'single' || plan.mode === 'group') && (!plan.regions.some(region => region.role === 'subject') || requiresCritical && !plan.regions.some(region => region.role === 'critical'))) concerns.push({ id: 'protected-regions', text: 'Locate the complete visible subject and its critical structures in source coordinates.' })
 return concerns
}
/** @param plan Existing source-coordinate protection. @returns One context-bearing subject crop; no image-wide substitute for missing localization. */
export function wallpaperPlanDetailRect(plan:WallpaperPlan):{x:number;y:number;width:number;height:number}|undefined{
 const regions=plan.regions.filter(r=>r.role==='subject'||r.role==='critical')
 if(!regions.length)return undefined
 const left=Math.min(...regions.map(r=>r.rect.x)),top=Math.min(...regions.map(r=>r.rect.y)),right=Math.max(...regions.map(r=>r.rect.x+r.rect.width)),bottom=Math.max(...regions.map(r=>r.rect.y+r.rect.height))
 // The V1 crop includes one eighth of the subject span on each side as visual context.
 const x=Math.max(0,left-(right-left)/8),y=Math.max(0,top-(bottom-top)/8)
 const rect={x,y,width:Math.min(1,right+(right-left)/8)-x,height:Math.min(1,bottom+(bottom-top)/8)-y}
 return rect.width<1||rect.height<1?rect:undefined
}
/** @param sourceId Canonical original. @param concerns Exact pending concerns. @param detailIds Actual saved crops in this request. @param version Frozen protocol; omission retains V1. @param nativeDetails Host-measured crop coordinates; V5 cannot authorize localized repairs without them. @returns Strict evidence-bound response validation. */
export function wallpaperPlanDetailOutputSchema(sourceId:string,concerns:readonly {id:string;text:string}[],detailIds:readonly string[],version:WallpaperPlanDetail['version']='wallpaper-plan-detail-v1',nativeDetails:readonly WallpaperNativeDetail[]=[]):z.ZodType<WallpaperPlanDetail>{
 const imageVersionId = z.literal(sourceId)
 const evidenceImageVersionIds = z.array(z.enum([sourceId,...detailIds])).min(1).max(8)
 const binding = {concernId:z.enum(concerns.map(c=>c.id)),evidenceImageVersionIds}
 const findings = z.array(wallpaperPlanDetailSchema.shape.findings.element.extend(binding)).max(19)
 const scoped = version === 'wallpaper-plan-detail-v4' ? edgeDetailSchema : scopedDetailSchema
 const scopedBinding = {imageVersionId, protectedSubjectExtent: scopedDetailSchema.shape.protectedSubjectExtent.extend({evidenceImageVersionIds: evidenceImageVersionIds.optional()}).describe('Judge only the complete visible main subject and its protected critical structures against the whole original frame.'), observation:scopedDetailSchema.shape.observation.extend({imageVersionId})}
 const schema = version === 'wallpaper-plan-detail-v5'
  ? readinessDetailSchema.extend({...scopedBinding, findings:z.array(readinessDetailSchema.shape.findings.element.extend({...binding, concernId:z.enum([...concerns.map(concern=>concern.id),...Array.from({length:16},(_,index)=>'observation:'+index)])})).max(35)})
  : version === 'wallpaper-plan-detail-v3' || version === 'wallpaper-plan-detail-v4'
  ? scoped.extend({...scopedBinding, findings})
  : wallpaperPlanDetailSchema.extend({version:z.literal(version), imageVersionId, findings, observation:wallpaperObservationPlanSchema.extend({imageVersionId})})
 return schema.superRefine((value,ctx)=>{
  if(value.imageVersionId!==sourceId||value.observation.imageVersionId!==sourceId)ctx.addIssue({code:'custom',message:'detail-source-mismatch'})
  const ids=value.findings.map(f=>f.concernId)
  if(value.version!=='wallpaper-plan-detail-v5'&&ids.length!==concerns.length||new Set(ids).size!==ids.length||concerns.some(c=>!ids.includes(c.id)))ctx.addIssue({code:'custom',message:'detail-concerns-mismatch'})
  if(!detailIds.length||value.findings.some(f=>!f.evidenceImageVersionIds.some(id=>detailIds.includes(id))||new Set(f.evidenceImageVersionIds).size!==f.evidenceImageVersionIds.length||f.evidenceImageVersionIds.some(id=>id!==sourceId&&!detailIds.includes(id))))ctx.addIssue({code:'custom',message:'detail-evidence-mismatch'})
  if ('edgeRepair' in value && value.edgeRepair.classification === 'edge-continuation' && (value.protectedSubjectExtent.extent !== 'cut-off' || !value.edgeRepair.edges.length || new Set(value.edgeRepair.edges).size !== value.edgeRepair.edges.length)) ctx.addIssue({code:'custom',message:'edge-repair-evidence-mismatch'})
  if (value.version !== 'wallpaper-plan-detail-v5') return
  const nativeViews = nativeDetails.filter(view => detailIds.includes(view.imageVersionId))
  if (value.findings.some(finding => !concerns.some(concern => concern.id === finding.concernId) && !value.observation.uncertainties[Number(finding.concernId.slice('observation:'.length))])) ctx.addIssue({code:'custom',path:['findings'],message:'detail-new-uncertainty-mismatch'})
  const retained = value.retainedUncertainties
  if (new Set(retained.map(entry => entry.text)).size !== retained.length || retained.some(entry => {
   const finding = value.findings.find(finding => finding.concernId === entry.concernId)
   return !value.observation.uncertainties.includes(entry.text) || entry.concernId.startsWith('observation:') && entry.text !== value.observation.uncertainties[Number(entry.concernId.slice('observation:'.length))] || !finding || finding.result !== 'unresolved' || wallpaperFindingBlocksEditing(finding) || !['normal-occlusion', 'background-crop', 'unseen-detail'].includes(finding.classification)
  })) ctx.addIssue({code:'custom',path:['retainedUncertainties'],message:'detail-retained-uncertainty-mismatch'})
  for (const [index, finding] of value.findings.entries()) {
   if (finding.result === 'unresolved' && !finding.blocking && !['normal-occlusion', 'background-crop', 'unseen-detail'].includes(finding.classification) || finding.result === 'resolved' && wallpaperFindingBlocksEditing(finding)) ctx.addIssue({code:'custom',path:['findings',index],message:'detail-readiness-conflict'})
   if (finding.scope === 'critical' && !finding.blocking && (!finding.sourceRegion || !wallpaperNativeDetailCovers(finding.sourceRegion, finding.evidenceImageVersionIds, nativeViews))) ctx.addIssue({code:'custom',path:['findings',index],message:'detail-covering-native-critical-detail-required'})
  }
  const repair = value.edgeRepair
  if (repair.classification !== 'edge-continuation') {
   if (value.findings.some(finding => finding.classification === 'edge-continuation')) ctx.addIssue({code:'custom',path:['edgeRepair'],message:'edge-repair-authorization-required'})
   return
  }
  const region = repair.sourceRegion, repairIds = repair.concernIds, evidence = repair.evidenceImageVersionIds
  if (!region || !repairIds || !evidence) { ctx.addIssue({code:'custom',path:['edgeRepair'],message:'edge-repair-native-target-required'}); return }
  const touches = { left: region.x === 0, top: region.y === 0, right: Math.abs(region.x + region.width - 1) < 1e-6, bottom: Math.abs(region.y + region.height - 1) < 1e-6 }
  const invalidEvidence = new Set(evidence).size !== evidence.length || evidence.some(id => id !== sourceId && !detailIds.includes(id)) || !wallpaperNativeDetailCovers(region, evidence, nativeViews)
  const invalidConcerns = new Set(repairIds).size !== repairIds.length || repairIds.some(id => !value.findings.some(finding => finding.concernId === id && finding.result === 'resolved' && !wallpaperFindingBlocksEditing(finding) && finding.classification === 'edge-continuation' && (finding.scope === 'subject' || finding.scope === 'critical')))
  const unboundFinding = value.findings.some(finding => finding.classification === 'edge-continuation' && !repairIds.includes(finding.concernId))
  if (invalidEvidence || invalidConcerns || unboundFinding || repair.edges.some(edge => !touches[edge])) ctx.addIssue({code:'custom',path:['edgeRepair'],message:'edge-repair-native-target-required'})
  if (value.findings.some(finding => {
   if (finding.classification !== 'edge-continuation') return false
   const target = finding.sourceRegion
   if (!target) return true
   const left = Math.max(target.x, region.x), top = Math.max(target.y, region.y)
   const right = Math.min(target.x + target.width, region.x + region.width), bottom = Math.min(target.y + target.height, region.y + region.height)
   if (right <= left || bottom <= top) return true
   const sharedEdge = repair.edges.some(edge => edge === 'left' ? left === 0 : edge === 'top' ? top === 0 : edge === 'right' ? Math.abs(right - 1) < 1e-6 : Math.abs(bottom - 1) < 1e-6)
   // A finding may describe the whole plant; native evidence must cover its intersection with the authorized repair.
   return !sharedEdge || !wallpaperNativeDetailCovers({x:left,y:top,width:right-left,height:bottom-top}, finding.evidenceImageVersionIds, nativeViews)
  })) ctx.addIssue({code:'custom',path:['edgeRepair'],message:'edge-repair-finding-target-mismatch'})
 })
}
/** @param prior Preserved source plan. @param detail Validated second observation. @param allowEdgeRepair Frozen task authorization; omission retains the source-completeness hold. @returns A conservative decision and observation retaining every original protected rectangle. */
export function resolveWallpaperPlanDetail(prior:WallpaperPlan,detail:WallpaperPlanDetail,allowEdgeRepair=false){
 const extent = 'protectedSubjectExtent' in detail ? detail.protectedSubjectExtent : detail.sourceExtent
 const observation = 'backgroundTruncations' in detail ? {...detail.observation, truncations:detail.backgroundTruncations} : detail.observation
 const edgeRepair = allowEdgeRepair && (detail.version === 'wallpaper-plan-detail-v4' || detail.version === 'wallpaper-plan-detail-v5') && detail.edgeRepair.classification === 'edge-continuation'
 const violated=!edgeRepair&&extent.extent==='cut-off'||detail.findings.some(f=>f.result==='violated')
 const complete=edgeRepair||extent.extent==='complete'||extent.extent==='not-applicable'&&detail.observation.mode==='abstract'&&!prior.regions.some(r=>r.role==='subject')
 const retainedUncertainties = detail.version === 'wallpaper-plan-detail-v5' ? detail.retainedUncertainties : []
 const blockingUncertainties = observation.uncertainties.filter(text => !retainedUncertainties.some(entry => entry.text === text))
 const findingsReady = detail.version === 'wallpaper-plan-detail-v5' ? detail.findings.every(finding => !wallpaperFindingBlocksEditing(finding)) : detail.findings.every(f=>f.result==='resolved')
  const roleMismatch=!!prior.objectRoles&&detail.observation.regions.some(region=>!region.entityId||!prior.objectRoles?.some(object=>object.entityId===region.entityId&&object.role!=='supporting'&&region.role===(object.role==='critical-part'?'critical':'subject')))
  const resolved=!violated&&complete&&findingsReady&&detail.observation.mode!=='uncertain'&&!blockingUncertainties.length&&!roleMismatch
 const ready = resolved && detail.version === 'wallpaper-plan-detail-v5' && (edgeRepair || detail.findings.some(finding => finding.result === 'unresolved') || retainedUncertainties.length > 0)
  const regions=retainWallpaperRegions(prior.regions,roleMismatch?[]:detail.observation.regions)
  return {outcome:violated?'violated' as const:ready?'ready-for-edit' as const:resolved?'resolved' as const:'unresolved' as const,observation:wallpaperObservationPlanSchema.parse({...observation,objectRoles:prior.objectRoles??observation.objectRoles,uncertainties:blockingUncertainties,regions}),retainedUncertainties,reason:extent.reason+'；'+detail.findings.map(f=>f.reason).join('；')+(roleMismatch?'；局部复核未沿用已冻结的实体ID和角色':'')}
}

/** @param prior Saved protected regions. @param observed New observations. @returns Cumulative protection that automatic rework cannot remove or shrink. */
export function retainWallpaperRegions(prior:WallpaperPlan['regions'],observed:WallpaperPlan['regions']):WallpaperPlan['regions']{
 const regions=prior.map(r=>structuredClone(r))
 for(const region of observed){
   const old=regions.find(r=>r.role===region.role&&(region.entityId&&r.entityId?region.entityId===r.entityId:!region.entityId&&!r.entityId&&r.name===region.name))
  if(!old){regions.push(structuredClone(region));continue}
  if(region.rect.x>=old.rect.x&&region.rect.y>=old.rect.y&&region.rect.x+region.rect.width<=old.rect.x+old.rect.width&&region.rect.y+region.rect.height<=old.rect.y+old.rect.height)continue
  const x=Math.min(old.rect.x,region.rect.x),y=Math.min(old.rect.y,region.rect.y)
  old.rect={x,y,width:Math.max(old.rect.width,Math.max(old.rect.x+old.rect.width,region.rect.x+region.rect.width)-x),height:Math.max(old.rect.height,Math.max(old.rect.y+old.rect.height,region.rect.y+region.rect.height)-y)}
 }
 return regions
}

/** @param prior Frozen source identities. @param observed Same identities after reinspection. @returns Updated descriptions without losing an established source-frame crop or visible extent. */
export function retainWallpaperObjectRoles(prior:readonly WallpaperObjectRole[],observed:readonly WallpaperObjectRole[]):WallpaperObjectRole[]{
 return observed.map(object=>{
  const old=prior.find(entry=>entry.entityId===object.entityId)
  if(!old)return structuredClone(object)
  const x=Math.min(old.rect.x,object.rect.x),y=Math.min(old.rect.y,object.rect.y)
  return {...object,rect:{x,y,width:Math.max(old.rect.x+old.rect.width,object.rect.x+object.rect.width)-x,height:Math.max(old.rect.y+old.rect.height,object.rect.y+object.rect.height)-y},sourceEdges:[...new Set([...old.sourceEdges,...object.sourceEdges])]}
 })
}
