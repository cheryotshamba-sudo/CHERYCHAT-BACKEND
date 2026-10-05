const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const crypto = require("crypto");
const { Pool } = require("pg");

const app = express();

app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));

const PORT = process.env.PORT || 10000;

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl:
        process.env.NODE_ENV === "production"
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

function cleanText(value, max = 5000) {
    if (value === undefined || value === null) return "";
    return String(value).trim().slice(0, max);
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

function createAvatar(name) {
    const safeName = cleanText(name, 100) || "VibeChat User";
    return `https://ui-avatars.com/api/?name=${encodeURIComponent(
        safeName
    )}&background=120a22&color=ffd54a&bold=true`;
}

function formatUser(user) {
    if (!user) return null;

    return {
        id: user.id,
        userId: user.id,
        fullName: user.full_name,
        email: user.email,
        phone: user.phone,
        profilePicture: user.profile_picture || createAvatar(user.full_name),
        about: user.about || "using VibeChat",
        isOnline: Boolean(user.is_online),
        lastSeen: user.last_seen,
        createdAt: user.created_at
    };
}

function formatGroup(group) {
    if (!group) return null;

    return {
        id: group.id,
        groupId: group.id,
        name: group.name,
        description: group.description || "",
        groupType: group.group_type,
        visibility: group.visibility,
        inviteCode: group.invite_code,
        ownerId: group.owner_id,
        ownerName: group.owner_name || null,
        ownerProfilePicture: group.owner_profile_picture || null,
        memberCount: Number(group.member_count || 0),
        createdAt: group.created_at,
        membership: group.membership || null
    };
}

function formatStory(story) {
    if (!story) return null;

    return {
        id: story.id,
        userId: story.user_id,
        fullName: story.full_name,
        profilePicture:
            story.profile_picture || createAvatar(story.full_name),
        mediaType: story.media_type,
        mediaData: story.media_data,
        caption: story.caption || "",
        createdAt: story.created_at,
        expiresAt: story.expires_at
    };
}

function formatPrivateMessage(message) {
    return {
        id: message.id,
        conversationId: message.conversation_id,
        senderId: message.sender_id,
        receiverId: message.receiver_id,
        messageText: message.message_text,
        isRead: Boolean(message.is_read),
        createdAt: message.created_at
    };
}

function formatGroupMessage(message) {
    return {
        id: message.id,
        groupId: message.group_id,
        senderId: message.sender_id,
        senderName: message.sender_name,
        senderProfilePicture:
            message.sender_profile_picture ||
            createAvatar(message.sender_name),
        messageText: message.message_text,
        createdAt: message.created_at
    };
}

async function userExists(userId) {
    const id = toId(userId);

    if (!id) return false;

    const result = await pool.query(
        `SELECT id FROM cherychat_users WHERE id = $1`,
        [id]
    );

    return result.rows.length > 0;
}

async function getGroup(groupId) {
    const id = toId(groupId);

    if (!id) return null;

    const result = await pool.query(
        `
        SELECT
            g.*,
            u.full_name AS owner_name,
            u.profile_picture AS owner_profile_picture,
            (
                SELECT COUNT(*)
                FROM cherychat_group_members gm
                WHERE gm.group_id = g.id
                  AND gm.status = 'active'
            ) AS member_count
        FROM cherychat_groups g
        LEFT JOIN cherychat_users u
            ON u.id = g.owner_id
        WHERE g.id = $1
        `,
        [id]
    );

    return result.rows[0] || null;
}

async function getMembership(groupId, userId) {
    const gid = toId(groupId);
    const uid = toId(userId);

    if (!gid || !uid) return null;

    const result = await pool.query(
        `
        SELECT *
        FROM cherychat_group_members
        WHERE group_id = $1
          AND user_id = $2
        LIMIT 1
        `,
        [gid, uid]
    );

    return result.rows[0] || null;
}

async function isActiveMember(groupId, userId) {
    const membership = await getMembership(groupId, userId);

    return Boolean(
        membership && membership.status === "active"
    );
}

async function isAdminOrOwner(groupId, userId) {
    const membership = await getMembership(groupId, userId);

    return Boolean(
        membership &&
        membership.status === "active" &&
        (membership.role === "admin" || membership.role === "owner")
    );
}

/* =========================================================
   DATABASE INITIALIZATION
========================================================= */

async function initializeDatabase() {
    await pool.query(`
        CREATE TABLE IF NOT EXISTS cherychat_users (
            id SERIAL PRIMARY KEY,
            full_name VARCHAR(150) NOT NULL,
            email VARCHAR(255) UNIQUE NOT NULL,
            phone VARCHAR(50) UNIQUE NOT NULL,
            password_hash TEXT NOT NULL,
            profile_picture TEXT,
            about TEXT DEFAULT 'using VibeChat',
            is_online BOOLEAN DEFAULT FALSE,
            last_seen TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS cherychat_conversations (
            id SERIAL PRIMARY KEY,
            user_one INTEGER NOT NULL REFERENCES cherychat_users(id) ON DELETE CASCADE,
            user_two INTEGER NOT NULL REFERENCES cherychat_users(id) ON DELETE CASCADE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(user_one, user_two),
            CHECK(user_one <> user_two)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS cherychat_messages (
            id SERIAL PRIMARY KEY,
            conversation_id INTEGER NOT NULL
                REFERENCES cherychat_conversations(id) ON DELETE CASCADE,
            sender_id INTEGER NOT NULL
                REFERENCES cherychat_users(id) ON DELETE CASCADE,
            receiver_id INTEGER NOT NULL
                REFERENCES cherychat_users(id) ON DELETE CASCADE,
            message_text TEXT NOT NULL,
            is_read BOOLEAN DEFAULT FALSE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS cherychat_groups (
            id SERIAL PRIMARY KEY,
            name VARCHAR(100) NOT NULL,
            description TEXT DEFAULT '',
            group_type VARCHAR(20) NOT NULL DEFAULT 'public',
            visibility VARCHAR(20) NOT NULL DEFAULT 'public',
            invite_code VARCHAR(50) UNIQUE NOT NULL,
            owner_id INTEGER NOT NULL
                REFERENCES cherychat_users(id) ON DELETE CASCADE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS cherychat_group_members (
            id SERIAL PRIMARY KEY,
            group_id INTEGER NOT NULL
                REFERENCES cherychat_groups(id) ON DELETE CASCADE,
            user_id INTEGER NOT NULL
                REFERENCES cherychat_users(id) ON DELETE CASCADE,
            role VARCHAR(20) NOT NULL DEFAULT 'member',
            status VARCHAR(20) NOT NULL DEFAULT 'active',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(group_id, user_id)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS cherychat_group_join_requests (
            id SERIAL PRIMARY KEY,
            group_id INTEGER NOT NULL
                REFERENCES cherychat_groups(id) ON DELETE CASCADE,
            user_id INTEGER NOT NULL
                REFERENCES cherychat_users(id) ON DELETE CASCADE,
            status VARCHAR(20) NOT NULL DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(group_id, user_id)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS cherychat_group_messages (
            id SERIAL PRIMARY KEY,
            group_id INTEGER NOT NULL
                REFERENCES cherychat_groups(id) ON DELETE CASCADE,
            sender_id INTEGER NOT NULL
                REFERENCES cherychat_users(id) ON DELETE CASCADE,
            message_text TEXT NOT NULL,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS cherychat_group_payments (
            id SERIAL PRIMARY KEY,
            group_id INTEGER NOT NULL
                REFERENCES cherychat_groups(id) ON DELETE CASCADE,
            user_id INTEGER NOT NULL
                REFERENCES cherychat_users(id) ON DELETE CASCADE,
            amount NUMERIC(12,2) NOT NULL DEFAULT 0,
            currency VARCHAR(10) DEFAULT 'KES',
            status VARCHAR(30) DEFAULT 'pending',
            reference VARCHAR(150),
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS cherychat_stories (
            id SERIAL PRIMARY KEY,
            user_id INTEGER NOT NULL
                REFERENCES cherychat_users(id) ON DELETE CASCADE,
            media_type VARCHAR(20) NOT NULL,
            media_data TEXT NOT NULL,
            caption TEXT DEFAULT '',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            expires_at TIMESTAMP DEFAULT (CURRENT_TIMESTAMP + INTERVAL '24 hours')
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS cherychat_story_views (
            id SERIAL PRIMARY KEY,
            story_id INTEGER NOT NULL
                REFERENCES cherychat_stories(id) ON DELETE CASCADE,
            viewer_id INTEGER NOT NULL
                REFERENCES cherychat_users(id) ON DELETE CASCADE,
            viewed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(story_id, viewer_id)
        )
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_cherychat_messages_conversation
        ON cherychat_messages(conversation_id, created_at)
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_cherychat_group_messages
        ON cherychat_group_messages(group_id, created_at)
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_cherychat_stories_user
        ON cherychat_stories(user_id, expires_at)
    `);

    await pool.query(`
        CREATE INDEX IF NOT EXISTS idx_cherychat_story_views
        ON cherychat_story_views(story_id, viewer_id)
    `);

    console.log("VibeChat database initialized.");
}

/* =========================================================
   BASIC ROUTES
========================================================= */

app.get("/", (req, res) => {
    res.json({
        success: true,
        app: "VibeChat",
        message: "VibeChat backend is running."
    });
});

app.get("/health", (req, res) => {
    res.json({
        success: true,
        status: "ok",
        app: "VibeChat"
    });
});

app.get("/api/test", async (req, res) => {
    try {
        await pool.query("SELECT 1");

        res.json({
            success: true,
            message: "VibeChat API is working."
        });
    } catch (error) {
        console.error("API test error:", error);

        res.status(500).json({
            success: false,
            message: "Database connection failed."
        });
    }
});

/* =========================================================
   AUTH
========================================================= */

app.post("/api/register", async (req, res) => {
    try {
        const fullName = cleanText(req.body.fullName, 150);
        const email = cleanText(req.body.email, 255).toLowerCase();
        const phone = cleanText(req.body.phone, 50);
        const password = String(req.body.password || "");

        if (!fullName || !email || !phone || !password) {
            return res.status(400).json({
                success: false,
                message: "All registration fields are required."
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
            WHERE LOWER(email) = LOWER($1)
               OR phone = $2
            LIMIT 1
            `,
            [email, phone]
        );

        if (existing.rows.length > 0) {
            return res.status(409).json({
                success: false,
                message: "An account with that email or phone already exists."
            });
        }

        const passwordHash = await bcrypt.hash(password, 12);

        const result = await pool.query(
            `
            INSERT INTO cherychat_users
                (full_name, email, phone, password_hash, profile_picture, about)
            VALUES
                ($1, $2, $3, $4, $5, $6)
            RETURNING *
            `,
            [
                fullName,
                email,
                phone,
                passwordHash,
                createAvatar(fullName),
                "using VibeChat"
            ]
        );

        res.status(201).json({
            success: true,
            message: "VibeChat account created successfully.",
            user: formatUser(result.rows[0])
        });
    } catch (error) {
        console.error("Register error:", error);

        res.status(500).json({
            success: false,
            message: "Registration failed."
        });
    }
});

app.post("/api/login", async (req, res) => {
    try {
        const identifier = cleanText(
            req.body.email || req.body.phone || req.body.identifier,
            255
        ).toLowerCase();

        const password = String(req.body.password || "");

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
            WHERE LOWER(email) = LOWER($1)
               OR phone = $1
            LIMIT 1
            `,
            [identifier]
        );

        if (result.rows.length === 0) {
            return res.status(401).json({
                success: false,
                message: "Invalid login details."
            });
        }

        const user = result.rows[0];

        const passwordMatches = await bcrypt.compare(
            password,
            user.password_hash
        );

        if (!passwordMatches) {
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

        user.is_online = true;
        user.last_seen = new Date();

        res.json({
            success: true,
            message: "Login successful.",
            user: formatUser(user)
        });
    } catch (error) {
        console.error("Login error:", error);

        res.status(500).json({
            success: false,
            message: "Login failed."
        });
    }
});

/* =========================================================
   USERS
========================================================= */

app.put("/api/users/:id/online", async (req, res) => {
    try {
        const id = toId(req.params.id);

        if (!id || !(await userExists(id))) {
            return res.status(404).json({
                success: false,
                message: "User not found."
            });
        }

        const result = await pool.query(
            `
            UPDATE cherychat_users
            SET is_online = TRUE,
                last_seen = CURRENT_TIMESTAMP
            WHERE id = $1
            RETURNING *
            `,
            [id]
        );

        res.json({
            success: true,
            user: formatUser(result.rows[0])
        });
    } catch (error) {
        console.error("Online status error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to update online status."
        });
    }
});

app.put("/api/users/:id/offline", async (req, res) => {
    try {
        const id = toId(req.params.id);

        if (!id || !(await userExists(id))) {
            return res.status(404).json({
                success: false,
                message: "User not found."
            });
        }

        const result = await pool.query(
            `
            UPDATE cherychat_users
            SET is_online = FALSE,
                last_seen = CURRENT_TIMESTAMP
            WHERE id = $1
            RETURNING *
            `,
            [id]
        );

        res.json({
            success: true,
            user: formatUser(result.rows[0])
        });
    } catch (error) {
        console.error("Offline status error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to update offline status."
        });
    }
});

app.get("/api/users/:id", async (req, res) => {
    try {
        const id = toId(req.params.id);

        if (!id) {
            return res.status(400).json({
                success: false,
                message: "Invalid user ID."
            });
        }

        const result = await pool.query(
            `
            SELECT *
            FROM cherychat_users
            WHERE id = $1
            `,
            [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "User not found."
            });
        }

        res.json({
            success: true,
            user: formatUser(result.rows[0])
        });
    } catch (error) {
        console.error("Get user error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to load user."
        });
    }
});

app.get("/api/users/search", async (req, res) => {
    try {
        const q = cleanText(req.query.q, 100);
        const userId = toId(req.query.userId);

        if (!q) {
            return res.json({
                success: true,
                users: []
            });
        }

        const searchTerm = `%${q}%`;

        const result = await pool.query(
            `
            SELECT *
            FROM cherychat_users
            WHERE
                (
                    full_name ILIKE $1
                    OR email ILIKE $1
                    OR phone ILIKE $1
                )
                AND ($2::INTEGER IS NULL OR id <> $2)
            ORDER BY
                CASE
                    WHEN full_name ILIKE $3 THEN 0
                    ELSE 1
                END,
                full_name ASC
            LIMIT 30
            `,
            [searchTerm, userId, `${q}%`]
        );

        res.json({
            success: true,
            users: result.rows.map(formatUser)
        });
    } catch (error) {
        console.error("User search error:", error);

        res.status(500).json({
            success: false,
            message: "User search failed."
        });
    }
});

app.put("/api/users/:id/profile", async (req, res) => {
    try {
        const id = toId(req.params.id);

        if (!id || !(await userExists(id))) {
            return res.status(404).json({
                success: false,
                message: "User not found."
            });
        }

        const fullName = cleanText(req.body.fullName, 150);
        const about = cleanText(req.body.about, 500);
        const phone = cleanText(req.body.phone, 50);

        if (!fullName) {
            return res.status(400).json({
                success: false,
                message: "Full name is required."
            });
        }

        const result = await pool.query(
            `
            UPDATE cherychat_users
            SET full_name = $1,
                about = $2,
                phone = COALESCE(NULLIF($3, ''), phone)
            WHERE id = $4
            RETURNING *
            `,
            [fullName, about || "using VibeChat", phone, id]
        );

        res.json({
            success: true,
            message: "Profile updated successfully.",
            user: formatUser(result.rows[0])
        });
    } catch (error) {
        console.error("Profile update error:", error);

        if (error.code === "23505") {
            return res.status(409).json({
                success: false,
                message: "That phone number is already in use."
            });
        }

        res.status(500).json({
            success: false,
            message: "Unable to update profile."
        });
    }
});

app.put("/api/users/:id/profile-picture", async (req, res) => {
    try {
        const id = toId(req.params.id);

        if (!id || !(await userExists(id))) {
            return res.status(404).json({
                success: false,
                message: "User not found."
            });
        }

        const profilePicture = cleanText(
            req.body.profilePicture || req.body.image || req.body.imageData,
            5000000
        );

        if (!profilePicture) {
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
            RETURNING *
            `,
            [profilePicture, id]
        );

        res.json({
            success: true,
            message: "Profile picture updated successfully.",
            user: formatUser(result.rows[0])
        });
    } catch (error) {
        console.error("Profile picture error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to update profile picture."
        });
    }
});

/* =========================================================
   PRIVATE CONVERSATIONS
========================================================= */

app.post("/api/conversations", async (req, res) => {
    try {
        const userId = toId(req.body.userId);
        const otherUserId = toId(req.body.otherUserId);

        if (!userId || !otherUserId || userId === otherUserId) {
            return res.status(400).json({
                success: false,
                message: "Valid users are required."
            });
        }

        if (
            !(await userExists(userId)) ||
            !(await userExists(otherUserId))
        ) {
            return res.status(404).json({
                success: false,
                message: "User not found."
            });
        }

        const userOne = Math.min(userId, otherUserId);
        const userTwo = Math.max(userId, otherUserId);

        const result = await pool.query(
            `
            INSERT INTO cherychat_conversations
                (user_one, user_two)
            VALUES
                ($1, $2)
            ON CONFLICT (user_one, user_two)
            DO UPDATE SET user_one = EXCLUDED.user_one
            RETURNING *
            `,
            [userOne, userTwo]
        );

        res.status(201).json({
            success: true,
            conversation: result.rows[0]
        });
    } catch (error) {
        console.error("Create conversation error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to create conversation."
        });
    }
});

app.get("/api/conversations", async (req, res) => {
    try {
        const userId = toId(req.query.userId);

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: "Valid user ID is required."
            });
        }

        if (!(await userExists(userId))) {
            return res.status(404).json({
                success: false,
                message: "User not found."
            });
        }

        const result = await pool.query(
            `
            SELECT
                c.id,
                c.created_at,
                CASE
                    WHEN c.user_one = $1 THEN c.user_two
                    ELSE c.user_one
                END AS other_user_id,

                u.full_name AS other_full_name,
                u.email AS other_email,
                u.phone AS other_phone,
                u.profile_picture AS other_profile_picture,
                u.about AS other_about,
                u.is_online AS other_is_online,
                u.last_seen AS other_last_seen,

                m.message_text AS last_message,
                m.created_at AS last_message_time,
                m.sender_id AS last_message_sender_id,
                m.is_read AS last_message_read

            FROM cherychat_conversations c

            JOIN cherychat_users u
                ON u.id = CASE
                    WHEN c.user_one = $1 THEN c.user_two
                    ELSE c.user_one
                END

            LEFT JOIN LATERAL (
                SELECT
                    message_text,
                    created_at,
                    sender_id,
                    is_read
                FROM cherychat_messages
                WHERE conversation_id = c.id
                ORDER BY created_at DESC, id DESC
                LIMIT 1
            ) m ON TRUE

            WHERE c.user_one = $1
               OR c.user_two = $1

            ORDER BY
                COALESCE(m.created_at, c.created_at) DESC
            `,
            [userId]
        );

        const conversations = result.rows.map((row) => ({
            id: row.id,
            conversationId: row.id,
            otherUserId: row.other_user_id,
            otherUser: {
                id: row.other_user_id,
                userId: row.other_user_id,
                fullName: row.other_full_name,
                email: row.other_email,
                phone: row.other_phone,
                profilePicture:
                    row.other_profile_picture ||
                    createAvatar(row.other_full_name),
                about: row.other_about || "using VibeChat",
                isOnline: Boolean(row.other_is_online),
                lastSeen: row.other_last_seen
            },
            lastMessage: row.last_message || "",
            lastMessageTime: row.last_message_time || null,
            lastMessageSenderId: row.last_message_sender_id || null,
            lastMessageRead: Boolean(row.last_message_read)
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

app.post("/api/messages", async (req, res) => {
    try {
        const senderId = toId(req.body.senderId);
        const receiverId = toId(req.body.receiverId);
        const messageText = cleanText(req.body.messageText, 10000);

        if (
            !senderId ||
            !receiverId ||
            senderId === receiverId ||
            !messageText
        ) {
            return res.status(400).json({
                success: false,
                message: "Valid sender, receiver and message are required."
            });
        }

        if (
            !(await userExists(senderId)) ||
            !(await userExists(receiverId))
        ) {
            return res.status(404).json({
                success: false,
                message: "User not found."
            });
        }

        const userOne = Math.min(senderId, receiverId);
        const userTwo = Math.max(senderId, receiverId);

        const conversation = await pool.query(
            `
            INSERT INTO cherychat_conversations
                (user_one, user_two)
            VALUES
                ($1, $2)
            ON CONFLICT (user_one, user_two)
            DO UPDATE SET user_one = EXCLUDED.user_one
            RETURNING id
            `,
            [userOne, userTwo]
        );

        const conversationId = conversation.rows[0].id;

        const result = await pool.query(
            `
            INSERT INTO cherychat_messages
                (
                    conversation_id,
                    sender_id,
                    receiver_id,
                    message_text
                )
            VALUES
                ($1, $2, $3, $4)
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
            message: formatPrivateMessage(result.rows[0])
        });
    } catch (error) {
        console.error("Send message error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to send message."
        });
    }
});

app.get("/api/messages", async (req, res) => {
    try {
        const userId = toId(req.query.userId);
        const otherUserId = toId(req.query.otherUserId);

        if (
            !userId ||
            !otherUserId ||
            userId === otherUserId
        ) {
            return res.status(400).json({
                success: false,
                message: "Valid users are required."
            });
        }

        const userOne = Math.min(userId, otherUserId);
        const userTwo = Math.max(userId, otherUserId);

        const conversation = await pool.query(
            `
            SELECT id
            FROM cherychat_conversations
            WHERE user_one = $1
              AND user_two = $2
            LIMIT 1
            `,
            [userOne, userTwo]
        );

        if (conversation.rows.length === 0) {
            return res.json({
                success: true,
                messages: []
            });
        }

        const conversationId = conversation.rows[0].id;

        const result = await pool.query(
            `
            SELECT *
            FROM cherychat_messages
            WHERE conversation_id = $1
            ORDER BY created_at ASC, id ASC
            `,
            [conversationId]
        );

        res.json({
            success: true,
            messages: result.rows.map(formatPrivateMessage)
        });
    } catch (error) {
        console.error("Get messages error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to load messages."
        });
    }
});

app.put("/api/messages/read", async (req, res) => {
    try {
        const userId = toId(req.body.userId);
        const otherUserId = toId(req.body.otherUserId);

        if (!userId || !otherUserId) {
            return res.status(400).json({
                success: false,
                message: "Valid users are required."
            });
        }

        const userOne = Math.min(userId, otherUserId);
        const userTwo = Math.max(userId, otherUserId);

        const conversation = await pool.query(
            `
            SELECT id
            FROM cherychat_conversations
            WHERE user_one = $1
              AND user_two = $2
            LIMIT 1
            `,
            [userOne, userTwo]
        );

        if (conversation.rows.length === 0) {
            return res.json({
                success: true,
                updated: 0
            });
        }

        const result = await pool.query(
            `
            UPDATE cherychat_messages
            SET is_read = TRUE
            WHERE conversation_id = $1
              AND receiver_id = $2
              AND is_read = FALSE
            `,
            [conversation.rows[0].id, userId]
        );

        res.json({
            success: true,
            updated: result.rowCount
        });
    } catch (error) {
        console.error("Read messages error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to mark messages as read."
        });
    }
});

/* =========================================================
   STORIES
========================================================= */

app.post("/api/stories", async (req, res) => {
    try {
        const userId = toId(req.body.userId);
        const mediaType = cleanText(req.body.mediaType, 20).toLowerCase();
        const mediaData = cleanText(
            req.body.mediaData || req.body.media,
            10000000
        );
        const caption = cleanText(req.body.caption, 1000);

        if (!userId || !(await userExists(userId))) {
            return res.status(404).json({
                success: false,
                message: "User not found."
            });
        }

        if (!["image", "video"].includes(mediaType)) {
            return res.status(400).json({
                success: false,
                message: "Story media type must be image or video."
            });
        }

        if (!mediaData) {
            return res.status(400).json({
                success: false,
                message: "Story media is required."
            });
        }

        const result = await pool.query(
            `
            INSERT INTO cherychat_stories
                (
                    user_id,
                    media_type,
                    media_data,
                    caption
                )
            VALUES
                ($1, $2, $3, $4)
            RETURNING *
            `,
            [
                userId,
                mediaType,
                mediaData,
                caption
            ]
        );

        const storyResult = await pool.query(
            `
            SELECT
                s.*,
                u.full_name,
                u.profile_picture
            FROM cherychat_stories s
            JOIN cherychat_users u
                ON u.id = s.user_id
            WHERE s.id = $1
            `,
            [result.rows[0].id]
        );

        res.status(201).json({
            success: true,
            story: formatStory(storyResult.rows[0])
        });
    } catch (error) {
        console.error("Create story error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to create story."
        });
    }
});

app.get("/api/stories", async (req, res) => {
    try {
        const userId = toId(req.query.userId);

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: "Valid user ID is required."
            });
        }

        await pool.query(`
            DELETE FROM cherychat_stories
            WHERE expires_at <= CURRENT_TIMESTAMP
        `);

        const result = await pool.query(
            `
            SELECT
                s.*,
                u.full_name,
                u.profile_picture
            FROM cherychat_stories s
            JOIN cherychat_users u
                ON u.id = s.user_id
            WHERE s.expires_at > CURRENT_TIMESTAMP
            ORDER BY s.created_at ASC
            `
        );

        const grouped = new Map();

        for (const row of result.rows) {
            if (!grouped.has(row.user_id)) {
                grouped.set(row.user_id, {
                    userId: row.user_id,
                    fullName: row.full_name,
                    profilePicture:
                        row.profile_picture ||
                        createAvatar(row.full_name),
                    isOwn: row.user_id === userId,
                    stories: []
                });
            }

            grouped.get(row.user_id).stories.push(
                formatStory(row)
            );
        }

        res.json({
            success: true,
            groups: Array.from(grouped.values())
        });
    } catch (error) {
        console.error("Get stories error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to load stories."
        });
    }
});

app.get("/api/stories/:id", async (req, res) => {
    try {
        const storyId = toId(req.params.id);
        const viewerId = toId(req.query.viewerId);

        if (!storyId) {
            return res.status(400).json({
                success: false,
                message: "Invalid story ID."
            });
        }

        const result = await pool.query(
            `
            SELECT
                s.*,
                u.full_name,
                u.profile_picture
            FROM cherychat_stories s
            JOIN cherychat_users u
                ON u.id = s.user_id
            WHERE s.id = $1
              AND s.expires_at > CURRENT_TIMESTAMP
            `,
            [storyId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Story not found or expired."
            });
        }

        let viewed = false;

        if (viewerId) {
            const viewResult = await pool.query(
                `
                SELECT id
                FROM cherychat_story_views
                WHERE story_id = $1
                  AND viewer_id = $2
                LIMIT 1
                `,
                [storyId, viewerId]
            );

            viewed = viewResult.rows.length > 0;
        }

        res.json({
            success: true,
            story: formatStory(result.rows[0]),
            viewed
        });
    } catch (error) {
        console.error("Get story error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to load story."
        });
    }
});

app.post("/api/stories/:id/view", async (req, res) => {
    try {
        const storyId = toId(req.params.id);
        const viewerId = toId(req.body.viewerId);

        if (!storyId || !viewerId) {
            return res.status(400).json({
                success: false,
                message: "Story ID and viewer ID are required."
            });
        }

        if (!(await userExists(viewerId))) {
            return res.status(404).json({
                success: false,
                message: "Viewer not found."
            });
        }

        const story = await pool.query(
            `
            SELECT id
            FROM cherychat_stories
            WHERE id = $1
              AND expires_at > CURRENT_TIMESTAMP
            `,
            [storyId]
        );

        if (story.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Story not found or expired."
            });
        }

        await pool.query(
            `
            INSERT INTO cherychat_story_views
                (story_id, viewer_id)
            VALUES
                ($1, $2)
            ON CONFLICT (story_id, viewer_id)
            DO NOTHING
            `,
            [storyId, viewerId]
        );

        res.json({
            success: true,
            message: "Story viewed."
        });
    } catch (error) {
        console.error("Story view error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to record story view."
        });
    }
});

app.get("/api/stories/:id/viewers", async (req, res) => {
    try {
        const storyId = toId(req.params.id);

        if (!storyId) {
            return res.status(400).json({
                success: false,
                message: "Invalid story ID."
            });
        }

        const result = await pool.query(
            `
            SELECT
                u.id,
                u.full_name,
                u.profile_picture,
                v.viewed_at
            FROM cherychat_story_views v
            JOIN cherychat_users u
                ON u.id = v.viewer_id
            WHERE v.story_id = $1
            ORDER BY v.viewed_at DESC
            `,
            [storyId]
        );

        res.json({
            success: true,
            viewers: result.rows.map((row) => ({
                id: row.id,
                userId: row.id,
                fullName: row.full_name,
                profilePicture:
                    row.profile_picture ||
                    createAvatar(row.full_name),
                viewedAt: row.viewed_at
            }))
        });
    } catch (error) {
        console.error("Story viewers error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to load story viewers."
        });
    }
});

app.delete("/api/stories/:id", async (req, res) => {
    try {
        const storyId = toId(req.params.id);
        const userId = toId(
            req.body.userId || req.query.userId
        );

        if (!storyId || !userId) {
            return res.status(400).json({
                success: false,
                message: "Story ID and user ID are required."
            });
        }

        const result = await pool.query(
            `
            DELETE FROM cherychat_stories
            WHERE id = $1
              AND user_id = $2
            RETURNING id
            `,
            [storyId, userId]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Story not found or you are not the owner."
            });
        }

        res.json({
            success: true,
            message: "Story deleted."
        });
    } catch (error) {
        console.error("Delete story error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to delete story."
        });
    }
});

app.delete("/api/stories/expired/cleanup", async (req, res) => {
    try {
        const result = await pool.query(`
            DELETE FROM cherychat_stories
            WHERE expires_at <= CURRENT_TIMESTAMP
        `);

        res.json({
            success: true,
            deleted: result.rowCount
        });
    } catch (error) {
        console.error("Story cleanup error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to clean expired stories."
        });
    }
});

/* =========================================================
   GROUPS
========================================================= */

app.post("/api/groups", async (req, res) => {
    const client = await pool.connect();

    try {
        const ownerId = toId(
            req.body.ownerId || req.body.userId
        );

        const name = cleanGroupName(req.body.name);
        const description = cleanDescription(req.body.description);

        const groupType = cleanText(
            req.body.groupType || req.body.type || "public",
            20
        ).toLowerCase();

        const visibility = cleanText(
            req.body.visibility || groupType,
            20
        ).toLowerCase();

        if (!ownerId || !(await userExists(ownerId))) {
            return res.status(404).json({
                success: false,
                message: "Owner not found."
            });
        }

        if (!name) {
            return res.status(400).json({
                success: false,
                message: "Group name is required."
            });
        }

        const safeGroupType =
            groupType === "private" ? "private" : "public";

        const safeVisibility =
            visibility === "private" ? "private" : "public";

        await client.query("BEGIN");

        let inviteCode = generateInviteCode();

        for (let i = 0; i < 5; i++) {
            const existing = await client.query(
                `
                SELECT id
                FROM cherychat_groups
                WHERE invite_code = $1
                `,
                [inviteCode]
            );

            if (existing.rows.length === 0) break;

            inviteCode = generateInviteCode();
        }

        const groupResult = await client.query(
            `
            INSERT INTO cherychat_groups
                (
                    name,
                    description,
                    group_type,
                    visibility,
                    invite_code,
                    owner_id
                )
            VALUES
                ($1, $2, $3, $4, $5, $6)
            RETURNING *
            `,
            [
                name,
                description,
                safeGroupType,
                safeVisibility,
                inviteCode,
                ownerId
            ]
        );

        const group = groupResult.rows[0];

        await client.query(
            `
            INSERT INTO cherychat_group_members
                (
                    group_id,
                    user_id,
                    role,
                    status
                )
            VALUES
                ($1, $2, 'owner', 'active')
            `,
            [group.id, ownerId]
        );

        await client.query("COMMIT");

        const finalGroup = await getGroup(group.id);

        res.status(201).json({
            success: true,
            message: "Group created successfully.",
            group: formatGroup(finalGroup)
        });
    } catch (error) {
        await client.query("ROLLBACK");

        console.error("Create group error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to create group."
        });
    } finally {
        client.release();
    }
});

app.get("/api/groups", async (req, res) => {
    try {
        const userId = toId(req.query.userId);

        const result = await pool.query(
            `
            SELECT
                g.*,
                u.full_name AS owner_name,
                u.profile_picture AS owner_profile_picture,

                (
                    SELECT COUNT(*)
                    FROM cherychat_group_members gm
                    WHERE gm.group_id = g.id
                      AND gm.status = 'active'
                ) AS member_count,

                gm.role AS membership_role,
                gm.status AS membership_status

            FROM cherychat_groups g

            LEFT JOIN cherychat_users u
                ON u.id = g.owner_id

            LEFT JOIN cherychat_group_members gm
                ON gm.group_id = g.id
               AND gm.user_id = $1

            WHERE g.visibility = 'public'

            ORDER BY g.created_at DESC
            `,
            [userId]
        );

        const groups = result.rows.map((row) =>
            formatGroup({
                ...row,
                membership:
                    row.membership_status
                        ? {
                              role: row.membership_role,
                              status: row.membership_status
                          }
                        : null
            })
        );

        res.json({
            success: true,
            groups
        });
    } catch (error) {
        console.error("Get groups error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to load groups."
        });
    }
});

app.get("/api/groups/my", async (req, res) => {
    try {
        const userId = toId(req.query.userId);

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: "Valid user ID is required."
            });
        }

        const result = await pool.query(
            `
            SELECT
                g.*,
                u.full_name AS owner_name,
                u.profile_picture AS owner_profile_picture,

                (
                    SELECT COUNT(*)
                    FROM cherychat_group_members gm2
                    WHERE gm2.group_id = g.id
                      AND gm2.status = 'active'
                ) AS member_count,

                gm.role AS membership_role,
                gm.status AS membership_status

            FROM cherychat_group_members gm

            JOIN cherychat_groups g
                ON g.id = gm.group_id

            LEFT JOIN cherychat_users u
                ON u.id = g.owner_id

            WHERE gm.user_id = $1
              AND gm.status = 'active'

            ORDER BY g.created_at DESC
            `,
            [userId]
        );

        const groups = result.rows.map((row) =>
            formatGroup({
                ...row,
                membership: {
                    role: row.membership_role,
                    status: row.membership_status
                }
            })
        );

        res.json({
            success: true,
            groups
        });
    } catch (error) {
        console.error("My groups error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to load your groups."
        });
    }
});

app.get("/api/groups/:id", async (req, res) => {
    try {
        const groupId = toId(req.params.id);
        const userId = toId(req.query.userId);

        if (!groupId) {
            return res.status(400).json({
                success: false,
                message: "Invalid group ID."
            });
        }

        const group = await getGroup(groupId);

        if (!group) {
            return res.status(404).json({
                success: false,
                message: "Group not found."
            });
        }

        const membership = userId
            ? await getMembership(groupId, userId)
            : null;

        res.json({
            success: true,
            group: formatGroup({
                ...group,
                membership: membership
                    ? {
                          role: membership.role,
                          status: membership.status
                      }
                    : null
            })
        });
    } catch (error) {
        console.error("Get group error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to load group."
        });
    }
});

/* =========================================================
   GROUP JOIN
========================================================= */

app.post("/api/groups/:id/join", async (req, res) => {
    try {
        const groupId = toId(req.params.id);
        const userId = toId(req.body.userId);

        if (!groupId || !userId) {
            return res.status(400).json({
                success: false,
                message: "Group ID and user ID are required."
            });
        }

        if (!(await userExists(userId))) {
            return res.status(404).json({
                success: false,
                message: "User not found."
            });
        }

        const group = await getGroup(groupId);

        if (!group) {
            return res.status(404).json({
                success: false,
                message: "Group not found."
            });
        }

        const existing = await getMembership(groupId, userId);

        if (existing && existing.status === "active") {
            return res.json({
                success: true,
                message: "You are already a member of this group.",
                membership: existing
            });
        }

        if (group.group_type === "private") {
            return res.status(403).json({
                success: false,
                message: "This is a private group. Request to join instead."
            });
        }

        const result = await pool.query(
            `
            INSERT INTO cherychat_group_members
                (
                    group_id,
                    user_id,
                    role,
                    status
                )
            VALUES
                ($1, $2, 'member', 'active')
            ON CONFLICT (group_id, user_id)
            DO UPDATE SET
                status = 'active',
                role = CASE
                    WHEN cherychat_group_members.role = 'owner'
                    THEN 'owner'
                    ELSE 'member'
                END
            RETURNING *
            `,
            [groupId, userId]
        );

        res.json({
            success: true,
            message: "Joined group successfully.",
            membership: result.rows[0]
        });
    } catch (error) {
        console.error("Join group error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to join group."
        });
    }
});

app.post("/api/groups/:id/request", async (req, res) => {
    try {
        const groupId = toId(req.params.id);
        const userId = toId(req.body.userId);

        if (!groupId || !userId) {
            return res.status(400).json({
                success: false,
                message: "Group ID and user ID are required."
            });
        }

        if (!(await userExists(userId))) {
            return res.status(404).json({
                success: false,
                message: "User not found."
            });
        }

        const group = await getGroup(groupId);

        if (!group) {
            return res.status(404).json({
                success: false,
                message: "Group not found."
            });
        }

        if (group.owner_id === userId) {
            return res.status(400).json({
                success: false,
                message: "You already own this group."
            });
        }

        const membership = await getMembership(
            groupId,
            userId
        );

        if (membership && membership.status === "active") {
            return res.status(400).json({
                success: false,
                message: "You are already a member."
            });
        }

        const result = await pool.query(
            `
            INSERT INTO cherychat_group_join_requests
                (
                    group_id,
                    user_id,
                    status
                )
            VALUES
                ($1, $2, 'pending')
            ON CONFLICT (group_id, user_id)
            DO UPDATE SET
                status = 'pending',
                created_at = CURRENT_TIMESTAMP
            RETURNING *
            `,
            [groupId, userId]
        );

        res.status(201).json({
            success: true,
            message: "Join request sent.",
            request: result.rows[0]
        });
    } catch (error) {
        console.error("Group request error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to send join request."
        });
    }
});

/* =========================================================
   GROUP JOIN REQUESTS
========================================================= */

app.get("/api/groups/:id/requests", async (req, res) => {
    try {
        const groupId = toId(req.params.id);
        const userId = toId(req.query.userId);

        if (!groupId || !userId) {
            return res.status(400).json({
                success: false,
                message: "Group ID and user ID are required."
            });
        }

        if (!(await isAdminOrOwner(groupId, userId))) {
            return res.status(403).json({
                success: false,
                message: "Only group admins can view requests."
            });
        }

        const result = await pool.query(
            `
            SELECT
                r.*,
                u.full_name,
                u.email,
                u.phone,
                u.profile_picture,
                u.about
            FROM cherychat_group_join_requests r
            JOIN cherychat_users u
                ON u.id = r.user_id
            WHERE r.group_id = $1
            ORDER BY r.created_at DESC
            `,
            [groupId]
        );

        res.json({
            success: true,
            requests: result.rows.map((row) => ({
                id: row.id,
                requestId: row.id,
                groupId: row.group_id,
                userId: row.user_id,
                status: row.status,
                createdAt: row.created_at,
                user: {
                    id: row.user_id,
                    userId: row.user_id,
                    fullName: row.full_name,
                    email: row.email,
                    phone: row.phone,
                    profilePicture:
                        row.profile_picture ||
                        createAvatar(row.full_name),
                    about: row.about || "using VibeChat"
                }
            }))
        });
    } catch (error) {
        console.error("Get group requests error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to load join requests."
        });
    }
});

app.post(
    "/api/groups/:id/requests/:requestId",
    async (req, res) => {
        try {
            const groupId = toId(req.params.id);
            const requestId = toId(req.params.requestId);
            const adminId = toId(
                req.body.adminId || req.body.userId
            );

            const action = cleanText(
                req.body.action || req.body.status,
                30
            ).toLowerCase();

            if (!groupId || !requestId || !adminId) {
                return res.status(400).json({
                    success: false,
                    message: "Group, request and admin IDs are required."
                });
            }

            if (!(await isAdminOrOwner(groupId, adminId))) {
                return res.status(403).json({
                    success: false,
                    message: "Only group admins can manage requests."
                });
            }

            if (!["approve", "approved", "reject", "rejected"].includes(action)) {
                return res.status(400).json({
                    success: false,
                    message: "Action must be approve or reject."
                });
            }

            const requestResult = await pool.query(
                `
                SELECT *
                FROM cherychat_group_join_requests
                WHERE id = $1
                  AND group_id = $2
                LIMIT 1
                `,
                [requestId, groupId]
            );

            if (requestResult.rows.length === 0) {
                return res.status(404).json({
                    success: false,
                    message: "Join request not found."
                });
            }

            const request = requestResult.rows[0];

            const approved =
                action === "approve" ||
                action === "approved";

            if (approved) {
                await pool.query(
                    `
                    INSERT INTO cherychat_group_members
                        (
                            group_id,
                            user_id,
                            role,
                            status
                        )
                    VALUES
                        ($1, $2, 'member', 'active')
                    ON CONFLICT (group_id, user_id)
                    DO UPDATE SET
                        status = 'active',
                        role = CASE
                            WHEN cherychat_group_members.role = 'owner'
                            THEN 'owner'
                            ELSE 'member'
                        END
                    `,
                    [groupId, request.user_id]
                );
            }

            const updated = await pool.query(
                `
                UPDATE cherychat_group_join_requests
                SET status = $1
                WHERE id = $2
                RETURNING *
                `,
                [
                    approved ? "approved" : "rejected",
                    requestId
                ]
            );

            res.json({
                success: true,
                message: approved
                    ? "Join request approved."
                    : "Join request rejected.",
                request: updated.rows[0]
            });
        } catch (error) {
            console.error("Manage request error:", error);

            res.status(500).json({
                success: false,
                message: "Unable to manage join request."
            });
        }
    }
);

/* =========================================================
   GROUP MEMBERS
========================================================= */

app.get("/api/groups/:id/members", async (req, res) => {
    try {
        const groupId = toId(req.params.id);
        const userId = toId(req.query.userId);

        if (!groupId) {
            return res.status(400).json({
                success: false,
                message: "Invalid group ID."
            });
        }

        if (
            userId &&
            !(await isActiveMember(groupId, userId))
        ) {
            return res.status(403).json({
                success: false,
                message: "You must be a member to view group members."
            });
        }

        const result = await pool.query(
            `
            SELECT
                gm.id,
                gm.group_id,
                gm.user_id,
                gm.role,
                gm.status,
                gm.created_at,
                u.full_name,
                u.email,
                u.phone,
                u.profile_picture,
                u.about,
                u.is_online,
                u.last_seen
            FROM cherychat_group_members gm
            JOIN cherychat_users u
                ON u.id = gm.user_id
            WHERE gm.group_id = $1
              AND gm.status = 'active'
            ORDER BY
                CASE gm.role
                    WHEN 'owner' THEN 0
                    WHEN 'admin' THEN 1
                    ELSE 2
                END,
                u.full_name ASC
            `,
            [groupId]
        );

        res.json({
            success: true,
            members: result.rows.map((row) => ({
                id: row.id,
                membershipId: row.id,
                groupId: row.group_id,
                userId: row.user_id,
                role: row.role,
                status: row.status,
                createdAt: row.created_at,
                fullName: row.full_name,
                email: row.email,
                phone: row.phone,
                profilePicture:
                    row.profile_picture ||
                    createAvatar(row.full_name),
                about: row.about || "using VibeChat",
                isOnline: Boolean(row.is_online),
                lastSeen: row.last_seen
            }))
        });
    } catch (error) {
        console.error("Get group members error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to load group members."
        });
    }
});

/* =========================================================
   GROUP MESSAGES
========================================================= */

app.get("/api/groups/:id/messages", async (req, res) => {
    try {
        const groupId = toId(req.params.id);
        const userId = toId(req.query.userId);

        if (!groupId || !userId) {
            return res.status(400).json({
                success: false,
                message: "Group ID and user ID are required."
            });
        }

        if (!(await isActiveMember(groupId, userId))) {
            return res.status(403).json({
                success: false,
                message: "You must be a group member."
            });
        }

        const result = await pool.query(
            `
            SELECT
                gm.*,
                u.full_name AS sender_name,
                u.profile_picture AS sender_profile_picture
            FROM cherychat_group_messages gm
            JOIN cherychat_users u
                ON u.id = gm.sender_id
            WHERE gm.group_id = $1
            ORDER BY gm.created_at ASC, gm.id ASC
            LIMIT 1000
            `,
            [groupId]
        );

        res.json({
            success: true,
            messages: result.rows.map(formatGroupMessage)
        });
    } catch (error) {
        console.error("Get group messages error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to load group messages."
        });
    }
});

app.post("/api/groups/:id/messages", async (req, res) => {
    try {
        const groupId = toId(req.params.id);
        const senderId = toId(
            req.body.senderId || req.body.userId
        );

        const messageText = cleanText(
            req.body.messageText || req.body.message,
            10000
        );

        if (!groupId || !senderId || !messageText) {
            return res.status(400).json({
                success: false,
                message: "Group, sender and message are required."
            });
        }

        if (!(await isActiveMember(groupId, senderId))) {
            return res.status(403).json({
                success: false,
                message: "You must be a group member to send messages."
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
            RETURNING *
            `,
            [
                groupId,
                senderId,
                messageText
            ]
        );

        const messageResult = await pool.query(
            `
            SELECT
                gm.*,
                u.full_name AS sender_name,
                u.profile_picture AS sender_profile_picture
            FROM cherychat_group_messages gm
            JOIN cherychat_users u
                ON u.id = gm.sender_id
            WHERE gm.id = $1
            `,
            [result.rows[0].id]
        );

        res.status(201).json({
            success: true,
            message: formatGroupMessage(
                messageResult.rows[0]
            )
        });
    } catch (error) {
        console.error("Send group message error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to send group message."
        });
    }
});

/* =========================================================
   GROUP LEAVE / MEMBER MANAGEMENT
========================================================= */

app.post("/api/groups/:id/leave", async (req, res) => {
    try {
        const groupId = toId(req.params.id);
        const userId = toId(req.body.userId);

        if (!groupId || !userId) {
            return res.status(400).json({
                success: false,
                message: "Group ID and user ID are required."
            });
        }

        const membership = await getMembership(
            groupId,
            userId
        );

        if (!membership || membership.status !== "active") {
            return res.status(400).json({
                success: false,
                message: "You are not an active member."
            });
        }

        if (membership.role === "owner") {
            return res.status(400).json({
                success: false,
                message: "The group owner cannot leave. Transfer ownership or delete the group."
            });
        }

        await pool.query(
            `
            UPDATE cherychat_group_members
            SET status = 'left'
            WHERE group_id = $1
              AND user_id = $2
            `,
            [groupId, userId]
        );

        res.json({
            success: true,
            message: "You left the group."
        });
    } catch (error) {
        console.error("Leave group error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to leave group."
        });
    }
});

app.delete(
    "/api/groups/:id/members/:memberId",
    async (req, res) => {
        try {
            const groupId = toId(req.params.id);
            const memberId = toId(req.params.memberId);
            const adminId = toId(
                req.body.adminId || req.body.userId
            );

            if (!groupId || !memberId || !adminId) {
                return res.status(400).json({
                    success: false,
                    message: "Group, member and admin IDs are required."
                });
            }

            if (!(await isAdminOrOwner(groupId, adminId))) {
                return res.status(403).json({
                    success: false,
                    message: "Only admins can remove members."
                });
            }

            const target = await getMembership(
                groupId,
                memberId
            );

            if (!target || target.status !== "active") {
                return res.status(404).json({
                    success: false,
                    message: "Active member not found."
                });
            }

            if (target.role === "owner") {
                return res.status(400).json({
                    success: false,
                    message: "The group owner cannot be removed."
                });
            }

            await pool.query(
                `
                UPDATE cherychat_group_members
                SET status = 'removed'
                WHERE group_id = $1
                  AND user_id = $2
                `,
                [groupId, memberId]
            );

            res.json({
                success: true,
                message: "Member removed."
            });
        } catch (error) {
            console.error("Remove member error:", error);

            res.status(500).json({
                success: false,
                message: "Unable to remove member."
            });
        }
    }
);

app.post(
    "/api/groups/:id/members/:memberId/admin",
    async (req, res) => {
        try {
            const groupId = toId(req.params.id);
            const memberId = toId(req.params.memberId);
            const adminId = toId(
                req.body.adminId || req.body.userId
            );

            if (!groupId || !memberId || !adminId) {
                return res.status(400).json({
                    success: false,
                    message: "Group, member and admin IDs are required."
                });
            }

            if (!(await isAdminOrOwner(groupId, adminId))) {
                return res.status(403).json({
                    success: false,
                    message: "Only admins can promote members."
                });
            }

            const target = await getMembership(
                groupId,
                memberId
            );

            if (!target || target.status !== "active") {
                return res.status(404).json({
                    success: false,
                    message: "Active member not found."
                });
            }

            if (target.role === "owner") {
                return res.status(400).json({
                    success: false,
                    message: "The owner is already above admin."
                });
            }

            const result = await pool.query(
                `
                UPDATE cherychat_group_members
                SET role = 'admin'
                WHERE group_id = $1
                  AND user_id = $2
                RETURNING *
                `,
                [groupId, memberId]
            );

            res.json({
                success: true,
                message: "Member promoted to admin.",
                membership: result.rows[0]
            });
        } catch (error) {
            console.error("Promote admin error:", error);

            res.status(500).json({
                success: false,
                message: "Unable to promote member."
            });
        }
    }
);

app.delete(
    "/api/groups/:id/members/:memberId/admin",
    async (req, res) => {
        try {
            const groupId = toId(req.params.id);
            const memberId = toId(req.params.memberId);
            const adminId = toId(
                req.body.adminId || req.body.userId
            );

            if (!groupId || !memberId || !adminId) {
                return res.status(400).json({
                    success: false,
                    message: "Group, member and admin IDs are required."
                });
            }

            if (!(await isAdminOrOwner(groupId, adminId))) {
                return res.status(403).json({
                    success: false,
                    message: "Only admins can remove admin status."
                });
            }

            const target = await getMembership(
                groupId,
                memberId
            );

            if (!target || target.status !== "active") {
                return res.status(404).json({
                    success: false,
                    message: "Active member not found."
                });
            }

            if (target.role === "owner") {
                return res.status(400).json({
                    success: false,
                    message: "The owner cannot lose owner status here."
                });
            }

            const result = await pool.query(
                `
                UPDATE cherychat_group_members
                SET role = 'member'
                WHERE group_id = $1
                  AND user_id = $2
                RETURNING *
                `,
                [groupId, memberId]
            );

            res.json({
                success: true,
                message: "Admin status removed.",
                membership: result.rows[0]
            });
        } catch (error) {
            console.error("Remove admin error:", error);

            res.status(500).json({
                success: false,
                message: "Unable to remove admin status."
            });
        }
    }
);

/* =========================================================
   UPDATE GROUP
========================================================= */

app.put("/api/groups/:id", async (req, res) => {
    try {
        const groupId = toId(req.params.id);
        const userId = toId(
            req.body.userId || req.body.adminId
        );

        if (!groupId || !userId) {
            return res.status(400).json({
                success: false,
                message: "Group ID and user ID are required."
            });
        }

        if (!(await isAdminOrOwner(groupId, userId))) {
            return res.status(403).json({
                success: false,
                message: "Only group admins can update the group."
            });
        }

        const current = await getGroup(groupId);

        if (!current) {
            return res.status(404).json({
                success: false,
                message: "Group not found."
            });
        }

        const name =
            req.body.name !== undefined
                ? cleanGroupName(req.body.name)
                : current.name;

        const description =
            req.body.description !== undefined
                ? cleanDescription(req.body.description)
                : current.description;

        const groupType =
            req.body.groupType !== undefined
                ? cleanText(req.body.groupType, 20).toLowerCase()
                : current.group_type;

        const visibility =
            req.body.visibility !== undefined
                ? cleanText(req.body.visibility, 20).toLowerCase()
                : current.visibility;

        if (!name) {
            return res.status(400).json({
                success: false,
                message: "Group name cannot be empty."
            });
        }

        const safeGroupType =
            groupType === "private" ? "private" : "public";

        const safeVisibility =
            visibility === "private" ? "private" : "public";

        const result = await pool.query(
            `
            UPDATE cherychat_groups
            SET
                name = $1,
                description = $2,
                group_type = $3,
                visibility = $4
            WHERE id = $5
            RETURNING *
            `,
            [
                name,
                description,
                safeGroupType,
                safeVisibility,
                groupId
            ]
        );

        const finalGroup = await getGroup(groupId);

        res.json({
            success: true,
            message: "Group updated successfully.",
            group: formatGroup(finalGroup)
        });
    } catch (error) {
        console.error("Update group error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to update group."
        });
    }
});

/* =========================================================
   DELETE GROUP
========================================================= */

app.delete("/api/groups/:id", async (req, res) => {
    try {
        const groupId = toId(req.params.id);
        const userId = toId(
            req.body.userId || req.query.userId
        );

        if (!groupId || !userId) {
            return res.status(400).json({
                success: false,
                message: "Group ID and user ID are required."
            });
        }

        const group = await getGroup(groupId);

        if (!group) {
            return res.status(404).json({
                success: false,
                message: "Group not found."
            });
        }

        if (group.owner_id !== userId) {
            return res.status(403).json({
                success: false,
                message: "Only the group owner can delete the group."
            });
        }

        await pool.query(
            `
            DELETE FROM cherychat_groups
            WHERE id = $1
            `,
            [groupId]
        );

        res.json({
            success: true,
            message: "Group deleted successfully."
        });
    } catch (error) {
        console.error("Delete group error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to delete group."
        });
    }
});

/* =========================================================
   GROUP INVITE
========================================================= */

app.get("/api/groups/:id/invite", async (req, res) => {
    try {
        const groupId = toId(req.params.id);
        const userId = toId(req.query.userId);

        if (!groupId || !userId) {
            return res.status(400).json({
                success: false,
                message: "Group ID and user ID are required."
            });
        }

        const group = await getGroup(groupId);

        if (!group) {
            return res.status(404).json({
                success: false,
                message: "Group not found."
            });
        }

        if (!(await isActiveMember(groupId, userId))) {
            return res.status(403).json({
                success: false,
                message: "You must be a member to get the invite."
            });
        }

        res.json({
            success: true,
            inviteCode: group.invite_code,
            groupId: group.id,
            inviteLink: `/join-group.html?code=${encodeURIComponent(
                group.invite_code
            )}`
        });
    } catch (error) {
        console.error("Group invite error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to generate group invite."
        });
    }
});

/* =========================================================
   INVITE CODE JOIN
========================================================= */

app.post("/api/groups/join-by-code", async (req, res) => {
    try {
        const userId = toId(req.body.userId);
        const inviteCode = cleanText(
            req.body.inviteCode,
            100
        ).toUpperCase();

        if (!userId || !inviteCode) {
            return res.status(400).json({
                success: false,
                message: "User ID and invite code are required."
            });
        }

        if (!(await userExists(userId))) {
            return res.status(404).json({
                success: false,
                message: "User not found."
            });
        }

        const groupResult = await pool.query(
            `
            SELECT id
            FROM cherychat_groups
            WHERE invite_code = $1
            LIMIT 1
            `,
            [inviteCode]
        );

        if (groupResult.rows.length === 0) {
            return res.status(404).json({
                success: false,
                message: "Invalid group invite code."
            });
        }

        const groupId = groupResult.rows[0].id;
        const group = await getGroup(groupId);

        const existing = await getMembership(
            groupId,
            userId
        );

        if (existing && existing.status === "active") {
            return res.json({
                success: true,
                message: "You are already a member.",
                group: formatGroup(group)
            });
        }

        await pool.query(
            `
            INSERT INTO cherychat_group_members
                (
                    group_id,
                    user_id,
                    role,
                    status
                )
            VALUES
                ($1, $2, 'member', 'active')
            ON CONFLICT (group_id, user_id)
            DO UPDATE SET
                status = 'active'
            `,
            [groupId, userId]
        );

        res.json({
            success: true,
            message: "Joined group successfully.",
            group: formatGroup(group)
        });
    } catch (error) {
        console.error("Join by code error:", error);

        res.status(500).json({
            success: false,
            message: "Unable to join group."
        });
    }
});

/* =========================================================
   404
========================================================= */

app.use((req, res) => {
    res.status(404).json({
        success: false,
        message: "VibeChat API route not found.",
        path: req.path
    });
});

/* =========================================================
   GLOBAL ERROR HANDLER
========================================================= */

app.use((error, req, res, next) => {
    console.error("Unhandled server error:", error);

    if (res.headersSent) {
        return next(error);
    }

    res.status(500).json({
        success: false,
        message: "An unexpected server error occurred."
    });
});

/* =========================================================
   START SERVER
========================================================= */

async function startServer() {
    try {
        await initializeDatabase();

        app.listen(PORT, () => {
            console.log(`VibeChat backend running on port ${PORT}`);
        });
    } catch (error) {
        console.error(
            "Failed to initialize VibeChat backend:",
            error
        );

        process.exit(1);
    }
}

startServer();
