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
   DATABASE
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


        await pool.query(`
            CREATE TABLE IF NOT EXISTS cherychat_conversations (
                id SERIAL PRIMARY KEY,
                user_one_id INTEGER NOT NULL
                    REFERENCES cherychat_users(id)
                    ON DELETE CASCADE,
                user_two_id INTEGER NOT NULL
                    REFERENCES cherychat_users(id)
                    ON DELETE CASCADE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

                CONSTRAINT different_users
                    CHECK (user_one_id <> user_two_id),

                CONSTRAINT unique_conversation
                    UNIQUE (user_one_id, user_two_id)
            );
        `);

        console.log("CheryChat conversations table ready");


        await pool.query(`
            CREATE TABLE IF NOT EXISTS cherychat_messages (
                id SERIAL PRIMARY KEY,
                conversation_id INTEGER NOT NULL
                    REFERENCES cherychat_conversations(id)
                    ON DELETE CASCADE,
                sender_id INTEGER NOT NULL
                    REFERENCES cherychat_users(id)
                    ON DELETE CASCADE,
                message_text TEXT NOT NULL,
                is_read BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        console.log("CheryChat messages table ready");


        await pool.query(`
            CREATE INDEX IF NOT EXISTS
            cherychat_messages_conversation_idx
            ON cherychat_messages(conversation_id, created_at);
        `);

        console.log("CheryChat messaging database ready");

    } catch (error) {

        console.error(
            "Database initialization failed:",
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
   TEST USERS
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
            "Users table error:",
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


        const passwordHash =
            await bcrypt.hash(
                cleanPassword,
                12
            );


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
   LOGIN
========================= */

app.post("/api/login", async (req, res) => {

    try {

        const {
            identifier,
            password
        } = req.body;


        if (
            !identifier ||
            !password
        ) {

            return res.status(400).json({

                success: false,

                message:
                    "Email/phone and password are required"

            });

        }


        const cleanIdentifier =
            String(identifier).trim();


        const result =
            await pool.query(
                `
                SELECT
                    id,
                    full_name,
                    email,
                    phone,
                    password_hash,
                    profile_picture,
                    about,
                    is_online,
                    last_seen,
                    created_at
                FROM cherychat_users
                WHERE LOWER(email) = LOWER($1)
                   OR phone = $1
                LIMIT 1
                `,
                [
                    cleanIdentifier
                ]
            );


        if (result.rows.length === 0) {

            return res.status(401).json({

                success: false,

                message:
                    "Incorrect email, phone number or password"

            });

        }


        const user =
            result.rows[0];


        const passwordMatch =
            await bcrypt.compare(
                String(password),
                user.password_hash
            );


        if (!passwordMatch) {

            return res.status(401).json({

                success: false,

                message:
                    "Incorrect email, phone number or password"

            });

        }


        await pool.query(
            `
            UPDATE cherychat_users
            SET
                is_online = TRUE,
                last_seen = CURRENT_TIMESTAMP
            WHERE id = $1
            `,
            [
                user.id
            ]
        );


        res.json({

            success: true,

            message:
                "Login successful",

            user: {

                id:
                    user.id,

                fullName:
                    user.full_name,

                email:
                    user.email,

                phone:
                    user.phone,

                profilePicture:
                    user.profile_picture,

                about:
                    user.about,

                isOnline:
                    true,

                lastSeen:
                    new Date(),

                createdAt:
                    user.created_at

            }

        });


    } catch (error) {

        console.error(
            "CHERYCHAT LOGIN ERROR:",
            error
        );


        res.status(500).json({

            success: false,

            message:
                "Unable to login"

        });

    }

});


/* =========================
   SEARCH USERS
========================= */

app.get("/api/users/search", async (req, res) => {

    try {

        const q =
            String(req.query.q || "").trim();


        if (!q) {

            return res.json({
                success: true,
                users: []
            });

        }


        const search =
            `%${q}%`;


        const result =
            await pool.query(
                `
                SELECT
                    id,
                    full_name,
                    email,
                    phone,
                    profile_picture,
                    about,
                    is_online,
                    last_seen
                FROM cherychat_users
                WHERE
                    full_name ILIKE $1
                    OR email ILIKE $1
                    OR phone ILIKE $1
                ORDER BY
                    is_online DESC,
                    full_name ASC
                LIMIT 20
                `,
                [
                    search
                ]
            );


        res.json({

            success: true,

            users:
                result.rows.map(user => ({

                    id:
                        user.id,

                    fullName:
                        user.full_name,

                    email:
                        user.email,

                    phone:
                        user.phone,

                    profilePicture:
                        user.profile_picture,

                    about:
                        user.about,

                    isOnline:
                        user.is_online,

                    lastSeen:
                        user.last_seen

                }))

        });


    } catch (error) {

        console.error(
            "CHERYCHAT USER SEARCH ERROR:",
            error
        );


        res.status(500).json({

            success: false,

            message:
                "Unable to search CheryChat users"

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
