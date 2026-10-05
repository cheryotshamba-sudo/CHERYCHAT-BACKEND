const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

const app = express();

app.use(cors());
app.use(express.json({ limit: "15mb" }));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL
        ? { rejectUnauthorized: false }
        : false
});

/* =========================================================
   DATABASE
========================================================= */

async function setupDatabase() {
    try {
        await pool.query(`
            CREATE TABLE IF NOT EXISTS cherychat_users (
                id SERIAL PRIMARY KEY,
                full_name TEXT NOT NULL,
                email TEXT UNIQUE,
                phone TEXT UNIQUE,
                password_hash TEXT NOT NULL,
                profile_picture TEXT,
                about TEXT DEFAULT 'using VibeChat',
                is_online BOOLEAN DEFAULT FALSE,
                last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS cherychat_conversations (
                id SERIAL PRIMARY KEY,
                user_one INTEGER NOT NULL,
                user_two INTEGER NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                CONSTRAINT different_users CHECK (user_one <> user_two),
                CONSTRAINT unique_conversation UNIQUE (user_one, user_two)
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS cherychat_messages (
                id SERIAL PRIMARY KEY,
                conversation_id INTEGER NOT NULL,
                sender_id INTEGER NOT NULL,
                receiver_id INTEGER NOT NULL,
                message_text TEXT NOT NULL,
                is_read BOOLEAN DEFAULT FALSE,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS cherychat_groups (
                id SERIAL PRIMARY KEY,
                name TEXT NOT NULL,
                description TEXT DEFAULT '',
                group_picture TEXT,
                creator_id INTEGER NOT NULL,
                is_private BOOLEAN DEFAULT FALSE,
                join_fee NUMERIC DEFAULT 0,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS cherychat_group_members (
                id SERIAL PRIMARY KEY,
                group_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                role TEXT DEFAULT 'member',
                joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(group_id, user_id)
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS cherychat_group_messages (
                id SERIAL PRIMARY KEY,
                group_id INTEGER NOT NULL,
                sender_id INTEGER NOT NULL,
                message_text TEXT NOT NULL,
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS cherychat_group_requests (
                id SERIAL PRIMARY KEY,
                group_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                status TEXT DEFAULT 'pending',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(group_id, user_id)
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS cherychat_stories (
                id SERIAL PRIMARY KEY,
                user_id INTEGER NOT NULL,
                media_type TEXT NOT NULL,
                media_data TEXT NOT NULL,
                caption TEXT DEFAULT '',
                created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                expires_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '24 hours')
            );
        `);

        await pool.query(`
            CREATE TABLE IF NOT EXISTS cherychat_story_views (
                id SERIAL PRIMARY KEY,
                story_id INTEGER NOT NULL,
                user_id INTEGER NOT NULL,
                viewed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
                UNIQUE(story_id, user_id)
            );
        `);

        console.log("VibeChat database ready.");
    } catch (error) {
        console.error("Database setup error:", error);
    }
}

setupDatabase();

/* =========================================================
   HELPERS
========================================================= */

function validId(value) {
    const id = Number(value);
    return Number.isInteger(id) && id > 0;
}

function clean(value) {
    return String(value || "").trim();
}

/* =========================================================
   ROOT
========================================================= */

app.get("/", (req, res) => {
    res.json({
        success: true,
        message: "VibeChat API is working."
    });
});

app.get("/api/test", (req, res) => {
    res.json({
        success: true,
        message: "VibeChat backend is working."
    });
});

app.get("/health", async (req, res) => {
    try {
        await pool.query("SELECT 1");

        res.json({
            success: true,
            status: "healthy",
            service: "VibeChat API"
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            status: "unhealthy"
        });
    }
});

/* =========================================================
   REGISTER
========================================================= */

app.post("/api/register", async (req, res) => {
    try {
        const fullName = clean(
            req.body.full_name || req.body.fullName
        );

        const email = clean(
            req.body.email
        ).toLowerCase();

        const phone = clean(
            req.body.phone
        );

        const password = String(
            req.body.password || ""
        );

        if (!fullName) {
            return res.status(400).json({
                success: false,
                message: "Full name is required."
            });
        }

        if (!email && !phone) {
            return res.status(400).json({
                success: false,
                message: "Email or phone number is required."
            });
        }

        if (password.length < 6) {
            return res.status(400).json({
                success: false,
                message: "Password must be at least 6 characters."
            });
        }

        const existing = await pool.query(
            `
            SELECT id
            FROM cherychat_users
            WHERE
                ($1 <> '' AND email = $1)
                OR
                ($2 <> '' AND phone = $2)
            LIMIT 1
            `,
            [email, phone]
        );

        if (existing.rows.length) {
            return res.status(409).json({
                success: false,
                message: "Email or phone number is already registered."
            });
        }

        const hash = await bcrypt.hash(password, 10);

        const result = await pool.query(
            `
            INSERT INTO cherychat_users
            (
                full_name,
                email,
                phone,
                password_hash,
                about
            )
            VALUES ($1,$2,$3,$4,$5)
            RETURNING
                id,
                full_name,
                email,
                phone,
                profile_picture,
                about,
                is_online,
                last_seen,
                created_at
            `,
            [
                fullName,
                email || null,
                phone || null,
                hash,
                "using VibeChat"
            ]
        );

        res.status(201).json({
            success: true,
            message: "VibeChat account created successfully.",
            user: result.rows[0]
        });
    } catch (error) {
        console.error("Register error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to create account."
        });
    }
});

/* =========================================================
   LOGIN
========================================================= */

app.post("/api/login", async (req, res) => {
    try {
        const identifier = clean(
            req.body.email ||
            req.body.phone ||
            req.body.identifier
        ).toLowerCase();

        const password = String(
            req.body.password || ""
        );

        if (!identifier || !password) {
            return res.status(400).json({
                success: false,
                message: "Email/phone and password are required."
            });
        }

        const result = await pool.query(
            `
            SELECT *
            FROM cherychat_users
            WHERE email = $1 OR phone = $1
            LIMIT 1
            `,
            [identifier]
        );

        if (!result.rows.length) {
            return res.status(401).json({
                success: false,
                message: "Invalid login details."
            });
        }

        const user = result.rows[0];

        const correct = await bcrypt.compare(
            password,
            user.password_hash
        );

        if (!correct) {
            return res.status(401).json({
                success: false,
                message: "Invalid login details."
            });
        }

        await pool.query(
            `
            UPDATE cherychat_users
            SET is_online = TRUE,
                last_seen = CURRENT_TIMESTAMP
            WHERE id = $1
            `,
            [user.id]
        );

        delete user.password_hash;

        res.json({
            success: true,
            message: "Login successful.",
            user
        });
    } catch (error) {
        console.error("Login error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to login."
        });
    }
});

/* =========================================================
   USER SEARCH
========================================================= */

app.get("/api/users/search", async (req, res) => {
    try {
        const q = clean(req.query.q);
        const currentUserId = Number(
            req.query.userId || 0
        );

        if (!q) {
            return res.json({
                success: true,
                users: []
            });
        }

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
                (
                    full_name ILIKE $1
                    OR email ILIKE $1
                    OR phone ILIKE $1
                )
                AND
                ($2 = 0 OR id <> $2)
            ORDER BY full_name
            LIMIT 50
            `,
            [
                `%${q}%`,
                currentUserId
            ]
        );

        res.json({
            success: true,
            users: result.rows
        });
    } catch (error) {
        console.error("Search error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to search users."
        });
    }
});

/* =========================================================
   GET USER
========================================================= */

app.get("/api/users/:id", async (req, res) => {
    try {
        const id = Number(req.params.id);

        if (!validId(id)) {
            return res.status(400).json({
                success: false,
                message: "Valid user ID is required."
            });
        }

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
                last_seen,
                created_at
            FROM cherychat_users
            WHERE id = $1
            `,
            [id]
        );

        if (!result.rows.length) {
            return res.status(404).json({
                success: false,
                message: "User not found."
            });
        }

        res.json({
            success: true,
            user: result.rows[0]
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Unable to load user."
        });
    }
});

/* =========================================================
   ONLINE
========================================================= */

app.put("/api/users/:id/online", async (req, res) => {
    try {
        const id = Number(req.params.id);

        if (!validId(id)) {
            return res.status(400).json({
                success: false,
                message: "Valid user ID is required."
            });
        }

        await pool.query(
            `
            UPDATE cherychat_users
            SET is_online = TRUE,
                last_seen = CURRENT_TIMESTAMP
            WHERE id = $1
            `,
            [id]
        );

        res.json({
            success: true,
            online: true
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Unable to update status."
        });
    }
});

/* =========================================================
   OFFLINE
========================================================= */

app.put("/api/users/:id/offline", async (req, res) => {
    try {
        const id = Number(req.params.id);

        if (!validId(id)) {
            return res.status(400).json({
                success: false,
                message: "Valid user ID is required."
            });
        }

        await pool.query(
            `
            UPDATE cherychat_users
            SET is_online = FALSE,
                last_seen = CURRENT_TIMESTAMP
            WHERE id = $1
            `,
            [id]
        );

        res.json({
            success: true,
            online: false
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Unable to update status."
        });
    }
});

/* =========================================================
   PROFILE
========================================================= */

app.put("/api/users/:id/profile", async (req, res) => {
    try {
        const id = Number(req.params.id);

        const fullName = clean(
            req.body.fullName ||
            req.body.full_name
        );

        const about =
            req.body.about !== undefined
                ? String(req.body.about)
                : null;

        if (!validId(id)) {
            return res.status(400).json({
                success: false,
                message: "Valid user ID is required."
            });
        }

        if (!fullName) {
            return res.status(400).json({
                success: false,
                message: "Name cannot be empty."
            });
        }

        const result = await pool.query(
            `
            UPDATE cherychat_users
            SET
                full_name = $1,
                about = COALESCE($2, about)
            WHERE id = $3
            RETURNING
                id,
                full_name,
                email,
                phone,
                profile_picture,
                about,
                is_online,
                last_seen,
                created_at
            `,
            [
                fullName,
                about,
                id
            ]
        );

        if (!result.rows.length) {
            return res.status(404).json({
                success: false,
                message: "User not found."
            });
        }

        res.json({
            success: true,
            user: result.rows[0]
        });
    } catch (error) {
        console.error("Profile error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to update profile."
        });
    }
});

/* =========================================================
   PROFILE PICTURE
========================================================= */

app.put(
    "/api/users/:id/profile-picture",
    async (req, res) => {
        try {
            const id = Number(req.params.id);

            const picture =
                req.body.profilePicture ||
                req.body.profile_picture;

            if (!validId(id)) {
                return res.status(400).json({
                    success: false,
                    message: "Valid user ID is required."
                });
            }

            if (!picture) {
                return res.status(400).json({
                    success: false,
                    message: "Profile picture is required."
                });
            }

            const result = await pool.query(
                `
                UPDATE cherychat_users
                SET profile_picture = $1
                WHERE id = $2
                RETURNING
                    id,
                    full_name,
                    email,
                    phone,
                    profile_picture,
                    about,
                    is_online,
                    last_seen,
                    created_at
                `,
                [picture, id]
            );

            if (!result.rows.length) {
                return res.status(404).json({
                    success: false,
                    message: "User not found."
                });
            }

            res.json({
                success: true,
                user: result.rows[0]
            });
        } catch (error) {
            console.error("Picture error:", error);

            res.status(500).json({
                success: false,
                message: "Unable to update profile picture."
            });
        }
    }
);

/* =========================================================
   CONVERSATION
========================================================= */

app.post("/api/conversations", async (req, res) => {
    try {
        const userId = Number(
            req.body.userId
        );

        const otherUserId = Number(
            req.body.otherUserId
        );

        if (
            !validId(userId) ||
            !validId(otherUserId)
        ) {
            return res.status(400).json({
                success: false,
                message: "Valid user IDs are required."
            });
        }

        if (userId === otherUserId) {
            return res.status(400).json({
                success: false,
                message: "You cannot chat with yourself."
            });
        }

        const one = Math.min(
            userId,
            otherUserId
        );

        const two = Math.max(
            userId,
            otherUserId
        );

        const existing = await pool.query(
            `
            SELECT *
            FROM cherychat_conversations
            WHERE user_one = $1
            AND user_two = $2
            LIMIT 1
            `,
            [one, two]
        );

        if (existing.rows.length) {
            return res.json({
                success: true,
                conversation: existing.rows[0]
            });
        }

        const result = await pool.query(
            `
            INSERT INTO cherychat_conversations
            (user_one, user_two)
            VALUES ($1,$2)
            RETURNING *
            `,
            [one, two]
        );

        res.json({
            success: true,
            conversation: result.rows[0]
        });
    } catch (error) {
        console.error("Conversation error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to create conversation."
        });
    }
});

/* =========================================================
   LIST CONVERSATIONS
========================================================= */

app.get("/api/conversations", async (req, res) => {
    try {
        const id = Number(
            req.query.userId
        );

        if (!validId(id)) {
            return res.status(400).json({
                success: false,
                message: "Valid user ID is required."
            });
        }

        const result = await pool.query(
            `
            SELECT
                c.id AS conversation_id,

                CASE
                    WHEN c.user_one = $1
                    THEN u2.id
                    ELSE u1.id
                END AS other_user_id,

                CASE
                    WHEN c.user_one = $1
                    THEN u2.full_name
                    ELSE u1.full_name
                END AS other_user_name,

                CASE
                    WHEN c.user_one = $1
                    THEN u2.profile_picture
                    ELSE u1.profile_picture
                END AS other_user_picture,

                CASE
                    WHEN c.user_one = $1
                    THEN u2.about
                    ELSE u1.about
                END AS other_user_about,

                CASE
                    WHEN c.user_one = $1
                    THEN u2.is_online
                    ELSE u1.is_online
                END AS other_user_online,

                CASE
                    WHEN c.user_one = $1
                    THEN u2.last_seen
                    ELSE u1.last_seen
                END AS other_user_last_seen,

                m.message_text AS last_message,
                m.created_at AS last_message_time

            FROM cherychat_conversations c

            JOIN cherychat_users u1
                ON u1.id = c.user_one

            JOIN cherychat_users u2
                ON u2.id = c.user_two

            LEFT JOIN LATERAL (
                SELECT
                    message_text,
                    created_at
                FROM cherychat_messages
                WHERE conversation_id = c.id
                ORDER BY created_at DESC
                LIMIT 1
            ) m ON TRUE

            WHERE
                c.user_one = $1
                OR c.user_two = $1

            ORDER BY
                COALESCE(
                    m.created_at,
                    c.created_at
                ) DESC
            `,
            [id]
        );

        const conversations =
            result.rows.map(row => ({
                conversationId:
                    row.conversation_id,

                otherUser: {
                    id: row.other_user_id,
                    fullName:
                        row.other_user_name,
                    profilePicture:
                        row.other_user_picture,
                    about:
                        row.other_user_about,
                    isOnline:
                        row.other_user_online,
                    lastSeen:
                        row.other_user_last_seen
                },

                lastMessage:
                    row.last_message,

                lastMessageTime:
                    row.last_message_time
            }));

        res.json({
            success: true,
            conversations
        });
    } catch (error) {
        console.error("Conversations error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to load conversations."
        });
    }
});

/* =========================================================
   PRIVATE MESSAGES
========================================================= */

app.get("/api/messages", async (req, res) => {
    try {
        const userId = Number(
            req.query.userId
        );

        const otherUserId = Number(
            req.query.otherUserId
        );

        if (
            !validId(userId) ||
            !validId(otherUserId)
        ) {
            return res.status(400).json({
                success: false,
                message: "Valid user IDs are required."
            });
        }

        const one = Math.min(
            userId,
            otherUserId
        );

        const two = Math.max(
            userId,
            otherUserId
        );

        const conversation =
            await pool.query(
                `
                SELECT id
                FROM cherychat_conversations
                WHERE user_one = $1
                AND user_two = $2
                LIMIT 1
                `,
                [one, two]
            );

        if (!conversation.rows.length) {
            return res.json({
                success: true,
                messages: []
            });
        }

        const conversationId =
            conversation.rows[0].id;

        const result = await pool.query(
            `
            SELECT
                id,
                conversation_id,
                sender_id,
                receiver_id,
                message_text,
                is_read,
                created_at
            FROM cherychat_messages
            WHERE conversation_id = $1
            ORDER BY created_at ASC
            `,
            [conversationId]
        );

        res.json({
            success: true,
            messages: result.rows
        });
    } catch (error) {
        console.error("Messages error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to load messages."
        });
    }
});

/* =========================================================
   SEND PRIVATE MESSAGE
========================================================= */

app.post("/api/messages", async (req, res) => {
    try {
        const senderId = Number(
            req.body.senderId
        );

        const receiverId = Number(
            req.body.receiverId
        );

        const messageText = clean(
            req.body.messageText ||
            req.body.message ||
            req.body.text
        );

        if (
            !validId(senderId) ||
            !validId(receiverId)
        ) {
            return res.status(400).json({
                success: false,
                message: "Valid sender and receiver IDs are required."
            });
        }

        if (!messageText) {
            return res.status(400).json({
                success: false,
                message: "Message cannot be empty."
            });
        }

        const one = Math.min(
            senderId,
            receiverId
        );

        const two = Math.max(
            senderId,
            receiverId
        );

        let conversation =
            await pool.query(
                `
                SELECT id
                FROM cherychat_conversations
                WHERE user_one = $1
                AND user_two = $2
                LIMIT 1
                `,
                [one, two]
            );

        let conversationId;

        if (!conversation.rows.length) {
            const created =
                await pool.query(
                    `
                    INSERT INTO cherychat_conversations
                    (user_one,user_two)
                    VALUES ($1,$2)
                    RETURNING id
                    `,
                    [one, two]
                );

            conversationId =
                created.rows[0].id;
        } else {
            conversationId =
                conversation.rows[0].id;
        }

        const result = await pool.query(
            `
            INSERT INTO cherychat_messages
            (
                conversation_id,
                sender_id,
                receiver_id,
                message_text
            )
            VALUES ($1,$2,$3,$4)
            RETURNING *
            `,
            [
                conversationId,
                senderId,
                receiverId,
                messageText
            ]
        );

        res.status(201).json({
            success: true,
            message: result.rows[0]
        });
    } catch (error) {
        console.error("Send message error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to send message."
        });
    }
});

/* =========================================================
   READ MESSAGES
========================================================= */

app.put("/api/messages/read", async (req, res) => {
    try {
        const userId = Number(
            req.body.userId
        );

        const otherUserId = Number(
            req.body.otherUserId
        );

        if (
            !validId(userId) ||
            !validId(otherUserId)
        ) {
            return res.status(400).json({
                success: false,
                message: "Valid user IDs are required."
            });
        }

        const one = Math.min(
            userId,
            otherUserId
        );

        const two = Math.max(
            userId,
            otherUserId
        );

        await pool.query(
            `
            UPDATE cherychat_messages m
            SET is_read = TRUE
            FROM cherychat_conversations c
            WHERE
                m.conversation_id = c.id
                AND c.user_one = $1
                AND c.user_two = $2
                AND m.receiver_id = $3
            `,
            [
                one,
                two,
                userId
            ]
        );

        res.json({
            success: true
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Unable to mark messages as read."
        });
    }
});

/* =========================================================
   GROUPS
========================================================= */

app.get("/api/groups", async (req, res) => {
    try {
        const q = clean(req.query.q);
        const userId = Number(
            req.query.userId || 0
        );

        let result;

        if (q) {
            result = await pool.query(
                `
                SELECT
                    g.*,
                    u.full_name AS creator_name,
                    COUNT(gm.id)::INTEGER AS member_count
                FROM cherychat_groups g
                LEFT JOIN cherychat_users u
                    ON u.id = g.creator_id
                LEFT JOIN cherychat_group_members gm
                    ON gm.group_id = g.id
                WHERE
                    g.name ILIKE $1
                    OR g.description ILIKE $1
                GROUP BY g.id, u.full_name
                ORDER BY g.created_at DESC
                `,
                [`%${q}%`]
            );
        } else {
            result = await pool.query(
                `
                SELECT
                    g.*,
                    u.full_name AS creator_name,
                    COUNT(gm.id)::INTEGER AS member_count
                FROM cherychat_groups g
                LEFT JOIN cherychat_users u
                    ON u.id = g.creator_id
                LEFT JOIN cherychat_group_members gm
                    ON gm.group_id = g.id
                GROUP BY g.id, u.full_name
                ORDER BY g.created_at DESC
                `
            );
        }

        res.json({
            success: true,
            groups: result.rows
        });
    } catch (error) {
        console.error("Groups error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to load groups."
        });
    }
});

/* =========================================================
   MY GROUPS
========================================================= */

app.get("/api/groups/my", async (req, res) => {
    try {
        const userId = Number(
            req.query.userId
        );

        if (!validId(userId)) {
            return res.status(400).json({
                success: false,
                message: "Valid user ID is required."
            });
        }

        const result = await pool.query(
            `
            SELECT
                g.*,
                gm.role,
                COUNT(allm.id)::INTEGER AS member_count
            FROM cherychat_groups g
            JOIN cherychat_group_members gm
                ON gm.group_id = g.id
            LEFT JOIN cherychat_group_members allm
                ON allm.group_id = g.id
            WHERE gm.user_id = $1
            GROUP BY g.id, gm.role
            ORDER BY g.created_at DESC
            `,
            [userId]
        );

        res.json({
            success: true,
            groups: result.rows
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Unable to load your groups."
        });
    }
});

/* =========================================================
   CREATE GROUP
========================================================= */

app.post("/api/groups", async (req, res) => {
    try {
        const creatorId = Number(
            req.body.creatorId ||
            req.body.userId
        );

        const name = clean(
            req.body.name
        );

        const description = clean(
            req.body.description
        );

        const isPrivate =
            req.body.isPrivate === true ||
            req.body.is_private === true;

        const joinFee = Number(
            req.body.joinFee ||
            req.body.join_fee ||
            0
        );

        if (!validId(creatorId)) {
            return res.status(400).json({
                success: false,
                message: "Valid creator ID is required."
            });
        }

        if (!name) {
            return res.status(400).json({
                success: false,
                message: "Group name is required."
            });
        }

        const group =
            await pool.query(
                `
                INSERT INTO cherychat_groups
                (
                    name,
                    description,
                    creator_id,
                    is_private,
                    join_fee
                )
                VALUES ($1,$2,$3,$4,$5)
                RETURNING *
                `,
                [
                    name,
                    description,
                    creatorId,
                    isPrivate,
                    joinFee >= 0
                        ? joinFee
                        : 0
                ]
            );

        const groupId =
            group.rows[0].id;

        await pool.query(
            `
            INSERT INTO cherychat_group_members
            (group_id,user_id,role)
            VALUES ($1,$2,'admin')
            `,
            [
                groupId,
                creatorId
            ]
        );

        res.status(201).json({
            success: true,
            message: "Group created successfully.",
            group: group.rows[0]
        });
    } catch (error) {
        console.error("Create group error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to create group."
        });
    }
});

/* =========================================================
   GROUP DETAILS
========================================================= */

app.get("/api/groups/:id", async (req, res) => {
    try {
        const groupId = Number(
            req.params.id
        );

        const userId = Number(
            req.query.userId || 0
        );

        if (!validId(groupId)) {
            return res.status(400).json({
                success: false,
                message: "Valid group ID is required."
            });
        }

        const group =
            await pool.query(
                `
                SELECT
                    g.*,
                    u.full_name AS creator_name,
                    COUNT(gm.id)::INTEGER AS member_count
                FROM cherychat_groups g
                LEFT JOIN cherychat_users u
                    ON u.id = g.creator_id
                LEFT JOIN cherychat_group_members gm
                    ON gm.group_id = g.id
                WHERE g.id = $1
                GROUP BY g.id, u.full_name
                `,
                [groupId]
            );

        if (!group.rows.length) {
            return res.status(404).json({
                success: false,
                message: "Group not found."
            });
        }

        const members =
            await pool.query(
                `
                SELECT
                    gm.user_id,
                    gm.role,
                    gm.joined_at,
                    u.full_name,
                    u.profile_picture,
                    u.is_online
                FROM cherychat_group_members gm
                JOIN cherychat_users u
                    ON u.id = gm.user_id
                WHERE gm.group_id = $1
                ORDER BY
                    CASE
                        WHEN gm.role = 'admin'
                        THEN 0
                        ELSE 1
                    END,
                    u.full_name
                `,
                [groupId]
            );

        let isMember = false;

        if (validId(userId)) {
            const member =
                await pool.query(
                    `
                    SELECT id
                    FROM cherychat_group_members
                    WHERE group_id = $1
                    AND user_id = $2
                    `,
                    [
                        groupId,
                        userId
                    ]
                );

            isMember =
                member.rows.length > 0;
        }

        res.json({
            success: true,
            group: group.rows[0],
            members: members.rows,
            isMember
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Unable to load group."
        });
    }
});

/* =========================================================
   JOIN GROUP
========================================================= */

app.post("/api/groups/:id/join", async (req, res) => {
    try {
        const groupId = Number(
            req.params.id
        );

        const userId = Number(
            req.body.userId
        );

        if (
            !validId(groupId) ||
            !validId(userId)
        ) {
            return res.status(400).json({
                success: false,
                message: "Valid group and user IDs are required."
            });
        }

        const group =
            await pool.query(
                `
                SELECT *
                FROM cherychat_groups
                WHERE id = $1
                `,
                [groupId]
            );

        if (!group.rows.length) {
            return res.status(404).json({
                success: false,
                message: "Group not found."
            });
        }

        const data =
            group.rows[0];

        if (Number(data.join_fee) > 0) {
            return res.json({
                success: false,
                paymentRequired: true,
                joinFee: Number(
                    data.join_fee
                ),
                message:
                    "Payment is required to join this private group."
            });
        }

        await pool.query(
            `
            INSERT INTO cherychat_group_members
            (group_id,user_id,role)
            VALUES ($1,$2,'member')
            ON CONFLICT (group_id,user_id)
            DO NOTHING
            `,
            [
                groupId,
                userId
            ]
        );

        res.json({
            success: true,
            message: "You joined the group."
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Unable to join group."
        });
    }
});

/* =========================================================
   GROUP MESSAGES
========================================================= */

app.get(
    "/api/groups/:id/messages",
    async (req, res) => {
        try {
            const groupId = Number(
                req.params.id
            );

            const userId = Number(
                req.query.userId
            );

            if (
                !validId(groupId) ||
                !validId(userId)
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Valid group and user IDs are required."
                });
            }

            const member =
                await pool.query(
                    `
                    SELECT id
                    FROM cherychat_group_members
                    WHERE group_id = $1
                    AND user_id = $2
                    `,
                    [
                        groupId,
                        userId
                    ]
                );

            if (!member.rows.length) {
                return res.status(403).json({
                    success: false,
                    message: "You are not a member of this group."
                });
            }

            const result =
                await pool.query(
                    `
                    SELECT
                        gm.id,
                        gm.group_id,
                        gm.sender_id,
                        gm.message_text,
                        gm.created_at,
                        u.full_name AS sender_name,
                        u.profile_picture AS sender_picture
                    FROM cherychat_group_messages gm
                    JOIN cherychat_users u
                        ON u.id = gm.sender_id
                    WHERE gm.group_id = $1
                    ORDER BY gm.created_at ASC
                    `,
                    [groupId]
                );

            res.json({
                success: true,
                messages: result.rows
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: "Unable to load group messages."
            });
        }
    }
);

/* =========================================================
   SEND GROUP MESSAGE
========================================================= */

app.post(
    "/api/groups/:id/messages",
    async (req, res) => {
        try {
            const groupId = Number(
                req.params.id
            );

            const senderId = Number(
                req.body.senderId ||
                req.body.userId
            );

            const messageText = clean(
                req.body.messageText ||
                req.body.message
            );

            if (
                !validId(groupId) ||
                !validId(senderId)
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Valid group and user IDs are required."
                });
            }

            if (!messageText) {
                return res.status(400).json({
                    success: false,
                    message: "Message cannot be empty."
                });
            }

            const member =
                await pool.query(
                    `
                    SELECT id
                    FROM cherychat_group_members
                    WHERE group_id = $1
                    AND user_id = $2
                    `,
                    [
                        groupId,
                        senderId
                    ]
                );

            if (!member.rows.length) {
                return res.status(403).json({
                    success: false,
                    message: "You are not a member of this group."
                });
            }

            const result =
                await pool.query(
                    `
                    INSERT INTO cherychat_group_messages
                    (
                        group_id,
                        sender_id,
                        message_text
                    )
                    VALUES ($1,$2,$3)
                    RETURNING *
                    `,
                    [
                        groupId,
                        senderId,
                        messageText
                    ]
                );

            res.status(201).json({
                success: true,
                message: result.rows[0]
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: "Unable to send group message."
            });
        }
    }
);

/* =========================================================
   STORIES
========================================================= */

app.get("/api/stories", async (req, res) => {
    try {
        const userId = Number(
            req.query.userId || 0
        );

        const result =
            await pool.query(
                `
                SELECT
                    s.id,
                    s.user_id,
                    s.media_type,
                    s.media_data,
                    s.caption,
                    s.created_at,
                    s.expires_at,
                    u.full_name,
                    u.profile_picture,
                    EXISTS (
                        SELECT 1
                        FROM cherychat_story_views sv
                        WHERE sv.story_id = s.id
                        AND sv.user_id = $1
                    ) AS viewed_by_me
                FROM cherychat_stories s
                JOIN cherychat_users u
                    ON u.id = s.user_id
                WHERE
                    s.expires_at > CURRENT_TIMESTAMP
                ORDER BY s.created_at ASC
                `,
                [userId]
            );

        const groups = {};

        for (const story of result.rows) {
            if (!groups[story.user_id]) {
                groups[story.user_id] = {
                    userId:
                        story.user_id,
                    fullName:
                        story.full_name,
                    profilePicture:
                        story.profile_picture,
                    stories: []
                };
            }

            groups[
                story.user_id
            ].stories.push({
                id: story.id,
                userId: story.user_id,
                fullName:
                    story.full_name,
                profilePicture:
                    story.profile_picture,
                mediaType:
                    story.media_type,
                mediaData:
                    story.media_data,
                caption:
                    story.caption,
                createdAt:
                    story.created_at,
                expiresAt:
                    story.expires_at,
                viewedByMe:
                    story.viewed_by_me,
                isOwn:
                    Number(story.user_id) ===
                    userId
            });
        }

        res.json({
            success: true,
            stories: result.rows,
            users: Object.values(groups)
        });
    } catch (error) {
        console.error("Stories error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to load stories."
        });
    }
});

/* =========================================================
   CREATE STORY
========================================================= */

app.post("/api/stories", async (req, res) => {
    try {
        const userId = Number(
            req.body.userId
        );

        const mediaType = clean(
            req.body.mediaType
        );

        const mediaData =
            req.body.mediaData;

        const caption = clean(
            req.body.caption
        );

        if (!validId(userId)) {
            return res.status(400).json({
                success: false,
                message: "Valid user ID is required."
            });
        }

        if (
            mediaType !== "image" &&
            mediaType !== "video"
        ) {
            return res.status(400).json({
                success: false,
                message: "Invalid story media type."
            });
        }

        if (!mediaData) {
            return res.status(400).json({
                success: false,
                message: "Story media is required."
            });
        }

        const result =
            await pool.query(
                `
                INSERT INTO cherychat_stories
                (
                    user_id,
                    media_type,
                    media_data,
                    caption
                )
                VALUES ($1,$2,$3,$4)
                RETURNING *
                `,
                [
                    userId,
                    mediaType,
                    mediaData,
                    caption
                ]
            );

        res.status(201).json({
            success: true,
            message: "Story posted successfully.",
            story: result.rows[0]
        });
    } catch (error) {
        console.error("Create story error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to post story."
        });
    }
});

/* =========================================================
   VIEW STORY
========================================================= */

app.post(
    "/api/stories/:id/view",
    async (req, res) => {
        try {
            const storyId = Number(
                req.params.id
            );

            const userId = Number(
                req.body.userId
            );

            if (
                !validId(storyId) ||
                !validId(userId)
            ) {
                return res.status(400).json({
                    success: false,
                    message: "Valid story and user IDs are required."
                });
            }

            await pool.query(
                `
                INSERT INTO cherychat_story_views
                (story_id,user_id)
                VALUES ($1,$2)
                ON CONFLICT
                (story_id,user_id)
                DO NOTHING
                `,
                [
                    storyId,
                    userId
                ]
            );

            res.json({
                success: true
            });
        } catch (error) {
            res.status(500).json({
                success: false,
                message: "Unable to record story view."
            });
        }
    }
);

/* =========================================================
   DELETE EXPIRED STORIES
========================================================= */

async function deleteExpiredStories() {
    try {
        await pool.query(
            `
            DELETE FROM cherychat_stories
            WHERE expires_at <= CURRENT_TIMESTAMP
            `
        );
    } catch (error) {
        console.error(
            "Expired stories cleanup error:",
            error
        );
    }
}

setInterval(
    deleteExpiredStories,
    60 * 60 * 1000
);

/* =========================================================
   LOGOUT
========================================================= */

app.post("/api/logout", async (req, res) => {
    try {
        const userId = Number(
            req.body.userId
        );

        if (!validId(userId)) {
            return res.status(400).json({
                success: false,
                message: "Valid user ID is required."
            });
        }

        await pool.query(
            `
            UPDATE cherychat_users
            SET is_online = FALSE,
                last_seen = CURRENT_TIMESTAMP
            WHERE id = $1
            `,
            [userId]
        );

        res.json({
            success: true,
            message: "Logged out successfully."
        });
    } catch (error) {
        res.status(500).json({
            success: false,
            message: "Unable to logout."
        });
    }
});

/* =========================================================
   404
========================================================= */

app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: "VibeChat API endpoint not found."
    });
});

/* =========================================================
   SERVER
========================================================= */

const PORT =
    process.env.PORT || 10000;

app.listen(PORT, () => {
    console.log(
        `VibeChat API running on port ${PORT}`
    );
});
