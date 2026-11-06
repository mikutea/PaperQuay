import assert from 'node:assert/strict';
import test from 'node:test';
import {nativeLinkBinding,nativeLinksFromEnvironment} from '../src/auth/nativeLinks.ts';
import {nativeRedirects,parseAppConfig,NATIVE_REDIRECT_URI} from '../src/config.ts';
import {nativeCallback,NativeOidcSession} from '../src/auth/nativeOidc.ts';
import {MemorySecretStore} from '../src/platform/secretStore.ts';

const origin='https://mobile.example.test',input={apiBaseUrl:'https://sync.example.test',oidcAuthority:'https://id.example.test/realms/paperquay',oidcClientId:'paperquay-mobile'};
test('each native platform has independent exact HTTPS callback, logout and public client bindings',()=>{
  const ios=nativeLinkBinding('ios',origin),android=nativeLinkBinding('android',origin);
  assert.notEqual(ios.clientId,android.clientId);assert.notEqual(ios.redirectUri,android.redirectUri);
  assert.equal(ios.redirectUri,origin+'/auth/native/ios/callback');assert.equal(android.logoutRedirectUri,origin+'/auth/native/android/logout');
  for(const binding of [ios,android]){
    const config=parseAppConfig({...input,oidcClientId:binding.clientId},'capacitor://localhost',true,binding);
    assert.equal(config.redirectUri,binding.redirectUri);
    assert.throws(()=>nativeRedirects(input,binding,true),{code:'CONFIG_INVALID'});
    assert.throws(()=>nativeRedirects({...config,oidcAuthority:'http://127.0.0.1/realm'},binding,true),{code:'CONFIG_INVALID'});
    assert.throws(()=>nativeRedirects(config,{...binding,redirectUri:origin+'/auth/callback'},true),{code:'CONFIG_INVALID'});
  }
});
test('native production does not fall back to a private-use scheme or a public Web client',()=>{
  assert.throws(()=>nativeRedirects(input,null,true),{code:'NATIVE_LINKS_REQUIRED'});
  assert.equal(nativeRedirects(input,null,false).redirectUri,NATIVE_REDIRECT_URI);
  const binding=nativeLinkBinding('ios',origin),config=parseAppConfig({...input,oidcClientId:binding.clientId},'capacitor://localhost',true,binding);
  const bridge={open:async()=>{},close:async()=>{},listen:async()=>async()=>{},launchUrl:async()=>undefined};
  assert.throws(()=>new NativeOidcSession({...config,redirectUri:NATIVE_REDIRECT_URI},{bridge,secrets:new MemorySecretStore(),links:binding}),{code:'CONFIG_INVALID'});
  assert.throws(()=>new NativeOidcSession(config,{bridge,secrets:new MemorySecretStore(),links:nativeLinkBinding('android',origin)}),{code:'CONFIG_INVALID'});
});
test('build metadata requires matching platform and canonical credential-free HTTPS origin',()=>{
  assert.equal(nativeLinksFromEnvironment('ios',{}),null);
  const environment={VITE_NATIVE_LINK_ORIGIN:origin,VITE_NATIVE_LINK_PLATFORM:'ios'};
  assert.equal(nativeLinksFromEnvironment('ios',environment)!.redirectUri,origin+'/auth/native/ios/callback');
  for(const value of [{VITE_NATIVE_LINK_ORIGIN:origin},{VITE_NATIVE_LINK_PLATFORM:'ios'},environment])
    assert.throws(()=>nativeLinksFromEnvironment('android',value),{code:'CONFIG_INVALID'});
  for(const value of ['http://mobile.example.test','https://mobile.example.test/','https://mobile.example.test/path',
    'https://user:secret@mobile.example.test','https://mobile.example.test?token=x','https://mobile.example.test#x',
    'https://*.example.test','https://127.0.0.1','https://localhost','https://mobile.example.test:444','https://MOBILE.example.test',
    'https://example.test-','https://unconfigured.invalid','https://'+('a'.repeat(63)+'.').repeat(4)+'test'])
    assert.throws(()=>nativeLinkBinding('ios',value),{code:'CONFIG_INVALID'});
});
test('claimed callbacks reject the other platform, Web endpoint, redirects, duplicate parameters and returned tokens',()=>{
  const binding=nativeLinkBinding('ios',origin),state='a'.repeat(32),good=binding.redirectUri+'?state='+state+'&code=one';
  assert.deepEqual(nativeCallback(good,binding.redirectUri),{state});
  for(const bad of [good.replace('/ios/','/android/'),good.replace('/native/ios',''),good.replace(origin,'https://foreign.example.test'),
    good+'&code=two',good+'&access_token=private',good+'#fragment',good.replace('https:','http:')])
    assert.throws(()=>nativeCallback(bad,binding.redirectUri),{code:'AUTH_FAILED'});
  assert.deepEqual(nativeCallback(binding.logoutRedirectUri+'?state='+state,binding.logoutRedirectUri,true),{state});
});
