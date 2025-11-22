// server.js — Full backend for BK Spiritual Chart
// Includes: full auth, points CRUD, daily records, progress aggregation,
// admin member management, debug reset routes.
// Replace env vars as needed: DATABASE_URL, FRONTEND_URL, PORT

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// CORS
app.use(cors({
  origin: [
    'https://try-bk-chart.vercel.app',
    'https://bk-chart.vercel.app',
    'http://localhost:3000',
    'http://localhost:5173',
    process.env.FRONTEND_URL
  ].filter(Boolean),
  credentials: true
}));
app.use(express.json());

// Postgres pool
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

pool.on('connect', () => console.log('✅ Connected to PostgreSQL database'));
pool.on('error', (err) => console.error('❌ Unexpected database error:', err));

// ---------- Helpers ----------

async function ensureSchemaAndDefaults() {
  // Create tables if missing (safe, idempotent)
  await pool.query(`
    CREATE TABLE IF NOT EXISTS admins (
      id SERIAL PRIMARY KEY,
      username VARCHAR(100) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS members (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255),
      centre VARCHAR(255),
      mobile VARCHAR(20) UNIQUE NOT NULL,
      password VARCHAR(255),
      status VARCHAR(20) DEFAULT 'approved',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS points (
      id SERIAL PRIMARY KEY,
      text TEXT NOT NULL,
      order_num INTEGER
    );
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS daily_records (
      id SERIAL PRIMARY KEY,
      member_id INTEGER REFERENCES members(id) ON DELETE CASCADE,
      point_id INTEGER REFERENCES points(id) ON DELETE CASCADE,
      date DATE NOT NULL,
      effort INTEGER DEFAULT 0,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(member_id, point_id, date)
    );
  `);

  // default admin
  const adminRes = await pool.query(`SELECT * FROM admins WHERE username=$1`, ['AmeerMushak']);
  if (adminRes.rows.length === 0) {
    const hashed = await bcrypt.hash('Trichy@123', 10);
    await pool.query(`INSERT INTO admins (username, password) VALUES ($1, $2)`, ['AmeerMushak', hashed]);
    console.log('✅ Default admin created');
  }

  // default points (only if none exist)
  const ptsCount = await pool.query(`SELECT COUNT(*) FROM points`);
  if (Number(ptsCount.rows[0].count) === 0) {
    const defaultPoints = [
      'பிறரிடம் பேசும்பொழுது ஆத்ம உணர்வோடு, ஆத்மாவோடு பேசினேனா?',
      'அமிர்தவேளை சக்திசாலியாக இருந்ததா?',
      '(அமிர்த வேளை உட்பட) 4 மணி நேரம் அமர்ந்து யோகா செய்தேனா?',
      'அவ்யக்த முரளி படித்து, ஆழந்து சிந்தித்தேனா?',
      'அன்றாட முரளியில் 10 பாயிண்ட்ஸ் எழுதினேனா?',
      'பாபா நினைவில் உணவை மெதுவாக மென்று சாப்பிட்டேனா?',
      'குறைந்தது அரை மணி நேரம் உடற்பயிற்சி செய்தேனா?',
      'குறைந்தது 5 முறை டிரில் செய்தேனா?',
      'மனசா சேவை இயற்கைக்கு, உலகிற்கு செய்தேனா?',
      'இரவு பாபாவிடம் கணக்கு ஒப்படைப்பேனா?'
    ];
    for (let i = 0; i < defaultPoints.length; i++) {
      await pool.query(`INSERT INTO points (text, order_num) VALUES ($1,$2)`, [defaultPoints[i], i + 1]);
    }
    console.log('✅ Default points inserted');
  }
}

// run at startup
ensureSchemaAndDefaults().catch(err => {
  console.error('Schema init error', err);
});

// Utility: compute date range for period
function computeRangeForPeriod(period) {
  const today = new Date();
  let start = new Date(today);
  if (period === 'weekly') start.setDate(today.getDate() - 6);
  if (period === 'monthly') start = new Date(today.getFullYear(), today.getMonth(), 1);
  if (period === 'yearly') start = new Date(today.getFullYear(), 0, 1);
  const pad = n => (n < 10 ? '0' + n : n);
  const fmt = d => `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  return { start: fmt(start), end: fmt(today) };
}

// ---------- Debug / Admin maintenance routes ----------

// full reset (drops and recreates everything) — use carefully
app.get('/api/debug/reset-all', async (req, res) => {
  try {
    await pool.query(`DROP TABLE IF EXISTS daily_records; DROP TABLE IF EXISTS points; DROP TABLE IF EXISTS members; DROP TABLE IF EXISTS admins`);
    await ensureSchemaAndDefaults();
    res.json({ status: 'OK', message: 'Database reset complete — Admin + 10 points restored successfully.' });
  } catch (err) {
    console.error('reset-all error', err);
    res.status(500).json({ status: 'ERROR', message: 'Reset failed' });
  }
});

// clear points (delete all — then server restart or call reset-all to recreate)
app.delete('/api/debug/clear-points', async (req, res) => {
  try {
    await pool.query('DELETE FROM points');
    res.json({ message: 'All points deleted. You can call /api/debug/reset-all to recreate defaults.' });
  } catch (err) {
    console.error('clear-points error', err);
    res.status(500).json({ message: 'Error deleting points' });
  }
});

// debug: inspect daily_records columns
app.get('/api/debug/schema/daily_records', async (req, res) => {
  try {
    const q = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'daily_records'
      ORDER BY ordinal_position
    `);
    res.json({ columns: q.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// debug: list points
app.get('/api/debug/points', async (req, res) => {
  try {
    const q = await pool.query('SELECT id, text, order_num FROM points ORDER BY order_num, id');
    res.json({ count: q.rows.length, points: q.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- Auth & Admin routes ----------

// Admin login
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const q = await pool.query('SELECT * FROM admins WHERE username=$1', [username]);
    if (q.rows.length === 0) return res.status(401).json({ message: 'Invalid credentials' });
    const admin = q.rows[0];
    const ok = await bcrypt.compare(password, admin.password);
    if (!ok) return res.status(401).json({ message: 'Invalid credentials' });
    res.json({ admin: { id: admin.id, username: admin.username } });
  } catch (err) {
    console.error('Admin login error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Admin: list all members
app.get('/api/admin/all-members', async (req, res) => {
  try {
    const q = await pool.query('SELECT id,name,centre,mobile,status,created_at FROM members ORDER BY created_at DESC');
    res.json({ members: q.rows });
  } catch (err) {
    console.error('admin all-members error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Admin: delete member
app.delete('/api/admin/delete-member/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id, 10);
    await pool.query('DELETE FROM members WHERE id=$1', [id]);
    res.json({ message: 'Member deleted' });
  } catch (err) {
    console.error('delete member error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Points management (admin)
// Add point
app.post('/api/admin/points', async (req, res) => {
  try {
    const { text } = req.body;
    const maxRes = await pool.query('SELECT MAX(order_num) AS m FROM points');
    const next = (maxRes.rows[0].m || 0) + 1;
    const r = await pool.query('INSERT INTO points (text, order_num) VALUES ($1,$2) RETURNING *', [text, next]);
    res.status(201).json({ point: r.rows[0] });
  } catch (err) {
    console.error('add point error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Edit point
app.put('/api/admin/points/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id,10);
    const { text } = req.body;
    await pool.query('UPDATE points SET text=$1 WHERE id=$2', [text, id]);
    res.json({ message: 'Point updated' });
  } catch (err) {
    console.error('update point error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Delete point
app.delete('/api/admin/points/:id', async (req, res) => {
  try {
    const id = parseInt(req.params.id,10);
    await pool.query('DELETE FROM points WHERE id=$1', [id]);
    res.json({ message: 'Point deleted' });
  } catch (err) {
    console.error('delete point error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ---------- Member routes (register/login/list) ----------

// Register
app.post('/api/members/register', async (req, res) => {
  try {
    const { name, centre, mobile, password } = req.body;
    if (!name || !centre || !mobile || !password) {
      return res.status(400).json({ message: 'Missing fields' });
    }
    // check duplicate
    const exists = await pool.query('SELECT id FROM members WHERE mobile=$1', [mobile]);
    if (exists.rows.length > 0) return res.status(400).json({ message: 'Mobile number already registered' });
    const hashed = await bcrypt.hash(password, 10);
    const r = await pool.query('INSERT INTO members (name, centre, mobile, password, status) VALUES ($1,$2,$3,$4,$5) RETURNING id,name,centre,mobile,status,created_at',
      [name, centre, mobile, hashed, 'approved']);
    res.status(201).json({ member: r.rows[0] });
  } catch (err) {
    console.error('member register error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Member login
app.post('/api/members/login', async (req, res) => {
  try {
    const { mobile, password } = req.body;
    if (!mobile || !password) return res.status(400).json({ message: 'Missing fields' });
    const q = await pool.query('SELECT * FROM members WHERE mobile=$1', [mobile]);
    if (q.rows.length === 0) return res.status(401).json({ message: 'Invalid credentials' });
    const user = q.rows[0];
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ message: 'Invalid credentials' });
    res.json({ member: { id: user.id, name: user.name, centre: user.centre, mobile: user.mobile, status: user.status, created_at: user.created_at } });
  } catch (err) {
    console.error('member login error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// List members (for admin charts & public list)
app.get('/api/members', async (req, res) => {
  try {
    const q = await pool.query('SELECT id,name,centre,mobile,status,created_at FROM members ORDER BY created_at DESC');
    res.json({ members: q.rows });
  } catch (err) {
    console.error('members list error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ---------- Daily records endpoints ----------

// Get member daily records for a given date (returns object { pointId: effort })
app.get('/api/members/:memberId/daily/:date', async (req, res) => {
  try {
    const { memberId, date } = req.params;
    const pRes = await pool.query('SELECT id FROM points ORDER BY order_num, id');
    const recRes = await pool.query('SELECT point_id, effort FROM daily_records WHERE member_id=$1 AND date=$2', [memberId, date]);
    const map = {};
    pRes.rows.forEach(r => map[r.id] = 0);
    recRes.rows.forEach(r => map[r.point_id] = r.effort);
    res.json(map);
  } catch (err) {
    console.error('Get daily records error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// Upsert daily record
app.post('/api/members/:memberId/daily', async (req, res) => {
  try {
    const { memberId } = req.params;
    const { date, pointId, completed } = req.body;
    if (!date || !pointId) return res.status(400).json({ message: 'Missing fields' });

    const r = await pool.query(`
      INSERT INTO daily_records (member_id, point_id, date, effort)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (member_id, point_id, date)
      DO UPDATE SET effort = $4
      RETURNING *
    `, [memberId, pointId, date, completed || 0]);

    res.json({ record: r.rows[0] });
  } catch (err) {
    console.error('Upsert daily error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ---------- Progress aggregation ----------

app.get('/api/members/:memberId/progress/:period', async (req, res) => {
  try {
    const { memberId, period } = req.params;
    const p = (period || 'daily').toLowerCase();
    const { start, end } = computeRangeForPeriod(p);

    const q = await pool.query(`
      SELECT p.id AS point_id, p.text,
             COALESCE(AVG(dr.effort)::numeric, 0) AS avg_effort
      FROM points p
      LEFT JOIN daily_records dr
        ON dr.point_id = p.id
        AND dr.member_id = $1
        AND dr.date BETWEEN $2 AND $3
      GROUP BY p.id, p.text, p.order_num
      ORDER BY p.order_num, p.id
    `, [memberId, start, end]);

    const progress = q.rows.map(r => ({
      point_id: r.point_id,
      text: r.text,
      percentage: Number(r.avg_effort) // 0..100
    }));

    res.json({ progress });
  } catch (err) {
    console.error('Get progress error', err);
    res.status(500).json({ message: 'Server error' });
  }
});

// ---------- Health ----------
app.get('/', (req, res) => res.json({ status: 'OK' }));


// ---------- Crossword puzzle shared storage (in-memory) ----------

// ஒரு சிம்பிள் in-memory storage (server restart ஆச்சு என்றா reset ஆகிடும்)
let currentCrossword = null; // { date, grid, questions }

// Admin: இன்றைய crossword-ஐ save செய்கிறார்
app.post("/api/crossword/today", (req, res) => {
  const { date, grid, questions } = req.body || {};

  if (!date || !Array.isArray(grid) || !Array.isArray(questions)) {
    return res.status(400).json({ message: "Invalid crossword payload" });
  }

  currentCrossword = { date, grid, questions };
  console.log("✅ Crossword stored for date:", date);
  return res.json({ ok: true });
});

// யார் வேண்டுமானாலும்: இன்றைய crossword-ஐ பெறலாம்
app.get("/api/crossword/today", (req, res) => {
  if (!currentCrossword) {
    return res.status(404).json({ message: "No crossword set for today yet." });
  }
  return res.json(currentCrossword);
});



// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server listening on port ${PORT}`);
});
