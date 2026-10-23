import { Link } from 'react-router-dom';
import { api, type Notification } from '../api';
import { Button, Empty, Loading, fmtDateTime, useAction, useDocumentTitle, useLoad } from '../ui';

export function Notifications() {
  useDocumentTitle('Notifications');
  const { data, loading, reload } = useLoad(() => api<{ items: Notification[]; unread: number }>('account', 'notifications', { limit: 100 }), []);
  const { busy, run } = useAction();
  return (
    <>
      <div className="page-head row-between">
        <h1>Notifications</h1>
        {!!data?.unread && <Button variant="secondary" small busy={busy} onClick={() => run(async () => { await api('account', 'markNotificationsRead'); await reload(); })}>Mark all as read</Button>}
      </div>
      {loading && !data && <Loading />}
      {data && data.items.length === 0 && <Empty title="No notifications yet">Course decisions, quiz results and certificates show up here.</Empty>}
      <ul className="notif-list">
        {data?.items.map((n) => (
          <li key={n.id} className={n.read_at ? '' : 'unread'}>
            <div>
              <strong>{n.title}</strong>
              {n.body && <p>{n.body}</p>}
              <span className="muted small">{fmtDateTime(n.created_at)}</span>
            </div>
            {n.link && <Link to={n.link} onClick={() => { if (!n.read_at) void api('account', 'markNotificationsRead', { ids: [n.id] }); }}>Open</Link>}
          </li>
        ))}
      </ul>
    </>
  );
}
