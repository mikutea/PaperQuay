import ReactDOM from 'react-dom/client';
import {Capacitor} from '@capacitor/core';
import { App } from './App.tsx';
import {androidAuthReturn} from './auth/androidReturn.ts';
import {AndroidAuthReturn} from './components/AndroidAuthReturn.tsx';
import { loadRuntimeConfig } from './runtimeConfig.ts';
import {observeSystemBarTheme} from './platform/systemBarTheme.ts';
import './styles.css';
import './components/paperReader.css';
import './components/cloudPdf.css';
import './components/aiWorkspace.css';
import './components/aiArchive.css';
import './components/aiSyncPanel.css';
import './components/noteExport.css';
import './components/richNoteEditor.css';
import './theme.css';

const stopSystemBarTheme = observeSystemBarTheme();
if (import.meta.hot) import.meta.hot.dispose(stopSystemBarTheme);

const returnState=Capacitor.isNativePlatform()?null:androidAuthReturn(location.href);
const root=ReactDOM.createRoot(document.getElementById('root')!);
if(returnState)root.render(<AndroidAuthReturn result={returnState} />);
else void loadRuntimeConfig(location.origin).then(defaults => root.render(<App defaults={defaults} />));

import './components/incomingShare.css';

import './components/accountPrivacy.css';
