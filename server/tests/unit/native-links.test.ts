import assert from 'node:assert/strict';
import test from 'node:test';
import {buildApp} from '../../src/app.ts';
import {ApiError} from '../../src/errors.ts';
import {loadNativeAssociations} from '../../src/native-links.ts';
import type {SyncRepository} from '../../src/types.ts';
import {testConfig} from '../fixtures.ts';

const origin='https://links.example.test',prefix='QATEST1234',certificate='12:34:'.repeat(15)+'12:34';
const environment={PAPERQUAY_NATIVE_LINK_ORIGIN:origin,PAPERQUAY_NATIVE_IOS_APPLICATION_IDENTIFIER_PREFIX:prefix,
  PAPERQUAY_NATIVE_ANDROID_CERTIFICATE_SHA256:certificate};
const apple='/.well-known/apple-app-site-association',android='/.well-known/assetlinks.json';
function repository(){return new Proxy({ready:async()=>true},{get(target,key){
  if(key==='ready')return target.ready;throw Error('public association routes must not read business data');
}}) as SyncRepository;}

test('public association configuration is opt in and never enables an OAuth client or native CORS origin',()=>{
  assert.equal(loadNativeAssociations({}),null);
  const config=testConfig(environment);assert.equal(config.nativeAssociations?.origin,origin);
  assert.deepEqual(config.oidcClientIds,['paperquay-test']);assert.deepEqual(config.allowedOrigins,['http://127.0.0.1:5174']);
  for(const invalid of [{PAPERQUAY_NATIVE_LINK_ORIGIN:origin},
    {...environment,PAPERQUAY_NATIVE_LINK_ORIGIN:'https://links.example.test/'},
    {...environment,PAPERQUAY_NATIVE_LINK_ORIGIN:'https://user:synthetic-secret@links.example.test'},
    {...environment,PAPERQUAY_NATIVE_IOS_APPLICATION_IDENTIFIER_PREFIX:'bad'},
    {...environment,PAPERQUAY_NATIVE_ANDROID_CERTIFICATE_SHA256:certificate+','+certificate},
    {...environment,PAPERQUAY_NATIVE_ANDROID_CERTIFICATE_SHA256:''}]){
    assert.throws(()=>testConfig(invalid),{code:'CONFIGURATION_INVALID'});
  }
});
test('only the configured host returns credential-free JSON associations without reading account data',async t=>{
  let authentications=0;
  const app=await buildApp({config:testConfig(environment),repository:repository(),rateLimitEnabled:false,
    verifyToken:async()=>{authentications++;throw new ApiError('AUTHENTICATION_REQUIRED',401);}});t.after(()=>app.close());
  const ios=await app.inject({url:apple,headers:{host:'LINKS.example.test',authorization:'Bearer invalid'}});
  assert.equal(ios.statusCode,200);assert.match(ios.headers['content-type']!,/^application\/json/);
  assert.equal(ios.headers['cache-control'],'no-store');assert.equal(ios.headers['referrer-policy'],'no-referrer');
  assert.deepEqual(ios.json().applinks.details,[{appID:prefix+'.dev.paperquay.mobile',paths:['/auth/native/ios/callback','/auth/native/ios/logout']}]);
  const apk=await app.inject({url:android,headers:{host:'links.example.test'}});assert.equal(apk.statusCode,200);
  assert.deepEqual(apk.json()[0].target.sha256_cert_fingerprints,[certificate]);assert.equal(authentications,0);
  const wrong=await app.inject({url:apple,headers:{host:'other.example.test','x-forwarded-host':'links.example.test'}});
  assert.equal(wrong.statusCode,404);assert.equal(wrong.json().error.code,'NOT_FOUND');
  assert.equal((await app.inject({url:'/v1/me'})).statusCode,401);assert.equal(authentications,1);
});
test('absent or unconfigured platform associations return 404',async t=>{
  for(const config of [testConfig(),testConfig({PAPERQUAY_NATIVE_LINK_ORIGIN:origin,PAPERQUAY_NATIVE_IOS_APPLICATION_IDENTIFIER_PREFIX:prefix})]){
    const app=await buildApp({config,repository:repository(),rateLimitEnabled:false,verifyToken:async()=>{throw Error('not called');}});t.after(()=>app.close());
    assert.equal((await app.inject({url:android,headers:{host:'links.example.test'}})).statusCode,404);
    assert.equal((await app.inject({url:apple,headers:{host:'links.example.test'}})).statusCode,config.nativeAssociations?200:404);
  }
});
test('the association endpoints use the existing shared anonymous rate limit',async t=>{
  const app=await buildApp({config:testConfig({...environment,PAPERQUAY_REQUESTS_PER_MINUTE:'1'}),repository:repository(),verifyToken:async()=>{throw Error('not called');}});t.after(()=>app.close());
  assert.equal((await app.inject({url:apple,headers:{host:'links.example.test'}})).statusCode,200);
  const limited=await app.inject({url:android,headers:{host:'links.example.test'}});
  assert.equal(limited.statusCode,429);assert.equal(limited.json().error.code,'RATE_LIMITED');
});
