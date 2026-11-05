import { createApp } from './app.js';
import { config } from './config.js';
import { pool } from './db.js';

await pool.query('SELECT 1');
createApp().listen(config.port, () => console.log(`E-Learning API listening on http://localhost:${config.port}`));
