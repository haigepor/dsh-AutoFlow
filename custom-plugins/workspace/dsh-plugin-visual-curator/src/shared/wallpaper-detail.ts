/** Bounded source-detail evidence can resolve a planning hold without weakening protection or final review. */
import {z} from 'zod'
import {wallpaperObservationPlanSchema,type WallpaperPlan} from './wallpaper.ts'
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
/** Independently addressed concerns retain their exact first-pass text. */
export type WallpaperPlanDetail=z.infer<typeof wallpaperPlanDetailSchema> | z.infer<typeof scopedDetailSchema>
/** @param plan Saved first-pass evidence. @returns Stable concern identities without treating generic prose as resolved. */
export function wallpaperPlanConcerns(plan:WallpaperPlan):{id:string;text:string}[]{
 const concerns=plan.uncertainties.map((text,index)=>({id:'uncertainty:'+index,text}))
 if(plan.truncations.length)concerns.push({id:'source-extent',text:'Verify the complete subject against the whole original frame before any rendering or expansion. Distinguish actual frame truncation from normal perspective or self-occlusion: '+plan.truncations.join('；')})
 if(plan.mode==='uncertain')concerns.push({id:'subject-mode',text:'Identify the visible main subject and its complete source-frame extent.'})
 if(!plan.regions.length||(plan.mode==='single'||plan.mode==='group')&&(!plan.regions.some(r=>r.role==='subject')||!plan.regions.some(r=>r.role==='critical')))concerns.push({id:'protected-regions',text:'Locate the complete visible subject and its critical structures in source coordinates.'})
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
/** @param sourceId Canonical original. @param concerns Exact pending concerns. @param detailIds Actual saved crops in this request. @returns Strict evidence-bound response validation. */
export function wallpaperPlanDetailOutputSchema(sourceId:string,concerns:readonly {id:string;text:string}[],detailIds:readonly string[],version:WallpaperPlanDetail['version']='wallpaper-plan-detail-v1'):z.ZodType<WallpaperPlanDetail>{
 const imageVersionId = z.literal(sourceId)
 const evidenceImageVersionIds = z.array(z.enum([sourceId,...detailIds])).min(1).max(8)
 const findings = z.array(wallpaperPlanDetailSchema.shape.findings.element.extend({concernId:z.enum(concerns.map(c=>c.id)),evidenceImageVersionIds})).max(19)
 const schema = version === 'wallpaper-plan-detail-v3'
  ? scopedDetailSchema.extend({imageVersionId, findings, protectedSubjectExtent: scopedDetailSchema.shape.protectedSubjectExtent.extend({evidenceImageVersionIds: evidenceImageVersionIds.optional()}).describe('Judge only the complete visible main subject and its protected critical structures against the whole original frame.'), observation:scopedDetailSchema.shape.observation.extend({imageVersionId})})
  : wallpaperPlanDetailSchema.extend({version:z.literal(version), imageVersionId, findings, observation:wallpaperObservationPlanSchema.extend({imageVersionId})})
 return schema.superRefine((value,ctx)=>{
  if(value.imageVersionId!==sourceId||value.observation.imageVersionId!==sourceId)ctx.addIssue({code:'custom',message:'detail-source-mismatch'})
  const ids=value.findings.map(f=>f.concernId)
  if(ids.length!==concerns.length||new Set(ids).size!==ids.length||concerns.some(c=>!ids.includes(c.id)))ctx.addIssue({code:'custom',message:'detail-concerns-mismatch'})
  if(!detailIds.length||value.findings.some(f=>!f.evidenceImageVersionIds.some(id=>detailIds.includes(id))||new Set(f.evidenceImageVersionIds).size!==f.evidenceImageVersionIds.length||f.evidenceImageVersionIds.some(id=>id!==sourceId&&!detailIds.includes(id))))ctx.addIssue({code:'custom',message:'detail-evidence-mismatch'})
 })
}
/** @param prior Preserved source plan. @param detail Validated second observation. @returns A conservative decision and observation retaining every original protected rectangle. */
export function resolveWallpaperPlanDetail(prior:WallpaperPlan,detail:WallpaperPlanDetail){
 const extent = detail.version === 'wallpaper-plan-detail-v3' ? detail.protectedSubjectExtent : detail.sourceExtent
 const observation = detail.version === 'wallpaper-plan-detail-v3' ? {...detail.observation, truncations:detail.backgroundTruncations} : detail.observation
 const violated=extent.extent==='cut-off'||detail.findings.some(f=>f.result==='violated')
 const complete=extent.extent==='complete'||extent.extent==='not-applicable'&&detail.observation.mode==='abstract'&&!prior.regions.some(r=>r.role==='subject')
 const resolved=!violated&&complete&&detail.findings.every(f=>f.result==='resolved')&&detail.observation.mode!=='uncertain'&&!detail.observation.uncertainties.length
 const regions=retainWallpaperRegions(prior.regions,detail.observation.regions)
 return {outcome:violated?'violated' as const:resolved?'resolved' as const:'unresolved' as const,observation:wallpaperObservationPlanSchema.parse({...observation,regions}),reason:extent.reason+'；'+detail.findings.map(f=>f.reason).join('；')}
}

/** @param prior Saved protected regions. @param observed New observations. @returns Cumulative protection that automatic rework cannot remove or shrink. */
export function retainWallpaperRegions(prior:WallpaperPlan['regions'],observed:WallpaperPlan['regions']):WallpaperPlan['regions']{
 const regions=prior.map(r=>structuredClone(r))
 for(const region of observed){
  const old=regions.find(r=>r.name===region.name&&r.role===region.role)
  if(!old){regions.push(structuredClone(region));continue}
  if(region.rect.x>=old.rect.x&&region.rect.y>=old.rect.y&&region.rect.x+region.rect.width<=old.rect.x+old.rect.width&&region.rect.y+region.rect.height<=old.rect.y+old.rect.height)continue
  const x=Math.min(old.rect.x,region.rect.x),y=Math.min(old.rect.y,region.rect.y)
  old.rect={x,y,width:Math.max(old.rect.width,Math.max(old.rect.x+old.rect.width,region.rect.x+region.rect.width)-x),height:Math.max(old.rect.height,Math.max(old.rect.y+old.rect.height,region.rect.y+region.rect.height)-y)}
 }
 return regions
}
