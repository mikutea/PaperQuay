import type {AndroidAuthReturn as ReturnState} from '../auth/androidReturn.ts';
import {Icon} from './Icon.tsx';

export function AndroidAuthReturn({result}:{result:ReturnState}) {
  return <main className="login-page native-auth-return">
    <div className="brand"><span className="brand-mark"><Icon name="library" /></span>PaperQuay</div>
    <section className="login-panel" aria-labelledby="native-return-heading">
      <div className="connection-art" aria-hidden="true"><span /><span><Icon name="device" /></span></div>
      <h1 id="native-return-heading">{result.status==='invalid'?'无法继续这次登录':'回到 PaperQuay'}</h1>
      <p className="muted">{result.status==='invalid'?'请关闭此页，在 PaperQuay 中重新点击登录。'
        :result.status==='error'?'本次授权未完成。请返回应用后重试。'
        :result.action==='logout'?'点击下方按钮，在应用中完成退出。':'点击下方按钮，在应用中继续登录。'}</p>
      {result.status!=='invalid'&&<a className="primary" href={result.href} rel="noreferrer">返回 PaperQuay</a>}
    </section>
  </main>;
}
