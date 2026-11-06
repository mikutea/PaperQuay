import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {reviewCore,type ReviewBlueprint,type ReviewContextItem,type ReviewJsonDraft} from '../src/review/core.ts';
import {createMobileWordCore} from '../src/review/wordCore.cjs';
const fixture=JSON.parse(await readFile(new URL('../../../tests/fixtures/review-core/desktop-baseline.json',import.meta.url),'utf8'));
test('mobile uses the same blueprint, checkpoint and formal citation business core as desktop',()=>{
 const context:ReviewContextItem[]=fixture.context,blueprint:ReviewBlueprint=reviewCore.normalizeReviewBlueprint(fixture.rawBlueprint,{...fixture.options,contextItems:context});
 assert.deepEqual(blueprint,fixture.blueprint);
 const parts=reviewCore.normalizeReviewGeneratedParts(fixture.rawParts,blueprint,new Set(context.map(x=>x.id)));
 const draft:ReviewJsonDraft=reviewCore.composeReviewDraftFromGeneratedParts({blueprint,contextItems:context,parts:{...parts,sections:(parts.sectionParagraphs??[]).map(p=>reviewCore.mergeGeneratedParagraphParts(p))}});
 assert.deepEqual(draft,fixture.draft);assert.equal(reviewCore.reviewDraftToMarkdown(draft,'English'),fixture.markdown);
});
test('mobile Word adapter returns portable bytes with editable formulas and explicitly supplied image bytes',async()=>{
 const image=Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=','base64'));
 const word=createMobileWordCore(async figure=>{assert.equal(figure.path,'fixture://review/figure-1');return{imageBuffer:image,extension:'png'};});
 const result=await word.renderReviewPackage({data:{...fixture.draft,outputLanguage:'English'}});
 assert(!Buffer.isBuffer(result.bytes));assert(result.bytes instanceof Uint8Array);assert.equal(result.validation.status,'passed');assert.equal(result.validation.imageCount,1);assert.equal(result.validation.formulaCount,1);assert.deepEqual(result.skippedFigures,[]);
});
