import * as Sentry from '@sentry/react';
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

// Better Stack Errors (Sentry-compatible). Off when VITE_BETTERSTACK_ERRORS_DSN is empty. The DSN is public by design.
const errorsDsn = import.meta.env.VITE_BETTERSTACK_ERRORS_DSN as string | undefined;
if (errorsDsn) {
  Sentry.init({
    dsn: errorsDsn,
    environment: import.meta.env.MODE,
    release: import.meta.env.VITE_RELEASE as string | undefined,
    tracesSampleRate: 0,
    beforeSend(event) {
      // Addresses can carry reset tokens, invite codes and organisation names in the query string or hash: keep the path only.
      if (event.request?.url) event.request.url = event.request.url.split(/[?#]/)[0];
      delete event.request?.headers;
      delete event.request?.cookies;
      delete event.user;
      return event;
    },
  });
}

function Crashed() {
  return <div role="alert" style={{ padding: 32, fontFamily: 'sans-serif' }}><h1>Something went wrong</h1><p>Please reload the page. If it keeps happening, contact support.</p></div>;
}

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

createRoot(document.getElementById('root')!).render(<StrictMode><Sentry.ErrorBoundary fallback={<Crashed />}>{app}</Sentry.ErrorBoundary></StrictMode>);
