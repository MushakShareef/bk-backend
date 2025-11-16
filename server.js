// BK Spiritual Chart — FULL CLEAN RESET BACKEND
// Option B — Complete DB Wipe + Recreate
//---------------------------------------------------------------

const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");
const bcrypt = require("bcryptjs");
require("dotenv").config();

const app = express();
const PORT = process.env.PORT || 3000;

// ---------------- CORS ----------------
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

// ---------------- PostgreSQL ----------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl:
    process.env.NODE_ENV === "production"
      ? { rejectUnauthorized: false }
      : false,
});

pool.on("connect", () => console.log("✅ DB Connected"));

// ---------------- RESET ALL TABLES (Option B) ----------------

async function resetDatabase() {
  console.log("🧹 Dropping ALL tables...");

  await pool.query(`
    DROP TABLE IF EXISTS daily_records;
    DROP TABLE IF EXISTS points;
    DROP TABLE IF EXISTS members;
    DROP TABLE IF EXISTS admins;
  `);

  console.log("🔧 Recreating schema...");

  await pool.query(`
    CREATE TABLE admins (
      id SERIAL PRIMARY KEY,
      username VARCHAR(100) UNIQUE NOT NULL,
      password VARCHAR(255) NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );
  `);

  await pool.query(`
    CREATE TABLE members (
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
    CREATE TABLE points (
      id SERIAL PRIMARY KEY,
      text TEXT NOT NULL,
      order_num INTEGER NOT NULL
    );
  `);

  await pool.query(`
    CREATE TABLE daily_records (
      id SERIAL PRIMARY KEY,
      member_id INTEGER REFERENCES members(id) ON DELETE CASCADE,
      point_id INTEGER REFERENCES points(id) ON DELETE CASCADE,
      date DATE NOT NULL,
      effort INTEGER DEFAULT 0,
      UNIQUE(member_id, point_id, date)
    );
  `);

  console.log("🔐 Creating default admin...");

  const hashedAdminPw = await bcrypt.hash("Trichy@123", 10);
  await pool.query(
    "INSERT INTO admins (username, password) VALUES ($1,$2)",
    ["AmeerMushak", hashedAdminPw]
  );

  console.log("📝 Inserting default 10 points...");

  const defaultPoints = [
    "பிறரிடம் பேசும்பொழுது ஆத்ம உணர்வோடு, ஆத்மாவோடு பேசினேனா?",
    "அமிர்தவேளை சக்திசாலியாக இருந்ததா?",
    "(அமிர்த வேளை உட்பட) 4 மணி நேரம் அமர்ந்து யோகா செய்தேனா?",
    "அவ்யக்த முரளி படித்து, ஆழ்ந்து சிந்தித்தேனா?",
    "அன்றாட முரளியில் 10 பாயிண்ட்ஸ் எழுதினேனா?",
    "பாபா நினைவில் உணவை மெதுவாக  மென்று சாப்பிட்டேனா?",
    "குறைந்தது அரை மணி நேரம் உடற்பயிற்சி செய்தேனா?",
    "குறைந்தது 5 முறை டிரில் செய்தேனா?",
    "மனசா சேவை இயற்கைக்கு, உலகிற்கு செய்தேனா?",
    "இரவு பாபாவிடம் கணக்கு ஒப்படைப்பேனா?",
  ];

  for (let i = 0; i < defaultPoints.length; i++) {
    await pool.query(
      "INSERT INTO points (text, order_num) VALUES ($1,$2)",
      [defaultPoints[i], i + 1]
    );
  }

  console.log("🎉 FULL CLEAN RESET DONE!");
}

// ---------------- PUBLIC DEBUG ROUTE ----------------
// (Run once => full database wipe + recreate)
app.get("/api/debug/reset-all", async (req, res) => {
  try {
    await resetDatabase();
    res.json({
      status: "OK",
      message:
        "Database reset complete — Admin + 10 points restored successfully.",
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({
      status: "ERROR",
      message: "Reset failed — see logs.",
    });
  }
});

// -------------------------------------------------------------
// ------------------------- API ROUTES -------------------------
// -------------------------------------------------------------

// Admin login
app.post("/api/admin/login", async (req, res) => {
  try {
    const { username, password } = req.body;

    const result = await pool.query(
      "SELECT * FROM admins WHERE username=$1",
      [username]
    );

    if (result.rows.length === 0)
      return res.status(401).json({ message: "Invalid credentials" });

    const admin = result.rows[0];
    const ok = await bcrypt.compare(password, admin.password);

    if (!ok) return res.status(401).json({ message: "Invalid credentials" });

    res.json({ admin: { id: admin.id, username: admin.username } });
  } catch (err) {
    console.error("Admin login error", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Get points
app.get("/api/points", async (req, res) => {
  try {
    const result = await pool.query(
      "SELECT * FROM points ORDER BY order_num"
    );
    res.json({ points: result.rows });
  } catch (err) {
    console.error("Points error", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Get daily records
app.get("/api/members/:memberId/daily/:date", async (req, res) => {
  try {
    const { memberId, date } = req.params;

    const pRes = await pool.query("SELECT id FROM points ORDER BY order_num");
    const points = pRes.rows.map((r) => r.id);

    const rRes = await pool.query(
      "SELECT point_id, effort FROM daily_records WHERE member_id=$1 AND date=$2",
      [memberId, date]
    );

    const records = {};
    points.forEach((id) => (records[id] = 0));
    rRes.rows.forEach((r) => (records[r.point_id] = r.effort));

    res.json(records);
  } catch (err) {
    console.error("Daily error", err);
    res.status(500).json({ message: "Server error" });
  }
});

// Save daily
app.post("/api/members/:memberId/daily", async (req, res) => {
  try {
    const { memberId } = req.params;
    const { date, pointId, completed } = req.body;

    const q = `
      INSERT INTO daily_records (member_id, point_id, date, effort)
      VALUES ($1,$2,$3,$4)
      ON CONFLICT (member_id, point_id, date)
      DO UPDATE SET effort=$4
      RETURNING *
    `;

    const r = await pool.query(q, [
      memberId,
      pointId,
      date,
      completed,
    ]);

    res.json({ record: r.rows[0] });
  } catch (err) {
    console.error("Save error", err);
    res.status(500).json({ message: "Server error" });
  }
});

// ---------------- Health Check ----------------
app.get("/", (req, res) => {
  res.json({ status: "OK", service: "BK Spiritual Backend" });
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Server running on ${PORT}`);
});
