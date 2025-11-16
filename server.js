// server.js - ULTIMATE FIXED VERSION - All data persistence issues resolved
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

// Handle preflight requests
app.options('*', cors());

// Database Connection
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === 'production' ? { rejectUnauthorized: false } : false
});

// Test database connection
pool.on('connect', () => {
    console.log('✅ Connected to PostgreSQL database');
});

pool.on('error', (err) => {
    console.error('❌ Unexpected database error:', err);
});

// In-memory storage for reset codes (expires after 15 minutes)
const resetCodes = new Map();

// Email Configuration
const transporter = nodemailer.createTransport({
    service: 'gmail',
    auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS
    }
});

// Initialize Database Tables
async function initDatabase() {
    try {
        // Admin Table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS admins (
                id SERIAL PRIMARY KEY,
                username VARCHAR(100) UNIQUE NOT NULL,
                password VARCHAR(255) NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Members Table
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

        // Points Table
        await pool.query(`
            CREATE TABLE IF NOT EXISTS points (
                id SERIAL PRIMARY KEY,
                text TEXT NOT NULL,
                order_num INTEGER,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            )
        `);

        // Daily Records Table
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

        // Create default admin if not exists
        const adminCheck = await pool.query('SELECT * FROM admins WHERE username = $1', ['AmeerMushak']);
        if (adminCheck.rows.length === 0) {
            const hashedPassword = await bcrypt.hash('Trichy@123', 10);
            await pool.query(
                'INSERT INTO admins (username, password) VALUES ($1, $2)',
                ['AmeerMushak', hashedPassword]
            );
            console.log('✅ Default admin created');
        }

        // Create default points if not exists
        const pointsCheck = await pool.query('SELECT COUNT(*) FROM points');
        if (pointsCheck.rows[0].count === '0') {
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
                await pool.query(
                    'INSERT INTO points (text, order_num) VALUES ($1, $2)',
                    [defaultPoints[i], i + 1]
                );
            }
            console.log('✅ Default points created');
        }

        console.log('✅ Database initialized successfully');
    } catch (error) {
        console.error('❌ Database initialization error:', error);
    }
}

// Send Email Notification
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
        console.log('✅ Email sent successfully');
    } catch (error) {
        console.error('❌ Email error:', error);
    }
}

// Generate 6-digit reset code
function generateResetCode() {
    return Math.floor(100000 + Math.random() * 900000).toString();
}

// Send Reset Code Email
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
        console.log('✅ Reset code email sent');
    } catch (error) {
        console.error('❌ Email error:', error);
    }
}

// ============ API ROUTES ============

// Admin Login
app.post('/api/admin/login', async (req, res) => {
    try {
        const { username, password } = req.body;
        
        const result = await pool.query('SELECT * FROM admins WHERE username = $1', [username]);
        if (result.rows.length === 0) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        const admin = result.rows[0];
        const validPassword = await bcrypt.compare(password, admin.password);
        
        if (!validPassword) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        res.json({ admin: { id: admin.id, username: admin.username } });
    } catch (error) {
        console.error('❌ Admin login error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Member Registration
app.post('/api/members/register', async (req, res) => {
    try {
        const { name, centre, mobile, password } = req.body;

        // Check if mobile already exists
        const existingMember = await pool.query('SELECT * FROM members WHERE mobile = $1', [mobile]);
        if (existingMember.rows.length > 0) {
            return res.status(400).json({ message: 'Mobile number already registered' });
        }

        const hashedPassword = await bcrypt.hash(password, 10);
        
        const result = await pool.query(
            'INSERT INTO members (name, centre, mobile, password, status) VALUES ($1, $2, $3, $4, $5) RETURNING *',
            [name, centre, mobile, hashedPassword, 'approved']
        );

        // Send email to admin
        await sendAdminEmail(name, centre, mobile);

        res.status(201).json({ member: result.rows[0] });
    } catch (error) {
        console.error('❌ Registration error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Admin Forgot Password
app.post('/api/admin/forgot-password', async (req, res) => {
    try {
        const { username } = req.body;
        
        const result = await pool.query('SELECT * FROM admins WHERE username = $1', [username]);
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Username not found' });
        }

        const resetCode = generateResetCode();
        const expiresAt = Date.now() + 15 * 60 * 1000;
        
        resetCodes.set(`admin_${username}`, { code: resetCode, expiresAt });
        
        await sendResetCodeEmail('iraisevaiyil@gmail.com', resetCode, username, 'Admin');

        res.json({ message: 'Reset code sent to email' });
    } catch (error) {
        console.error('❌ Admin forgot password error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Admin Reset Password
app.post('/api/admin/reset-password', async (req, res) => {
    try {
        const { username, code, newPassword } = req.body;
        
        const storedData = resetCodes.get(`admin_${username}`);
        
        if (!storedData) {
            return res.status(400).json({ message: 'No reset request found' });
        }
        
        if (Date.now() > storedData.expiresAt) {
            resetCodes.delete(`admin_${username}`);
            return res.status(400).json({ message: 'Reset code expired' });
        }
        
        if (storedData.code !== code) {
            return res.status(400).json({ message: 'Invalid reset code' });
        }
        
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await pool.query('UPDATE admins SET password = $1 WHERE username = $2', [hashedPassword, username]);
        
        resetCodes.delete(`admin_${username}`);
        
        res.json({ message: 'Password reset successful' });
    } catch (error) {
        console.error('❌ Admin reset password error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Member Forgot Password
app.post('/api/members/forgot-password', async (req, res) => {
    try {
        const { mobile } = req.body;
        
        const result = await pool.query('SELECT * FROM members WHERE mobile = $1', [mobile]);
        if (result.rows.length === 0) {
            return res.status(404).json({ message: 'Mobile number not found' });
        }

        const member = result.rows[0];
        const resetCode = generateResetCode();
        const expiresAt = Date.now() + 15 * 60 * 1000;
        
        resetCodes.set(`member_${mobile}`, { code: resetCode, expiresAt });
        
        await sendResetCodeEmail('iraisevaiyil@gmail.com', resetCode, `${member.name} (${mobile})`, 'Member');

        res.json({ message: 'Reset code sent to admin email' });
    } catch (error) {
        console.error('❌ Member forgot password error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Member Reset Password
app.post('/api/members/reset-password', async (req, res) => {
    try {
        const { mobile, code, newPassword } = req.body;
        
        const storedData = resetCodes.get(`member_${mobile}`);
        
        if (!storedData) {
            return res.status(400).json({ message: 'No reset request found' });
        }
        
        if (Date.now() > storedData.expiresAt) {
            resetCodes.delete(`member_${mobile}`);
            return res.status(400).json({ message: 'Reset code expired' });
        }
        
        if (storedData.code !== code) {
            return res.status(400).json({ message: 'Invalid reset code' });
        }
        
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await pool.query('UPDATE members SET password = $1 WHERE mobile = $2', [hashedPassword, mobile]);
        
        resetCodes.delete(`member_${mobile}`);
        
        res.json({ message: 'Password reset successful' });
    } catch (error) {
        console.error('❌ Member reset password error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Member Login
app.post('/api/members/login', async (req, res) => {
    try {
        const { mobile, password } = req.body;
        
        const result = await pool.query('SELECT * FROM members WHERE mobile = $1', [mobile]);
        if (result.rows.length === 0) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        const member = result.rows[0];
        const validPassword = await bcrypt.compare(password, member.password);
        
        if (!validPassword) {
            return res.status(401).json({ message: 'Invalid credentials' });
        }

        res.json({ member: { id: member.id, name: member.name, centre: member.centre, mobile: member.mobile, status: member.status } });
    } catch (error) {
        console.error('❌ Member login error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Get All Members (Admin)
app.get('/api/admin/all-members', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM members ORDER BY created_at DESC');
        res.json({ members: result.rows });
    } catch (error) {
        console.error('❌ Get all members error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Delete Member (Admin)
app.delete('/api/admin/delete-member/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM members WHERE id = $1', [id]);
        res.json({ message: 'Member deleted' });
    } catch (error) {
        console.error('❌ Delete member error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Get All Points
app.get('/api/points', async (req, res) => {
    try {
        const result = await pool.query('SELECT * FROM points ORDER BY order_num');
        res.json({ points: result.rows });
    } catch (error) {
        console.error('❌ Get points error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Add Point (Admin)
app.post('/api/admin/points', async (req, res) => {
    try {
        const { text } = req.body;
        const maxOrder = await pool.query('SELECT MAX(order_num) as max FROM points');
        const newOrder = (maxOrder.rows[0].max || 0) + 1;
        
        const result = await pool.query(
            'INSERT INTO points (text, order_num) VALUES ($1, $2) RETURNING *',
            [text, newOrder]
        );
        res.status(201).json({ point: result.rows[0] });
    } catch (error) {
        console.error('❌ Add point error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Update Point (Admin)
app.put('/api/admin/points/:id', async (req, res) => {
    try {
        const { id } = req.params;
        const { text } = req.body;
        
        await pool.query('UPDATE points SET text = $1 WHERE id = $2', [text, id]);
        res.json({ message: 'Point updated' });
    } catch (error) {
        console.error('❌ Update point error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Delete Point (Admin)
app.delete('/api/admin/points/:id', async (req, res) => {
    try {
        const { id } = req.params;
        await pool.query('DELETE FROM points WHERE id = $1', [id]);
        res.json({ message: 'Point deleted' });
    } catch (error) {
        console.error('❌ Delete point error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// FIXED: Get Member's Daily Records - Returns object with point_id as key
app.get('/api/members/:memberId/daily/:date', async (req, res) => {
    try {
        const { memberId, date } = req.params;
        
        console.log(`📊 Fetching daily records for member ${memberId} on ${date}`);
        
        const result = await pool.query(
            'SELECT point_id, effort FROM daily_records WHERE member_id = $1 AND date = $2',
            [memberId, date]
        );
        
        console.log(`✅ Found ${result.rows.length} records`);
        
        // Convert to object format: { pointId: effort }
        const records = {};
        result.rows.forEach(row => {
            records[row.point_id] = row.effort;
            console.log(`  Point ${row.point_id}: ${row.effort}%`);
        });
        
        res.json(records);
    } catch (error) {
        console.error('❌ Get daily records error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// FIXED: Update Daily Record - Save percentage
app.post('/api/members/:memberId/daily', async (req, res) => {
    try {
        const { memberId } = req.params;
        const { date, pointId, completed } = req.body;
        
        console.log(`💾 Saving: Member ${memberId}, Point ${pointId}, Date ${date}, Effort ${completed}%`);

        const result = await pool.query(
            `INSERT INTO daily_records (member_id, point_id, date, effort) 
             VALUES ($1, $2, $3, $4) 
             ON CONFLICT (member_id, point_id, date) 
             DO UPDATE SET effort = $4
             RETURNING *`,
            [memberId, pointId, date, completed]
        );
        
        console.log(`✅ Saved successfully:`, result.rows[0]);

        res.json({ message: 'Record updated', record: result.rows[0] });
    } catch (error) {
        console.error('❌ Update daily record error:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
});

// FIXED: Get Member Progress - Calculate averages properly
app.get('/api/members/:memberId/progress/:period', async (req, res) => {
    try {
        const { memberId, period } = req.params;
        
        let days = 1;
        if (period === 'weekly') days = 7;
        else if (period === 'monthly') days = 30;
        else if (period === 'yearly') days = 365;

        const startDate = new Date();
        startDate.setDate(startDate.getDate() - days + 1);
        const startDateStr = startDate.toISOString().split('T')[0];

        console.log(`📈 Getting progress for member ${memberId}, period ${period} (${days} days from ${startDateStr})`);

        const points = await pool.query('SELECT * FROM points ORDER BY order_num');
        
        const progress = await Promise.all(points.rows.map(async (point) => {
            const result = await pool.query(
                `SELECT 
                    COUNT(*) as total_records,
                    COALESCE(AVG(effort), 0) as avg_effort
                 FROM daily_records 
                 WHERE member_id = $1 AND point_id = $2 AND date >= $3`,
                [memberId, point.id, startDateStr]
            );

            const avgEffort = parseFloat(result.rows[0].avg_effort) || 0;
            const totalRecords = parseInt(result.rows[0].total_records) || 0;

            console.log(`  Point ${point.id}: ${totalRecords} records, avg ${avgEffort.toFixed(1)}%`);

            return {
                pointId: point.id,
                text: point.text,
                percentage: Math.round(avgEffort),
                records: totalRecords
            };
        }));

        console.log(`✅ Progress calculated for ${progress.length} points`);

        res.json({ progress });
    } catch (error) {
        console.error('❌ Get progress error:', error);
        res.status(500).json({ message: 'Server error', error: error.message });
    }
});

// Get All Members (for member view) - Only approved members
app.get('/api/members', async (req, res) => {
    try {
        const result = await pool.query(
            'SELECT id, name, centre, mobile, status FROM members WHERE status = $1 ORDER BY name',
            ['approved']
        );
        res.json({ members: result.rows });
    } catch (error) {
        console.error('❌ Get members error:', error);
        res.status(500).json({ message: 'Server error' });
    }
});

// Health Check
app.get('/health', (req, res) => {
    res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

// Debug endpoint - Check database records
app.get('/api/debug/records/:memberId', async (req, res) => {
    try {
        const { memberId } = req.params;
        const result = await pool.query(
            'SELECT * FROM daily_records WHERE member_id = $1 ORDER BY date DESC, point_id',
            [memberId]
        );
        res.json({ records: result.rows });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Start Server
app.listen(PORT, async () => {
    console.log(`🚀 Server running on port ${PORT}`);
    await initDatabase();
});