// server.js - Fully Fixed Backend for BK Spiritual Chart
const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();

// ⭐ Render sets its own dynamic port — REQUIRED
const PORT = process.env.PORT || 10000;

// ⭐ CORS FIX — allow your frontend
const allowedOrigins = [
    'https://try-bk-chart.vercel.app',
    'http://localhost:3000',
    'http://localhost:5173',
    process.env.FRONTEND_URL
].filter(Boolean);

app.use(cors({
    origin: allowedOrigins,
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

// Extra safety CORS headers
app.use((req, res, next) => {
    const origin = req.headers.origin;

    if (allowedOrigins.includes(origin)) {
        res.header("Access-Control-Allow-Origin", origin);
    }

    res.header("Access-Control-Allow-Credentials", "true");
    res.header("Access-Control-Allow-Methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.header("Access-Control-Allow-Headers", "Content-Type, Authorization");
    next();
});


app.options('*', cors());
app.use(express.json());

// ⭐ POSTGRES FIX — Safe connection
let pool;
try {
    pool = new Pool({
        connectionString: process.env.DATABASE_URL,
        ssl: process.env.NODE_ENV === 'production'
            ? { rejectUnauthorized: false }
            : false
    });
} catch (err) {
    console.error("❌ PostgreSQL Pool initialization failed:", err);
}

// ⭐ Simple function to check DB before queries
async function safeQuery(query, params = []) {
    try {
        if (!pool) throw new Error("Pool not initialized");
        return await pool.query(query, params);
    } catch (err) {
        console.error("❌ Database query failed:", err.message);
        return { rows: [] };
    }
}

// ⭐ Email Transport
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// ⭐ In-memory reset code store
const resetCodes = new Map();

// ⭐ Initialize database (non-blocking)
async function initDatabase() {
    try {
        console.log("Initializing database...");

        await safeQuery(`
            CREATE TABLE IF NOT EXISTS admins (
                id SERIAL PRIMARY KEY,
                username VARCHAR(100) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await safeQuery(`
            CREATE TABLE IF NOT EXISTS members (
                id SERIAL PRIMARY KEY,
                name VARCHAR(255) NOT NULL,
                centre VARCHAR(255) NOT NULL,
                mobile VARCHAR(20) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                status VARCHAR(20) DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await safeQuery(`
            CREATE TABLE IF NOT EXISTS points (
                id SERIAL PRIMARY KEY,
                text TEXT NOT NULL,
                order_num INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        await safeQuery(`
            CREATE TABLE IF NOT EXISTS daily_records (
                id SERIAL PRIMARY KEY,
                member_id INTEGER REFERENCES members(id) ON DELETE CASCADE,
                point_id INTEGER REFERENCES points(id) ON DELETE CASCADE,
                date DATE NOT NULL,
                completed BOOLEAN DEFAULT false,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(member_id, point_id, date)
            )
        `);

        // ⭐ Create default admin
        const adminCheck = await safeQuery(
            'SELECT * FROM admins WHERE username = $1',
            ['AmeerMushak']
        );

        if (adminCheck.rows.length === 0) {
            const hashedPassword = await bcrypt.hash('Trichy@123', 10);
            await safeQuery(
                'INSERT INTO admins (username, password) VALUES ($1, $2)',
                ['AmeerMushak', hashedPassword]
            );
            console.log("Default admin created");
        }

        console.log("Database Initialized Successfully ✔");
    } catch (err) {
        console.error("❌ DB Init Error:", err);
    }
}

// ⭐ API ROUTES — unchanged but safer

// Admin Login
app.post('/api/admin/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        const result = await safeQuery(
            'SELECT * FROM admins WHERE username = $1',
            [username]
        );

        if (!result.rows.length)
            return res.status(401).json({ message: 'Invalid credentials' });

        const admin = result.rows[0];
        const validPassword = await bcrypt.compare(password, admin.password);

        if (!validPassword)
            return res.status(401).json({ message: 'Invalid credentials' });

        res.json({ admin: { id: admin.id, username: admin.username } });
    } catch (err) {
        res.status(500).json({ message: 'Server error' });
    }
});

// Member Registration
app.post('/api/members/register', async (req, res) => {
    try {
        const { name, centre, mobile, password } = req.body;

        const existing = await safeQuery(
            'SELECT * FROM members WHERE mobile = $1',
            [mobile]
        );

        if (existing.rows.length)
            return res.status(400).json({ message: 'Mobile number already registered' });

        const hashedPassword = await bcrypt.hash(password, 10);

        const result = await safeQuery(
            'INSERT INTO members (name, centre, mobile, password, status) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [name, centre, mobile, hashedPassword, 'approved']
        );

        res.status(201).json({ member: result.rows[0] });
    } catch (err) {
        res.status(500).json({ message: 'Server error' });
    }
});

// Member Login
app.post('/api/members/login', async (req, res) => {
    try {
        const { mobile, password } = req.body;

        const result = await safeQuery(
            'SELECT * FROM members WHERE mobile = $1',
            [mobile]
        );

        if (!result.rows.length)
            return res.status(401).json({ message: 'Invalid credentials' });

        const member = result.rows[0];
        const validPassword = await bcrypt.compare(password, member.password);

        if (!validPassword)
            return res.status(401).json({ message: 'Invalid credentials' });

        res.json({
            member: {
                id: member.id,
                name: member.name,
                centre: member.centre,
                mobile: member.mobile,
                status: member.status
            }
        });
    } catch (err) {
        res.status(500).json({ message: 'Server error' });
    }
});

// Health check
app.get('/health', (req, res) => {
    res.json({ status: "OK", time: new Date().toISOString() });
});

// ⭐ Server Start — DB init runs AFTER server starts (prevent crashes)
app.listen(PORT, () => {
    console.log(`🚀 Server running on PORT ${PORT}`);
    initDatabase();
});
