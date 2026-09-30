const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
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


/* =========================
   CREATE CHERYCHAT TABLE
========================= */

async function initializeDatabase() {
    try {

        await pool.query(`
            CREATE TABLE IF NOT EXISTS cherychat_users (
                id SERIAL PRIMARY KEY,
                full_name VARCHAR(100) NOT NULL,
                email VARCHAR(255) UNIQUE NOT NULL,
                phone VARCHAR(30) UNIQUE NOT NULL,
                password_hash TEXT NOT NULL,
                profile_picture TEXT,
                about TEXT DEFAULT 'Hey there! I am using CheryChat.',
                is_online BOOLEAN DEFAULT FALSE,
                last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log("CheryChat users table ready");

    } catch (error) {

        console.error(
            "CheryChat database initialization failed:",
            error
        );

    }
}


/* =========================
   HOME
========================= */

app.get("/", (req, res) => {

    res.json({
        success: true,
        message: "CheryChat Backend is running",
        status: "online",
        database: "connected"
    });

});


/* =========================
   TEST DATABASE
========================= */

app.get("/api/test-db", async (req, res) => {

    try {

        const result =
            await pool.query("SELECT NOW()");

        res.json({
            success: true,
            message:
                "CheryChat database connected successfully",
            time: result.rows[0].now
        });

    } catch (error) {

        console.error(
            "Database error:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Database connection failed"
        });

    }

});


/* =========================
   TEST CHERYCHAT USERS
========================= */

app.get("/api/test-users", async (req, res) => {

    try {

        const result =
            await pool.query(`
                SELECT COUNT(*) AS total_users
                FROM cherychat_users
            `);

        res.json({
            success: true,
            message:
                "CheryChat users table is working",
            total_users:
                Number(result.rows[0].total_users)
        });

    } catch (error) {

        console.error(
            "CheryChat users table error:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "CheryChat users table is not available"
        });

    }

});


/* =========================
   REGISTER
========================= */

app.post("/api/register", async (req, res) => {

    try {

        const {
            fullName,
            email,
            phone,
            password
        } = req.body;


        if (
            !fullName ||
            !email ||
            !phone ||
            !password
        ) {

            return res.status(400).json({
                success: false,
                message:
                    "All fields are required"
            });

        }


        const cleanName =
            String(fullName).trim();

        const cleanEmail =
            String(email)
                .trim()
                .toLowerCase();

        const cleanPhone =
            String(phone).trim();

        const cleanPassword =
            String(password);


        if (cleanPassword.length < 6) {

            return res.status(400).json({
                success: false,
                message:
                    "Password must be at least 6 characters"
            });

        }


        /* CHECK CHERYCHAT USERS ONLY */

        const existingUser =
            await pool.query(
                `
                SELECT id, email, phone
                FROM cherychat_users
                WHERE LOWER(email) = LOWER($1)
                   OR phone = $2
                LIMIT 1
                `,
                [
                    cleanEmail,
                    cleanPhone
                ]
            );


        if (existingUser.rows.length > 0) {

            const existing =
                existingUser.rows[0];


            if (
                existing.email.toLowerCase() ===
                cleanEmail
            ) {

                return res.status(409).json({
                    success: false,
                    message:
                        "That email address is already registered on CheryChat"
                });

            }


            if (
                existing.phone ===
                cleanPhone
            ) {

                return res.status(409).json({
                    success: false,
                    message:
                        "That phone number is already registered on CheryChat"
                });

            }

        }


        /* HASH PASSWORD */

        const passwordHash =
            await bcrypt.hash(
                cleanPassword,
                12
            );


        /* CREATE CHERYCHAT USER */

        const result =
            await pool.query(
                `
                INSERT INTO cherychat_users
                (
                    full_name,
                    email,
                    phone,
                    password_hash
                )
                VALUES
                ($1, $2, $3, $4)
                RETURNING
                    id,
                    full_name,
                    email,
                    phone,
                    about,
                    created_at
                `,
                [
                    cleanName,
                    cleanEmail,
                    cleanPhone,
                    passwordHash
                ]
            );


        const user =
            result.rows[0];


        res.status(201).json({

            success: true,

            message:
                "CheryChat account created successfully",

            user: {

                id: user.id,

                fullName:
                    user.full_name,

                email:
                    user.email,

                phone:
                    user.phone,

                about:
                    user.about,

                createdAt:
                    user.created_at

            }

        });


    } catch (error) {

        console.error(
            "CHERYCHAT REGISTRATION ERROR:",
            error
        );

        res.status(500).json({

            success: false,

            message:
                "Unable to create CheryChat account"

        });

    }

});


/* =========================
   START SERVER
========================= */

const PORT =
    process.env.PORT || 10000;

app.listen(PORT, async () => {

    console.log(
        `CheryChat backend running on port ${PORT}`
    );

    await initializeDatabase();

});
