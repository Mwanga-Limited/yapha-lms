import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';

await pool.query('SELECT 1');
// Express 5 passes a failed listen (e.g. the port is in use) to this callback, so check for it.
createApp().listen(config.port, (err) => {
  if (err) {
    console.error(err.code === 'EADDRINUSE'
      ? `Port ${config.port} is already in use: another copy of the API is probably running. Stop it, or set PORT in backend/.env.`
      : err);
    process.exit(1);
  }
  console.log(`Yapha API listening on http://localhost:${config.port}`);
});
