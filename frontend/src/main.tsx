import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { setTenantSlug } from './api';
import { App } from './App';
import { AuthProvider } from './auth';
import { Landing } from './pages/Landing';
import { PlatformApp } from './platform/PlatformApp';
import { ToastProvider } from './ui';
import './styles.css';

/*
 * Three apps share one bundle, chosen by the address:
 *   /t/<organisation>/...  an organisation's own e-learning site (each organisation is isolated)
 *   /platform/...          the super admin console (all organisations)
 *   /                      "find your organisation"
 * Inside an organisation the router's basename is /t/<organisation>, so every page link stays inside it.
 */
const path = window.location.pathname;
const tenantMatch = path.match(/^\/t\/([a-z0-9][a-z0-9-]{0,39})(\/|$)/i);

let app: ReactNode;
if (tenantMatch) {
  const slug = tenantMatch[1].toLowerCase();
  setTenantSlug(slug);
  app = (
    <BrowserRouter basename={`/t/${slug}`}>
      <ToastProvider>
        <AuthProvider>
          <App />
        </AuthProvider>
      </ToastProvider>
    </BrowserRouter>
  );
} else if (path === '/platform' || path.startsWith('/platform/')) {
  app = (
    <BrowserRouter basename="/platform">
      <ToastProvider>
        <PlatformApp />
      </ToastProvider>
    </BrowserRouter>
  );
} else {
  app = <ToastProvider><Landing /></ToastProvider>;
}

createRoot(document.getElementById('root')!).render(<StrictMode>{app}</StrictMode>);
