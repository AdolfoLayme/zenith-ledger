import '@fontsource-variable/inter';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { registerServiceWorker } from './pwa/pwa';
import { App } from './ui/App';
import './ui/styles.css';

void registerServiceWorker();
createRoot(document.getElementById('root')!).render(<StrictMode><App /></StrictMode>);
