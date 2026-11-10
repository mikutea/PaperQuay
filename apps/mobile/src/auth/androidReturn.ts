import {nativeCallback} from './nativeOidc.ts';

export type AndroidAuthReturn =
  | {status:'ready'|'error';action:'login'|'logout';href:string}
  | {status:'invalid'};

/** Some Custom Tabs keep same-origin HTTPS callbacks in the browser. A user
 * gesture can explicitly deliver that same HTTPS URL to the installed app. */
export function androidAuthReturn(value:string):AndroidAuthReturn|null {
  let url:URL;
  try {url=new URL(value);} catch {return null;}
  const action=url.pathname==='/auth/native/android/callback'?'login'
    :url.pathname==='/auth/native/android/logout'?'logout':null;
  if(!action)return null;
  try {
    if(url.protocol!=='https:')throw Error();
    nativeCallback(value,`${url.origin}${url.pathname}`,action==='logout');
    // Let Android enforce domain association; an explicit package could bypass it.
    return {status:url.searchParams.has('error')?'error':'ready',action,
      href:`intent:${url.href.slice('https:'.length)}#Intent;scheme=https;action=android.intent.action.VIEW;category=android.intent.category.DEFAULT;category=android.intent.category.BROWSABLE;end`};
  } catch {return {status:'invalid'};}
}
