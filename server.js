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

function cleanText(value, max = 1000) {
    return String(value || "").trim().slice(0, max);
}

function cleanGroupName(value) {
    return cleanText(value, 100);
}

function cleanDescription(value) {
    return cleanText(value, 500);
}

function generateInviteCode() {
    return crypto.randomBytes(5).toString("hex").toUpperCase();
}

function createAvatar(name) {
    return (
        "https://ui-avatars.com/api/?name=" +
        encodeURIComponent(name || "User") +
        "&background=241538&color=ffd54a&bold=true"
    );
}

async function userExists(userId) {
    const result = await pool.query(
        "SELECT id FROM cherychat_users WHERE id = $1",
        [userId]
    );

    return result.rows.length > 0;
}

async function getGroup(groupId) {
    const result = await pool.query(
        "SELECT * FROM cherychat_groups WHERE id = $1",
        [groupId]
    );

    return result.rows[0] || null;
}

async function getMembership(groupId, userId) {
    const result = await pool.query(
        `
        SELECT *
        FROM cherychat_group_members
        WHERE group_id = $1
        AND user_id = $2
        `,
        [groupId, userId]
    );

    return result.rows[0] || null;
}

async function isActiveMember(groupId, userId) {
    const result = await pool.query(
        `
        SELECT id
        FROM cherychat_group_members
        WHERE group_id = $1
        AND user_id = $2
        AND status = 'active'
        `,
        [groupId, userId]
    );

    return result.rows.length > 0;
}

async function isAdminOrOwner(groupId, userId) {
    const result = await pool.query(
        `
        SELECT role
        FROM cherychat_group_members
        WHERE group_id = $1
        AND user_id = $2
        AND status = 'active'
        `,
        [groupId, userId]
    );

    if (!result.rows.length) return false;

    return ["owner", "admin"].includes(result.rows[0].role);
}

function formatUser(row) {
    if (!row) return null;

    return {
        id: row.id,
        fullName: row.full_name,
        full_name: row.full_name,
        email: row.email,
        phone: row.phone,
        profilePicture:
            row.profile_picture || createAvatar(row.full_name),
        profile_picture:
            row.profile_picture || createAvatar(row.full_name),
        about: row.about || "Hey there! I am using VibeChat.",
        isOnline: !!row.is_online,
        is_online: !!row.is_online,
        lastSeen: row.last_seen,
        last_seen: row.last_seen,
        createdAt: row.created_at
    };
}

function formatGroup(row) {
    if (!row) return null;

    return {
        id: row.id,
        name: row.name,
        description: row.description || "",
        groupType: row.group_type,
        group_type: row.group_type,
        visibility: row.visibility,
        inviteCode: row.invite_code,
        invite_code: row.invite_code,
        ownerId: row.owner_id,
        owner_id: row.owner_id,
        createdAt: row.created_at
    };
}

/* =========================================================
   DATABASE INITIALIZATION
========================================================= */

async function initializeDatabase() {
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
                REFERENCES cherychat_conversations(id)
                ON DELETE CASCADE,
            sender_id INTEGER NOT NULL
                REFERENCES cherychat_users(id)
                ON DELETE CASCADE,
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
            group_type VARCHAR(20) DEFAULT 'public',
            visibility VARCHAR(20) DEFAULT 'public',
            invite_code VARCHAR(30) UNIQUE NOT NULL,
            owner_id INTEGER NOT NULL
                REFERENCES cherychat_users(id)
                ON DELETE CASCADE,
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS cherychat_group_members (
            id SERIAL PRIMARY KEY,
            group_id INTEGER NOT NULL
                REFERENCES cherychat_groups(id)
                ON DELETE CASCADE,
            user_id INTEGER NOT NULL
                REFERENCES cherychat_users(id)
                ON DELETE CASCADE,
            role VARCHAR(20) DEFAULT 'member',
            status VARCHAR(20) DEFAULT 'active',
            joined_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(group_id, user_id)
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS cherychat_group_join_requests (
            id SERIAL PRIMARY KEY,
            group_id INTEGER NOT NULL
                REFERENCES cherychat_groups(id)
                ON DELETE CASCADE,
            user_id INTEGER NOT NULL
                REFERENCES cherychat_users(id)
                ON DELETE CASCADE,
            status VARCHAR(20) DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
            UNIQUE(group_id, user_id)
        )
    `);

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
        )
    `);

    await pool.query(`
        CREATE TABLE IF NOT EXISTS cherychat_group_payments (
            id SERIAL PRIMARY KEY,
            group_id INTEGER NOT NULL
                REFERENCES cherychat_groups(id)
                ON DELETE CASCADE,
            user_id INTEGER NOT NULL
                REFERENCES cherychat_users(id)
                ON DELETE CASCADE,
            amount NUMERIC(12,2) DEFAULT 0,
            reference VARCHAR(100),
            status VARCHAR(30) DEFAULT 'pending',
            created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    console.log("VibeChat database ready.");
}

/* =========================================================
   ROOT
========================================================= */

app.get("/", (req, res) => {
    res.json({
        success: true,
        app: "VibeChat",
        message: "VibeChat backend is running."
    });
});

app.get("/api/test", (req, res) => {
    res.json({
        success: true,
        message: "VibeChat API is working."
    });
});

/* =========================================================
   REGISTER
========================================================= */

app.post("/api/register", async (req, res) => {
    try {
        const fullName = cleanText(req.body.fullName || req.body.full_name, 100);
        const email = cleanText(req.body.email, 255).toLowerCase();
        const phone = cleanText(req.body.phone, 30);
        const password = String(req.body.password || "");

        if (!fullName || !email || !phone || !password) {
            return res.status(400).json({
                success: false,
                message: "Please fill in all required fields."
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
            `,
            [email, phone]
        );

        if (existing.rows.length) {
            return res.status(409).json({
                success: false,
                message: "Email or phone number is already registered."
            });
        }

        const passwordHash = await bcrypt.hash(password, 10);

        const result = await pool.query(
            `
            INSERT INTO cherychat_users
            (
                full_name,
                email,
                phone,
                password_hash,
                about,
                is_online
            )
            VALUES ($1, $2, $3, $4, $5, FALSE)
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
                email,
                phone,
                passwordHash,
                "Hey there! I am using VibeChat."
            ]
        );

        const user = formatUser(result.rows[0]);

        res.status(201).json({
            success: true,
            message: "Registration successful.",
            user
        });
    } catch (error) {
        console.error("REGISTER ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Unable to register user."
        });
    }
});

/* =========================================================
   LOGIN
========================================================= */

app.post("/api/login", async (req, res) => {
    try {
        const identifier = cleanText(
            req.body.email ||
            req.body.phone ||
            req.body.identifier,
            255
        );

        const password = String(req.body.password || "");

        if (!identifier || !password) {
            return res.status(400).json({
                success: false,
                message: "Enter your email/phone and password."
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

        if (!result.rows.length) {
            return res.status(401).json({
                success: false,
                message: "Invalid login details."
            });
        }

        const userRow = result.rows[0];

        const validPassword = await bcrypt.compare(
            password,
            userRow.password_hash
        );

        if (!validPassword) {
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
            [userRow.id]
        );

        userRow.is_online = true;

        res.json({
            success: true,
            message: "Login successful.",
            user: formatUser(userRow)
        });
    } catch (error) {
        console.error("LOGIN ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Unable to login."
        });
    }
});

/* =========================================================
   USER STATUS
========================================================= */

app.put("/api/users/:id/online", async (req, res) => {
    try {
        const userId = toId(req.params.id);

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: "Invalid user ID."
            });
        }

        await pool.query(
            `
            UPDATE cherychat_users
            SET is_online = TRUE,
                last_seen = CURRENT_TIMESTAMP
            WHERE id = $1
            `,
            [userId]
        );

        res.json({
            success: true
        });
    } catch (error) {
        console.error("ONLINE ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Unable to update online status."
        });
    }
});

app.put("/api/users/:id/offline", async (req, res) => {
    try {
        const userId = toId(req.params.id);

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: "Invalid user ID."
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
            success: true
        });
    } catch (error) {
        console.error("OFFLINE ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Unable to update offline status."
        });
    }
});

/* =========================================================
   UPDATE PROFILE PICTURE
========================================================= */

app.put("/api/users/:id/profile-picture", async (req, res) => {
    try {
        const userId = toId(req.params.id);

        const profilePicture = String(
            req.body.profilePicture || ""
        ).trim();

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: "Valid user ID is required."
            });
        }

        if (!profilePicture) {
            return res.status(400).json({
                success: false,
                message: "Profile picture is required."
            });
        }

        const imagePattern =
            /^data:image\/(jpeg|jpg|png|webp);base64,[A-Za-z0-9+/=\s]+$/i;

        if (!imagePattern.test(profilePicture)) {
            return res.status(400).json({
                success: false,
                message: "Please upload a valid JPG, PNG or WEBP image."
            });
        }

        const base64Part =
            profilePicture.split(",")[1] || "";

        const estimatedBytes =
            Math.ceil((base64Part.length * 3) / 4);

        const maxBytes = 2 * 1024 * 1024;

        if (estimatedBytes > maxBytes) {
            return res.status(400).json({
                success: false,
                message: "Profile picture must be 2MB or smaller."
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
            [profilePicture, userId]
        );

        if (!result.rows.length) {
            return res.status(404).json({
                success: false,
                message: "User not found."
            });
        }

        res.json({
            success: true,
            message: "Profile picture updated successfully.",
            user: formatUser(result.rows[0])
        });
    } catch (error) {
        console.error(
            "VIBECHAT PROFILE PICTURE UPDATE ERROR:",
            error
        );

        res.status(500).json({
            success: false,
            message: "Unable to update profile picture."
        });
    }
});

/* =========================================================
   UPDATE PROFILE
========================================================= */

app.put("/api/users/:id/profile", async (req, res) => {
    try {
        const userId = toId(req.params.id);

        const fullName = cleanText(
            req.body.fullName || req.body.full_name,
            100
        );

        const about = cleanText(
            req.body.about,
            300
        );

        if (!userId || !fullName) {
            return res.status(400).json({
                success: false,
                message: "Name is required."
            });
        }

        const result = await pool.query(
            `
            UPDATE cherychat_users
            SET full_name = $1,
                about = $2
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
                about || "Hey there! I am using VibeChat.",
                userId
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
            message: "Profile updated successfully.",
            user: formatUser(result.rows[0])
        });
    } catch (error) {
        console.error("PROFILE UPDATE ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Unable to update profile."
        });
    }
});

/* =========================================================
   GET USER
========================================================= */

app.get("/api/users/:id", async (req, res) => {
    try {
        const userId = toId(req.params.id);

        if (!userId) {
            return res.status(400).json({
                success: false,
                message: "Invalid user ID."
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
            [userId]
        );

        if (!result.rows.length) {
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
        console.error("GET USER ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Unable to get user."
        });
    }
});

/* =========================================================
   SEARCH USERS
========================================================= */

app.get("/api/users/search", async (req, res) => {
    try {
        const q = cleanText(req.query.q, 100);
        const currentUserId = toId(req.query.userId);

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
                AND ($2::INTEGER IS NULL OR id <> $2)
            ORDER BY
                CASE
                    WHEN LOWER(full_name) = LOWER($3)
                    THEN 0
                    ELSE 1
                END,
                full_name ASC
            LIMIT 30
            `,
            [
                `%${q}%`,
                currentUserId,
                q
            ]
        );

        res.json({
            success: true,
            users: result.rows.map(formatUser)
        });
    } catch (error) {
        console.error("SEARCH USERS ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Unable to search users."
        });
    }
});

/* =========================================================
   CONVERSATION
========================================================= */

app.post("/api/conversations", async (req, res) => {
    try {
        const userId = toId(req.body.userId);
        const otherUserId = toId(req.body.otherUserId);

        if (!userId || !otherUserId || userId === otherUserId) {
            return res.status(400).json({
                success: false,
                message: "Invalid users."
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

        const one = Math.min(userId, otherUserId);
        const two = Math.max(userId, otherUserId);

        const result = await pool.query(
            `
            INSERT INTO cherychat_conversations
            (user_one, user_two)
            VALUES ($1, $2)
            ON CONFLICT (user_one, user_two)
            DO UPDATE SET user_one = EXCLUDED.user_one
            RETURNING id, user_one, user_two, created_at
            `,
            [one, two]
        );

        res.json({
            success: true,
            conversation: result.rows[0]
        });
    } catch (error) {
        console.error("CREATE CONVERSATION ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Unable to create conversation."
        });
    }
});

/* =========================================================
   GET CONVERSATIONS
========================================================= */

app.get("/api/conversations", async (req, res) => {
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
                c.id,
                c.created_at,
                u.id AS other_id,
                u.full_name AS other_name,
                u.email AS other_email,
                u.phone AS other_phone,
                u.profile_picture AS other_picture,
                u.about AS other_about,
                u.is_online AS other_online,
                u.last_seen AS other_last_seen,

                (
                    SELECT m.message_text
                    FROM cherychat_messages m
                    WHERE m.conversation_id = c.id
                    ORDER BY m.created_at DESC
                    LIMIT 1
                ) AS last_message,

                (
                    SELECT m.created_at
                    FROM cherychat_messages m
                    WHERE m.conversation_id = c.id
                    ORDER BY m.created_at DESC
                    LIMIT 1
                ) AS last_message_time

            FROM cherychat_conversations c

            JOIN cherychat_users u
            ON u.id =
                CASE
                    WHEN c.user_one = $1 THEN c.user_two
                    ELSE c.user_one
                END

            WHERE c.user_one = $1
            OR c.user_two = $1

            ORDER BY
                COALESCE(
                    (
                        SELECT m.created_at
                        FROM cherychat_messages m
                        WHERE m.conversation_id = c.id
                        ORDER BY m.created_at DESC
                        LIMIT 1
                    ),
                    c.created_at
                ) DESC
            `,
            [userId]
        );

        res.json({
            success: true,
            conversations: result.rows.map(row => ({
                id: row.id,
                otherUser: {
                    id: row.other_id,
                    fullName: row.other_name,
                    full_name: row.other_name,
                    email: row.other_email,
                    phone: row.other_phone,
                    profilePicture:
                        row.other_picture ||
                        createAvatar(row.other_name),
                    profile_picture:
                        row.other_picture ||
                        createAvatar(row.other_name),
                    about: row.other_about,
                    isOnline: !!row.other_online,
                    is_online: !!row.other_online,
                    lastSeen: row.other_last_seen,
                    last_seen: row.other_last_seen
                },
                lastMessage: row.last_message || "",
                lastMessageTime: row.last_message_time
            }))
        });
    } catch (error) {
        console.error("GET CONVERSATIONS ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Unable to load conversations."
        });
    }
});

/* =========================================================
   SEND MESSAGE
========================================================= */

app.post("/api/messages", async (req, res) => {
    try {
        const senderId = toId(req.body.senderId);
        const receiverId = toId(req.body.receiverId);
        const messageText = cleanText(req.body.messageText, 5000);

        if (!senderId || !receiverId || !messageText) {
            return res.status(400).json({
                success: false,
                message: "Message details are required."
            });
        }

        const one = Math.min(senderId, receiverId);
        const two = Math.max(senderId, receiverId);

        const conversation = await pool.query(
            `
            INSERT INTO cherychat_conversations
            (user_one, user_two)
            VALUES ($1, $2)
            ON CONFLICT (user_one, user_two)
            DO UPDATE SET user_one = EXCLUDED.user_one
            RETURNING id
            `,
            [one, two]
        );

        const conversationId = conversation.rows[0].id;

        const result = await pool.query(
            `
            INSERT INTO cherychat_messages
            (
                conversation_id,
                sender_id,
                message_text
            )
            VALUES ($1, $2, $3)
            RETURNING id, conversation_id, sender_id,
                      message_text, is_read, created_at
            `,
            [
                conversationId,
                senderId,
                messageText
            ]
        );

        res.status(201).json({
            success: true,
            message: result.rows[0]
        });
    } catch (error) {
        console.error("SEND MESSAGE ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Unable to send message."
        });
    }
});

/* =========================================================
   GET MESSAGES
========================================================= */

app.get("/api/messages", async (req, res) => {
    try {
        const userId = toId(req.query.userId);
        const otherUserId = toId(req.query.otherUserId);

        if (!userId || !otherUserId) {
            return res.status(400).json({
                success: false,
                message: "Invalid users."
            });
        }

        const one = Math.min(userId, otherUserId);
        const two = Math.max(userId, otherUserId);

        const conversation = await pool.query(
            `
            SELECT id
            FROM cherychat_conversations
            WHERE user_one = $1
            AND user_two = $2
            `,
            [one, two]
        );

        if (!conversation.rows.length) {
            return res.json({
                success: true,
                messages: []
            });
        }

        const conversationId = conversation.rows[0].id;

        const result = await pool.query(
            `
            SELECT
                m.id,
                m.conversation_id,
                m.sender_id,
                m.message_text,
                m.is_read,
                m.created_at,
                u.full_name AS sender_name,
                u.profile_picture AS sender_picture
            FROM cherychat_messages m
            JOIN cherychat_users u
            ON u.id = m.sender_id
            WHERE m.conversation_id = $1
            ORDER BY m.created_at ASC
            `,
            [conversationId]
        );

        res.json({
            success: true,
            conversationId,
            messages: result.rows.map(row => ({
                id: row.id,
                conversationId: row.conversation_id,
                senderId: row.sender_id,
                senderName: row.sender_name,
                senderPicture:
                    row.sender_picture ||
                    createAvatar(row.sender_name),
                messageText: row.message_text,
                isRead: row.is_read,
                createdAt: row.created_at
            }))
        });
    } catch (error) {
        console.error("GET MESSAGES ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Unable to load messages."
        });
    }
});

/* =========================================================
   MARK MESSAGES READ
========================================================= */

app.put("/api/messages/read", async (req, res) => {
    try {
        const userId = toId(req.body.userId);
        const otherUserId = toId(req.body.otherUserId);

        if (!userId || !otherUserId) {
            return res.status(400).json({
                success: false,
                message: "Invalid users."
            });
        }

        const one = Math.min(userId, otherUserId);
        const two = Math.max(userId, otherUserId);

        const conversation = await pool.query(
            `
            SELECT id
            FROM cherychat_conversations
            WHERE user_one = $1
            AND user_two = $2
            `,
            [one, two]
        );

        if (!conversation.rows.length) {
            return res.json({ success: true });
        }

        await pool.query(
            `
            UPDATE cherychat_messages
            SET is_read = TRUE
            WHERE conversation_id = $1
            AND sender_id = $2
            `,
            [
                conversation.rows[0].id,
                otherUserId
            ]
        );

        res.json({
            success: true
        });
    } catch (error) {
        console.error("READ MESSAGE ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Unable to mark messages read."
        });
    }
});

/* =========================================================
   CREATE GROUP
========================================================= */

app.post("/api/groups", async (req, res) => {
    try {
        const ownerId = toId(req.body.ownerId);
        const name = cleanGroupName(req.body.name);
        const description = cleanDescription(req.body.description);
        const groupType =
            req.body.groupType === "private"
                ? "private"
                : "public";

        if (!ownerId || !name) {
            return res.status(400).json({
                success: false,
                message: "Group name is required."
            });
        }

        if (!(await userExists(ownerId))) {
            return res.status(404).json({
                success: false,
                message: "Owner not found."
            });
        }

        let inviteCode = generateInviteCode();

        while (
            (
                await pool.query(
                    `
                    SELECT id
                    FROM cherychat_groups
                    WHERE invite_code = $1
                    `,
                    [inviteCode]
                )
            ).rows.length
        ) {
            inviteCode = generateInviteCode();
        }

        const groupResult = await pool.query(
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
            VALUES ($1, $2, $3, $4, $5, $6)
            RETURNING *
            `,
            [
                name,
                description,
                groupType,
                groupType === "private"
                    ? "private"
                    : "public",
                inviteCode,
                ownerId
            ]
        );

        const group = groupResult.rows[0];

        await pool.query(
            `
            INSERT INTO cherychat_group_members
            (
                group_id,
                user_id,
                role,
                status
            )
            VALUES ($1, $2, 'owner', 'active')
            `,
            [group.id, ownerId]
        );

        res.status(201).json({
            success: true,
            message: "Group created successfully.",
            group: formatGroup(group)
        });
    } catch (error) {
        console.error("CREATE GROUP ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Unable to create group."
        });
    }
});

/* =========================================================
   DISCOVER GROUPS
========================================================= */

app.get("/api/groups", async (req, res) => {
    try {
        const userId = toId(req.query.userId);
        const q = cleanText(req.query.q, 100);

        const result = await pool.query(
            `
            SELECT
                g.*,
                u.full_name AS owner_name,
                (
                    SELECT COUNT(*)
                    FROM cherychat_group_members gm
                    WHERE gm.group_id = g.id
                    AND gm.status = 'active'
                ) AS member_count
            FROM cherychat_groups g
            JOIN cherychat_users u
            ON u.id = g.owner_id
            WHERE
                g.visibility = 'public'
                AND (
                    $1 = ''
                    OR g.name ILIKE '%' || $1 || '%'
                    OR g.description ILIKE '%' || $1 || '%'
                )
            ORDER BY g.created_at DESC
            LIMIT 100
            `,
            [q]
        );

        const groups = [];

        for (const row of result.rows) {
            let membership = null;

            if (userId) {
                membership = await getMembership(
                    row.id,
                    userId
                );
            }

            groups.push({
                ...formatGroup(row),
                ownerName: row.owner_name,
                memberCount: Number(row.member_count || 0),
                membership: membership
                    ? {
                          role: membership.role,
                          status: membership.status
                      }
                    : null
            });
        }

        res.json({
            success: true,
            groups
        });
    } catch (error) {
        console.error("GET GROUPS ERROR:", error);

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
                gm.role,
                (
                    SELECT COUNT(*)
                    FROM cherychat_group_members members
                    WHERE members.group_id = g.id
                    AND members.status = 'active'
                ) AS member_count
            FROM cherychat_group_members gm
            JOIN cherychat_groups g
            ON g.id = gm.group_id
            WHERE gm.user_id = $1
            AND gm.status = 'active'
            ORDER BY g.created_at DESC
            `,
            [userId]
        );

        res.json({
            success: true,
            groups: result.rows.map(row => ({
                ...formatGroup(row),
                role: row.role,
                memberCount: Number(row.member_count || 0)
            }))
        });
    } catch (error) {
        console.error("MY GROUPS ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Unable to load your groups."
        });
    }
});

/* =========================================================
   GROUP DETAILS
========================================================= */

app.get("/api/groups/:id", async (req, res) => {
    try {
        const groupId = toId(req.params.id);
        const userId = toId(req.query.userId);

        if (!groupId) {
            return res.status(400).json({
                success: false,
                message: "Invalid group."
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
            group: {
                ...formatGroup(group),
                membership: membership
                    ? {
                          role: membership.role,
                          status: membership.status
                      }
                    : null
            }
        });
    } catch (error) {
        console.error("GROUP DETAILS ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Unable to load group."
        });
    }
});

/* =========================================================
   JOIN PUBLIC GROUP
========================================================= */

app.post("/api/groups/:id/join", async (req, res) => {
    try {
        const groupId = toId(req.params.id);
        const userId = toId(req.body.userId);

        if (!groupId || !userId) {
            return res.status(400).json({
                success: false,
                message: "Invalid request."
            });
        }

        const group = await getGroup(groupId);

        if (!group) {
            return res.status(404).json({
                success: false,
                message: "Group not found."
            });
        }

        if (group.group_type === "private") {
            return res.status(403).json({
                success: false,
                message: "This is a private group."
            });
        }

        const existing = await getMembership(
            groupId,
            userId
        );

        if (existing) {
            if (existing.status === "active") {
                return res.json({
                    success: true,
                    message: "You are already a member."
                });
            }

            await pool.query(
                `
                UPDATE cherychat_group_members
                SET status = 'active',
                    role = 'member',
                    joined_at = CURRENT_TIMESTAMP
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
                    status
                )
                VALUES ($1, $2, 'member', 'active')
                `,
                [groupId, userId]
            );
        }

        res.json({
            success: true,
            message: "You joined the group."
        });
    } catch (error) {
        console.error("JOIN GROUP ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Unable to join group."
        });
    }
});

/* =========================================================
   PRIVATE GROUP REQUEST
========================================================= */

app.post("/api/groups/:id/request", async (req, res) => {
    try {
        const groupId = toId(req.params.id);
        const userId = toId(req.body.userId);

        if (!groupId || !userId) {
            return res.status(400).json({
                success: false,
                message: "Invalid request."
            });
        }

        const group = await getGroup(groupId);

        if (!group) {
            return res.status(404).json({
                success: false,
                message: "Group not found."
            });
        }

        const membership = await getMembership(
            groupId,
            userId
        );

        if (
            membership &&
            membership.status === "active"
        ) {
            return res.json({
                success: true,
                message: "You are already a member."
            });
        }

        const existing = await pool.query(
            `
            SELECT *
            FROM cherychat_group_join_requests
            WHERE group_id = $1
            AND user_id = $2
            `,
            [groupId, userId]
        );

        if (
            existing.rows.length &&
            existing.rows[0].status === "pending"
        ) {
            return res.json({
                success: true,
                message: "Request already pending."
            });
        }

        await pool.query(
            `
            INSERT INTO cherychat_group_join_requests
            (
                group_id,
                user_id,
                status
            )
            VALUES ($1, $2, 'pending')
            ON CONFLICT (group_id, user_id)
            DO UPDATE SET
                status = 'pending',
                created_at = CURRENT_TIMESTAMP
            `,
            [groupId, userId]
        );

        res.json({
            success: true,
            message: "Join request sent."
        });
    } catch (error) {
        console.error("GROUP REQUEST ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Unable to send request."
        });
    }
});

/* =========================================================
   GROUP REQUESTS FOR ADMIN
========================================================= */

app.get("/api/groups/:id/requests", async (req, res) => {
    try {
        const groupId = toId(req.params.id);
        const userId = toId(req.query.userId);

        if (!(await isAdminOrOwner(groupId, userId))) {
            return res.status(403).json({
                success: false,
                message: "Admin access required."
            });
        }

        const result = await pool.query(
            `
            SELECT
                r.id,
                r.group_id,
                r.user_id,
                r.status,
                r.created_at,
                u.full_name,
                u.email,
                u.profile_picture
            FROM cherychat_group_join_requests r
            JOIN cherychat_users u
            ON u.id = r.user_id
            WHERE r.group_id = $1
            AND r.status = 'pending'
            ORDER BY r.created_at ASC
            `,
            [groupId]
        );

        res.json({
            success: true,
            requests: result.rows.map(row => ({
                id: row.id,
                groupId: row.group_id,
                userId: row.user_id,
                fullName: row.full_name,
                email: row.email,
                profilePicture:
                    row.profile_picture ||
                    createAvatar(row.full_name),
                createdAt: row.created_at
            }))
        });
    } catch (error) {
        console.error("GROUP REQUESTS ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Unable to load requests."
        });
    }
});

/* =========================================================
   APPROVE / REJECT GROUP REQUEST
========================================================= */

app.post("/api/groups/:id/requests/:requestId", async (req, res) => {
    try {
        const groupId = toId(req.params.id);
        const requestId = toId(req.params.requestId);
        const adminId = toId(req.body.userId);
        const action =
            req.body.action === "reject"
                ? "reject"
                : "approve";

        if (!(await isAdminOrOwner(groupId, adminId))) {
            return res.status(403).json({
                success: false,
                message: "Admin access required."
            });
        }

        const requestResult = await pool.query(
            `
            SELECT *
            FROM cherychat_group_join_requests
            WHERE id = $1
            AND group_id = $2
            `,
            [requestId, groupId]
        );

        if (!requestResult.rows.length) {
            return res.status(404).json({
                success: false,
                message: "Request not found."
            });
        }

        const request = requestResult.rows[0];

        if (action === "reject") {
            await pool.query(
                `
                UPDATE cherychat_group_join_requests
                SET status = 'rejected'
                WHERE id = $1
                `,
                [requestId]
            );

            return res.json({
                success: true,
                message: "Request rejected."
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
            VALUES ($1, $2, 'member', 'active')
            ON CONFLICT (group_id, user_id)
            DO UPDATE SET status = 'active'
            `,
            [
                groupId,
                request.user_id
            ]
        );

        await pool.query(
            `
            UPDATE cherychat_group_join_requests
            SET status = 'approved'
            WHERE id = $1
            `,
            [requestId]
        );

        res.json({
            success: true,
            message: "Member approved."
        });
    } catch (error) {
        console.error("APPROVE REQUEST ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Unable to process request."
        });
    }
});

/* =========================================================
   GROUP MEMBERS
========================================================= */

app.get("/api/groups/:id/members", async (req, res) => {
    try {
        const groupId = toId(req.params.id);
        const userId = toId(req.query.userId);

        if (!(await isActiveMember(groupId, userId))) {
            return res.status(403).json({
                success: false,
                message: "Group membership required."
            });
        }

        const result = await pool.query(
            `
            SELECT
                gm.id,
                gm.user_id,
                gm.role,
                gm.status,
                gm.joined_at,
                u.full_name,
                u.email,
                u.profile_picture,
                u.is_online,
                u.last_seen
            FROM cherychat_group_members gm
            JOIN cherychat_users u
            ON u.id = gm.user_id
            WHERE gm.group_id = $1
            AND gm.status = 'active'
            ORDER BY
                CASE
                    WHEN gm.role = 'owner' THEN 0
                    WHEN gm.role = 'admin' THEN 1
                    ELSE 2
                END,
                u.full_name ASC
            `,
            [groupId]
        );

        res.json({
            success: true,
            members: result.rows.map(row => ({
                id: row.id,
                userId: row.user_id,
                fullName: row.full_name,
                email: row.email,
                profilePicture:
                    row.profile_picture ||
                    createAvatar(row.full_name),
                role: row.role,
                status: row.status,
                isOnline: !!row.is_online,
                lastSeen: row.last_seen,
                joinedAt: row.joined_at
            }))
        });
    } catch (error) {
        console.error("GROUP MEMBERS ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Unable to load members."
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

        if (!(await isActiveMember(groupId, userId))) {
            return res.status(403).json({
                success: false,
                message: "Group membership required."
            });
        }

        const result = await pool.query(
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
            LIMIT 500
            `,
            [groupId]
        );

        res.json({
            success: true,
            messages: result.rows.map(row => ({
                id: row.id,
                groupId: row.group_id,
                senderId: row.sender_id,
                senderName: row.sender_name,
                senderPicture:
                    row.sender_picture ||
                    createAvatar(row.sender_name),
                messageText: row.message_text,
                createdAt: row.created_at
            }))
        });
    } catch (error) {
        console.error("GROUP MESSAGES ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Unable to load group messages."
        });
    }
});

app.post("/api/groups/:id/messages", async (req, res) => {
    try {
        const groupId = toId(req.params.id);
        const senderId = toId(req.body.userId);
        const messageText = cleanText(
            req.body.messageText,
            5000
        );

        if (
            !(await isActiveMember(groupId, senderId))
        ) {
            return res.status(403).json({
                success: false,
                message: "Group membership required."
            });
        }

        if (!messageText) {
            return res.status(400).json({
                success: false,
                message: "Message cannot be empty."
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
            VALUES ($1, $2, $3)
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
        console.error("SEND GROUP MESSAGE ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Unable to send group message."
        });
    }
});

/* =========================================================
   LEAVE GROUP
========================================================= */

app.post("/api/groups/:id/leave", async (req, res) => {
    try {
        const groupId = toId(req.params.id);
        const userId = toId(req.body.userId);

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
                message: "The group owner cannot leave. Delete the group instead."
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
        console.error("LEAVE GROUP ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Unable to leave group."
        });
    }
});

/* =========================================================
   REMOVE MEMBER
========================================================= */

app.delete("/api/groups/:id/members/:memberId", async (req, res) => {
    try {
        const groupId = toId(req.params.id);
        const memberId = toId(req.params.memberId);
        const adminId = toId(req.body.userId);

        if (!(await isAdminOrOwner(groupId, adminId))) {
            return res.status(403).json({
                success: false,
                message: "Admin access required."
            });
        }

        const target = await getMembership(
            groupId,
            memberId
        );

        if (!target) {
            return res.status(404).json({
                success: false,
                message: "Member not found."
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
        console.error("REMOVE MEMBER ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Unable to remove member."
        });
    }
});

/* =========================================================
   MAKE ADMIN
========================================================= */

app.post("/api/groups/:id/members/:memberId/admin", async (req, res) => {
    try {
        const groupId = toId(req.params.id);
        const memberId = toId(req.params.memberId);
        const adminId = toId(req.body.userId);

        if (!(await isAdminOrOwner(groupId, adminId))) {
            return res.status(403).json({
                success: false,
                message: "Admin access required."
            });
        }

        await pool.query(
            `
            UPDATE cherychat_group_members
            SET role = 'admin'
            WHERE group_id = $1
            AND user_id = $2
            AND status = 'active'
            AND role <> 'owner'
            `,
            [groupId, memberId]
        );

        res.json({
            success: true,
            message: "Member is now an admin."
        });
    } catch (error) {
        console.error("MAKE ADMIN ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Unable to make admin."
        });
    }
});

/* =========================================================
   REMOVE ADMIN
========================================================= */

app.delete("/api/groups/:id/members/:memberId/admin", async (req, res) => {
    try {
        const groupId = toId(req.params.id);
        const memberId = toId(req.params.memberId);
        const adminId = toId(req.body.userId);

        if (!(await isAdminOrOwner(groupId, adminId))) {
            return res.status(403).json({
                success: false,
                message: "Admin access required."
            });
        }

        await pool.query(
            `
            UPDATE cherychat_group_members
            SET role = 'member'
            WHERE group_id = $1
            AND user_id = $2
            AND role = 'admin'
            `,
            [groupId, memberId]
        );

        res.json({
            success: true,
            message: "Admin role removed."
        });
    } catch (error) {
        console.error("REMOVE ADMIN ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Unable to remove admin role."
        });
    }
});

/* =========================================================
   UPDATE GROUP
========================================================= */

app.put("/api/groups/:id", async (req, res) => {
    try {
        const groupId = toId(req.params.id);
        const userId = toId(req.body.userId);

        if (!(await isAdminOrOwner(groupId, userId))) {
            return res.status(403).json({
                success: false,
                message: "Admin access required."
            });
        }

        const name = cleanGroupName(req.body.name);
        const description = cleanDescription(
            req.body.description
        );

        if (!name) {
            return res.status(400).json({
                success: false,
                message: "Group name is required."
            });
        }

        const result = await pool.query(
            `
            UPDATE cherychat_groups
            SET name = $1,
                description = $2
            WHERE id = $3
            RETURNING *
            `,
            [
                name,
                description,
                groupId
            ]
        );

        res.json({
            success: true,
            message: "Group updated.",
            group: formatGroup(result.rows[0])
        });
    } catch (error) {
        console.error("UPDATE GROUP ERROR:", error);

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
        const userId = toId(req.body.userId);

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
                message: "Only the group owner can delete this group."
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
            message: "Group deleted."
        });
    } catch (error) {
        console.error("DELETE GROUP ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Unable to delete group."
        });
    }
});

/* =========================================================
   INVITE GROUP
========================================================= */

app.get("/api/groups/:id/invite", async (req, res) => {
    try {
        const groupId = toId(req.params.id);
        const userId = toId(req.query.userId);

        if (!(await isActiveMember(groupId, userId))) {
            return res.status(403).json({
                success: false,
                message: "Group membership required."
            });
        }

        const group = await getGroup(groupId);

        res.json({
            success: true,
            inviteCode: group.invite_code,
            inviteLink:
                `https://cherychat.onrender.com/dashboard.html?group=${group.invite_code}`
        });
    } catch (error) {
        console.error("INVITE ERROR:", error);

        res.status(500).json({
            success: false,
            message: "Unable to create invite."
        });
    }
});

/* =========================================================
   START SERVER
========================================================= */

const PORT = process.env.PORT || 10000;

initializeDatabase()
    .then(() => {
        app.listen(PORT, () => {
            console.log(
                `VibeChat backend running on port ${PORT}`
            );
        });
    })
    .catch(error => {
        console.error(
            "DATABASE INITIALIZATION ERROR:",
            error
        );

        process.exit(1);
    });
