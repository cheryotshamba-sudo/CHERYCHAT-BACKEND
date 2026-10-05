const express = require("express");
const cors = require("cors");
const bcrypt = require("bcryptjs");
const { Pool } = require("pg");

const app = express();

app.use(cors());
app.use(express.json({ limit: "25mb" }));
app.use(express.urlencoded({ extended: true, limit: "25mb" }));

const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: process.env.DATABASE_URL
        ? { rejectUnauthorized: false }
        : false
});

function clean(value) {
    return String(value ?? "").trim();
}

function numberId(value) {
    const id = Number(value);
    return Number.isInteger(id) && id > 0 ? id : null;
}

function getId(value) {
    if (value && typeof value === "object") {
        return numberId(
            value.id ||
            value.userId ||
            value.user_id
        );
    }

    return numberId(value);
}

function sendError(res, status, message, error = null) {
    if (error) {
        console.error(message, error);
    }

    return res.status(status).json({
        success: false,
        message
    });
}

async function setupDatabase() {
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
            expires_at TIMESTAMP DEFAULT (
                CURRENT_TIMESTAMP + INTERVAL '24 hours'
            )
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
}

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
        sendError(
            res,
            500,
            "Database connection failed.",
            error
        );
    }
});

app.post("/api/register", async (req, res) => {
    try {
        const fullName = clean(
            req.body.full_name ||
            req.body.fullName ||
            req.body.name
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
            return sendError(
                res,
                400,
                "Full name is required."
            );
        }

        if (!email && !phone) {
            return sendError(
                res,
                400,
                "Email or phone number is required."
            );
        }

        if (password.length < 6) {
            return sendError(
                res,
                400,
                "Password must be at least 6 characters."
            );
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
            return sendError(
                res,
                409,
                "Email or phone number is already registered."
            );
        }

        const passwordHash =
            await bcrypt.hash(password, 10);

        const result = await pool.query(
            `
            INSERT INTO cherychat_users
            (
                full_name,
                email,
                phone,
                password_hash,
                about,
                is_online,
                last_seen
            )
            VALUES ($1,$2,$3,$4,$5,TRUE,CURRENT_TIMESTAMP)
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
                passwordHash,
                "using VibeChat"
            ]
        );

        res.status(201).json({
            success: true,
            message: "VibeChat account created successfully.",
            user: result.rows[0]
        });
    } catch (error) {
        sendError(
            res,
            500,
            "Unable to create account.",
            error
        );
    }
});

app.post("/api/login", async (req, res) => {
    try {
        const identifier = clean(
            req.body.email ||
            req.body.phone ||
            req.body.identifier ||
            req.body.login
        ).toLowerCase();

        const password = String(
            req.body.password || ""
        );

        if (!identifier || !password) {
            return sendError(
                res,
                400,
                "Email/phone and password are required."
            );
        }

        const result = await pool.query(
            `
            SELECT *
            FROM cherychat_users
            WHERE
                LOWER(COALESCE(email,'')) = $1
                OR phone = $1
            LIMIT 1
            `,
            [identifier]
        );

        if (!result.rows.length) {
            return sendError(
                res,
                401,
                "Invalid login details."
            );
        }

        const user = result.rows[0];

        const validPassword =
            await bcrypt.compare(
                password,
                user.password_hash
            );

        if (!validPassword) {
            return sendError(
                res,
                401,
                "Invalid login details."
            );
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

        delete user.password_hash;

        res.json({
            success: true,
            message: "Login successful.",
            user
        });
    } catch (error) {
        sendError(
            res,
            500,
            "Unable to login.",
            error
        );
    }
});

app.get("/api/users/search", async (req, res) => {
    try {
        const q = clean(req.query.q);
        const userId =
            numberId(req.query.userId) || 0;

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
                AND ($2 = 0 OR id <> $2)
            ORDER BY full_name ASC
            LIMIT 50
            `,
            [
                `%${q}%`,
                userId
            ]
        );

        res.json({
            success: true,
            users: result.rows
        });
    } catch (error) {
        sendError(
            res,
            500,
            "Unable to search users.",
            error
        );
    }
});

app.get("/api/users/:id", async (req, res) => {
    try {
        const id =
            numberId(req.params.id);

        if (!id) {
            return sendError(
                res,
                400,
                "Valid user ID is required."
            );
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
            return sendError(
                res,
                404,
                "User not found."
            );
        }

        res.json({
            success: true,
            user: result.rows[0]
        });
    } catch (error) {
        sendError(
            res,
            500,
            "Unable to load user.",
            error
        );
    }
});

app.put("/api/users/:id/online", async (req, res) => {
    try {
        const id =
            numberId(req.params.id);

        if (!id) {
            return sendError(
                res,
                400,
                "Valid user ID is required."
            );
        }

        await pool.query(
            `
            UPDATE cherychat_users
            SET
                is_online = TRUE,
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
        sendError(
            res,
            500,
            "Unable to update status.",
            error
        );
    }
});

app.put("/api/users/:id/offline", async (req, res) => {
    try {
        const id =
            numberId(req.params.id);

        if (!id) {
            return sendError(
                res,
                400,
                "Valid user ID is required."
            );
        }

        await pool.query(
            `
            UPDATE cherychat_users
            SET
                is_online = FALSE,
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
        sendError(
            res,
            500,
            "Unable to update status.",
            error
        );
    }
});

app.put("/api/users/:id/profile", async (req, res) => {
    try {
        const id =
            numberId(req.params.id);

        const fullName = clean(
            req.body.fullName ||
            req.body.full_name ||
            req.body.name
        );

        const about =
            req.body.about !== undefined
                ? String(req.body.about)
                : null;

        if (!id) {
            return sendError(
                res,
                400,
                "Valid user ID is required."
            );
        }

        if (!fullName) {
            return sendError(
                res,
                400,
                "Name cannot be empty."
            );
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
            return sendError(
                res,
                404,
                "User not found."
            );
        }

        res.json({
            success: true,
            user: result.rows[0]
        });
    } catch (error) {
        sendError(
            res,
            500,
            "Unable to update profile.",
            error
        );
    }
});

app.put(
    "/api/users/:id/profile-picture",
    async (req, res) => {
        try {
            const id =
                numberId(req.params.id);

            const picture =
                req.body.profilePicture ||
                req.body.profile_picture;

            if (!id) {
                return sendError(
                    res,
                    400,
                    "Valid user ID is required."
                );
            }

            if (!picture) {
                return sendError(
                    res,
                    400,
                    "Profile picture is required."
                );
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
                [
                    picture,
                    id
                ]
            );

            if (!result.rows.length) {
                return sendError(
                    res,
                    404,
                    "User not found."
                );
            }

            res.json({
                success: true,
                user: result.rows[0]
            });
        } catch (error) {
            sendError(
                res,
                500,
                "Unable to update profile picture.",
                error
            );
        }
    }
);

app.post("/api/conversations", async (req, res) => {
    try {
        const userId =
            getId(req.body.userId) ||
            getId(req.body.id);

        const otherUserId =
            getId(req.body.otherUserId) ||
            getId(req.body.receiverId) ||
            getId(req.body.otherUser);

        if (!userId || !otherUserId) {
            return sendError(
                res,
                400,
                "Valid user IDs are required."
            );
        }

        if (userId === otherUserId) {
            return sendError(
                res,
                400,
                "You cannot chat with yourself."
            );
        }

        const one =
            Math.min(userId, otherUserId);

        const two =
            Math.max(userId, otherUserId);

        const result = await pool.query(
            `
            INSERT INTO cherychat_conversations
            (user_one,user_two)
            VALUES ($1,$2)
            ON CONFLICT (user_one,user_two)
            DO UPDATE SET user_one = EXCLUDED.user_one
            RETURNING *
            `,
            [
                one,
                two
            ]
        );

        res.json({
            success: true,
            conversation: result.rows[0]
        });
    } catch (error) {
        sendError(
            res,
            500,
            "Unable to create conversation.",
            error
        );
    }
});

app.get("/api/conversations", async (req, res) => {
    try {
        const userId =
            getId(req.query.userId) ||
            getId(req.query.id);

        if (!userId) {
            return sendError(
                res,
                400,
                "Valid user ID is required."
            );
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
                ORDER BY created_at DESC, id DESC
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
            [userId]
        );

        res.json({
            success: true,
            conversations:
                result.rows.map(row => ({
                    conversationId:
                        Number(row.conversation_id),

                    otherUser: {
                        id:
                            Number(row.other_user_id),

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
                        row.last_message || "",

                    lastMessageTime:
                        row.last_message_time
                }))
        });
    } catch (error) {
        sendError(
            res,
            500,
            "Unable to load conversations.",
            error
        );
    }
});

app.get("/api/messages", async (req, res) => {
    try {
        const userId =
            getId(req.query.userId);

        const otherUserId =
            getId(req.query.otherUserId) ||
            getId(req.query.receiverId);

        if (!userId || !otherUserId) {
            return sendError(
                res,
                400,
                "Valid user IDs are required."
            );
        }

        const one =
            Math.min(userId, otherUserId);

        const two =
            Math.max(userId, otherUserId);

        const conversation =
            await pool.query(
                `
                SELECT id
                FROM cherychat_conversations
                WHERE user_one = $1
                AND user_two = $2
                LIMIT 1
                `,
                [
                    one,
                    two
                ]
            );

        if (!conversation.rows.length) {
            return res.json({
                success: true,
                messages: []
            });
        }

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
            ORDER BY created_at ASC, id ASC
            `,
            [
                conversation.rows[0].id
            ]
        );

        res.json({
            success: true,
            messages: result.rows
        });
    } catch (error) {
        sendError(
            res,
            500,
            "Unable to load messages.",
            error
        );
    }
});

app.post("/api/messages", async (req, res) => {
    try {
        const senderId =
            getId(req.body.senderId) ||
            getId(req.body.sender_id) ||
            getId(req.body.userId);

        const receiverId =
            getId(req.body.receiverId) ||
            getId(req.body.receiver_id) ||
            getId(req.body.otherUserId);

        const messageText = clean(
            req.body.messageText ||
            req.body.message ||
            req.body.text
        );

        if (!senderId || !receiverId) {
            return sendError(
                res,
                400,
                "Valid sender and receiver IDs are required."
            );
        }

        if (!messageText) {
            return sendError(
                res,
                400,
                "Message cannot be empty."
            );
        }

        if (senderId === receiverId) {
            return sendError(
                res,
                400,
                "You cannot message yourself."
            );
        }

        const one =
            Math.min(senderId, receiverId);

        const two =
            Math.max(senderId, receiverId);

        const conversation =
            await pool.query(
                `
                INSERT INTO cherychat_conversations
                (user_one,user_two)
                VALUES ($1,$2)
                ON CONFLICT (user_one,user_two)
                DO UPDATE SET user_one = EXCLUDED.user_one
                RETURNING id
                `,
                [
                    one,
                    two
                ]
            );

        const result =
            await pool.query(
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
                    conversation.rows[0].id,
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
        sendError(
            res,
            500,
            "Unable to send message.",
            error
        );
    }
});

app.put("/api/messages/read", async (req, res) => {
    try {
        const userId =
            getId(req.body.userId);

        const otherUserId =
            getId(req.body.otherUserId) ||
            getId(req.body.receiverId);

        if (!userId || !otherUserId) {
            return sendError(
                res,
                400,
                "Valid user IDs are required."
            );
        }

        const one =
            Math.min(userId, otherUserId);

        const two =
            Math.max(userId, otherUserId);

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
        sendError(
            res,
            500,
            "Unable to mark messages as read.",
            error
        );
    }
});

app.get("/api/groups", async (req, res) => {
    try {
        const q =
            clean(req.query.q);

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
                GROUP BY
                    g.id,
                    u.full_name
                ORDER BY
                    g.created_at DESC
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
                GROUP BY
                    g.id,
                    u.full_name
                ORDER BY
                    g.created_at DESC
                `
            );
        }

        res.json({
            success: true,
            groups: result.rows
        });
    } catch (error) {
        sendError(
            res,
            500,
            "Unable to load groups.",
            error
        );
    }
});

app.get("/api/groups/my", async (req, res) => {
    try {
        const userId =
            getId(req.query.userId);

        if (!userId) {
            return sendError(
                res,
                400,
                "Valid user ID is required."
            );
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
            GROUP BY
                g.id,
                gm.role
            ORDER BY
                g.created_at DESC
            `,
            [userId]
        );

        res.json({
            success: true,
            groups: result.rows
        });
    } catch (error) {
        sendError(
            res,
            500,
            "Unable to load your groups.",
            error
        );
    }
});

app.post("/api/groups", async (req, res) => {
    try {
        const creatorId =
            getId(req.body.creatorId) ||
            getId(req.body.creator_id) ||
            getId(req.body.userId) ||
            getId(req.body.user_id);

        const name = clean(
            req.body.name ||
            req.body.groupName ||
            req.body.group_name
        );

        const description = clean(
            req.body.description ||
            req.body.groupDescription ||
            req.body.group_description
        );

        const groupPicture =
            req.body.groupPicture ||
            req.body.group_picture ||
            null;

        const privacy =
            clean(req.body.privacy).toLowerCase();

        const isPrivate =
            req.body.isPrivate === true ||
            req.body.is_private === true ||
            String(
                req.body.isPrivate ||
                req.body.is_private ||
                ""
            ).toLowerCase() === "true" ||
            privacy === "private";

        let joinFee = Number(
            req.body.joinFee ??
            req.body.join_fee ??
            0
        );

        if (
            !Number.isFinite(joinFee) ||
            joinFee < 0
        ) {
            joinFee = 0;
        }

        if (!creatorId) {
            return sendError(
                res,
                400,
                "Valid creator ID is required."
            );
        }

        if (!name) {
            return sendError(
                res,
                400,
                "Group name is required."
            );
        }

        const creator =
            await pool.query(
                `
                SELECT id
                FROM cherychat_users
                WHERE id = $1
                `,
                [creatorId]
            );

        if (!creator.rows.length) {
            return sendError(
                res,
                404,
                "Creator account not found."
            );
        }

        const groupResult =
            await pool.query(
                `
                INSERT INTO cherychat_groups
                (
                    name,
                    description,
                    group_picture,
                    creator_id,
                    is_private,
                    join_fee
                )
                VALUES ($1,$2,$3,$4,$5,$6)
                RETURNING *
                `,
                [
                    name,
                    description,
                    groupPicture,
                    creatorId,
                    isPrivate,
                    joinFee
                ]
            );

        const group =
            groupResult.rows[0];

        await pool.query(
            `
            INSERT INTO cherychat_group_members
            (
                group_id,
                user_id,
                role
            )
            VALUES ($1,$2,'admin')
            ON CONFLICT (group_id,user_id)
            DO UPDATE SET role = 'admin'
            `,
            [
                group.id,
                creatorId
            ]
        );

        res.status(201).json({
            success: true,
            message: "Group created successfully.",
            group
        });
    } catch (error) {
        sendError(
            res,
            500,
            "Unable to create group.",
            error
        );
    }
});

app.get("/api/groups/:id", async (req, res) => {
    try {
        const groupId =
            numberId(req.params.id);

        const userId =
            getId(req.query.userId);

        if (!groupId) {
            return sendError(
                res,
                400,
                "Valid group ID is required."
            );
        }

        const groupResult =
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
                GROUP BY
                    g.id,
                    u.full_name
                `,
                [groupId]
            );

        if (!groupResult.rows.length) {
            return sendError(
                res,
                404,
                "Group not found."
            );
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

        if (userId) {
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
            group:
                groupResult.rows[0],
            members:
                members.rows,
            isMember
        });
    } catch (error) {
        sendError(
            res,
            500,
            "Unable to load group.",
            error
        );
    }
});

app.post("/api/groups/:id/join", async (req, res) => {
    try {
        const groupId =
            numberId(req.params.id);

        const userId =
            getId(req.body.userId) ||
            getId(req.body.user_id);

        if (!groupId || !userId) {
            return sendError(
                res,
                400,
                "Valid group and user IDs are required."
            );
        }

        const groupResult =
            await pool.query(
                `
                SELECT *
                FROM cherychat_groups
                WHERE id = $1
                `,
                [groupId]
            );

        if (!groupResult.rows.length) {
            return sendError(
                res,
                404,
                "Group not found."
            );
        }

        const group =
            groupResult.rows[0];

        if (Number(group.join_fee) > 0) {
            return res.json({
                success: false,
                paymentRequired: true,
                joinFee:
                    Number(group.join_fee),
                message:
                    "Payment is required to join this private group."
            });
        }

        await pool.query(
            `
            INSERT INTO cherychat_group_members
            (
                group_id,
                user_id,
                role
            )
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
        sendError(
            res,
            500,
            "Unable to join group.",
            error
        );
    }
});

app.get(
    "/api/groups/:id/messages",
    async (req, res) => {
        try {
            const groupId =
                numberId(req.params.id);

            const userId =
                getId(req.query.userId);

            if (!groupId || !userId) {
                return sendError(
                    res,
                    400,
                    "Valid group and user IDs are required."
                );
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
                return sendError(
                    res,
                    403,
                    "You are not a member of this group."
                );
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
                    ORDER BY
                        gm.created_at ASC,
                        gm.id ASC
                    `,
                    [groupId]
                );

            res.json({
                success: true,
                messages:
                    result.rows
            });
        } catch (error) {
            sendError(
                res,
                500,
                "Unable to load group messages.",
                error
            );
        }
    }
);

app.post(
    "/api/groups/:id/messages",
    async (req, res) => {
        try {
            const groupId =
                numberId(req.params.id);

            const senderId =
                getId(req.body.senderId) ||
                getId(req.body.sender_id) ||
                getId(req.body.userId);

            const messageText = clean(
                req.body.messageText ||
                req.body.message ||
                req.body.text
            );

            if (!groupId || !senderId) {
                return sendError(
                    res,
                    400,
                    "Valid group and user IDs are required."
                );
            }

            if (!messageText) {
                return sendError(
                    res,
                    400,
                    "Message cannot be empty."
                );
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
                return sendError(
                    res,
                    403,
                    "You are not a member of this group."
                );
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
                message:
                    result.rows[0]
            });
        } catch (error) {
            sendError(
                res,
                500,
                "Unable to send group message.",
                error
            );
        }
    }
);

app.get("/api/stories", async (req, res) => {
    try {
        const userId =
            getId(req.query.userId) || 0;

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
                        WHERE
                            sv.story_id = s.id
                            AND sv.user_id = $1
                    ) AS viewed_by_me
                FROM cherychat_stories s
                JOIN cherychat_users u
                    ON u.id = s.user_id
                WHERE
                    s.expires_at > CURRENT_TIMESTAMP
                ORDER BY
                    s.created_at ASC,
                    s.id ASC
                `,
                [userId]
            );

        const usersMap = {};

        for (const story of result.rows) {
            const uid =
                Number(story.user_id);

            if (!usersMap[uid]) {
                usersMap[uid] = {
                    userId: uid,
                    fullName:
                        story.full_name,
                    profilePicture:
                        story.profile_picture,
                    stories: []
                };
            }

            usersMap[uid].stories.push({
                id:
                    Number(story.id),

                userId:
                    uid,

                fullName:
                    story.full_name,

                profilePicture:
                    story.profile_picture,

                mediaType:
                    story.media_type,

                mediaData:
                    story.media_data,

                caption:
                    story.caption || "",

                createdAt:
                    story.created_at,

                expiresAt:
                    story.expires_at,

                viewedByMe:
                    story.viewed_by_me === true,

                isOwn:
                    uid === userId
            });
        }

        res.json({
            success: true,
            stories:
                result.rows,
            users:
                Object.values(usersMap)
        });
    } catch (error) {
        sendError(
            res,
            500,
            "Unable to load stories.",
            error
        );
    }
});

app.post("/api/stories", async (req, res) => {
    try {
        const userId =
            getId(req.body.userId) ||
            getId(req.body.user_id) ||
            getId(req.body.id);

        let mediaType = clean(
            req.body.mediaType ||
            req.body.media_type ||
            req.body.type
        ).toLowerCase();

        const mediaData =
            req.body.mediaData ||
            req.body.media_data ||
            req.body.data ||
            req.body.image ||
            req.body.video;

        const caption = clean(
            req.body.caption ||
            req.body.text
        );

        if (
            mediaType.startsWith("image/")
        ) {
            mediaType = "image";
        }

        if (
            mediaType.startsWith("video/")
        ) {
            mediaType = "video";
        }

        if (
            mediaType === "photo"
        ) {
            mediaType = "image";
        }

        if (
            mediaType === "mp4"
        ) {
            mediaType = "video";
        }

        if (!userId) {
            return sendError(
                res,
                400,
                "Valid user ID is required."
            );
        }

        if (
            mediaType !== "image" &&
            mediaType !== "video"
        ) {
            return sendError(
                res,
                400,
                "Invalid story media type."
            );
        }

        if (!mediaData) {
            return sendError(
                res,
                400,
                "Story media is required."
            );
        }

        const user =
            await pool.query(
                `
                SELECT id
                FROM cherychat_users
                WHERE id = $1
                `,
                [userId]
            );

        if (!user.rows.length) {
            return sendError(
                res,
                404,
                "User account not found."
            );
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
                    String(mediaData),
                    caption
                ]
            );

        res.status(201).json({
            success: true,
            message:
                "Story posted successfully.",
            story:
                result.rows[0]
        });
    } catch (error) {
        sendError(
            res,
            500,
            "Unable to post story.",
            error
        );
    }
});

app.post(
    "/api/stories/:id/view",
    async (req, res) => {
        try {
            const storyId =
                numberId(req.params.id);

            const userId =
                getId(req.body.userId) ||
                getId(req.body.user_id);

            if (!storyId || !userId) {
                return sendError(
                    res,
                    400,
                    "Valid story and user IDs are required."
                );
            }

            const story =
                await pool.query(
                    `
                    SELECT id
                    FROM cherychat_stories
                    WHERE id = $1
                    `,
                    [storyId]
                );

            if (!story.rows.length) {
                return sendError(
                    res,
                    404,
                    "Story not found."
                );
            }

            await pool.query(
                `
                INSERT INTO cherychat_story_views
                (
                    story_id,
                    user_id
                )
                VALUES ($1,$2)
                ON CONFLICT (story_id,user_id)
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
            sendError(
                res,
                500,
                "Unable to record story view.",
                error
            );
        }
    }
);

async function deleteExpiredStories() {
    try {
        await pool.query(
            `
            DELETE FROM cherychat_story_views
            WHERE story_id IN (
                SELECT id
                FROM cherychat_stories
                WHERE expires_at <= CURRENT_TIMESTAMP
            )
            `
        );

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

app.post("/api/logout", async (req, res) => {
    try {
        const userId =
            getId(req.body.userId) ||
            getId(req.body.id);

        if (!userId) {
            return sendError(
                res,
                400,
                "Valid user ID is required."
            );
        }

        await pool.query(
            `
            UPDATE cherychat_users
            SET
                is_online = FALSE,
                last_seen = CURRENT_TIMESTAMP
            WHERE id = $1
            `,
            [userId]
        );

        res.json({
            success: true,
            message:
                "Logged out successfully."
        });
    } catch (error) {
        sendError(
            res,
            500,
            "Unable to logout.",
            error
        );
    }
});

app.use((req, res) => {
    res.status(404).json({
        success: false,
        message:
            "VibeChat API endpoint not found."
    });
});

const PORT =
    process.env.PORT || 10000;

setupDatabase()
    .then(() => {
        app.listen(PORT, () => {
            console.log(
                `VibeChat API running on port ${PORT}`
            );
        });
    })
    .catch(error => {
        console.error(
            "VibeChat server startup failed:",
            error
        );
    });
