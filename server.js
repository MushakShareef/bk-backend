// server.js — Full server with automatic DB repair + debug routes
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

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

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

pool.on('error', (err) => console.error('Unexpected DB error', err));

// ---------- Helpers ----------
async function tableExists(name) {
  const r = await pool.query(
    `SELECT to_regclass($1) as exists`, [name]
  );
  return !!r.rows[0].exists;
}

async function columnInfo(table, column) {
  const r = await pool.query(
    `SELECT column_name, data_type 
     FROM information_schema.columns 
     WHERE table_name=$1 AND column_name=$2`,
    [table, column]
  );
  return r.rows[0] || null;
}

// ---------- Auto-repair / fresh start ----------
async function ensureFreshSchema() {
  try {
    // Ensure admins, members, points exist
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
        name VARCHAR(255) NOT NULL,
        centre VARCHAR(255) NOT NULL,
        mobile VARCHAR(20) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        status VARCHAR(20) DEFAULT 'approved',
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS points (
        id SERIAL PRIMARY KEY,
        text TEXT NOT NULL,
        order_num INTEGER,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `);

    // If daily_records exists but column types are wrong, drop and recreate (fresh start policy)
    const hasDaily = await tableExists('daily_records');
    if (hasDaily) {
      // We'll DROP and recreate to be safe (you asked for fresh)
      await pool.query(`DROP TABLE IF EXISTS daily_records CASCADE`);
      console.log('Dropped existing daily_records (fresh start)');
    }

    // Recreate correct daily_records table
    await pool.query(`
      CREATE TABLE daily_records (
        id SERIAL PRIMARY KEY,
        member_id INTEGER REFERENCES members(id) ON DELETE CASCADE,
        point_id INTEGER REFERENCES points(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        effort INTEGER DEFAULT 0,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(member_id, point_id, date)
      );
    `);

    // Create default admin if missing
    const adminCheck = await pool.query('SELECT * FROM admins WHERE username=$1', ['AmeerMushak']);
    if (adminCheck.rows.length === 0) {
      const hash = await bcrypt.hash('Trichy@123', 10);
      await pool.query('INSERT INTO admins (username, password) VALUES ($1,$2)', ['AmeerMushak', hash]);
      console.log('Default admin created.');
    }

    // Insert default points only if points table empty
    const ptsCount = await pool.query('SELECT COUNT(*) FROM points');
    if (Number(ptsCount.rows[0].count) === 0) {
      const defaultPoints = [
        'பிறரிடம் பேசும்பொழுது ஆத்ம உணர்வோடு, ஆத்மாவோடு பேசினேனா?',
        'அமிர்தவேளை சக்திசாலியாக இருந்ததா?',
        '(அமிர்த வேளை உட்பட) 4 மணி நேரம் அமர்ந்து யோகா செய்தேனா?',
        'அவ்யக்த முரளி படித்து, ஆழ்ந்து சிந்தித்தேனா?',
        'அன்றாட முரளியில் 10 பாயிண்ட்ஸ் எழுதினேனா?',
        'பாபா நினைவில் உணவை மெதுவாக  மென்று சாப்பிட்டேனா?',
        'குறைந்தது அரை மணி நேரம் உடற்பயிற்சி செய்தேனா?',
        'குறைந்தது 5 முறை டிரில் செய்தேனா?',
        'மனசா சேவை இயற்கைக்கு, உலகிற்கு செய்தேனா?',
        'இரவு பாபாவிடம் கணக்கு ஒப்படைப்பேனா?'
      ];
      for (let i = 0; i < defaultPoints.length; i++) {
        await pool.query('INSERT INTO points (text, order_num) VALUES ($1,$2)', [defaultPoints[i], i + 1]);
      }
      console.log('Default points inserted.');
    }

    console.log('Schema ensured (fresh daily_records).');
  } catch (err) {
    console.error('Error ensuring schema:', err);
    throw err;
  }
}

// Run ensureFreshSchema at startup (idempotent)
ensureFreshSchema().catch(err => console.error('Startup schema error:', err));

// ---------- Debug endpoints ----------
app.get('/debug/points', async (req, res) => {
  try {
    const r = await pool.query('SELECT id, text, order_num, created_at FROM points ORDER BY order_num, id');
    res.json({ count: r.rows.length, points: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/debug/schema/daily_records', async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT column_name, data_type
      FROM information_schema.columns
      WHERE table_name = 'daily_records'
      ORDER BY ordinal_position
    `);
    res.json({ columns: r.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// dedupe points endpoint (safe) — merge duplicates by text keeping smallest id
app.post('/debug/cleanup-points', async (req, res) => {
  try {
    // Find duplicate texts
    const dupQ = await pool.query(`
      SELECT text, array_agg(id ORDER BY id) as ids, COUNT(*) as cnt
      FROM points
      GROUP BY text
      HAVING COUNT(*) > 1
    `);

    const actions = [];
    for (const row of dupQ.rows) {
      const ids = row.ids;
      const keep = ids[0];
      const remove = ids.slice(1);
      // update any daily_records to point to keep id
      await pool.query(`
        UPDATE daily_records SET point_id = $1 WHERE point_id = ANY($2::int[])
      `, [keep, remove]);
      // delete duplicates
      await pool.query(`DELETE FROM points WHERE id = ANY($1::int[])`, [remove]);
      actions.push({ text: row.text, kept: keep, removed: remove });
    }

    res.json({ cleaned: actions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// safety migration route — idempotent: create effort if missing or change boolean->integer
app.get('/fix-effort-column', async (req, res) => {
  try {
    // Check if effort column exists
    const col = await columnInfo('daily_records', 'effort');
    if (!col) {
      // attempt to create effort col (if a completed boolean exists, convert)
      const completedCol = await columnInfo('daily_records', 'completed');
      if (completedCol) {
        // add effort int and copy values true->100 false->0
        await pool.query(`ALTER TABLE daily_records ADD COLUMN effort INTEGER DEFAULT 0`);
        await pool.query(`
          UPDATE daily_records
          SET effort = CASE WHEN completed = true THEN 100 WHEN completed = false THEN 0 ELSE 0 END
        `);
        // drop completed
        await pool.query(`ALTER TABLE daily_records DROP COLUMN completed`);
        await pool.query(`ALTER TABLE daily_records ALTER COLUMN effort SET DEFAULT 0`);
        res.json({ message: 'created effort column and migrated from completed' });
        return;
      } else {
        // no completed column either — create effort column fresh
        await pool.query(`ALTER TABLE daily_records ADD COLUMN effort INTEGER DEFAULT 0`);
        res.json({ message: 'created effort column (fresh)' });
        return;
      }
    } else {
      // exists — check type
      if (col.data_type === 'boolean') {
        // convert boolean -> integer
        await pool.query(`ALTER TABLE daily_records ALTER COLUMN effort DROP DEFAULT`);
        await pool.query(`
          ALTER TABLE daily_records
          ALTER COLUMN effort TYPE INTEGER
          USING CASE WHEN effort = true THEN 100 WHEN effort = false THEN 0 ELSE 0 END
        `);
        await pool.query(`ALTER TABLE daily_records ALTER COLUMN effort SET DEFAULT 0`);
        res.json({ message: 'converted effort boolean -> integer' });
        return;
      } else {
        res.json({ message: 'effort column exists and is ok', data_type: col.data_type });
        return;
      }
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- App API endpoints ----------

// Admin login
app.post('/api/admin/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    const r = await pool.query('SELECT * FROM admins WHERE username=$1', [username]);
    if (r.rows.length === 0) return res.status(401).json({ message: 'Invalid' });
    const admin = r.rows[0];
    const ok = await bcrypt.compare(password, admin.password);
    if (!ok) return res.status(401).json({ message: 'Invalid' });
    res.json({ admin: { id: admin.id, username: admin.username } });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// Members list (admin view)
app.get('/api/admin/all-members', async (req, res) => {
  try {
    const r = await pool.query('SELECT id,name,centre,mobile,status,created_at FROM members ORDER BY created_at DESC');
    res.json({ members: r.rows });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// members endpoint for public listing
app.get('/api/members', async (req, res) => {
  try {
    const r = await pool.query('SELECT id,name,centre,mobile,status,created_at FROM members ORDER BY created_at DESC');
    res.json({ members: r.rows });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// member register/login
app.post('/api/members/register', async (req, res) => {
  try {
    const { name, centre, mobile, password } = req.body;
    const exists = await pool.query('SELECT * FROM members WHERE mobile=$1', [mobile]);
    if (exists.rows.length > 0) return res.status(400).json({ message: 'Mobile exists' });
    const hashed = await bcrypt.hash(password, 10);
    const r = await pool.query(`INSERT INTO members (name,centre,mobile,password,status) VALUES ($1,$2,$3,$4,'approved') RETURNING *`, [name,centre,mobile,hashed]);
    res.json({ member: r.rows[0] });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

app.post('/api/members/login', async (req, res) => {
  try {
    const { mobile, password } = req.body;
    const r = await pool.query('SELECT * FROM members WHERE mobile=$1', [mobile]);
    if (r.rows.length === 0) return res.status(401).json({ message: 'Invalid' });
    const user = r.rows[0];
    const ok = await bcrypt.compare(password, user.password);
    if (!ok) return res.status(401).json({ message: 'Invalid' });
    // send minimal member object
    res.json({ member: { id: user.id, name: user.name, centre: user.centre, mobile: user.mobile, status: user.status, created_at: user.created_at } });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// Points
app.get('/api/points', async (req, res) => {
  try {
    const r = await pool.query('SELECT id,text,order_num FROM points ORDER BY order_num, id');
    res.json({ points: r.rows });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// create point
app.post('/api/admin/points', async (req, res) => {
  try {
    const { text } = req.body;
    const max = await pool.query('SELECT MAX(order_num) as m FROM points');
    const next = (max.rows[0].m || 0) + 1;
    const r = await pool.query('INSERT INTO points (text,order_num) VALUES ($1,$2) RETURNING *', [text, next]);
    res.json({ point: r.rows[0] });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// delete point
app.delete('/api/admin/points/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM points WHERE id=$1', [id]);
    res.json({ message: 'deleted' });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// Get daily records (returns object of pointId => effort)
app.get('/api/members/:memberId/daily/:date', async (req, res) => {
  try {
    const { memberId, date } = req.params;
    const points = await pool.query('SELECT id FROM points ORDER BY order_num, id');
    const recs = await pool.query('SELECT point_id, effort FROM daily_records WHERE member_id=$1 AND date=$2', [memberId, date]);
    const out = {};
    points.rows.forEach(p => out[p.id] = 0);
    recs.rows.forEach(r => out[r.point_id] = r.effort);
    res.json(out);
  } catch (err) { console.error('Get daily records error', err); res.status(500).json({ message: 'Server error' }); }
});

// Upsert daily record
app.post('/api/members/:memberId/daily', async (req, res) => {
  try {
    const { memberId } = req.params;
    const { date, pointId, completed } = req.body;
    await pool.query(`
      INSERT INTO daily_records (member_id, point_id, date, effort)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (member_id, point_id, date)
      DO UPDATE SET effort = $4
    `, [memberId, pointId, date, completed]);
    res.json({ message: 'ok' });
  } catch (err) { console.error('Upsert daily error', err); res.status(500).json({ message: 'Server error' }); }
});

// progress aggregation
function computeRange(period) {
  const t = new Date();
  let start = new Date(t);
  if (period === 'weekly') start.setDate(t.getDate() - 6);
  if (period === 'monthly') start = new Date(t.getFullYear(), t.getMonth(), 1);
  if (period === 'yearly') start = new Date(t.getFullYear(), 0, 1);
  const fmt = d => d.toISOString().split('T')[0];
  return { start: fmt(start), end: fmt(t) };
}

app.get('/api/members/:memberId/progress/:period', async (req, res) => {
  try {
    const { memberId, period } = req.params;
    const { start, end } = computeRange(period || 'daily');
    const q = await pool.query(`
      SELECT p.id as point_id, p.text,
        COALESCE(AVG(dr.effort)::numeric,0) AS avg_effort
      FROM points p
      LEFT JOIN daily_records dr
        ON dr.point_id = p.id AND dr.member_id = $1 AND dr.date BETWEEN $2 AND $3
      GROUP BY p.id, p.text
      ORDER BY p.order_num, p.id
    `, [memberId, start, end]);
    res.json({ progress: q.rows.map(r => ({ point_id: r.point_id, text: r.text, percentage: Number(r.avg_effort) })) });
  } catch (err) { console.error('Get progress error', err); res.status(500).json({ message: 'Server error' }); }
});

// admin delete member
app.delete('/api/admin/delete-member/:id', async (req, res) => {
  try {
    const { id } = req.params;
    await pool.query('DELETE FROM members WHERE id=$1', [id]);
    res.json({ message: 'deleted' });
  } catch (err) { res.status(500).json({ message: 'Server error' }); }
});

// health
app.get('/', (req, res) => res.json({ status: 'Backend running OK' }));

app.listen(PORT, () => console.log(`Server running on ${PORT}`));
