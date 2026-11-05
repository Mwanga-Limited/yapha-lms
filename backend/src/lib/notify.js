/** Insert an in-app notification (shown in the bell). */
export async function notify(db, userId, { type, title, body = '', link = null }) {
  await db.query(`INSERT INTO notifications (user_id, type, title, body, link) VALUES ($1,$2,$3,$4,$5)`, [userId, type, title, body, link]);
}

export async function notifyAdmins(db, payload) {
  const { rows } = await db.query(`SELECT id FROM users WHERE role = 'admin' AND is_active`);
  for (const r of rows) await notify(db, r.id, payload);
}
