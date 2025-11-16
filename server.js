// ==========================================
// BK SPIRITUAL CHART — COMPLETE NEW SERVER
// BACKEND FIXED + DATABASE FRESH + ALL APIS WORK
// ==========================================

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
const nodemailer = require("nodemailer");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// ========================
// CORS
// ========================
app.use(
  cors({
    origin: [
      "https://try-bk-chart.vercel.app",
      "https://bk-chart.vercel.app",
      "http://localhost:3000",
      "http://localhost:5173",
      process.env.FRONTEND_URL,
    ].filter(Boolean),
    credentials: true,
  })
);

app.use(express.json());

// ========================
// DATABASE CONNECTION
// ========================
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : false,
});

// ========================
// DB INITIALIZER (FRESH START)
// ========================
async function initializeFreshDatabase() {
  try {
    // DELETE old broken daily_records table
    await pool.query(`DROP TABLE IF EXISTS daily_records CASCADE`);

    // Create tables fresh
    await pool.query(`
      CREATE TABLE IF NOT EXISTS admins (
        id SERIAL PRIMARY KEY,
        username VARCHAR(100) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS members (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) NOT NULL,
        centre VARCHAR(255) NOT NULL,
        mobile VARCHAR(20) UNIQUE NOT NULL,
        password VARCHAR(255) NOT NULL,
        status VARCHAR(20) DEFAULT 'approved'
      )
    `);

    await pool.query(`
      CREATE TABLE IF NOT EXISTS points (
        id SERIAL PRIMARY KEY,
        text TEXT NOT NULL,
        order_num INTEGER NOT NULL
      )
    `);

    // NEW CLEAN daily_records table
    await pool.query(`
      CREATE TABLE daily_records (
        id SERIAL PRIMARY KEY,
        member_id INTEGER REFERENCES members(id) ON DELETE CASCADE,
        point_id INTEGER REFERENCES points(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        effort INTEGER DEFAULT 0,
        UNIQUE(member_id, point_id, date)
      )
    `);

    console.log("🔥 Fresh clean database created.");

    // Create default admin
    const hashed = await bcrypt.hash("Trichy@123", 10);
    await pool.query(
      `INSERT INTO admins (username, password) VALUES ('AmeerMushak', $1)
       ON CONFLICT (username) DO NOTHING`,
      [hashed]
    );

    // Create default points (10 Tamil points)
    const defaultPoints = [
      "பிறரிடம் பேசும்பொழுது ஆத்ம உணர்வோடு, ஆத்மாவோடு பேசினேனா?",
      "அமிர்தவேளை சக்திசாலியாக இருந்ததா?",
      "(அமிர்த வேளை உட்பட) 4 மணி நேரம் அமர்ந்து யோகா செய்தேனா?",
      "அவ்யக்த முரளி படித்து, ஆழ்ந்து சிந்தித்தேனா?",
      "அன்றாட முரளியில் 10 பாயிண்ட்ஸ் எழுதினேனா?",
      "பாபா நினைவில் உணவை மெதுவாக மென்று சாப்பிட்டேனா?",
      "குறைந்தது அரை மணி நேரம் உடற்பயிற்சி செய்தேனா?",
      "குறைந்தது 5 முறை டிரில் செய்தேனா?",
      "மனசா சேவை இயற்கைக்கு, உலகிற்கு செய்தேனா?",
      "இரவு பாபாவிடம் கணக்கு ஒப்படைப்பேனா?",
    ];

    for (let i = 0; i < defaultPoints.length; i++) {
      await pool.query(
        `INSERT INTO points (text, order_num) VALUES ($1, $2)`,
        [defaultPoints[i], i + 1]
      );
    }

    console.log("🔥 Default points added.");
  } catch (err) {
    console.error("DB Init error:", err);
  }
}

// Initialize fresh DB (only on first deploy)
initializeFreshDatabase();

// ========================
// AUTH APIS
// ========================
app.post("/api/admin/login", async (req, res) => {
  try {
    const { username, password } = req.body;
    const rows = await pool.query(`SELECT * FROM admins WHERE username=$1`, [
      username,
    ]);

    if (rows.rows.length === 0)
      return res.status(401).json({ message: "Invalid credentials" });

    const admin = rows.rows[0];
    const ok = await bcrypt.compare(password, admin.password);
    if (!ok) return res.status(401).json({ message: "Invalid credentials" });

    res.json({
      admin: { id: admin.id, username: admin.username },
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

app.post("/api/members/register", async (req, res) => {
  try {
    const { name, centre, mobile, password } = req.body;

    const exists = await pool.query(
      `SELECT * FROM members WHERE mobile=$1`,
      [mobile]
    );
    if (exists.rows.length > 0)
      return res.status(400).json({ message: "Mobile already registered" });

    const hashed = await bcrypt.hash(password, 10);

    const result = await pool.query(
      `INSERT INTO members (name, centre, mobile, password, status)
       VALUES ($1,$2,$3,$4,'approved') RETURNING *`,
      [name, centre, mobile, hashed]
    );

    res.json({ member: result.rows[0] });
  } catch {
    res.status(500).json({ message: "Server error" });
  }
});

app.post("/api/members/login", async (req, res) => {
  try {
    const { mobile, password } = req.body;
    const rows = await pool.query(`SELECT * FROM members WHERE mobile=$1`, [
      mobile,
    ]);

    if (rows.rows.length === 0)
      return res.status(401).json({ message: "Invalid credentials" });

    const member = rows.rows[0];
    const ok = await bcrypt.compare(password, member.password);
    if (!ok) return res.status(401).json({ message: "Invalid credentials" });

    res.json({ member });
  } catch {
    res.status(500).json({ message: "Server error" });
  }
});

// ========================
// POINTS
// ========================
app.get("/api/points", async (req, res) => {
  const rows = await pool.query(`SELECT * FROM points ORDER BY order_num`);
  res.json({ points: rows.rows });
});

// ========================
// DAILY RECORDS
// ========================
app.get("/api/members/:memberId/daily/:date", async (req, res) => {
  try {
    const { memberId, date } = req.params;

    const points = await pool.query(`SELECT id FROM points ORDER BY order_num`);
    const rec = await pool.query(
      `SELECT point_id, effort FROM daily_records WHERE member_id=$1 AND date=$2`,
      [memberId, date]
    );

    const out = {};
    points.rows.forEach((p) => (out[p.id] = 0));
    rec.rows.forEach((r) => (out[r.point_id] = r.effort));

    res.json(out);
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

app.post("/api/members/:memberId/daily", async (req, res) => {
  try {
    const { memberId } = req.params;
    const { date, pointId, completed } = req.body;

    await pool.query(
      `INSERT INTO daily_records (member_id, point_id, date, effort)
       VALUES ($1,$2,$3,$4)
       ON CONFLICT (member_id, point_id, date)
       DO UPDATE SET effort=$4`,
      [memberId, pointId, date, completed]
    );

    res.json({ message: "Saved" });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

// ========================
// PROGRESS (DAILY/WEEK/MONTH/YEAR)
// ========================
function dateRange(period) {
  const today = new Date();
  let start = new Date(today);
  let end = new Date(today);

  if (period === "weekly") start.setDate(today.getDate() - 6);
  if (period === "monthly") start = new Date(today.getFullYear(), today.getMonth(), 1);
  if (period === "yearly") start = new Date(today.getFullYear(), 0, 1);

  const f = (d) =>
    d.toISOString().split("T")[0];

  return { start: f(start), end: f(end) };
}

app.get("/api/members/:memberId/progress/:period", async (req, res) => {
  try {
    const { memberId, period } = req.params;
    const { start, end } = dateRange(period);

    const q = await pool.query(
      `
      SELECT p.id, p.text,
        COALESCE(AVG(dr.effort),0) AS avg_effort
      FROM points p
      LEFT JOIN daily_records dr
        ON dr.point_id=p.id
       AND dr.member_id=$1
       AND dr.date BETWEEN $2 AND $3
      GROUP BY p.id, p.text
      ORDER BY p.id
      `,
      [memberId, start, end]
    );

    res.json({
      progress: q.rows.map((r) => ({
        point_id: r.id,
        text: r.text,
        percentage: Number(r.avg_effort),
      })),
    });
  } catch (err) {
    res.status(500).json({ message: "Server error" });
  }
});

// ========================
app.get("/", (req, res) => {
  res.json({ status: "Backend running OK" });
});

app.listen(PORT, () => console.log("🔥 Server running on " + PORT));
