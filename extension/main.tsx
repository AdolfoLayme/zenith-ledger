import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import '@fontsource-variable/inter';
import '../src/ui/styles.css';
import { App } from '../src/ui/App';
import { auditActiveTabTable } from './extractTable';

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App extension={{ auditPage: auditActiveTabTable }} />
  </StrictMode>,
);
