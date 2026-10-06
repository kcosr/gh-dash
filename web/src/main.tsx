import './workbench/styles/index.css';
import './styles/app.css';
import './styles/web.css';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './App';
import { applyStoredTheme } from './workbench';
import { THEME_KEY } from './lib/storage';

applyStoredTheme(THEME_KEY);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
