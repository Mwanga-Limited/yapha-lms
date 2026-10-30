import { useEffect, useState } from 'react';
import { api, type TenantInfo, type TenantSettings } from '../../api';
import { useAuth } from '../../auth';
import { SettingsForm } from '../../components/SettingsForm';
import { Button, ErrorState, Field, Loading, fmtDate, useAction, useDocumentTitle, useLoad } from '../../ui';
import { AdminNav } from './Dashboard';

interface SettingsData { tenant: TenantInfo; settings: TenantSettings; name: string; slug: string; id: string; createdAt: string; counts: { members: number; published_courses: number } }

export function AdminSettings() {
  useDocumentTitle('Organisation settings');
  const { setTenant } = useAuth();
  const { data, error, loading, reload } = useLoad(() => api<SettingsData>('admin', 'settings'), []);
  const [draft, setDraft] = useState<TenantSettings | null>(null);
  const [name, setName] = useState('');
  const { busy, run } = useAction();
  useEffect(() => { if (data) { setDraft(data.settings); setName(data.name); } }, [data]);

  if (loading && !data) return <Loading />;
  if (error) return <ErrorState error={error} onRetry={reload} />;
  if (!data || !draft) return null;
  const dirty = JSON.stringify(draft) !== JSON.stringify(data.settings) || name !== data.name;

  const save = () => run(async () => {
    const r = await api<{ tenant: TenantInfo; settings: TenantSettings }>('admin', 'updateSettings', { name, settings: draft });
    setTenant(r.tenant);
    await reload();
  }, 'Settings saved');

  return (
    <>
      <AdminNav />
      <div className="page-head"><h1>Organisation settings</h1><p className="muted">These apply only to {data.tenant.name}.</p></div>
      <div className="org-ids panel">
        <div><span className="muted small">Organisation ID</span><code>{data.id}</code></div>
        <div><span className="muted small">Web address</span><code>{window.location.host}/t/{data.slug}</code></div>
        <div><span className="muted small">Created</span><span>{fmtDate(data.createdAt)}</span></div>
        <div><span className="muted small">Members</span><span>{data.counts.members}</span></div>
      </div>
      <div className="panel">
        <Field label="Organisation name" value={name} onChange={(e) => setName(e.target.value)} maxLength={120} required />
        <SettingsForm value={draft} onChange={setDraft} logoPreviewUrl={data.tenant.branding.logoUrl} canUploadLogo />
      </div>
      <div className={`savebar ${dirty ? 'dirty' : ''}`}>
        <span>{dirty ? 'You have unsaved changes' : 'All changes saved'}</span>
        <Button busy={busy} disabled={!dirty || !name.trim()} onClick={save}>Save settings</Button>
      </div>
    </>
  );
}
