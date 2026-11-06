import assert from 'node:assert/strict';
import test from 'node:test';
import {User,UserManager,InMemoryWebStorage} from 'oidc-client-ts';
import {OidcSession} from '../src/auth/oidc.ts';
import {parseAppConfig} from '../src/config.ts';

const config=parseAppConfig({apiBaseUrl:'https://sync.example.test',oidcAuthority:'https://id.example.test/realms/paperquay',oidcClientId:'web'},'https://app.example.test');
function deferred<T>(){let resolve!:(value:T)=>void;const promise=new Promise<T>(done=>{resolve=done;});return{promise,resolve};}
function user(sid='original',rotated=false){return new User({access_token:rotated?'rotated-access':'original-access',token_type:'Bearer',
  refresh_token:rotated?'rotated-refresh':'original-refresh',expires_at:Math.floor(Date.now()/1000)+(rotated?3600:10),
  profile:{iss:config.oidcAuthority,sub:'owner',aud:config.oidcClientId,sid,iat:Math.floor(Date.now()/1000),exp:Math.floor(Date.now()/1000)+3600}});}

test('Web erasure waits for an existing refresh, blocks its ordinary caller and clears storage before ACK',async t=>{
  const sid='s'.repeat(512),release=deferred<User>(),entered=deferred<void>();let stored:User|null=null,refreshes=0;
  t.mock.method(UserManager.prototype,'signinRedirectCallback',async()=>stored=user(sid));
  t.mock.method(UserManager.prototype,'signinSilent',async()=>{refreshes++;entered.resolve();stored=await release.promise;return stored;});
  t.mock.method(UserManager.prototype,'removeUser',async()=>{stored=null;});
  t.mock.method(globalThis,'fetch',async()=>{throw Error('Erasure must use the completed rotation');});
  const session=new OidcSession(config,new InMemoryWebStorage());t.after(()=>session.dispose());
  await session.completeSignIn(config.redirectUri);const originalKey=session.getSubject()!.sessionKey;
  const ordinary=assert.rejects(session.getAccessToken(),{code:'AUTH_REQUIRED'});await entered.promise;
  let acknowledgements=0;
  const clearing=session.clearLocalSession({renewForErasure:true,afterPersisted:async token=>{
    assert.equal(stored,null);assert.equal(token,'rotated-access');assert.equal(session.getSubject()!.sessionKey,originalKey);
    await assert.rejects(session.getAccessToken(),{code:'AUTH_REQUIRED'});acknowledgements++;
  }});
  await assert.rejects(session.getAccessToken(),{code:'AUTH_REQUIRED'});assert.equal(acknowledgements,0);
  release.resolve(user(sid,true));await ordinary;await clearing;
  assert.equal(refreshes,1);assert.equal(acknowledgements,1);assert.equal(session.getSubject(),null);
});

test('a Web peer retains only its original volatile session until its own explicit confirmation',async t=>{
  let stored:User|null=user('peer',true);
  t.mock.method(UserManager.prototype,'signinRedirectCallback',async()=>stored!);
  t.mock.method(UserManager.prototype,'removeUser',async()=>{stored=null;});
  const session=new OidcSession(config,new InMemoryWebStorage());t.after(()=>session.dispose());
  await session.completeSignIn(config.redirectUri);const original=session.getSubject();
  await session.clearLocalSession({retainForErasure:true});
  assert.equal(stored,null);assert.deepEqual(session.getSubject(),original);
  assert.equal(session.getSnapshot().status,'signed-in');assert.equal(session.getSnapshot().needsLogin,true);
  await assert.rejects(session.getAccessToken(),{code:'AUTH_REQUIRED'});
  let verified=0;
  await session.clearLocalSession({retainForErasure:true,renewForErasure:true,afterPersisted:async token=>{
    assert.equal(stored,null);assert.equal(token,'rotated-access');verified++;
  }});
  assert.equal(verified,1);assert.deepEqual(session.getSubject(),original);
  await session.clearLocalSession({renewForErasure:true,afterPersisted:async token=>{assert.equal(token,'rotated-access');}});
  assert.equal(session.getSubject(),null);assert.equal(session.getSnapshot().status,'signed-out');
});

test('a replacement Web login invalidates erasure waiting for the former rotation without clearing the replacement',async t=>{
  const release=deferred<User>(),entered=deferred<void>();let next=user(),removals=0;
  t.mock.method(UserManager.prototype,'signinRedirectCallback',async()=>next);
  t.mock.method(UserManager.prototype,'signinSilent',async()=>{entered.resolve();return release.promise;});
  t.mock.method(UserManager.prototype,'removeUser',async()=>{removals++;});
  const session=new OidcSession(config,new InMemoryWebStorage());t.after(()=>session.dispose());
  await session.completeSignIn(config.redirectUri);
  const ordinary=assert.rejects(session.getAccessToken(),{code:'AUTH_REQUIRED'});await entered.promise;
  let acknowledgements=0;
  const clearing=assert.rejects(session.clearLocalSession({renewForErasure:true,afterPersisted:async()=>{acknowledgements++;}}),{code:'ACCOUNT_CHANGED'});
  next=user('replacement',true);await session.completeSignIn(config.redirectUri);const replacement=session.getSubject()!.sessionKey;
  release.resolve(user('original',true));await ordinary;await clearing;
  assert.equal(removals,0);assert.equal(acknowledgements,0);assert.equal(session.getSubject()!.sessionKey,replacement);
  assert.equal(await session.getAccessToken(),'rotated-access');
});
