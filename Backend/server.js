const express = require('express');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const cors = require('cors');
const bcrypt = require('bcrypt');
const multer = require('multer');
const path = require('path');
const retry = require('async-retry');
const fs = require('fs');

// Load environment variables from server.env if it exists
if (fs.existsSync(path.join(__dirname, 'server.env'))) {
  dotenv.config({ path: path.join(__dirname, 'server.env') });
} else {
  dotenv.config();
}

const app = express();

// CORS configuration
const allowedOrigins = [
  'http://54.166.206.245:8005',
  'http://54.166.206.245:8006',
  'http://54.166.206.245:8007',
  process.env.FRONTEND_URL || 'http://54.166.206.245:8005'
];

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));
app.use('/uploads', express.static(path.join(__dirname, 'Uploads')));

// PostgreSQL pool
const pool = new Pool({
  user: process.env.DB_USER || 'postgres',
  host: process.env.DB_HOST || 'localhost',
  database: process.env.DB_NAME || 'auth_db',
  password: process.env.DB_PASSWORD || 'admin123',
  port: process.env.DB_PORT || 5432,
  connectionTimeoutMillis: 10000,
  idleTimeoutMillis: 30000,
});

// Multer config
const storage = multer.diskStorage({
  destination: './Uploads/',
  filename: (req, file, cb) => {
    cb(null, Date.now() + path.extname(file.originalname));
  }
});
const upload = multer({ storage });

// Initialize DB schema
async function initializeDatabase() {
  const client = await pool.connect();
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        username VARCHAR(50) UNIQUE NOT NULL,
        email VARCHAR(100) UNIQUE NOT NULL,
        password TEXT NOT NULL,
        profile_image TEXT,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
      CREATE INDEX IF NOT EXISTS idx_email ON users(email);
    `);
    console.log('✅ Database initialized successfully');
  } finally {
    client.release();
  }
}

// Retry PostgreSQL connection
async function connectWithRetry() {
  return retry(
    async () => {
      const client = await pool.connect();
      console.log('✅ PostgreSQL connected successfully');
      await initializeDatabase();
      client.release();
    },
    {
      retries: 10,
      factor: 2,
      minTimeout: 1000,
      maxTimeout: 10000,
      onRetry: (err) => {
        console.error(`🔁 Retry failed: ${err.message}`);
      }
    }
  );
}

// Health check
app.get('/api/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({
      status: 'healthy',
      database: 'connected',
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    res.status(503).json({
      status: 'unhealthy',
      database: 'disconnected',
      error: err.message
    });
  }
});

// Signup route
app.post('/api/signup', upload.single('profileImage'), async (req, res) => {
  try {
    const { username, email, password } = req.body;
    const hashedPassword = await bcrypt.hash(password, 10);
    const profileImage = req.file ? `/uploads/${req.file.filename}` : null;

    const result = await pool.query(
      'INSERT INTO users (username, email, password, profile_image) VALUES ($1, $2, $3, $4) RETURNING id',
      [username, email, hashedPassword, profileImage]
    );

    res.status(201).json({ message: 'User created', userId: result.rows[0].id });
  } catch (err) {
    console.error('❌ Signup error:', err);
    res.status(500).json({ error: 'Failed to create user' });
  }
});

// Login route
app.post('/api/login', async (req, res) => {
  try {
    const { email, password } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);
    if (result.rows.length === 0) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    const user = result.rows[0];
    const isValid = await bcrypt.compare(password, user.password);

    if (!isValid) {
      return res.status(401).json({ error: 'Invalid credentials' });
    }

    res.json({ message: 'Login successful', userId: user.id });
  } catch (err) {
    console.error('❌ Login error:', err);
    res.status(500).json({ error: 'Failed to login' });
  }
});

// Forgot password
app.post('/api/forgot', async (req, res) => {
  try {
    const { email } = req.body;
    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    // TODO: Implement password reset logic
    res.json({ message: 'Password reset link sent' });
  } catch (err) {
    console.error('❌ Forgot password error:', err);
    res.status(500).json({ error: 'Failed to process request' });
  }
});

// ✅ Check if email exists
app.post('/check-email-data', async (req, res) => {
  try {
    const { email } = req.body;

    if (!email) {
      return res.status(400).json({ error: 'Email is required' });
    }

    const result = await pool.query('SELECT * FROM users WHERE email = $1', [email]);

    res.json({ exists: result.rows.length > 0 });
  } catch (err) {
    console.error('❌ Email check error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// ✅ Start server after DB connection
const PORT = process.env.PORT || 3628;
connectWithRetry()
  .then(() => {
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`🚀 Server running on port ${PORT}`);
      console.log(`🌐 Allowed CORS origins: ${allowedOrigins.join(', ')}`);
    });
  })
  .catch(err => {
    console.error('❌ Failed to connect to DB after retries:', err);
    process.exit(1);
  });
