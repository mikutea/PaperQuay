import assert from 'node:assert/strict';
import {createElement} from 'react';
import {renderToStaticMarkup} from 'react-dom/server';
import test from 'node:test';
import {androidAuthReturn} from '../src/auth/androidReturn.ts';
import {nativeCallback} from '../src/auth/nativeOidc.ts';
import {AndroidAuthReturn} from '../src/components/AndroidAuthReturn.tsx';

const origin='https://links.example.test';
const state='synthetic_public_callback_state_123';
const base=`${origin}/auth/native/android/callback`;
const callback=`${base}?code=synthetic-code&state=${state}&iss=${encodeURIComponent(origin+'/identity/realm')}`;

test('a browser-held native callback offers a user-initiated HTTPS handoff resolved by OS app-link policies',()=>{
  const result=androidAuthReturn(callback);
  assert(result&&result.status==='ready');
  assert.equal(result.href,`intent:${callback.slice('https:'.length)}#Intent;scheme=https;action=android.intent.action.VIEW;category=android.intent.category.DEFAULT;category=android.intent.category.BROWSABLE;end`);
  assert.doesNotMatch(result.href,/[;#](?:package|component|S\.browser_fallback_url)=/);
  const delivered='https:'+result.href.slice('intent:'.length).split('#Intent;')[0];
  assert.equal(delivered,callback);
  assert.deepEqual(nativeCallback(delivered,base),{state});
  const html=renderToStaticMarkup(createElement(AndroidAuthReturn,{result}));
  assert.match(html,/返回 PaperQuay<\/a>/);
  assert.doesNotMatch(html,/<(?:script|form)\b|http-equiv|登录到你的文库/);
  assert(!html.replace(/<[^>]*>/g,'').includes('synthetic-code'));
});

test('ordinary Web, iOS, and lookalike routes retain their existing entrypoint',()=>{
  for(const value of [origin+'/',origin+'/auth/callback',origin+'/auth/native/ios/callback',base+'/',base+'/extra','not a URL'])
    assert.equal(androidAuthReturn(value),null);
});

test('invalid callbacks never offer an app-launch link or display query content',()=>{
  for(const value of [base,callback+'&state='+state,callback+'&code=second',callback+'#fragment',
    callback+'&access_token=synthetic-token',callback+'&error=other',callback.replace('https:','http:'),
    callback.replace('links.example.test','user:synthetic-password@links.example.test'),callback.replace('links.example.test','links.example.test:8443')]){
    const result=androidAuthReturn(value);assert.deepEqual(result,{status:'invalid'});
    const html=renderToStaticMarkup(createElement(AndroidAuthReturn,{result:result!}));
    assert.doesNotMatch(html,/<a\b|intent:|synthetic-|access_token/);
    assert.match(html,/在 PaperQuay 中重新点击登录/);
  }
});

test('provider errors and logout return to the app without claiming authentication succeeded',()=>{
  for(const [url,action,status] of [
    [base+`?error=access_denied&state=${state}`,'login','error'],
    [origin+`/auth/native/android/logout?state=${state}`,'logout','ready'],
  ] as const){
    const result=androidAuthReturn(url);assert(result&&result.status!=='invalid');
    assert.equal(result.action,action);assert.equal(result.status,status);
    const html=renderToStaticMarkup(createElement(AndroidAuthReturn,{result}));
    assert.match(html,/返回 PaperQuay/);assert.doesNotMatch(html.replace(/<[^>]*>/g,''),/已登录|登录成功|access_denied/);
  }
});
