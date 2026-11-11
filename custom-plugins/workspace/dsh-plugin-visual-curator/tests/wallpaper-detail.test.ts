/** Independent protocol cases keep unknown pixels, foreign evidence and cropped subjects blocked. */
import assert from 'node:assert/strict'
import test from 'node:test'
import {wallpaperPlanSchema} from '../src/shared/wallpaper.ts'
import {wallpaperPlanConcerns,wallpaperPlanDetailRect,wallpaperPlanDetailOutputSchema,resolveWallpaperPlanDetail} from '../src/shared/wallpaper-detail.ts'
const prior=wallpaperPlanSchema.parse({version:1,imageVersionId:'original',mode:'single',subject:'Vehicle',evidence:'The overview is too small to inspect the visible wheel.',priorities:[],anchors:[],truncations:[],uncertainties:['Inspect the visible wheel contour.'],regions:[{name:'whole car',role:'subject',rect:{x:0.39,y:0.44,width:0.24,height:0.17}},{name:'wheel',role:'critical',rect:{x:0.4,y:0.47,width:0.22,height:0.12}}],placement:{scale:0.656,left:-170,top:0},reason:'Preserve the complete subject'})
const concerns=wallpaperPlanConcerns(prior),schema=wallpaperPlanDetailOutputSchema('original',concerns,['saved-crop'])
function response(){const {placement,...observation}=structuredClone(prior);return {version:'wallpaper-plan-detail-v1',imageVersionId:'original',sourceExtent:{extent:'complete',reason:'The complete visible outline is inside the original frame.'},findings:[{concernId:'uncertainty:0',result:'resolved',reason:'The saved native crop shows the visible wheel boundary.',evidenceImageVersionIds:['saved-crop']}],observation:{...observation,uncertainties:[],regions:[{name:'whole car',role:'subject',rect:{x:0.4,y:0.45,width:0.2,height:0.1}}]}}}
test('source context crop preserves native detail and does not substitute an unlocalized whole frame',()=>{const crop=wallpaperPlanDetailRect(prior)!;assert(crop.x<0.39&&crop.y<0.44&&crop.x+crop.width>0.63&&crop.y+crop.height>0.61);assert(crop.width<0.4&&crop.height<0.3);assert.equal(wallpaperPlanDetailRect({...prior,regions:[]}),undefined);assert.equal(wallpaperPlanDetailRect({...prior,regions:[{...prior.regions[0]!,rect:{x:0,y:0,width:1,height:1}}]}),undefined)})
test('every prior concern requires the current canonical source and actual crop identities',()=>{assert(schema.safeParse(response()).success);assert(schema.safeParse({...response(),findings:[{...response().findings[0],evidenceImageVersionIds:['saved-crop','original']}]}).success);assert.equal(schema.safeParse({...response(),imageVersionId:'foreign'}).success,false);assert.equal(schema.safeParse({...response(),findings:[]}).success,false);assert.equal(schema.safeParse({...response(),findings:[{...response().findings[0],evidenceImageVersionIds:['original']}]}).success,false);assert.equal(schema.safeParse({...response(),findings:[{...response().findings[0],evidenceImageVersionIds:['foreign-crop']}]}).success,false);assert.equal(schema.safeParse({...response(),extra:'ignore uncertainty'}).success,false)})
test('a resolved detail observation cannot remove or shrink previous subject or critical protection',()=>{const decision=resolveWallpaperPlanDetail(prior,schema.parse(response()));assert.equal(decision.outcome,'resolved');assert.deepEqual(decision.observation.regions,prior.regions);assert.equal(prior.uncertainties.length,1)})
test('claims of resolution cannot override unknown, occluded or cut-off whole-source extent',()=>{for(const extent of ['unknown','occluded','cut-off','not-applicable'] as const){const decision=resolveWallpaperPlanDetail(prior,schema.parse({...response(),sourceExtent:{extent,reason:'Observed source extent.'}}));assert.equal(decision.outcome,extent==='cut-off'?'violated':'unresolved')}const unknown=resolveWallpaperPlanDetail(prior,schema.parse({...response(),findings:[{...response().findings[0],result:'unresolved'}]}));assert.equal(unknown.outcome,'unresolved');const newConcern=resolveWallpaperPlanDetail(prior,schema.parse({...response(),observation:{...response().observation,uncertainties:['Another visible contour remains unclear.']}}));assert.equal(newConcern.outcome,'unresolved')})

test('declared truncation is an extent concern even when the planner reports no uncertainty',()=>{
 const concerns=wallpaperPlanConcerns({...prior,uncertainties:[],truncations:['The rear body crosses the original frame edge.']})
 assert.equal(concerns.length,1);assert.equal(concerns[0]!.id,'source-extent')
})

test('whole-subject extent can cite supplied original and detail images independently of each finding', () => {
 const input = response()
 const { truncations: backgroundTruncations, ...observation } = input.observation
 const scoped = { version: 'wallpaper-plan-detail-v3', imageVersionId: 'original', findings: input.findings, protectedSubjectExtent: input.sourceExtent, backgroundTruncations, observation }
 const parse = wallpaperPlanDetailOutputSchema('original', concerns, ['saved-crop'], 'wallpaper-plan-detail-v3')
 assert.ok(parse.safeParse(scoped).success)
 const cited = { ...scoped, protectedSubjectExtent: { ...input.sourceExtent, evidenceImageVersionIds: ['original', 'saved-crop'] } }
 assert.deepEqual(parse.parse(cited), cited)
 assert.equal(parse.safeParse({ ...cited, protectedSubjectExtent: { ...input.sourceExtent, evidenceImageVersionIds: ['foreign-image'] } }).success, false)
 assert.equal(parse.safeParse({ ...cited, findings: [{ ...input.findings[0], evidenceImageVersionIds: ['original'] }] }).success, false)
})
