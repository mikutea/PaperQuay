import ReactDOM from 'react-dom/client';
import { App } from './App.tsx';
import './styles.css';
import './components/paperReader.css';
import './components/cloudPdf.css';
import './components/aiWorkspace.css';
import './components/aiArchive.css';
import './components/aiSyncPanel.css';
import './components/noteExport.css';
import './components/richNoteEditor.css';
import './theme.css';

ReactDOM.createRoot(document.getElementById('root')!).render(<App />);
