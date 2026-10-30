import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import {createReviewCore} from '../packages/review-core/index.cjs';
const require=createRequire(import.meta.url);
const PizZip=require('pizzip'),Docxtemplater=require('docxtemplater'),temml=require('temml'),mathml2omml=require('mathml2omml');
const {DOMParser}=require('@xmldom/xmldom');
const fixture=JSON.parse(await readFile(new URL('./fixtures/review-core/desktop-baseline.json',import.meta.url),'utf8'));
const golden=JSON.parse(await readFile(new URL('./fixtures/review-core/desktop-word-parts.json',import.meta.url),'utf8'));
const image=Uint8Array.from(Buffer.from(golden['word/media/paperquay-review-figure-1.png'],'base64'));
const adapters={PizZip,Docxtemplater,temml,mathml2omml,DOMParser};
const core=createReviewCore(adapters);
function partRequest(){return{options:fixture.options,blueprint:fixture.blueprint,kind:'section_paragraph',heading:'Evidence synthesis',task:fixture.blueprint.sections[0].paragraphTasks[0],contextItems:fixture.context};}
function partsOf(bytes){const zip=new PizZip(bytes);return Object.fromEntries(Object.keys(zip.files).filter(name=>!zip.files[name].dir).sort().map(name=>[name,Buffer.from(zip.file(name).asUint8Array()).toString('base64')]));}
// These golden values were captured from desktop before extraction, with a synthetic paper and note.
test('shared blueprint normalization preserves the pre-extraction desktop output',()=>assert.deepEqual(core.normalizeReviewBlueprint(fixture.rawBlueprint,fixture.options),fixture.blueprint));
test('shared blueprint prompt preserves desktop source limits and output shape',()=>assert.deepEqual(core.buildReviewBlueprintPrompt(fixture.options),fixture.blueprintPrompt));
test('shared paragraph prompt preserves the desktop evidence and figure context',()=>assert.deepEqual(core.buildReviewPartPrompt(partRequest()),fixture.partPrompt));
test('resumable parts and composition preserve desktop academic draft semantics',()=>{
 const parts=core.normalizeReviewGeneratedParts(fixture.rawParts,fixture.blueprint,new Set(fixture.context.map(x=>x.id)));
 assert.deepEqual(parts,fixture.parts);assert.equal(core.countCompletedReviewGeneratedParts(parts),7);
 const composed={...parts,sections:parts.sectionParagraphs.map(p=>core.mergeGeneratedParagraphParts(p))};
 assert.deepEqual(core.composeReviewDraftFromGeneratedParts({blueprint:fixture.blueprint,contextItems:fixture.context,parts:composed}),fixture.draft);
});
test('formal references and Markdown are unchanged by the common core',()=>{
 assert.deepEqual(core.prepareReviewDocxData(fixture.draft,fixture.options.outputLanguage),fixture.prepared);
 assert.equal(core.reviewDraftToMarkdown(fixture.draft,fixture.options.outputLanguage),fixture.markdown);
 assert.match(fixture.markdown,/\[1\]/);assert.doesNotMatch(fixture.markdown,/\[P1\]|\[N1\]/);
});
test('pure core can build prompts and compose without Node, Buffer, DOM, filesystem or network',async()=>{
 const sandbox={module:{exports:{}}};vm.runInNewContext(await readFile(new URL('../packages/review-core/index.cjs',import.meta.url),'utf8'),sandbox);
 const isolated=sandbox.module.exports.createReviewCore();
 assert.equal(JSON.stringify(isolated.normalizeReviewBlueprint(fixture.rawBlueprint,fixture.options)),JSON.stringify(fixture.blueprint));
 assert.equal(JSON.stringify(isolated.buildReviewPartPrompt(partRequest())),JSON.stringify(fixture.partPrompt));
 assert.equal(isolated.reviewDraftToMarkdown(fixture.draft,fixture.options.outputLanguage),fixture.markdown);
});
for(const binaryType of ['nodebuffer','uint8array'])test('shared Word '+binaryType+' preserves every pre-extraction XML, equation, reference and media part',async()=>{
 const word=createReviewCore({...adapters,binaryType,readFigure:async figure=>{assert.equal(figure.path,'fixture://review/figure-1');return{imageBuffer:image,extension:'png'};}});
 const output=await word.renderReviewPackage({data:{...fixture.draft,outputLanguage:'English'}});
 assert.equal(Buffer.isBuffer(output.bytes),binaryType==='nodebuffer');assert.deepEqual(partsOf(output.bytes),golden);
 assert.deepEqual(output.skippedFigures,[]);assert.equal(output.validation.status,'passed');
 assert.equal(output.validation.imageCount,1);assert.equal(output.validation.formulaCount,1);assert.equal(output.markdown,fixture.markdown);
});
test('unavailable figure bytes are explicitly reported and never trigger path or URL access',async()=>{
 const word=createReviewCore(adapters),result=await word.renderReviewPackage({data:{...fixture.draft,outputLanguage:'English'}});
 assert.equal(result.skippedFigures.length,1);assert.match(result.skippedFigures[0].reason,/unavailable/);assert.equal(result.validation.imageCount,0);
});
for(const target of ['media/paperquay-review-figure-1.png','media\\paperquay-review-figure-1.png','./media/../media/paperquay-review-figure-1.png'])test('portable Word relationship resolution matches desktop: '+target,()=>{
 const zip=new PizZip();for(const [name,value]of Object.entries(golden))zip.file(name,Buffer.from(value,'base64'));
 const name='word/_rels/document.xml.rels',xml=zip.file(name).asText();zip.file(name,xml.replace('media/paperquay-review-figure-1.png',target));
 assert.equal(core.validateReviewDocxBuffer(zip.generate({type:'uint8array'})).status,'passed');
});
test('Word validation still rejects missing media and malformed archives',()=>{
 const zip=new PizZip();for(const[name,value]of Object.entries(golden))zip.file(name,Buffer.from(value,'base64'));zip.remove('word/media/paperquay-review-figure-1.png');
 assert.equal(core.validateReviewDocxBuffer(zip.generate({type:'uint8array'})).status,'error');assert.equal(core.validateReviewDocxBuffer(new Uint8Array([1,2])).status,'error');
});
for(const [format,data,width,height]of [
 ['png',[...Array(16).fill(0),0,0,1,44,0,0,0,200],300,200],
 ['gif',[0,0,0,0,0,0,44,1,200,0],300,200],
 ['jpeg',[255,216,255,192,0,17,8,0,200,1,44,0],300,200],
])test('image dimensions use bounded typed-array offsets for '+format,()=>{
 const backing=new Uint8Array(data.length+12);backing.fill(255);backing.set(data,5);
 const bytes=backing.subarray(5,5+data.length);assert.deepEqual(core.readImagePixelSize(bytes,format),{width,height});
 const buffer=Buffer.from(backing.buffer,5,data.length);assert.deepEqual(core.readImagePixelSize(buffer,format),{width,height});
});
test('desktop output permission gate remains ahead of all export IO',async()=>{
 const {createReviewCommands}=require('../electron/backend/reviewCommands.cjs');
 const commands=createReviewCommands({approvedWritePaths:new Set()});
 await assert.rejects(commands.review_export_docx({outputPath:'unapproved.docx',data:fixture.draft}),/not allowed until approved/);
});
