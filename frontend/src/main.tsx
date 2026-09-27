import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { I18nProvider, initI18n } from './i18n';
import './index.css';

// Warm the active language layer; the provider re-renders once it arrives.
void initI18n();

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <I18nProvider>
      <App />
    </I18nProvider>
  </React.StrictMode>
);
