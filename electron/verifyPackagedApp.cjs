const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const asar = require('@electron/asar');
const { spawnSync } = require('node:child_process');

const archivePath = process.argv[2];

if (!archivePath) {
  throw new Error('Usage: node electron/verifyPackagedApp.cjs <path-to-app.asar>');
}

const resolvedArchivePath = path.resolve(archivePath);
if (!fs.existsSync(resolvedArchivePath)) {
  throw new Error(`Packaged app archive not found: ${resolvedArchivePath}`);
}

const extractionParent = fs.realpathSync.native(os.tmpdir());
const extractionRoot = fs.mkdtempSync(path.join(extractionParent, 'paperquay-package-smoke-'));

try {
  asar.extractAll(resolvedArchivePath, extractionRoot);

  const pizzipDirectory = path.join(extractionRoot, 'node_modules', 'pizzip', 'js');
  const pakoEntry = require.resolve('pako/dist/pako.es5.min.js', {
    paths: [pizzipDirectory],
  });

  require(pakoEntry);
  require(path.join(pizzipDirectory, 'flate.js'));
  const agentEntry=require('node:url').pathToFileURL(path.join(extractionRoot,'packages','agent-core','index.mjs')).href;
  const agentCheck=spawnSync(process.execPath,['--input-type=module','-e',"const {createAgentPlanCore}=await import(process.argv[1]);const core=createAgentPlanCore({now:()=>1,random:()=>0.125});const plan=core.buildRenamePlan([{id:'synthetic',title:'Evidence'}],{mode:'prefix',value:'Reviewed '});if(plan.items.length!==1||plan.items[0].updateRequest?.title!=='Reviewed Evidence'||core.normalizeAgentTagName('人工智能')!=='AI')throw Error('Packaged Agent planning failed');console.log('Packaged Agent planning passed.');",agentEntry],{stdio:'inherit',windowsHide:true});
  if(agentCheck.error)throw agentCheck.error;if(agentCheck.status!==0)throw new Error('Packaged Agent planning failed.');
  const radarDomain=require(path.join(extractionRoot,'electron','backend','radarDomain.cjs'));
  const radarSources=require(path.join(extractionRoot,'electron','backend','radarSources.cjs'));
  const radarTopic=radarDomain.normalizeTopic({name:'Packaged radar',queries:['evidence'],includeTerms:['evidence'],sources:['crossref']});
  const radarRecord=radarDomain.mapWork('crossref',{DOI:'10.5555/packaged-radar',title:['Evidence in package'],published:{'date-parts':[[2026]]}});
  const radarState={topics:[radarTopic],candidates:[],queue:[]};
  if(!radarRecord||radarDomain.mergeCandidates(radarState,[radarRecord],radarTopic,0,{papers:[]}).added!==1||radarDomain.rankPaper(radarRecord,radarTopic,Date.UTC(2026,0,1)).score<=0||typeof radarSources.searchTopic!=='function')throw new Error('Packaged radar derivation failed.');
  const graphCore=require(path.join(extractionRoot,'packages','graph-core','index.cjs')).createKnowledgeGraphCore();
  const graphSmoke=graphCore.createKnowledgeGraphSnapshot({store:{load:()=>({papers:[{id:'synthetic',title:'Packaged graph',authors:[],tags:[{name:'Evidence'}]}],categories:[]})},noteStore:{listAllNotes:()=>[]}}, {includeCustomRelations:false});
  if(graphSmoke.nodes.length!==2||graphSmoke.edges[0]?.type!=='paper_tag')throw new Error('Packaged graph derivation failed.');
  const reviewCorePath=path.join(extractionRoot,'packages','review-core','index.cjs');
  const {createReviewCore}=require(reviewCorePath);
  const reviewCore=createReviewCore();
  for(const name of ['normalizeReviewBlueprint','buildReviewBlueprintPrompt','composeReviewDraftFromGeneratedParts','reviewDraftToMarkdown','renderReviewPackage']) {
    if(typeof reviewCore[name]!=='function')throw new Error('Packaged review core is missing '+name+'.');
  }
  const reviewCheck=spawnSync(process.execPath,['-e',"(function(){const {createRequire}=require('node:module'),path=require('node:path'),root=process.argv[1],load=createRequire(path.join(root,'package.json'));const {createReviewCore}=load('./packages/review-core/index.cjs');const word=createReviewCore({PizZip:load('pizzip'),Docxtemplater:load('docxtemplater'),temml:load('temml'),mathml2omml:load('mathml2omml'),DOMParser:load('@xmldom/xmldom').DOMParser,binaryType:'nodebuffer',readFigure:async()=>({imageBuffer:Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=','base64'),extension:'png'})});const data=word.normalizeReviewJsonDraft({title:'Packaged review smoke',sections:[{heading:'Evidence',content:'Evidence [P1].\\n\\n$$E=mc^2$$\\n\\n[Figure: P1-F1]',citations:['P1']}],sources:[{id:'P1',title:'Synthetic source',sourceType:'paper'}],references:[{id:'P1',title:'Synthetic source',authors:'Synthetic A',year:'2026'}],figures:[{id:'P1-F1',sourceId:'P1',caption:'Synthetic image',path:'fixture://package/image'}]});word.renderReviewPackage({data}).then(result=>{if(result.validation.status!=='passed'||result.validation.imageCount!==1||result.validation.formulaCount!==1||result.skippedFigures.length)throw new Error(JSON.stringify(result.validation));console.log('Packaged review Word smoke passed: image, formal reference and editable formula.');}).catch(error=>{console.error(error);process.exitCode=1;});})()",extractionRoot],{stdio:'inherit',windowsHide:true});
  if(reviewCheck.error)throw reviewCheck.error;
  if(reviewCheck.status!==0)throw new Error('Packaged review Word runtime failed verification.');
  const syncCore = require(path.join(extractionRoot, 'electron', 'generated', 'desktopSyncCore.cjs'));
  for (const name of ['projectDesktopLibrary', 'createDesktopIdentityMap', 'queueLocalCreates', 'preparePush', 'applyPushResults', 'verifyParsedDocument', 'inspectParsedImage']) {
    if (typeof syncCore[name] !== 'function') throw new Error(`Packaged desktop sync core is missing ${name}.`);
  }
  const modelCheck=spawnSync(process.execPath,[path.join(extractionRoot,'electron','modelInferencePackageSmoke.mjs'),extractionRoot],{stdio:'inherit',windowsHide:true});
  if(modelCheck.error)throw modelCheck.error;
  if(modelCheck.status!==0)throw new Error('Packaged model inference runtime failed verification.');
  const parsedConverter = require(path.join(extractionRoot, 'electron', 'generated', 'desktopParsedDocument.cjs'));
  if (typeof parsedConverter.createPortableParsedDocument !== 'function') throw new Error('Packaged parsed document converter is missing.');
  const richNoteConverter = require(path.join(extractionRoot, 'electron', 'generated', 'desktopRichNoteArchive.cjs'));
  for (const name of ['createPortableRichNoteArchive', 'snapshotDesktopSavedNote', 'inspectDesktopSavedNote']) {
    if (typeof richNoteConverter[name] !== 'function') throw new Error(`Packaged saved note archive converter is missing ${name}.`);
  }
  for (const file of ['node_modules/pdfjs-dist/legacy/build/pdf.mjs', 'node_modules/pdfjs-dist/legacy/build/pdf.worker.mjs']) {
    const stat = fs.statSync(path.join(extractionRoot, file));
    if (!stat.isFile() || !stat.size) throw new Error(`Packaged PDF inspection runtime is missing ${file}.`);
  }
  for (const file of ['backend/desktopPeerHost.cjs', 'desktopPeerPreload.cjs', 'desktopPeer.html', 'appWindowLifecycle.cjs']) {
    const stat = fs.statSync(path.join(extractionRoot, 'electron', file));
    if (!stat.isFile() || !stat.size) throw new Error(`Packaged direct transfer runtime is missing ${file}.`);
  }
  if (typeof require(path.join(extractionRoot, 'electron', 'backend', 'desktopPeerHost.cjs')).createDesktopPeerHost !== 'function') {
    throw new Error('Packaged direct transfer host failed verification.');
  }
  const oidcEntry = require.resolve('openid-client', { paths: [extractionRoot] });
  if (!oidcEntry.startsWith(`${extractionRoot}${path.sep}`)) throw new Error('OIDC dependency escaped the package.');
  const oidcCheck = spawnSync(process.execPath, ['--input-type=module', '-e',
    'const client = await import(process.argv[1]); if (typeof client.authorizationCodeGrant !== "function" || typeof client.enableNonRepudiationChecks !== "function") process.exit(1);',
    require('node:url').pathToFileURL(oidcEntry).href], { stdio: 'inherit', windowsHide: true });
  if (oidcCheck.error) throw oidcCheck.error;
  if (oidcCheck.status !== 0) throw new Error('Packaged OIDC runtime dependencies failed verification.');
  const markdownEntries = ['unified', 'remark-parse', 'remark-math'].map((name) => {
    const entry = require.resolve(name, { paths: [extractionRoot] });
    if (!entry.startsWith(`${extractionRoot}${path.sep}`)) throw new Error(`Markdown dependency escaped the package: ${name}.`);
    return require('node:url').pathToFileURL(entry).href;
  });
  const markdownCheck = spawnSync(process.execPath, ['--input-type=module', '-e',
    'const [{unified},{default:parse},{default:math}]=await Promise.all(process.argv.slice(1).map(entry=>import(entry))); const tree=unified().use(parse).use(math).parse("formula $x=1$"); if(!tree.children[0]?.children?.some(node=>node.type==="inlineMath"&&node.value==="x=1"))process.exit(1);',
    ...markdownEntries], { stdio: 'inherit', windowsHide: true });
  if (markdownCheck.error) throw markdownCheck.error;
  if (markdownCheck.status !== 0) throw new Error('Packaged remote vector Markdown runtime failed verification.');
  const nativeCheck = spawnSync(process.execPath, [path.join(__dirname, 'native', 'smoke.cjs'), extractionRoot], {
    stdio: 'inherit', windowsHide: true,
  });
  if (nativeCheck.error) throw nativeCheck.error;
  if (nativeCheck.status !== 0) throw new Error('Packaged native filesystem module failed Electron verification.');

  const packageJson = JSON.parse(
    fs.readFileSync(path.join(extractionRoot, 'package.json'), 'utf8'),
  );

  process.stdout.write(
    `Packaged PaperQuay ${packageJson.version} resolved document, desktop sync, and OIDC dependencies successfully.\n`,
  );
} finally {
  const resolvedExtraction = fs.realpathSync.native(extractionRoot);
  if (path.dirname(resolvedExtraction) !== extractionParent || !path.basename(resolvedExtraction).startsWith('paperquay-package-smoke-')) {
    throw new Error('Refusing to clean an unexpected package verification directory.');
  }
  fs.rmSync(resolvedExtraction, { recursive: true, force: true });
}
