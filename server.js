const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

app.use(cors());
app.use(express.json({ limit: "10mb" }));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.NODE_ENV === "production"
        ? { rejectUnauthorized: false }
        : false
});

/* =========================================================
   HELPERS
========================================================= */

function toId(value) {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
}

function cleanText(value, maxLength = 1000) {
    return String(value || "").trim().slice(0, maxLength);
}

function cleanGroupName(value) {
    return cleanText(value, 100);
}

function cleanDescription(value) {
    return cleanText(value, 1000);
}

function generateInviteCode() {
    return crypto.randomBytes(6).toString("hex").toUpperCase();
}

async function userExists(userId) {
    const result = await pool.query(
        `
        SELECT id
        FROM cherychat_users
        WHERE id = $1
        LIMIT 1
        `,
        [userId]
    );

    return result.rows.length > 0;
}

/* =========================================================
   DATABASE
========================================================= */

async function initializeDatabase() {
    try {

        /* USERS */

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

        /* PRIVATE CONVERSATIONS */

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

        /* PRIVATE MESSAGES */

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

        await pool.query(`
            CREATE INDEX IF NOT EXISTS
            cherychat_messages_conversation_idx
            ON cherychat_messages(conversation_id, created_at);
        `);

        /* =====================================================
           GROUPS
        ===================================================== */

        await pool.query(`
            CREATE TABLE IF NOT EXISTS cherychat_groups (
                id SERIAL PRIMARY KEY,

                name VARCHAR(100) NOT NULL,

                description TEXT DEFAULT '',

                group_picture TEXT,

                privacy VARCHAR(20) NOT NULL DEFAULT 'public'
                    CHECK (privacy IN ('public', 'private')),

                joining_fee NUMERIC(12,2) NOT NULL DEFAULT 0
                    CHECK (joining_fee >= 0),

                owner_id INTEGER NOT NULL
                    REFERENCES cherychat_users(id)
                    ON DELETE CASCADE,

                invite_code VARCHAR(30) UNIQUE NOT NULL,

                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

                updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        /* GROUP MEMBERS */

        await pool.query(`
            CREATE TABLE IF NOT EXISTS cherychat_group_members (
                id SERIAL PRIMARY KEY,

                group_id INTEGER NOT NULL
                    REFERENCES cherychat_groups(id)
                    ON DELETE CASCADE,

                user_id INTEGER NOT NULL
                    REFERENCES cherychat_users(id)
                    ON DELETE CASCADE,

                role VARCHAR(20) NOT NULL DEFAULT 'member'
                    CHECK (role IN ('owner', 'admin', 'member')),

                membership_status VARCHAR(20) NOT NULL DEFAULT 'active'
                    CHECK (
                        membership_status IN
                        ('active', 'pending', 'removed')
                    ),

                payment_status VARCHAR(20) NOT NULL DEFAULT 'not_required'
                    CHECK (
                        payment_status IN
                        (
                            'not_required',
                            'pending',
                            'paid',
                            'failed'
                        )
                    ),

                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

                UNIQUE(group_id, user_id)
            );
        `);

        /* GROUP MESSAGES */

        await pool.query(`
            CREATE TABLE IF NOT EXISTS cherychat_group_messages (
                id SERIAL PRIMARY KEY,

                group_id INTEGER NOT NULL
                    REFERENCES cherychat_groups(id)
                    ON DELETE CASCADE,

                sender_id INTEGER NOT NULL
                    REFERENCES cherychat_users(id)
                    ON DELETE CASCADE,

                message_text TEXT NOT NULL,

                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS
            cherychat_group_messages_idx
            ON cherychat_group_messages(group_id, created_at);
        `);

        /* GROUP PAYMENTS
           Payment provider will be connected later.
        */

        await pool.query(`
            CREATE TABLE IF NOT EXISTS cherychat_group_payments (
                id SERIAL PRIMARY KEY,

                group_id INTEGER NOT NULL
                    REFERENCES cherychat_groups(id)
                    ON DELETE CASCADE,

                user_id INTEGER NOT NULL
                    REFERENCES cherychat_users(id)
                    ON DELETE CASCADE,

                amount NUMERIC(12,2) NOT NULL
                    CHECK (amount >= 0),

                currency VARCHAR(10) NOT NULL DEFAULT 'KES',

                provider VARCHAR(30) DEFAULT 'pending',

                provider_reference TEXT,

                status VARCHAR(20) NOT NULL DEFAULT 'pending'
                    CHECK (
                        status IN
                        ('pending', 'paid', 'failed', 'cancelled')
                    ),

                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,

                paid_at TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS
            cherychat_group_members_group_idx
            ON cherychat_group_members(group_id);
        `);

        await pool.query(`
            CREATE INDEX IF NOT EXISTS
            cherychat_group_members_user_idx
            ON cherychat_group_members(user_id);
        `);

        console.log("VibeChat database ready");
        console.log("VibeChat groups database ready");

    } catch (error) {
        console.error(
            "Database initialization failed:",
            error
        );
    }
}

/* =========================================================
   HOME
========================================================= */

app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "VibeChat Backend is running",
        status: "online",
        database: "connected"
    });
});

/* =========================================================
   TEST DATABASE
========================================================= */

app.get("/api/test-db", async (req, res) => {
    try {

        const result = await pool.query("SELECT NOW()");

        res.json({
            success: true,
            message: "VibeChat database connected successfully",
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

/* =========================================================
   TEST USERS
========================================================= */

app.get("/api/test-users", async (req, res) => {
    try {

        const result = await pool.query(`
            SELECT COUNT(*) AS total_users
            FROM cherychat_users
        `);

        res.json({
            success: true,
            message: "VibeChat users table is working",
            total_users: Number(result.rows[0].total_users)
        });

    } catch (error) {

        console.error("Users table error:", error);

        res.status(500).json({
            success: false,
            message: "VibeChat users table is not available"
        });
    }
});

/* =========================================================
   REGISTER
========================================================= */

app.post("/api/register", async (req, res) => {
    try {

        const {
            fullName,
            email,
            phone,
            password
        } = req.body;

        if (!fullName || !email || !phone || !password) {
            return res.status(400).json({
                success: false,
                message: "All fields are required"
            });
        }

        const cleanName = String(fullName).trim();
        const cleanEmail = String(email).trim().toLowerCase();
        const cleanPhone = String(phone).trim();
        const cleanPassword = String(password);

        if (cleanPassword.length < 6) {
            return res.status(400).json({
                success: false,
                message: "Password must be at least 6 characters"
            });
        }

        const existingUser = await pool.query(
            `
            SELECT id, email, phone
            FROM cherychat_users
            WHERE LOWER(email) = LOWER($1)
               OR phone = $2
            LIMIT 1
            `,
            [cleanEmail, cleanPhone]
        );

        if (existingUser.rows.length > 0) {

            const existing = existingUser.rows[0];

            if (existing.email.toLowerCase() === cleanEmail) {
                return res.status(409).json({
                    success: false,
                    message:
                        "That email address is already registered on VibeChat"
                });
            }

            if (existing.phone === cleanPhone) {
                return res.status(409).json({
                    success: false,
                    message:
                        "That phone number is already registered on VibeChat"
                });
            }
        }

        const passwordHash = await bcrypt.hash(
            cleanPassword,
            12
        );

        const result = await pool.query(
            `
            INSERT INTO cherychat_users
            (
                full_name,
                email,
                phone,
                password_hash
            )
            VALUES ($1, $2, $3, $4)
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

        const user = result.rows[0];

        res.status(201).json({
            success: true,
            message: "VibeChat account created successfully",

            user: {
                id: user.id,
                fullName: user.full_name,
                email: user.email,
                phone: user.phone,
                about: user.about,
                createdAt: user.created_at
            }
        });

    } catch (error) {

        console.error(
            "VIBECHAT REGISTRATION ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message: "Unable to create VibeChat account"
        });
    }
});

/* =========================================================
   LOGIN
========================================================= */

app.post("/api/login", async (req, res) => {
    try {

        const {
            identifier,
            password
        } = req.body;

        if (!identifier || !password) {
            return res.status(400).json({
                success: false,
                message:
                    "Email/phone and password are required"
            });
        }

        const cleanIdentifier =
            String(identifier).trim();

        const result = await pool.query(
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
            [cleanIdentifier]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({
                success: false,
                message:
                    "Incorrect email, phone number or password"
            });
        }

        const user = result.rows[0];

        const passwordMatch = await bcrypt.compare(
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
            [user.id]
        );

        res.json({
            success: true,
            message: "Login successful",

            user: {
                id: user.id,
                fullName: user.full_name,
                email: user.email,
                phone: user.phone,
                profilePicture: user.profile_picture,
                about: user.about,
                isOnline: true,
                lastSeen: new Date(),
                createdAt: user.created_at
            }
        });

    } catch (error) {

        console.error(
            "VIBECHAT LOGIN ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message: "Unable to login"
        });
    }
});

/* =========================================================
   ONLINE HEARTBEAT
========================================================= */

app.post("/api/users/heartbeat", async (req, res) => {
    try {

        const userId = toId(req.body.userId);

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: "Valid user ID is required"
            });
        }

        const result = await pool.query(
            `
            UPDATE cherychat_users
            SET
                is_online = TRUE,
                last_seen = CURRENT_TIMESTAMP
            WHERE id = $1
            RETURNING id, is_online, last_seen
            `,
            [userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        res.json({
            success: true,
            isOnline: result.rows[0].is_online,
            lastSeen: result.rows[0].last_seen
        });

    } catch (error) {

        console.error(
            "VIBECHAT HEARTBEAT ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message: "Unable to update online status"
        });
    }
});

/* =========================================================
   OFFLINE STATUS
========================================================= */

app.post("/api/users/logout-status", async (req, res) => {
    try {

        const userId = toId(req.body.userId);

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: "Valid user ID is required"
            });
        }

        const result = await pool.query(
            `
            UPDATE cherychat_users
            SET
                is_online = FALSE,
                last_seen = CURRENT_TIMESTAMP
            WHERE id = $1
            RETURNING id, is_online, last_seen
            `,
            [userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        res.json({
            success: true,
            isOnline: result.rows[0].is_online,
            lastSeen: result.rows[0].last_seen
        });

    } catch (error) {

        console.error(
            "VIBECHAT OFFLINE STATUS ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message: "Unable to update offline status"
        });
    }
});

/* =========================================================
   USER STATUS
========================================================= */

app.get("/api/users/:id/status", async (req, res) => {
    try {

        const userId = toId(req.params.id);

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: "Valid user ID is required"
            });
        }

        const result = await pool.query(
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
            [userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        const user = result.rows[0];

        res.json({
            success: true,

            user: {
                id: user.id,
                fullName: user.full_name,
                isOnline: user.is_online,
                lastSeen: user.last_seen
            }
        });

    } catch (error) {

        console.error(
            "VIBECHAT USER STATUS ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message: "Unable to get user status"
        });
    }
});

/* =========================================================
   SEARCH USERS
========================================================= */

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

        const search = `%${q}%`;

        const result = await pool.query(
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
            [search]
        );

        res.json({
            success: true,

            users: result.rows.map(user => ({
                id: user.id,
                fullName: user.full_name,
                email: user.email,
                phone: user.phone,
                profilePicture: user.profile_picture,
                about: user.about,
                isOnline: user.is_online,
                lastSeen: user.last_seen
            }))
        });

    } catch (error) {

        console.error(
            "VIBECHAT USER SEARCH ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message: "Unable to search VibeChat users"
        });
    }
});

/* =========================================================
   LIST USER CONVERSATIONS
========================================================= */

app.get("/api/conversations", async (req, res) => {
    try {

        const userId = toId(req.query.userId);

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: "A valid user ID is required"
            });
        }

        if (!(await userExists(userId))) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        const result = await pool.query(
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
                ORDER BY m.created_at DESC, m.id DESC
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
                COALESCE(lm.created_at, c.created_at) DESC
            `,
            [userId]
        );

        res.json({
            success: true,

            conversations: result.rows.map(chat => ({
                conversationId: chat.conversation_id,

                otherUser: {
                    id: chat.other_user_id,
                    fullName: chat.other_user_name,
                    email: chat.other_user_email,
                    profilePicture: chat.other_user_picture,
                    about: chat.other_user_about,
                    isOnline: chat.other_user_online,
                    lastSeen: chat.other_user_last_seen
                },

                lastMessage: chat.last_message || "",

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
            message: "Unable to load conversations"
        });
    }
});

/* =========================================================
   START PRIVATE CONVERSATION
========================================================= */

app.post("/api/conversations", async (req, res) => {
    try {

        const currentUserId = toId(req.body.userId);
        const targetUserId = toId(req.body.otherUserId);

        if (!currentUserId || !targetUserId) {
            return res.status(400).json({
                success: false,
                message: "Valid user IDs are required"
            });
        }

        if (currentUserId === targetUserId) {
            return res.status(400).json({
                success: false,
                message:
                    "You cannot start a conversation with yourself"
            });
        }

        const users = await pool.query(
            `
            SELECT id
            FROM cherychat_users
            WHERE id IN ($1, $2)
            `,
            [currentUserId, targetUserId]
        );

        if (users.rows.length !== 2) {
            return res.status(404).json({
                success: false,
                message:
                    "One or both users do not exist"
            });
        }

        const userOne = Math.min(
            currentUserId,
            targetUserId
        );

        const userTwo = Math.max(
            currentUserId,
            targetUserId
        );

        const result = await pool.query(
            `
            INSERT INTO cherychat_conversations
            (
                user_one_id,
                user_two_id
            )
            VALUES ($1, $2)

            ON CONFLICT (user_one_id, user_two_id)
            DO UPDATE SET
                user_one_id = EXCLUDED.user_one_id

            RETURNING
                id,
                user_one_id,
                user_two_id,
                created_at
            `,
            [userOne, userTwo]
        );

        res.json({
            success: true,

            conversation: {
                id: result.rows[0].id,
                userOneId: result.rows[0].user_one_id,
                userTwoId: result.rows[0].user_two_id,
                createdAt: result.rows[0].created_at
            }
        });

    } catch (error) {

        console.error(
            "VIBECHAT CONVERSATION ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message: "Unable to start conversation"
        });
    }
});

/* =========================================================
   SEND PRIVATE MESSAGE
========================================================= */

app.post("/api/messages", async (req, res) => {
    try {

        const conversationId =
            toId(req.body.conversationId);

        const senderId =
            toId(req.body.senderId);

        const message =
            cleanText(req.body.message, 5000);

        if (!conversationId || !senderId || !message) {
            return res.status(400).json({
                success: false,
                message:
                    "Conversation ID, sender ID and message are required"
            });
        }

        const conversation = await pool.query(
            `
            SELECT
                id,
                user_one_id,
                user_two_id
            FROM cherychat_conversations
            WHERE id = $1
            LIMIT 1
            `,
            [conversationId]
        );

        if (conversation.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Conversation not found"
            });
        }

        const chat = conversation.rows[0];

        if (
            chat.user_one_id !== senderId &&
            chat.user_two_id !== senderId
        ) {
            return res.status(403).json({
                success: false,
                message:
                    "You are not a member of this conversation"
            });
        }

        const result = await pool.query(
            `
            INSERT INTO cherychat_messages
            (
                conversation_id,
                sender_id,
                message_text
            )
            VALUES ($1, $2, $3)
            RETURNING
                id,
                conversation_id,
                sender_id,
                message_text,
                is_read,
                created_at
            `,
            [
                conversationId,
                senderId,
                message
            ]
        );

        res.status(201).json({
            success: true,

            message: {
                id: result.rows[0].id,
                conversationId:
                    result.rows[0].conversation_id,
                senderId:
                    result.rows[0].sender_id,
                message:
                    result.rows[0].message_text,
                isRead:
                    result.rows[0].is_read,
                createdAt:
                    result.rows[0].created_at
            }
        });

    } catch (error) {

        console.error(
            "VIBECHAT SEND MESSAGE ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message: "Unable to send message"
        });
    }
});

/* =========================================================
   GET PRIVATE MESSAGES
========================================================= */

app.get("/api/messages", async (req, res) => {
    try {

        const conversationId =
            toId(req.query.conversationId);

        const userId =
            toId(req.query.userId);

        if (!conversationId || !userId) {
            return res.status(400).json({
                success: false,
                message:
                    "Valid conversation ID and user ID are required"
            });
        }

        const conversation = await pool.query(
            `
            SELECT
                user_one_id,
                user_two_id
            FROM cherychat_conversations
            WHERE id = $1
            LIMIT 1
            `,
            [conversationId]
        );

        if (conversation.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Conversation not found"
            });
        }

        const chat = conversation.rows[0];

        if (
            chat.user_one_id !== userId &&
            chat.user_two_id !== userId
        ) {
            return res.status(403).json({
                success: false,
                message:
                    "You are not a member of this conversation"
            });
        }

        const result = await pool.query(
            `
            SELECT
                m.id,
                m.conversation_id,
                m.sender_id,
                u.full_name AS sender_name,
                u.profile_picture AS sender_picture,
                m.message_text,
                m.is_read,
                m.created_at
            FROM cherychat_messages m

            JOIN cherychat_users u
                ON u.id = m.sender_id

            WHERE m.conversation_id = $1

            ORDER BY
                m.created_at ASC,
                m.id ASC
            `,
            [conversationId]
        );

        res.json({
            success: true,

            messages: result.rows.map(message => ({
                id: message.id,
                conversationId:
                    message.conversation_id,
                senderId:
                    message.sender_id,
                senderName:
                    message.sender_name,
                senderPicture:
                    message.sender_picture,
                message:
                    message.message_text,
                isRead:
                    message.is_read,
                createdAt:
                    message.created_at
            }))
        });

    } catch (error) {

        console.error(
            "VIBECHAT GET MESSAGES ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message: "Unable to load messages"
        });
    }
});

/* =========================================================
   MARK PRIVATE MESSAGES READ
========================================================= */

app.post("/api/messages/read", async (req, res) => {
    try {

        const conversationId =
            toId(req.body.conversationId);

        const userId =
            toId(req.body.userId);

        if (!conversationId || !userId) {
            return res.status(400).json({
                success: false,
                message:
                    "Valid conversation ID and user ID are required"
            });
        }

        const conversation = await pool.query(
            `
            SELECT user_one_id, user_two_id
            FROM cherychat_conversations
            WHERE id = $1
            `,
            [conversationId]
        );

        if (conversation.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Conversation not found"
            });
        }

        const chat = conversation.rows[0];

        if (
            chat.user_one_id !== userId &&
            chat.user_two_id !== userId
        ) {
            return res.status(403).json({
                success: false,
                message:
                    "You are not a member of this conversation"
            });
        }

        await pool.query(
            `
            UPDATE cherychat_messages
            SET is_read = TRUE
            WHERE conversation_id = $1
              AND sender_id <> $2
            `,
            [conversationId, userId]
        );

        res.json({
            success: true,
            message: "Messages marked as read"
        });

    } catch (error) {

        console.error(
            "VIBECHAT MARK READ ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Unable to mark messages as read"
        });
    }
});

/* =========================================================
   GROUPS
========================================================= */

/*
   CREATE GROUP

   privacy:
   public
   private

   joiningFee:
   0 = free
   > 0 = paid

   Payment provider is intentionally not connected yet.
*/

app.post("/api/groups", async (req, res) => {
    const client = await pool.connect();

    try {

        const ownerId = toId(req.body.ownerId);

        const name =
            cleanGroupName(req.body.name);

        const description =
            cleanDescription(req.body.description);

        const privacy =
            String(req.body.privacy || "public")
                .toLowerCase();

        const joiningFee =
            Number(req.body.joiningFee || 0);

        const groupPicture =
            cleanText(req.body.groupPicture, 1000000);

        if (!ownerId || !name) {
            return res.status(400).json({
                success: false,
                message:
                    "Owner ID and group name are required"
            });
        }

        if (!(await userExists(ownerId))) {
            return res.status(404).json({
                success: false,
                message: "User not found"
            });
        }

        if (
            privacy !== "public" &&
            privacy !== "private"
        ) {
            return res.status(400).json({
                success: false,
                message:
                    "Group privacy must be public or private"
            });
        }

        if (
            !Number.isFinite(joiningFee) ||
            joiningFee < 0
        ) {
            return res.status(400).json({
                success: false,
                message:
                    "Joining fee must be zero or a positive amount"
            });
        }

        if (
            privacy === "public" &&
            joiningFee > 0
        ) {
            return res.status(400).json({
                success: false,
                message:
                    "Public groups must currently be free"
            });
        }

        await client.query("BEGIN");

        let inviteCode;

        for (let attempt = 0; attempt < 5; attempt++) {

            const candidate =
                generateInviteCode();

            const check =
                await client.query(
                    `
                    SELECT id
                    FROM cherychat_groups
                    WHERE invite_code = $1
                    `,
                    [candidate]
                );

            if (check.rows.length === 0) {
                inviteCode = candidate;
                break;
            }
        }

        if (!inviteCode) {
            throw new Error(
                "Unable to generate group invite code"
            );
        }

        const groupResult =
            await client.query(
                `
                INSERT INTO cherychat_groups
                (
                    name,
                    description,
                    group_picture,
                    privacy,
                    joining_fee,
                    owner_id,
                    invite_code
                )
                VALUES
                ($1, $2, $3, $4, $5, $6, $7)
                RETURNING *
                `,
                [
                    name,
                    description,
                    groupPicture || null,
                    privacy,
                    joiningFee,
                    ownerId,
                    inviteCode
                ]
            );

        const group =
            groupResult.rows[0];

        await client.query(
            `
            INSERT INTO cherychat_group_members
            (
                group_id,
                user_id,
                role,
                membership_status,
                payment_status
            )
            VALUES
            ($1, $2, 'owner', 'active', 'not_required')
            `,
            [group.id, ownerId]
        );

        await client.query("COMMIT");

        res.status(201).json({
            success: true,
            message: "VibeChat group created successfully",

            group: {
                id: group.id,
                name: group.name,
                description: group.description,
                groupPicture: group.group_picture,
                privacy: group.privacy,
                joiningFee: Number(group.joining_fee),
                ownerId: group.owner_id,
                inviteCode: group.invite_code,
                createdAt: group.created_at
            }
        });

    } catch (error) {

        await client.query("ROLLBACK");

        console.error(
            "VIBECHAT CREATE GROUP ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message: "Unable to create group"
        });

    } finally {
        client.release();
    }
});

/* =========================================================
   DISCOVER PUBLIC GROUPS
========================================================= */

app.get("/api/groups", async (req, res) => {
    try {

        const userId =
            toId(req.query.userId);

        const q =
            cleanText(req.query.q, 100);

        const search =
            `%${q}%`;

        const result = await pool.query(
            `
            SELECT
                g.id,
                g.name,
                g.description,
                g.group_picture,
                g.privacy,
                g.joining_fee,
                g.owner_id,
                g.invite_code,
                g.created_at,

                u.full_name AS owner_name,

                COUNT(
                    CASE
                        WHEN gm.membership_status = 'active'
                        THEN 1
                    END
                ) AS member_count,

                CASE
                    WHEN EXISTS (
                        SELECT 1
                        FROM cherychat_group_members mine
                        WHERE mine.group_id = g.id
                          AND mine.user_id = $1
                          AND mine.membership_status = 'active'
                    )
                    THEN TRUE
                    ELSE FALSE
                END AS is_member

            FROM cherychat_groups g

            JOIN cherychat_users u
                ON u.id = g.owner_id

            LEFT JOIN cherychat_group_members gm
                ON gm.group_id = g.id

            WHERE
                g.privacy = 'public'
                AND
                (
                    $2 = '%%'
                    OR g.name ILIKE $2
                    OR g.description ILIKE $2
                )

            GROUP BY
                g.id,
                u.full_name

            ORDER BY
                g.created_at DESC

            LIMIT 100
            `,
            [userId || 0, search]
        );

        res.json({
            success: true,

            groups: result.rows.map(group => ({
                id: group.id,
                name: group.name,
                description: group.description,
                groupPicture: group.group_picture,
                privacy: group.privacy,
                joiningFee: Number(group.joining_fee),
                ownerId: group.owner_id,
                ownerName: group.owner_name,
                inviteCode: group.invite_code,
                memberCount:
                    Number(group.member_count),
                isMember:
                    group.is_member,
                createdAt:
                    group.created_at
            }))
        });

    } catch (error) {

        console.error(
            "VIBECHAT GROUP SEARCH ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message: "Unable to load groups"
        });
    }
});

/* =========================================================
   MY GROUPS
========================================================= */

app.get("/api/groups/my", async (req, res) => {
    try {

        const userId =
            toId(req.query.userId);

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: "Valid user ID is required"
            });
        }

        const result = await pool.query(
            `
            SELECT
                g.id,
                g.name,
                g.description,
                g.group_picture,
                g.privacy,
                g.joining_fee,
                g.owner_id,
                g.invite_code,
                g.created_at,

                gm.role,
                gm.membership_status,
                gm.payment_status,

                COUNT(
                    DISTINCT active_members.user_id
                ) AS member_count

            FROM cherychat_group_members gm

            JOIN cherychat_groups g
                ON g.id = gm.group_id

            LEFT JOIN cherychat_group_members active_members
                ON active_members.group_id = g.id
                AND active_members.membership_status = 'active'

            WHERE
                gm.user_id = $1
                AND gm.membership_status = 'active'

            GROUP BY
                g.id,
                gm.role,
                gm.membership_status,
                gm.payment_status

            ORDER BY
                g.created_at DESC
            `,
            [userId]
        );

        res.json({
            success: true,

            groups: result.rows.map(group => ({
                id: group.id,
                name: group.name,
                description: group.description,
                groupPicture: group.group_picture,
                privacy: group.privacy,
                joiningFee: Number(group.joining_fee),
                ownerId: group.owner_id,
                inviteCode: group.invite_code,
                role: group.role,
                membershipStatus:
                    group.membership_status,
                paymentStatus:
                    group.payment_status,
                memberCount:
                    Number(group.member_count),
                createdAt:
                    group.created_at
            }))
        });

    } catch (error) {

        console.error(
            "VIBECHAT MY GROUPS ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message: "Unable to load your groups"
        });
    }
});

/* =========================================================
   GET GROUP DETAILS
========================================================= */

app.get("/api/groups/:groupId", async (req, res) => {
    try {

        const groupId =
            toId(req.params.groupId);

        const userId =
            toId(req.query.userId);

        if (!groupId) {
            return res.status(400).json({
                success: false,
                message: "Valid group ID is required"
            });
        }

        const result = await pool.query(
            `
            SELECT
                g.id,
                g.name,
                g.description,
                g.group_picture,
                g.privacy,
                g.joining_fee,
                g.owner_id,
                g.invite_code,
                g.created_at,

                u.full_name AS owner_name,

                COUNT(
                    CASE
                        WHEN gm.membership_status = 'active'
                        THEN 1
                    END
                ) AS member_count,

                CASE
                    WHEN EXISTS (
                        SELECT 1
                        FROM cherychat_group_members me
                        WHERE me.group_id = g.id
                          AND me.user_id = $2
                          AND me.membership_status = 'active'
                    )
                    THEN TRUE
                    ELSE FALSE
                END AS is_member

            FROM cherychat_groups g

            JOIN cherychat_users u
                ON u.id = g.owner_id

            LEFT JOIN cherychat_group_members gm
                ON gm.group_id = g.id

            WHERE g.id = $1

            GROUP BY
                g.id,
                u.full_name
            `,
            [groupId, userId || 0]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Group not found"
            });
        }

        const group = result.rows[0];

        res.json({
            success: true,

            group: {
                id: group.id,
                name: group.name,
                description: group.description,
                groupPicture: group.group_picture,
                privacy: group.privacy,
                joiningFee: Number(group.joining_fee),
                ownerId: group.owner_id,
                ownerName: group.owner_name,
                inviteCode: group.invite_code,
                memberCount:
                    Number(group.member_count),
                isMember:
                    group.is_member,
                createdAt:
                    group.created_at
            }
        });

    } catch (error) {

        console.error(
            "VIBECHAT GROUP DETAILS ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message: "Unable to load group"
        });
    }
});

/* =========================================================
   JOIN FREE/PUBLIC GROUP
========================================================= */

app.post("/api/groups/:groupId/join", async (req, res) => {
    try {

        const groupId =
            toId(req.params.groupId);

        const userId =
            toId(req.body.userId);

        if (!groupId || !userId) {
            return res.status(400).json({
                success: false,
                message:
                    "Valid group ID and user ID are required"
            });
        }

        const groupResult = await pool.query(
            `
            SELECT
                id,
                privacy,
                joining_fee
            FROM cherychat_groups
            WHERE id = $1
            LIMIT 1
            `,
            [groupId]
        );

        if (groupResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Group not found"
            });
        }

        const group = groupResult.rows[0];

        /*
           Paid private groups cannot be joined directly.
           Payment integration will be connected later.
        */

        if (
            group.privacy === "private" &&
            Number(group.joining_fee) > 0
        ) {
            return res.status(402).json({
                success: false,
                paymentRequired: true,
                message:
                    "Payment is required before joining this private group",
                joiningFee:
                    Number(group.joining_fee),
                currency: "KES"
            });
        }

        const existing = await pool.query(
            `
            SELECT id
            FROM cherychat_group_members
            WHERE group_id = $1
              AND user_id = $2
            `,
            [groupId, userId]
        );

        if (existing.rows.length > 0) {

            await pool.query(
                `
                UPDATE cherychat_group_members
                SET
                    membership_status = 'active',
                    payment_status = 'not_required'
                WHERE group_id = $1
                  AND user_id = $2
                `,
                [groupId, userId]
            );

        } else {

            await pool.query(
                `
                INSERT INTO cherychat_group_members
                (
                    group_id,
                    user_id,
                    role,
                    membership_status,
                    payment_status
                )
                VALUES
                ($1, $2, 'member', 'active', 'not_required')
                `,
                [groupId, userId]
            );
        }

        res.json({
            success: true,
            message: "You joined the group successfully"
        });

    } catch (error) {

        console.error(
            "VIBECHAT JOIN GROUP ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message: "Unable to join group"
        });
    }
});

/* =========================================================
   REQUEST PRIVATE GROUP JOIN
========================================================= */

app.post("/api/groups/:groupId/request", async (req, res) => {
    try {

        const groupId =
            toId(req.params.groupId);

        const userId =
            toId(req.body.userId);

        if (!groupId || !userId) {
            return res.status(400).json({
                success: false,
                message:
                    "Valid group ID and user ID are required"
            });
        }

        const groupResult = await pool.query(
            `
            SELECT
                id,
                privacy,
                joining_fee
            FROM cherychat_groups
            WHERE id = $1
            LIMIT 1
            `,
            [groupId]
        );

        if (groupResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Group not found"
            });
        }

        const group = groupResult.rows[0];

        if (group.privacy !== "private") {
            return res.status(400).json({
                success: false,
                message:
                    "This is not a private group"
            });
        }

        if (Number(group.joining_fee) > 0) {

            /*
               Payment will be connected later.
            */

            const paymentResult =
                await pool.query(
                    `
                    INSERT INTO cherychat_group_payments
                    (
                        group_id,
                        user_id,
                        amount,
                        currency,
                        provider,
                        status
                    )
                    VALUES
                    ($1, $2, $3, 'KES', 'pending', 'pending')
                    RETURNING id, amount, status, created_at
                    `,
                    [
                        groupId,
                        userId,
                        Number(group.joining_fee)
                    ]
                );

            await pool.query(
                `
                INSERT INTO cherychat_group_members
                (
                    group_id,
                    user_id,
                    role,
                    membership_status,
                    payment_status
                )
                VALUES
                ($1, $2, 'member', 'pending', 'pending')

                ON CONFLICT (group_id, user_id)
                DO UPDATE SET
                    membership_status = 'pending',
                    payment_status = 'pending'
                `,
                [groupId, userId]
            );

            return res.status(202).json({
                success: true,
                paymentRequired: true,
                paymentStarted: false,
                message:
                    "Payment record created. Payment provider will be connected later.",
                payment: {
                    id:
                        paymentResult.rows[0].id,
                    amount:
                        Number(paymentResult.rows[0].amount),
                    currency: "KES",
                    status:
                        paymentResult.rows[0].status,
                    createdAt:
                        paymentResult.rows[0].created_at
                }
            });
        }

        await pool.query(
            `
            INSERT INTO cherychat_group_members
            (
                group_id,
                user_id,
                role,
                membership_status,
                payment_status
            )
            VALUES
            ($1, $2, 'member', 'pending', 'not_required')

            ON CONFLICT (group_id, user_id)
            DO UPDATE SET
                membership_status = 'pending'
            `,
            [groupId, userId]
        );

        res.status(202).json({
            success: true,
            paymentRequired: false,
            message:
                "Join request sent to the group owner"
        });

    } catch (error) {

        console.error(
            "VIBECHAT PRIVATE GROUP REQUEST ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Unable to request group access"
        });
    }
});

/* =========================================================
   GROUP INVITE
========================================================= */

app.get("/api/groups/invite/:inviteCode", async (req, res) => {
    try {

        const inviteCode =
            cleanText(
                req.params.inviteCode,
                30
            ).toUpperCase();

        const result = await pool.query(
            `
            SELECT
                g.id,
                g.name,
                g.description,
                g.group_picture,
                g.privacy,
                g.joining_fee,
                g.owner_id,
                u.full_name AS owner_name,

                COUNT(
                    CASE
                        WHEN gm.membership_status = 'active'
                        THEN 1
                    END
                ) AS member_count

            FROM cherychat_groups g

            JOIN cherychat_users u
                ON u.id = g.owner_id

            LEFT JOIN cherychat_group_members gm
                ON gm.group_id = g.id

            WHERE g.invite_code = $1

            GROUP BY
                g.id,
                u.full_name
            `,
            [inviteCode]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Invalid group invite"
            });
        }

        const group = result.rows[0];

        res.json({
            success: true,

            group: {
                id: group.id,
                name: group.name,
                description: group.description,
                groupPicture: group.group_picture,
                privacy: group.privacy,
                joiningFee:
                    Number(group.joining_fee),
                ownerId: group.owner_id,
                ownerName: group.owner_name,
                memberCount:
                    Number(group.member_count)
            }
        });

    } catch (error) {

        console.error(
            "VIBECHAT GROUP INVITE ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Unable to load group invite"
        });
    }
});

/* =========================================================
   GROUP MEMBERS
========================================================= */

app.get("/api/groups/:groupId/members", async (req, res) => {
    try {

        const groupId =
            toId(req.params.groupId);

        const userId =
            toId(req.query.userId);

        if (!groupId || !userId) {
            return res.status(400).json({
                success: false,
                message:
                    "Valid group ID and user ID are required"
            });
        }

        const access = await pool.query(
            `
            SELECT role, membership_status
            FROM cherychat_group_members
            WHERE group_id = $1
              AND user_id = $2
              AND membership_status = 'active'
            `,
            [groupId, userId]
        );

        if (access.rows.length === 0) {
            return res.status(403).json({
                success: false,
                message:
                    "You are not a member of this group"
            });
        }

        const result = await pool.query(
            `
            SELECT
                gm.user_id,
                gm.role,
                gm.membership_status,
                gm.payment_status,
                gm.joined_at,

                u.full_name,
                u.profile_picture,
                u.about,
                u.is_online,
                u.last_seen

            FROM cherychat_group_members gm

            JOIN cherychat_users u
                ON u.id = gm.user_id

            WHERE gm.group_id = $1
              AND gm.membership_status = 'active'

            ORDER BY
                CASE
                    WHEN gm.role = 'owner'
                    THEN 1
                    WHEN gm.role = 'admin'
                    THEN 2
                    ELSE 3
                END,
                u.full_name ASC
            `,
            [groupId]
        );

        res.json({
            success: true,

            members: result.rows.map(member => ({
                userId: member.user_id,
                fullName: member.full_name,
                profilePicture:
                    member.profile_picture,
                about: member.about,
                isOnline: member.is_online,
                lastSeen: member.last_seen,
                role: member.role,
                membershipStatus:
                    member.membership_status,
                paymentStatus:
                    member.payment_status,
                joinedAt:
                    member.joined_at
            }))
        });

    } catch (error) {

        console.error(
            "VIBECHAT GROUP MEMBERS ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Unable to load group members"
        });
    }
});

/* =========================================================
   GROUP MESSAGES
========================================================= */

app.post("/api/groups/:groupId/messages", async (req, res) => {
    try {

        const groupId =
            toId(req.params.groupId);

        const senderId =
            toId(req.body.senderId);

        const message =
            cleanText(req.body.message, 5000);

        if (!groupId || !senderId || !message) {
            return res.status(400).json({
                success: false,
                message:
                    "Group ID, sender ID and message are required"
            });
        }

        const member = await pool.query(
            `
            SELECT id
            FROM cherychat_group_members
            WHERE group_id = $1
              AND user_id = $2
              AND membership_status = 'active'
            LIMIT 1
            `,
            [groupId, senderId]
        );

        if (member.rows.length === 0) {
            return res.status(403).json({
                success: false,
                message:
                    "Only group members can send messages"
            });
        }

        const result = await pool.query(
            `
            INSERT INTO cherychat_group_messages
            (
                group_id,
                sender_id,
                message_text
            )
            VALUES
            ($1, $2, $3)

            RETURNING
                id,
                group_id,
                sender_id,
                message_text,
                created_at
            `,
            [
                groupId,
                senderId,
                message
            ]
        );

        const saved = result.rows[0];

        const sender = await pool.query(
            `
            SELECT
                full_name,
                profile_picture
            FROM cherychat_users
            WHERE id = $1
            `,
            [senderId]
        );

        res.status(201).json({
            success: true,

            message: {
                id: saved.id,
                groupId: saved.group_id,
                senderId: saved.sender_id,
                senderName:
                    sender.rows[0]?.full_name || "",
                senderPicture:
                    sender.rows[0]?.profile_picture || null,
                message:
                    saved.message_text,
                createdAt:
                    saved.created_at
            }
        });

    } catch (error) {

        console.error(
            "VIBECHAT GROUP SEND MESSAGE ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Unable to send group message"
        });
    }
});

/* =========================================================
   GET GROUP MESSAGES
========================================================= */

app.get("/api/groups/:groupId/messages", async (req, res) => {
    try {

        const groupId =
            toId(req.params.groupId);

        const userId =
            toId(req.query.userId);

        if (!groupId || !userId) {
            return res.status(400).json({
                success: false,
                message:
                    "Valid group ID and user ID are required"
            });
        }

        const member = await pool.query(
            `
            SELECT id
            FROM cherychat_group_members
            WHERE group_id = $1
              AND user_id = $2
              AND membership_status = 'active'
            LIMIT 1
            `,
            [groupId, userId]
        );

        if (member.rows.length === 0) {
            return res.status(403).json({
                success: false,
                message:
                    "Only group members can view messages"
            });
        }

        const result = await pool.query(
            `
            SELECT
                gm.id,
                gm.group_id,
                gm.sender_id,
                u.full_name AS sender_name,
                u.profile_picture AS sender_picture,
                gm.message_text,
                gm.created_at

            FROM cherychat_group_messages gm

            JOIN cherychat_users u
                ON u.id = gm.sender_id

            WHERE gm.group_id = $1

            ORDER BY
                gm.created_at ASC,
                gm.id ASC
            `,
            [groupId]
        );

        res.json({
            success: true,

            messages: result.rows.map(message => ({
                id: message.id,
                groupId: message.group_id,
                senderId: message.sender_id,
                senderName: message.sender_name,
                senderPicture:
                    message.sender_picture,
                message:
                    message.message_text,
                createdAt:
                    message.created_at
            }))
        });

    } catch (error) {

        console.error(
            "VIBECHAT GROUP GET MESSAGES ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Unable to load group messages"
        });
    }
});

/* =========================================================
   LEAVE GROUP
========================================================= */

app.post("/api/groups/:groupId/leave", async (req, res) => {
    try {

        const groupId =
            toId(req.params.groupId);

        const userId =
            toId(req.body.userId);

        if (!groupId || !userId) {
            return res.status(400).json({
                success: false,
                message:
                    "Valid group ID and user ID are required"
            });
        }

        const member = await pool.query(
            `
            SELECT role
            FROM cherychat_group_members
            WHERE group_id = $1
              AND user_id = $2
              AND membership_status = 'active'
            `,
            [groupId, userId]
        );

        if (member.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message:
                    "You are not an active member of this group"
            });
        }

        if (member.rows[0].role === "owner") {
            return res.status(400).json({
                success: false,
                message:
                    "The group owner cannot leave. Transfer ownership or delete the group."
            });
        }

        await pool.query(
            `
            UPDATE cherychat_group_members
            SET membership_status = 'removed'
            WHERE group_id = $1
              AND user_id = $2
            `,
            [groupId, userId]
        );

        res.json({
            success: true,
            message: "You left the group"
        });

    } catch (error) {

        console.error(
            "VIBECHAT LEAVE GROUP ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message: "Unable to leave group"
        });
    }
});

/* =========================================================
   DELETE GROUP
========================================================= */

app.delete("/api/groups/:groupId", async (req, res) => {
    try {

        const groupId =
            toId(req.params.groupId);

        const ownerId =
            toId(req.body.ownerId);

        if (!groupId || !ownerId) {
            return res.status(400).json({
                success: false,
                message:
                    "Valid group ID and owner ID are required"
            });
        }

        const result = await pool.query(
            `
            DELETE FROM cherychat_groups
            WHERE id = $1
              AND owner_id = $2
            RETURNING id
            `,
            [groupId, ownerId]
        );

        if (result.rows.length === 0) {
            return res.status(403).json({
                success: false,
                message:
                    "Only the group owner can delete this group"
            });
        }

        res.json({
            success: true,
            message: "Group deleted successfully"
        });

    } catch (error) {

        console.error(
            "VIBECHAT DELETE GROUP ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message: "Unable to delete group"
        });
    }
});

/* =========================================================
   ADMIN / OWNER: REMOVE MEMBER
========================================================= */

app.post("/api/groups/:groupId/remove-member", async (req, res) => {
    try {

        const groupId =
            toId(req.params.groupId);

        const actorId =
            toId(req.body.actorId);

        const targetUserId =
            toId(req.body.targetUserId);

        if (!groupId || !actorId || !targetUserId) {
            return res.status(400).json({
                success: false,
                message:
                    "Valid group, actor and target user IDs are required"
            });
        }

        const actor = await pool.query(
            `
            SELECT role
            FROM cherychat_group_members
            WHERE group_id = $1
              AND user_id = $2
              AND membership_status = 'active'
            `,
            [groupId, actorId]
        );

        if (actor.rows.length === 0) {
            return res.status(403).json({
                success: false,
                message:
                    "You are not a member of this group"
            });
        }

        if (
            actor.rows[0].role !== "owner" &&
            actor.rows[0].role !== "admin"
        ) {
            return res.status(403).json({
                success: false,
                message:
                    "Only the owner or an admin can remove members"
            });
        }

        const target = await pool.query(
            `
            SELECT role
            FROM cherychat_group_members
            WHERE group_id = $1
              AND user_id = $2
              AND membership_status = 'active'
            `,
            [groupId, targetUserId]
        );

        if (target.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Member not found"
            });
        }

        if (target.rows[0].role === "owner") {
            return res.status(400).json({
                success: false,
                message:
                    "The group owner cannot be removed"
            });
        }

        if (
            target.rows[0].role === "admin" &&
            actor.rows[0].role !== "owner"
        ) {
            return res.status(403).json({
                success: false,
                message:
                    "Only the owner can remove an admin"
            });
        }

        await pool.query(
            `
            UPDATE cherychat_group_members
            SET membership_status = 'removed'
            WHERE group_id = $1
              AND user_id = $2
            `,
            [groupId, targetUserId]
        );

        res.json({
            success: true,
            message: "Member removed from group"
        });

    } catch (error) {

        console.error(
            "VIBECHAT REMOVE MEMBER ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Unable to remove member"
        });
    }
});

/* =========================================================
   OWNER: MAKE ADMIN
========================================================= */

app.post("/api/groups/:groupId/make-admin", async (req, res) => {
    try {

        const groupId =
            toId(req.params.groupId);

        const ownerId =
            toId(req.body.ownerId);

        const targetUserId =
            toId(req.body.targetUserId);

        if (!groupId || !ownerId || !targetUserId) {
            return res.status(400).json({
                success: false,
                message:
                    "Valid IDs are required"
            });
        }

        const owner = await pool.query(
            `
            SELECT role
            FROM cherychat_group_members
            WHERE group_id = $1
              AND user_id = $2
              AND membership_status = 'active'
            `,
            [groupId, ownerId]
        );

        if (
            owner.rows.length === 0 ||
            owner.rows[0].role !== "owner"
        ) {
            return res.status(403).json({
                success: false,
                message:
                    "Only the group owner can manage admins"
            });
        }

        const result = await pool.query(
            `
            UPDATE cherychat_group_members
            SET role = 'admin'
            WHERE group_id = $1
              AND user_id = $2
              AND membership_status = 'active'
              AND role <> 'owner'
            RETURNING user_id, role
            `,
            [groupId, targetUserId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message:
                    "Active group member not found"
            });
        }

        res.json({
            success: true,
            message: "Member promoted to admin"
        });

    } catch (error) {

        console.error(
            "VIBECHAT MAKE ADMIN ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Unable to promote member"
        });
    }
});

/* =========================================================
   OWNER: REMOVE ADMIN
========================================================= */

app.post("/api/groups/:groupId/remove-admin", async (req, res) => {
    try {

        const groupId =
            toId(req.params.groupId);

        const ownerId =
            toId(req.body.ownerId);

        const targetUserId =
            toId(req.body.targetUserId);

        if (!groupId || !ownerId || !targetUserId) {
            return res.status(400).json({
                success: false,
                message:
                    "Valid IDs are required"
            });
        }

        const owner = await pool.query(
            `
            SELECT role
            FROM cherychat_group_members
            WHERE group_id = $1
              AND user_id = $2
              AND membership_status = 'active'
            `,
            [groupId, ownerId]
        );

        if (
            owner.rows.length === 0 ||
            owner.rows[0].role !== "owner"
        ) {
            return res.status(403).json({
                success: false,
                message:
                    "Only the group owner can manage admins"
            });
        }

        const result = await pool.query(
            `
            UPDATE cherychat_group_members
            SET role = 'member'
            WHERE group_id = $1
              AND user_id = $2
              AND role = 'admin'
            RETURNING user_id
            `,
            [groupId, targetUserId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message:
                    "Admin not found"
            });
        }

        res.json({
            success: true,
            message: "Admin role removed"
        });

    } catch (error) {

        console.error(
            "VIBECHAT REMOVE ADMIN ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Unable to remove admin role"
        });
    }
});

/* =========================================================
   OWNER: UPDATE GROUP
========================================================= */

app.put("/api/groups/:groupId", async (req, res) => {
    try {

        const groupId =
            toId(req.params.groupId);

        const ownerId =
            toId(req.body.ownerId);

        if (!groupId || !ownerId) {
            return res.status(400).json({
                success: false,
                message:
                    "Valid group ID and owner ID are required"
            });
        }

        const existing = await pool.query(
            `
            SELECT *
            FROM cherychat_groups
            WHERE id = $1
              AND owner_id = $2
            LIMIT 1
            `,
            [groupId, ownerId]
        );

        if (existing.rows.length === 0) {
            return res.status(403).json({
                success: false,
                message:
                    "Only the group owner can edit the group"
            });
        }

        const oldGroup = existing.rows[0];

        const name =
            req.body.name !== undefined
                ? cleanGroupName(req.body.name)
                : oldGroup.name;

        const description =
            req.body.description !== undefined
                ? cleanDescription(req.body.description)
                : oldGroup.description;

        const privacy =
            req.body.privacy !== undefined
                ? String(req.body.privacy).toLowerCase()
                : oldGroup.privacy;

        const joiningFee =
            req.body.joiningFee !== undefined
                ? Number(req.body.joiningFee)
                : Number(oldGroup.joining_fee);

        const groupPicture =
            req.body.groupPicture !== undefined
                ? cleanText(req.body.groupPicture, 1000000)
                : oldGroup.group_picture;

        if (!name) {
            return res.status(400).json({
                success: false,
                message:
                    "Group name cannot be empty"
            });
        }

        if (
            privacy !== "public" &&
            privacy !== "private"
        ) {
            return res.status(400).json({
                success: false,
                message:
                    "Privacy must be public or private"
            });
        }

        if (
            !Number.isFinite(joiningFee) ||
            joiningFee < 0
        ) {
            return res.status(400).json({
                success: false,
                message:
                    "Joining fee must be zero or positive"
            });
        }

        if (
            privacy === "public" &&
            joiningFee > 0
        ) {
            return res.status(400).json({
                success: false,
                message:
                    "Public groups must currently be free"
            });
        }

        const result = await pool.query(
            `
            UPDATE cherychat_groups
            SET
                name = $1,
                description = $2,
                group_picture = $3,
                privacy = $4,
                joining_fee = $5,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $6
              AND owner_id = $7
            RETURNING *
            `,
            [
                name,
                description,
                groupPicture || null,
                privacy,
                joiningFee,
                groupId,
                ownerId
            ]
        );

        const group = result.rows[0];

        res.json({
            success: true,
            message: "Group updated successfully",

            group: {
                id: group.id,
                name: group.name,
                description: group.description,
                groupPicture: group.group_picture,
                privacy: group.privacy,
                joiningFee:
                    Number(group.joining_fee),
                ownerId: group.owner_id,
                inviteCode:
                    group.invite_code,
                updatedAt:
                    group.updated_at
            }
        });

    } catch (error) {

        console.error(
            "VIBECHAT UPDATE GROUP ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message:
                "Unable to update group"
        });
    }
});

/* =========================================================
   SERVER
========================================================= */

const PORT =
    process.env.PORT || 3000;

async function startServer() {

    await initializeDatabase();

    app.listen(PORT, () => {

        console.log(
            `VibeChat Backend running on port ${PORT}`
        );

    });
}

startServer();
