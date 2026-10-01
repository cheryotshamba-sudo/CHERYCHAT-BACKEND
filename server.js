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
                about TEXT DEFAULT 'Hey there! I am using VibeChat.',
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
        message: "VibeChat Backend is running",
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
                "VibeChat database connected successfully",
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
                "VibeChat users table is working",
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
                "VibeChat users table is not available"
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
                        "That email address is already registered on VibeChat"
                });

            }


            if (
                existing.phone ===
                cleanPhone
            ) {

                return res.status(409).json({
                    success: false,
                    message:
                        "That phone number is already registered on VibeChat"
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
                "VibeChat account created successfully",

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
            "VIBECHAT REGISTRATION ERROR:",
            error
        );

        res.status(500).json({

            success: false,

            message:
                "Unable to create VibeChat account"

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
            "VIBECHAT LOGIN ERROR:",
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
   ONLINE HEARTBEAT
========================= */

app.post("/api/users/heartbeat", async (req, res) => {

    try {

        const userId =
            Number(req.body.userId);


        if (!Number.isInteger(userId)) {

            return res.status(400).json({

                success: false,

                message:
                    "Valid user ID is required"

            });

        }


        const result =
            await pool.query(
                `
                UPDATE cherychat_users
                SET
                    is_online = TRUE,
                    last_seen = CURRENT_TIMESTAMP
                WHERE id = $1
                RETURNING
                    id,
                    is_online,
                    last_seen
                `,
                [
                    userId
                ]
            );


        if (result.rows.length === 0) {

            return res.status(404).json({

                success: false,

                message:
                    "User not found"

            });

        }


        res.json({

            success: true,

            isOnline:
                result.rows[0].is_online,

            lastSeen:
                result.rows[0].last_seen

        });

    } catch (error) {

        console.error(
            "VIBECHAT HEARTBEAT ERROR:",
            error
        );

        res.status(500).json({

            success: false,

            message:
                "Unable to update online status"

        });

    }

});


/* =========================
   OFFLINE STATUS
========================= */

app.post("/api/users/logout-status", async (req, res) => {

    try {

        const userId =
            Number(req.body.userId);


        if (!Number.isInteger(userId)) {

            return res.status(400).json({

                success: false,

                message:
                    "Valid user ID is required"

            });

        }


        const result =
            await pool.query(
                `
                UPDATE cherychat_users
                SET
                    is_online = FALSE,
                    last_seen = CURRENT_TIMESTAMP
                WHERE id = $1
                RETURNING
                    id,
                    is_online,
                    last_seen
                `,
                [
                    userId
                ]
            );


        if (result.rows.length === 0) {

            return res.status(404).json({

                success: false,

                message:
                    "User not found"

            });

        }


        res.json({

            success: true,

            isOnline:
                result.rows[0].is_online,

            lastSeen:
                result.rows[0].last_seen

        });

    } catch (error) {

        console.error(
            "VIBECHAT OFFLINE STATUS ERROR:",
            error
        );

        res.status(500).json({

            success: false,

            message:
                "Unable to update offline status"

        });

    }

});


/* =========================
   USER STATUS
========================= */

app.get("/api/users/:id/status", async (req, res) => {

    try {

        const userId =
            Number(req.params.id);


        if (!Number.isInteger(userId)) {

            return res.status(400).json({

                success: false,

                message:
                    "Valid user ID is required"

            });

        }


        const result =
            await pool.query(
                `
                SELECT
                    id,
                    full_name,
                    is_online,
                    last_seen
                FROM cherychat_users
                WHERE id = $1
                LIMIT 1
                `,
                [
                    userId
                ]
            );


        if (result.rows.length === 0) {

            return res.status(404).json({

                success: false,

                message:
                    "User not found"

            });

        }


        const user =
            result.rows[0];


        res.json({

            success: true,

            user: {

                id:
                    user.id,

                fullName:
                    user.full_name,

                isOnline:
                    user.is_online,

                lastSeen:
                    user.last_seen

            }

        });

    } catch (error) {

        console.error(
            "VIBECHAT USER STATUS ERROR:",
            error
        );

        res.status(500).json({

            success: false,

            message:
                "Unable to get user status"

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
            "VIBECHAT USER SEARCH ERROR:",
            error
        );


        res.status(500).json({

            success: false,

            message:
                "Unable to search VibeChat users"

        });

    }

});


/* =========================
   LIST USER CONVERSATIONS
========================= */

app.get("/api/conversations", async (req, res) => {

    try {

        const userId =
            Number(req.query.userId);


        if (!Number.isInteger(userId)) {

            return res.status(400).json({

                success: false,

                message:
                    "A valid user ID is required"

            });

        }


        const userCheck =
            await pool.query(
                `
                SELECT id
                FROM cherychat_users
                WHERE id = $1
                LIMIT 1
                `,
                [
                    userId
                ]
            );


        if (userCheck.rows.length === 0) {

            return res.status(404).json({

                success: false,

                message:
                    "User not found"

            });

        }


        const result =
            await pool.query(
                `
                SELECT
                    c.id AS conversation_id,
                    c.created_at AS conversation_created_at,

                    CASE
                        WHEN c.user_one_id = $1
                        THEN u2.id
                        ELSE u1.id
                    END AS other_user_id,

                    CASE
                        WHEN c.user_one_id = $1
                        THEN u2.full_name
                        ELSE u1.full_name
                    END AS other_user_name,

                    CASE
                        WHEN c.user_one_id = $1
                        THEN u2.email
                        ELSE u1.email
                    END AS other_user_email,

                    CASE
                        WHEN c.user_one_id = $1
                        THEN u2.profile_picture
                        ELSE u1.profile_picture
                    END AS other_user_picture,

                    CASE
                        WHEN c.user_one_id = $1
                        THEN u2.about
                        ELSE u1.about
                    END AS other_user_about,

                    CASE
                        WHEN c.user_one_id = $1
                        THEN u2.is_online
                        ELSE u1.is_online
                    END AS other_user_online,

                    CASE
                        WHEN c.user_one_id = $1
                        THEN u2.last_seen
                        ELSE u1.last_seen
                    END AS other_user_last_seen,

                    lm.message_text AS last_message,
                    lm.created_at AS last_message_time,
                    lm.sender_id AS last_message_sender_id,

                    COALESCE(unread.unread_count, 0) AS unread_count

                FROM cherychat_conversations c

                JOIN cherychat_users u1
                    ON u1.id = c.user_one_id

                JOIN cherychat_users u2
                    ON u2.id = c.user_two_id

                LEFT JOIN LATERAL (
                    SELECT
                        m.message_text,
                        m.created_at,
                        m.sender_id
                    FROM cherychat_messages m
                    WHERE m.conversation_id = c.id
                    ORDER BY
                        m.created_at DESC,
                        m.id DESC
                    LIMIT 1
                ) lm ON TRUE

                LEFT JOIN LATERAL (
                    SELECT COUNT(*) AS unread_count
                    FROM cherychat_messages m
                    WHERE m.conversation_id = c.id
                      AND m.sender_id <> $1
                      AND m.is_read = FALSE
                ) unread ON TRUE

                WHERE
                    c.user_one_id = $1
                    OR c.user_two_id = $1

                ORDER BY
                    COALESCE(
                        lm.created_at,
                        c.created_at
                    ) DESC

                `,
                [
                    userId
                ]
            );


        res.json({

            success: true,

            conversations:
                result.rows.map(chat => ({

                    conversationId:
                        chat.conversation_id,

                    otherUser: {

                        id:
                            chat.other_user_id,

                        fullName:
                            chat.other_user_name,

                        email:
                            chat.other_user_email,

                        profilePicture:
                            chat.other_user_picture,

                        about:
                            chat.other_user_about,

                        isOnline:
                            chat.other_user_online,

                        lastSeen:
                            chat.other_user_last_seen

                    },

                    lastMessage:
                        chat.last_message || "",

                    lastMessageTime:
                        chat.last_message_time ||
                        chat.conversation_created_at,

                    lastMessageSenderId:
                        chat.last_message_sender_id,

                    unreadCount:
                        Number(chat.unread_count)

                }))

        });


    } catch (error) {

        console.error(
            "VIBECHAT CONVERSATIONS LIST ERROR:",
            error
        );


        res.status(500).json({

            success: false,

            message:
                "Unable to load conversations"

        });

    }

});


/* =========================
   START PRIVATE CONVERSATION
========================= */

app.post("/api/conversations", async (req, res) => {

    try {

        const {
            userId,
            otherUserId
        } = req.body;


        const currentUserId =
            Number(userId);

        const targetUserId =
            Number(otherUserId);


        if (
            !Number.isInteger(currentUserId) ||
            !Number.isInteger(targetUserId)
        ) {

            return res.status(400).json({
                success: false,
                message:
                    "Valid user IDs are required"
            });

        }


        if (currentUserId === targetUserId) {

            return res.status(400).json({
                success: false,
                message:
                    "You cannot start a conversation with yourself"
            });

        }


        const users =
            await pool.query(
                `
                SELECT id
                FROM cherychat_users
                WHERE id IN ($1, $2)
                `,
                [
                    currentUserId,
                    targetUserId
                ]
            );


        if (users.rows.length !== 2) {

            return res.status(404).json({
                success: false,
                message:
                    "One or both users do not exist"
            });

        }


        const userOne =
            Math.min(
                currentUserId,
                targetUserId
            );

        const userTwo =
            Math.max(
                currentUserId,
                targetUserId
            );


        const result =
            await pool.query(
                `
                INSERT INTO cherychat_conversations
                (
                    user_one_id,
                    user_two_id
                )
                VALUES ($1, $2)
                ON CONFLICT (user_one_id, user_two_id)
                DO UPDATE SET
                    user_one_id =
                        EXCLUDED.user_one_id
                RETURNING id, user_one_id, user_two_id, created_at
                `,
                [
                    userOne,
                    userTwo
                ]
            );


        res.json({

            success: true,

            conversation: {

                id:
                    result.rows[0].id,

                userOneId:
                    result.rows[0].user_one_id,

                userTwoId:
                    result.rows[0].user_two_id,

                createdAt:
                    result.rows[0].created_at

            }

        });


    } catch (error) {

        console.error(
            "VIBECHAT CONVERSATION ERROR:",
            error
        );


        res.status(500).json({

            success: false,

            message:
                "Unable to start conversation"

        });

    }

});


/* =========================
   SEND MESSAGE
========================= */

app.post("/api/messages", async (req, res) => {

    try {

        const {
            conversationId,
            senderId,
            message
        } = req.body;


        const cleanConversationId =
           
