const express = require("express");
const cors = require("cors");
const { Pool } = require("pg");

const app = express();

app.use(cors());
app.use(express.json());

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: false }
        : false
});

// Create database tables
async function initializeDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS users (
                id SERIAL PRIMARY KEY,
                full_name VARCHAR(100) NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                phone VARCHAR(20) UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                profile_picture TEXT,
                about TEXT DEFAULT 'Hey there! I am using CheryChat.',
                is_online BOOLEAN DEFAULT FALSE,
                last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log("Users table ready");
    } catch (error) {
        console.error("Database initialization failed:", error);
    }
}

// Home
app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "CheryChat Backend is running",
        status: "online",
        database: "connected"
    });
});

// Test database
app.get("/api/test-db", async (req, res) => {
    try {
        const result = await pool.query("SELECT NOW()");

        res.json({
            success: true,
            message: "CheryChat database connected successfully",
            time: result.rows[0].now
        });
    } catch (error) {
        console.error("Database error:", error);

        res.status(500).json({
            success: false,
            message: "Database connection failed"
        });
    }
});

// Test users table
app.get("/api/test-users", async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT COUNT(*) AS total_users
            FROM users
        `);

        res.json({
            success: true,
            message: "Users table is working",
            total_users: Number(result.rows[0].total_users)
        });
    } catch (error) {
        console.error("Users table error:", error);

        res.status(500).json({
            success: false,
            message: "Users table is not available"
        });
    }
});

const PORT = process.env.PORT || 10000;

app.listen(PORT, async () => {
    console.log(`CheryChat backend running on port ${PORT}`);

    await initializeDatabase();
});
