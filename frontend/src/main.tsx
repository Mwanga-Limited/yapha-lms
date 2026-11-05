import { StrictMode, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router-dom';
import { RESERVED_PATHS, setTenantSlug } from './api';
import { App } from './App';
import { AuthProvider } from './auth';
import { Landing } from './pages/Landing';
import { RegisterOrganisation } from './pages/RegisterOrganisation';
import { PlatformApp } from './platform/PlatformApp';
import { ToastProvider } from './ui';
import './styles.css';

/*
 * Three apps share one bundle, chosen by the address:
 *   /<organisation>/...    an organisation's own e-learning site (each organisation is isolated)
 *   /platform/...          the super admin console (all organisations)
 *   /register              an organisation registers itself (its first Admin is the person registering)
 *   /                      "find your organisation"
 * Inside an organisation the router's basename is /<organisation>, so every page link stays inside it.
 * Words such as platform and register are reserved (RESERVED_PATHS), so no organisation can use them.
 * Older links of the form /t/<organisation>/... are forwarded to /<organisation>/....
 */
const legacy = window.location.pathname.match(/^\/t\/([a-z0-9][a-z0-9-]{0,39})(\/.*)?$/i);
if (legacy) window.location.replace(`/${legacy[1].toLowerCase()}${legacy[2] ?? '/'}${window.location.search}${window.location.hash}`);

const path = window.location.pathname;
const first = path.match(/^\/([a-z0-9][a-z0-9-]{0,39})(\/|$)/i);
const tenantMatch = !legacy && first && !RESERVED_PATHS.has(first[1].toLowerCase()) ? first : null;

let app: ReactNode;
if (tenantMatch) {
  const slug = tenantMatch[1].toLowerCase();
  setTenantSlug(slug);
  app = (
    <BrowserRouter basename={`/${slug}`}>
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
} else if (path === '/register' || path === '/register/') {
  app = <ToastProvider><RegisterOrganisation /></ToastProvider>;
} else {
  app = <ToastProvider><Landing /></ToastProvider>;
}

createRoot(document.getElementById('root')!).render(<StrictMode>{app}</StrictMode>);
