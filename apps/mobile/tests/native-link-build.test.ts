import assert from 'node:assert/strict';
import {execFileSync,spawnSync} from 'node:child_process';
import {existsSync,mkdtempSync,mkdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import test,{type TestContext} from 'node:test';
import {checkedNativeBuildSettings,outsideRepository,prepareNativeLinks,readNativeBuildSettings,validateNativeBundle,writeNativeBundleBinding} from '../scripts/native-link-build.ts';

const mobile=fileURLToPath(new URL('..',import.meta.url));
const fixture=JSON.parse(readFileSync(new URL('./fixtures/native-link-settings.json',import.meta.url),'utf8'));
function directory(t:TestContext){const path=mkdtempSync(join(tmpdir(),'paperquay-native-links-'));t.after(()=>rmSync(path,{recursive:true,force:true}));return path;}
function bundle(t:TestContext){
  const path=directory(t);mkdirSync(join(path,'assets'));writeFileSync(join(path,'index.html'),'<html>synthetic build</html>');
  writeFileSync(join(path,'assets/main.js'),'// synthetic compiled application');
  const settings=checkedNativeBuildSettings({...Object.fromEntries(Object.entries(fixture).filter(([key])=>!['ios','android'].includes(key))),platform:'ios'});
  writeNativeBundleBinding(settings,path);return{path,settings};
}
test('private settings generate independent association documents, matching native defaults and disabled production clients',t=>{
  const parent=directory(t);
  for(const platform of ['ios','android']){
    const output=join(parent,platform),settings=prepareNativeLinks(fixture,platform,output);
    assert.deepEqual(readNativeBuildSettings(join(output,'native-build.settings.json')),settings);
    const client=JSON.parse(readFileSync(join(output,'oidc-client.disabled.json'),'utf8'));
    assert.equal(client.enabled,false);assert.equal(client.clientId,'paperquay-'+platform);assert.equal(client.directAccessGrantsEnabled,false);
    assert.deepEqual(client.redirectUris,[fixture.origin+'/auth/native/'+platform+'/callback']);
    assert.equal(client.attributes['pkce.code.challenge.method'],'S256');
    assert.deepEqual(client.optionalClientScopes,['offline_access']);
    assert.deepEqual(client.webOrigins,[platform==='ios'?'capacitor://localhost':'https://localhost']);
    const required=JSON.parse(readFileSync(join(output,'verification-required.json'),'utf8'));
    assert.equal(required.signatureVerified,false);assert.equal(required.osDomainAssociationVerified,false);
    const association=JSON.parse(readFileSync(join(output,'.well-known',platform==='ios'?'apple-app-site-association':'assetlinks.json'),'utf8'));
    if(platform==='ios')assert.deepEqual(association.applinks.details,[{appID:'QATEST1234.dev.paperquay.mobile',paths:['/auth/native/ios/callback','/auth/native/ios/logout']}]);
    else assert.deepEqual(association[0].target.sha256_cert_fingerprints,fixture.android.sha256CertificateFingerprints);
  }
});
test('preparation refuses repository paths and preserves an existing output',t=>{
  const parent=directory(t),output=join(parent,'existing');mkdirSync(output);writeFileSync(join(output,'keep'),'original');
  assert.throws(()=>prepareNativeLinks(fixture,'ios',output),/NATIVE_OUTPUT_EXISTS/);assert.equal(readFileSync(join(output,'keep'),'utf8'),'original');
  assert.throws(()=>prepareNativeLinks(fixture,'ios',resolve(mobile,'native-private-output')),/OUTSIDE_GIT/);
  assert.equal(existsSync(resolve(mobile,'native-private-output')),false);
  assert.throws(()=>outsideRepository(fileURLToPath(import.meta.url)),/OUTSIDE_GIT/);
});
test('invalid signature identifiers, secrets and noncanonical service settings create no outputs',t=>{
  const parent=directory(t);
  const invalid=[{...fixture,apiKey:'synthetic-private-value'}, {...fixture,apiBaseUrl:'http://127.0.0.1'},
    {...fixture,origin:'https://links.example.test/'},{...fixture,ios:{applicationIdentifierPrefix:'bad'}},
    {...fixture,android:{sha256CertificateFingerprints:[]}},
    {...fixture,android:{sha256CertificateFingerprints:[...fixture.android.sha256CertificateFingerprints,...fixture.android.sha256CertificateFingerprints]}},
    {...fixture,android:{sha256CertificateFingerprints:['00:'.repeat(31)+'00']}},
    {...fixture,oidcAuthority:'https://user:synthetic-secret@id.example.test/realm'}];
  for(const [index,input] of invalid.entries()){
    const output=join(parent,String(index)),platform=index>=4&&index<=6?'android':'ios';
    assert.throws(()=>prepareNativeLinks(input,platform,output));assert.equal(existsSync(output),false);
  }
});
test('the actual CLI writes outside Git and never prints input values on malformed input',t=>{
  const parent=directory(t),input=join(parent,'input.json'),output=join(parent,'prepared');writeFileSync(input,JSON.stringify(fixture));
  const stdout=execFileSync(process.execPath,['--import','tsx','scripts/configure-native-links.ts','--input',input,'--output',output,'--platform','android'],{cwd:mobile,encoding:'utf8'});
  assert.equal(JSON.parse(stdout).status,'prepared');assert(!stdout.includes(fixture.origin));
  writeFileSync(input,'{"synthetic-private-value":');
  const failed=spawnSync(process.execPath,['--import','tsx','scripts/configure-native-links.ts','--input',input,'--output',join(parent,'failed'),'--platform','ios'],{cwd:mobile,encoding:'utf8'});
  assert.equal(failed.status,1);assert(!failed.stdout.includes('synthetic-private-value'));assert(!failed.stderr.includes('synthetic-private-value'));
  assert.equal(existsSync(join(parent,'failed')),false);
});
test('native compile validation checks the platform, OS host and every copied build byte',t=>{
  const {path}=bundle(t);assert.deepEqual(validateNativeBundle('ios','links.example.test',path),{configured:true,filesVerified:2});
  assert.throws(()=>validateNativeBundle('android','links.example.test',path));
  assert.throws(()=>validateNativeBundle('ios','other.example.test',path));
  writeFileSync(join(path,'assets/main.js'),'// changed after compilation');
  assert.throws(()=>validateNativeBundle('ios','links.example.test',path),/BYTES_CHANGED/);
});
test('adding or removing copied assets and traversal metadata cannot pass native validation',t=>{
  const {path,settings}=bundle(t);writeFileSync(join(path,'assets/extra.js'),'// stale application');
  assert.throws(()=>validateNativeBundle('ios','links.example.test',path),/FILES_CHANGED/);
  rmSync(join(path,'assets/extra.js'));rmSync(join(path,'assets/main.js'));
  assert.throws(()=>validateNativeBundle('ios','links.example.test',path),/FILES_CHANGED/);
  writeFileSync(join(path,'assets/main.js'),'// rebuilt application');writeNativeBundleBinding(settings,path);
  const manifest=JSON.parse(readFileSync(join(path,'native-link-binding.json'),'utf8'));
  manifest.files['../private-key']='0'.repeat(64);writeFileSync(join(path,'native-link-binding.json'),JSON.stringify(manifest));
  assert.throws(()=>validateNativeBundle('ios','links.example.test',path),/BUNDLE_INVALID/);
});
test('an unconfigured native build stays explicit and cannot be combined with a configured OS host',t=>{
  const path=directory(t);assert.deepEqual(validateNativeBundle('ios','unconfigured.invalid',path),{configured:false,filesVerified:0});
  assert.throws(()=>validateNativeBundle('ios','links.example.test',path),/BINDING_REQUIRED/);
});
test('Capacitor bridge additions are admitted while a bridge shipped by Vite retains its checksum',t=>{
  const {path,settings}=bundle(t);writeFileSync(join(path,'cordova.js'),'// generated Capacitor bridge');
  assert.equal(validateNativeBundle('ios','links.example.test',path).configured,true);
  writeNativeBundleBinding(settings,path);assert.equal(validateNativeBundle('ios','links.example.test',path).filesVerified,3);
  writeFileSync(join(path,'cordova.js'),'// changed original bridge');
  assert.throws(()=>validateNativeBundle('ios','links.example.test',path),/BYTES_CHANGED/);
});
