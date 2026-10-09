// First: outside Tauri (plain `npm run dev` in a browser) it stands in for
// the backend before any other module makes an IPC call.
import './lib/browserPreview';
import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import '@fontsource/familjen-grotesk/500.css';
import '@fontsource/familjen-grotesk/600.css';
import '@fontsource/familjen-grotesk/700.css';
import '@fontsource/schibsted-grotesk/400.css';
import '@fontsource/schibsted-grotesk/500.css';
import '@fontsource/schibsted-grotesk/600.css';
import '@fontsource/schibsted-grotesk/700.css';
import './index.css';
import { applyTheme, applyThemeFromCache } from './lib/theme';
import { getSetting } from './lib/tauri';
import type { Theme } from './components/settings/constants';
import { applyUiScale, useDisplayStore } from './stores/display-store';

// Instant theme from localStorage cache (no flash)
applyThemeFromCache();

// Then sync with the authoritative SQLite setting
getSetting('theme').then((saved) => {
  applyTheme((saved as Theme) || 'system');
});

// Interface scale from the display settings, now and whenever it changes.
applyUiScale(useDisplayStore.getState().uiScale);
useDisplayStore.subscribe((state, prev) => {
  if (state.uiScale !== prev.uiScale) applyUiScale(state.uiScale);
});

ReactDOM.createRoot(document.getElementById('root') as HTMLElement).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
