import ReactDOM from 'react-dom/client';
import { App } from './App.tsx';
import { loadRuntimeConfig } from './runtimeConfig.ts';
import './styles.css';
import './components/paperReader.css';
import './components/cloudPdf.css';
import './components/aiWorkspace.css';
import './components/aiArchive.css';
import './components/aiSyncPanel.css';
import './components/noteExport.css';
import './components/richNoteEditor.css';
import './theme.css';

void loadRuntimeConfig(location.origin).then(defaults => {
  ReactDOM.createRoot(document.getElementById('root')!).render(<App defaults={defaults} />);
});

import './components/incomingShare.css';

import './components/accountPrivacy.css';
