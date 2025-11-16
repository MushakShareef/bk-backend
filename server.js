// server.js - Complete server for BK Spiritual Chart
// Replace environment variables as needed: DATABASE_URL, EMAIL_USER, EMAIL_PASS, FRONTEND_URL, PORT

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const bcrypt = require('bcryptjs');
const nodemailer = require('nodemailer');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware - CORS Configuration
app.use(cors({
    origin: [
        'https://try-bk-chart.vercel.app',
        'https://bk-chart.vercel.app',
        'http://localhost:3000',
        'http://localhost:5173',
        process.env.FRONTEND_URL
    ].filter(Boolean),
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));
app.use(express.json());
app.options('*', cors()); // preflight

// Database connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

pool.on('connect', () => console.log('✅ Connected to PostgreSQL database'));
pool.on('error', (err) => console.error('❌ Unexpected database error:', err));

// In-memory storage for reset codes (expires after 15 minutes)
const resetCodes = new Map();

// Nodemailer transporter (Gmail example)
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// ================== Helpers ==================

function generateResetCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

async function sendAdminEmail(memberName, memberCentre, memberMobile) {
    try {
        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: 'iraisevaiyil@gmail.com',
            subject: 'New Member Registered - BK Spiritual Chart',
            html: `
                <h2>New Member Registered</h2>
                <p><strong>Name:</strong> ${memberName}</p>
                <p><strong>BK Centre:</strong> ${memberCentre}</p>
                <p><strong>Mobile:</strong> ${memberMobile}</p>
                <p>Member has been automatically approved and can now login.</p>
            `
        });
    } catch (err) {
        console.error('Email send error', err);
    }
}

async function sendResetCodeEmail(email, code, userName, userType) {
    try {
        await transporter.sendMail({
            from: process.env.EMAIL_USER,
            to: email,
            subject: `Password Reset Code - BK Spiritual Chart`,
            html: `
                <h2>Password Reset Request</h2>
                <p><strong>${userType}:</strong> ${userName}</p>
                <p>Your password reset code is:</p>
                <h1 style="color: #ff6600; font-size: 36px; letter-spacing: 5px;">${code}</h1>
                <p>This code will expire in 15 minutes.</p>
                <p>If you didn't request this, please ignore this email.</p>
            `
        });
    } catch (err) {
        console.error('Reset code email error', err);
    }
}

// Initialize DB: create tables and default data if required
async function initDatabase() {
    try {
        // Admins table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS admins (
                id SERIAL PRIMARY KEY,
                username VARCHAR(100) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Members
        await pool.query(`
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

        // Points (the check items)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS points (
                id SERIAL PRIMARY KEY,
                text TEXT NOT NULL,
                order_num INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Daily records (effort percentage per member per point per date)
        await pool.query(`
            CREATE TABLE IF NOT EXISTS daily_records (
                id SERIAL PRIMARY KEY,
                member_id INTEGER REFERENCES members(id) ON DELETE CASCADE,
                point_id INTEGER REFERENCES points(id) ON DELETE CASCADE,
                date DATE NOT NULL,
                effort INTEGER DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(member_id, point_id, date)
            )
        `);

        // Create default admin if not exist
        const adminCheck = await pool.query('SELECT * FROM admins WHERE username = $1', ['AmeerMushak']);
        if (adminCheck.rows.length === 0) {
            const hashed = await bcrypt.hash('Trichy@123', 10);
            await pool.query('INSERT INTO admins (username, password) VALUES ($1, $2)', ['AmeerMushak', hashed]);
            console.log('✅ Default admin created');
        }

        // Create default points if none
        const pointsCount = await pool.query('SELECT COUNT(*) FROM points');
        if (pointsCount.rows[0].count === '0') {
            const defaultPoints = [
                'பிறரிடம் பேசும்பொழுது ஆத்ம உணர்வோடு, ஆத்மாவோடு பேசினேனா?',
                'அமிர்தவேளை சக்திசாலியாக இருந்ததா?',
                '(அமிர்த வேளை உட்பட) 4 மணி நேரம் அமர்ந்து யோகா செய்தேனா?',
                'அவ்யக்த முரளி படித்து, ஆழந்து சிந்தித்தேனா?',
                'அன்றாட முரளியில் 10 பாயிண்ட்ஸ் எழுதினேனா?',
                'பாபா நினைவில் உணவை மெதுவாக  மென்று சாப்பிட்டேனா?',
                'குறைந்தது அரை மணி நேரம் உடற்பயிற்சி செய்தேனா?',
                'குறைந்தது 5 முறை டிரில் செய்தேனா?',
                'மனசா சேவை இயற்கைக்கு, உலகிற்கு செய்தேனா?',
                'இரவு பாபாவிடம் கணக்கு ஒப்படைப்பேனா?'
            ];
            for (let i = 0; i < defaultPoints.length; i++) {
                await pool.query('INSERT INTO points (text, order_num) VALUES ($1, $2)', [defaultPoints[i], i + 1]);
            }
            console.log('✅ Default points created');
        }

        console.log('✅ Database initialized');
    } catch (err) {
        console.error('❌ DB init error:', err);
    }
}

// ================== API ROUTES ==================

// Admin login
app.post('/api/admin/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        const result = await pool.query('SELECT * FROM admins WHERE username = $1', [username]);
        if (result.rows.length === 0) return res.status(401).json({ message: 'Invalid credentials' });

        const admin = result.rows[0];
        const ok = await bcrypt.compare(password, admin.password);
        if (!ok) return res.status(401).json({ message: 'Invalid credentials' });

        res.json({ admin: { id: admin.id, username: admin.username } });
    } catch (err) {
        console.error('Admin login error', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// Member register
app.post('/api/members/register', async (req, res) => {
    try {
        const { name, centre, mobile, password } = req.body;
        const exists = await pool.query('SELECT * FROM members WHERE mobile = $1', [mobile]);
        if (exists.rows.length > 0) return res.status(400).json({ message: 'Mobile number already registered' });

        const hashed = await bcrypt.hash(password, 10);
        const result = await pool.query(
            'INSERT INTO members (name, centre, mobile, password, status) VALUES ($1,$2,$3,$4,$5) RETURNING *',
            [name, centre, mobile, hashed, 'approved']
        );

        // notify admin
        sendAdminEmail(name, centre, mobile).catch(() => {});

        res.status(201).json({ member: result.rows[0] });
    } catch (err) {
        console.error('Register error', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// Member login
app.post('/api/members/login', async (req, res) => {
    try {
        const { mobile, password } = req.body;
        const result = await pool.query('SELECT * FROM members WHERE mobile = $1', [mobile]);
        if (result.rows.length === 0) return res.status(401).json({ message: 'Invalid credentials' });

        const member = result.rows[0];
        const ok = await bcrypt.compare(password, member.password);
        if (!ok) return res.status(401).json({ message: 'Invalid credentials' });

        res.json({
            member: {
                id: member.id,
                name: member.name,
                centre: member.centre,
                mobile: member.mobile,
                status: member.status,
                created_at: member.created_at
            }
        });
    } catch (err) {
        console.error('Member login error', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// Admin forgot & reset password
app.post('/api/admin/forgot-password', async (req, res) => {
    try {
        const { username } = req.body;
        const result = await pool.query('SELECT * FROM admins WHERE username = $1', [username]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'Username not found' });

        const code = generateResetCode();
        const expiresAt = Date.now() + 15 * 60 * 1000;
        resetCodes.set(`admin_${username}`, { code, expiresAt });

        await sendResetCodeEmail(process.env.EMAIL_USER, code, username, 'Admin');
        res.json({ message: 'Reset code sent to email' });
    } catch (err) {
        console.error('Admin forgot password error', err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.post('/api/admin/reset-password', async (req, res) => {
    try {
        const { username, code, newPassword } = req.body;
        const stored = resetCodes.get(`admin_${username}`);
        if (!stored) return res.status(400).json({ message: 'No reset request found' });
        if (Date.now() > stored.expiresAt) {
            resetCodes.delete(`admin_${username}`);
            return res.status(400).json({ message: 'Reset code expired' });
        }
        if (stored.code !== code) return res.status(400).json({ message: 'Invalid reset code' });

        const hashed = await bcrypt.hash(newPassword, 10);
        await pool.query('UPDATE admins SET password = $1 WHERE username = $2', [hashed, username]);
        resetCodes.delete(`admin_${username}`);
        res.json({ message: 'Password reset successful' });
    } catch (err) {
        console.error('Admin reset error', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// Member forgot & reset password
app.post('/api/members/forgot-password', async (req, res) => {
    try {
        const { mobile } = req.body;
        const result = await pool.query('SELECT * FROM members WHERE mobile = $1', [mobile]);
        if (result.rows.length === 0) return res.status(404).json({ message: 'Mobile number not found' });

        const member = result.rows[0];
        const code = generateResetCode();
        const expiresAt = Date.now() + 15 * 60 * 1000;
        resetCodes.set(`member_${mobile}`, { code, expiresAt });

        await sendResetCodeEmail(process.env.EMAIL_USER, code, `${member.name} (${mobile})`, 'Member');
        res.json({ message: 'Reset code sent to admin email' });
    } catch (err) {
        console.error('Member forgot password error', err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.post('/api/members/reset-password', async (req, res) => {
    try {
        const { mobile, code, newPassword } = req.body;
        const stored = resetCodes.get(`member_${mobile}`);
        if (!stored) return res.status(400).json({ message: 'No reset request found' });
        if (Date.now() > stored.expiresAt) {
            resetCodes.delete(`member_${mobile}`);
            return res.status(400).json({ message: 'Reset code expired' });
        }
        if (stored.code !== code) return res.status(400).json({ message: 'Invalid reset code' });

        const hashed = await bcrypt.hash(newPassword, 10);
        await pool.query('UPDATE members SET password = $1 WHERE mobile = $2', [hashed, mobile]);
        resetCodes.delete(`member_${mobile}`);
        res.json({ message: 'Password reset successful' });
    } catch (err) {
        console.error('Member reset error', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// Get all members (admin view)
app.get('/api/admin/all-members', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM members ORDER BY created_at DESC');
        res.json({ members: result.rows });
    } catch (err) {
        console.error('Get all members error', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// Also expose /api/members for admin/other pages that call it
app.get('/api/members', async (req, res) => {
    try {
        const result = await pool.query('SELECT id, name, centre, mobile, status, created_at FROM members ORDER BY created_at DESC');
        res.json({ members: result.rows });
    } catch (err) {
        console.error('Get members error', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// Delete member
app.delete('/api/admin/delete-member/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM members WHERE id = $1', [id]);
        res.json({ message: 'Member deleted' });
    } catch (err) {
        console.error('Delete member error', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// Points: list/add/update/delete
app.get('/api/points', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM points ORDER BY order_num');
        res.json({ points: result.rows });
    } catch (err) {
        console.error('Get points error', err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.post('/api/admin/points', async (req, res) => {
    try {
        const { text } = req.body;
        const maxOrderRes = await pool.query('SELECT MAX(order_num) as max FROM points');
        const newOrder = (maxOrderRes.rows[0].max || 0) + 1;
        const result = await pool.query('INSERT INTO points (text, order_num) VALUES ($1, $2) RETURNING *', [text, newOrder]);
        res.status(201).json({ point: result.rows[0] });
    } catch (err) {
        console.error('Add point error', err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.put('/api/admin/points/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { text } = req.body;
        await pool.query('UPDATE points SET text = $1 WHERE id = $2', [text, id]);
        res.json({ message: 'Point updated' });
    } catch (err) {
        console.error('Update point error', err);
        res.status(500).json({ message: 'Server error' });
    }
});

app.delete('/api/admin/points/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM points WHERE id = $1', [id]);
        res.json({ message: 'Point deleted' });
    } catch (err) {
        console.error('Delete point error', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// Get member's daily records for a date (returns object { point_id: effort })
app.get('/api/members/:memberId/daily/:date', async (req, res) => {
    try {
        const { memberId, date } = req.params;
        // fetch all points and join with daily_records so we can return even missing entries as 0 if needed on frontend
        const pointsRes = await pool.query('SELECT id FROM points ORDER BY order_num');
        const points = pointsRes.rows.map(r => r.id);

        const recordsRes = await pool.query(
            'SELECT point_id, effort FROM daily_records WHERE member_id = $1 AND date = $2',
            [memberId, date]
        );

        const records = {};
        // Initialize with 0 for all known points to ensure UI sees them (optional)
        points.forEach(pid => records[pid] = 0);
        recordsRes.rows.forEach(r => {
            records[r.point_id] = r.effort;
        });

        res.json(records);
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

        const result = await pool.query(
            `INSERT INTO daily_records (member_id, point_id, date, effort)
             VALUES ($1, $2, $3, $4)
             ON CONFLICT (member_id, point_id, date)
             DO UPDATE SET effort = $4
             RETURNING *`,
            [memberId, pointId, date, completed]
        );

        res.json({ message: 'Record updated', record: result.rows[0] });
    } catch (err) {
        console.error('Update daily record error', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// Helper to compute date range for period
function computeRangeForPeriod(period) {
    const today = new Date();
    let startDate = new Date(today);
    let endDate = new Date(today);

    switch (period) {
        case 'daily':
            // only today
            break;
        case 'weekly':
            // last 6 days + today = 7 day window
            startDate.setDate(today.getDate() - 6);
            break;
        case 'monthly':
            startDate = new Date(today.getFullYear(), today.getMonth(), 1);
            break;
        case 'yearly':
            startDate = new Date(today.getFullYear(), 0, 1);
            break;
        default:
            // default to daily
            break;
    }
    // Format dates as YYYY-MM-DD for SQL
    const pad = (n) => (n < 10 ? '0' + n : n);
    const fmt = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

    return { start: fmt(startDate), end: fmt(endDate) };
}

// Get member's progress aggregated by point for period
app.get('/api/members/:memberId/progress/:period', async (req, res) => {
    try {
        const { memberId, period } = req.params;
        const p = (period || 'daily').toLowerCase();

        const { start, end } = computeRangeForPeriod(p);

        // Select all points, left join average effort over date range for the member
        const query = `
            SELECT p.id as point_id, p.text,
                   COALESCE(AVG(dr.completed)::numeric, 0) AS avg_effort
            FROM points p
            LEFT JOIN daily_records dr
              ON dr.point_id = p.id
              AND dr.member_id = $1
              AND dr.date BETWEEN $2 AND $3
            GROUP BY p.id, p.text
            ORDER BY p.order_num
        `;
        const result = await pool.query(query, [memberId, start, end]);

        // Format response expected by frontend: { progress: [{ text, percentage }, ...] }
        const progress = result.rows.map(row => ({
            point_id: row.point_id,
            text: row.text,
            percentage: Number(row.avg_effort) // already numeric average (0..100)
        }));

        res.json({ progress });
    } catch (err) {
        console.error('Get progress error', err);
        res.status(500).json({ message: 'Server error' });
    }
});

// Fallback health-check
app.get('/', (req, res) => {
    res.json({ message: 'BK Spiritual Chart API is running' });
});

// Start server and initialize DB
initDatabase().then(() => {
    app.listen(PORT, () => {
        console.log(`🚀 Server listening on port ${PORT}`);
    });
}).catch(err => {
    console.error('Failed to init DB', err);
    process.exit(1);
});
