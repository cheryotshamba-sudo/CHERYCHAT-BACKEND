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
            "CHERYCHAT CONVERSATION ERROR:",
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
            Number(conversationId);

        const cleanSenderId =
            Number(senderId);

        const cleanMessage =
            String(message || "").trim();


        if (
            !Number.isInteger(cleanConversationId) ||
            !Number.isInteger(cleanSenderId) ||
            !cleanMessage
        ) {

            return res.status(400).json({

                success: false,

                message:
                    "Conversation, sender and message are required"

            });

        }


        if (cleanMessage.length > 5000) {

            return res.status(400).json({

                success: false,

                message:
                    "Message is too long"

            });

        }


        const conversation =
            await pool.query(
                `
                SELECT
                    id,
                    user_one_id,
                    user_two_id
                FROM cherychat_conversations
                WHERE id = $1
                LIMIT 1
                `,
                [
                    cleanConversationId
                ]
            );


        if (conversation.rows.length === 0) {

            return res.status(404).json({

                success: false,

                message:
                    "Conversation not found"

            });

        }


        const chat =
            conversation.rows[0];


        if (
            cleanSenderId !==
                chat.user_one_id &&
            cleanSenderId !==
                chat.user_two_id
        ) {

            return res.status(403).json({

                success: false,

                message:
                    "You are not part of this conversation"

            });

        }


        const result =
            await pool.query(
                `
                INSERT INTO cherychat_messages
                (
                    conversation_id,
                    sender_id,
                    message_text
                )
                VALUES
                ($1, $2, $3)
                RETURNING
                    id,
                    conversation_id,
                    sender_id,
                    message_text,
                    is_read,
                    created_at
                `,
                [
                    cleanConversationId,
                    cleanSenderId,
                    cleanMessage
                ]
            );


        const sentMessage =
            result.rows[0];


        res.status(201).json({

            success: true,

            message: {

                id:
                    sentMessage.id,

                conversationId:
                    sentMessage.conversation_id,

                senderId:
                    sentMessage.sender_id,

                message:
                    sentMessage.message_text,

                isRead:
                    sentMessage.is_read,

                createdAt:
                    sentMessage.created_at

            }

        });


    } catch (error) {

        console.error(
            "CHERYCHAT SEND MESSAGE ERROR:",
            error
        );


        res.status(500).json({

            success: false,

            message:
                "Unable to send message"

        });

    }

});


/* =========================
   GET CONVERSATION MESSAGES
========================= */

app.get("/api/messages/:conversationId", async (req, res) => {

    try {

        const conversationId =
            Number(req.params.conversationId);

        const userId =
            Number(req.query.userId);


        if (
            !Number.isInteger(conversationId) ||
            !Number.isInteger(userId)
        ) {

            return res.status(400).json({

                success: false,

                message:
                    "Valid conversation and user IDs are required"

            });

        }


        const conversation =
            await pool.query(
                `
                SELECT
                    id,
                    user_one_id,
                    user_two_id
                FROM cherychat_conversations
                WHERE id = $1
                LIMIT 1
                `,
                [
                    conversationId
                ]
            );


        if (conversation.rows.length === 0) {

            return res.status(404).json({

                success: false,

                message:
                    "Conversation not found"

            });

        }


        const chat =
            conversation.rows[0];


        if (
            userId !== chat.user_one_id &&
            userId !== chat.user_two_id
        ) {

            return res.status(403).json({

                success: false,

                message:
                    "You are not part of this conversation"

            });

        }


        const result =
            await pool.query(
                `
                SELECT
                    id,
                    conversation_id,
                    sender_id,
                    message_text,
                    is_read,
                    created_at
                FROM cherychat_messages
                WHERE conversation_id = $1
                ORDER BY created_at ASC, id ASC
                `,
                [
                    conversationId
                ]
            );


        res.json({

            success: true,

            messages:
                result.rows.map(message => ({

                    id:
                        message.id,

                    conversationId:
                        message.conversation_id,

                    senderId:
                        message.sender_id,

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
            "CHERYCHAT GET MESSAGES ERROR:",
            error
        );


        res.status(500).json({

            success: false,

            message:
                "Unable to load messages"

        });

    }

});


/* =========================
   MARK MESSAGES AS READ
========================= */

app.post("/api/messages/read", async (req, res) => {

    try {

        const {
            conversationId,
            userId
        } = req.body;


        const cleanConversationId =
            Number(conversationId);

        const cleanUserId =
            Number(userId);


        if (
            !Number.isInteger(cleanConversationId) ||
            !Number.isInteger(cleanUserId)
        ) {

            return res.status(400).json({

                success: false,

                message:
                    "Valid conversation and user IDs are required"

            });

        }


        const conversation =
            await pool.query(
                `
                SELECT
                    user_one_id,
                    user_two_id
                FROM cherychat_conversations
                WHERE id = $1
                `,
                [
                    cleanConversationId
                ]
            );


        if (conversation.rows.length === 0) {

            return res.status(404).json({

                success: false,

                message:
                    "Conversation not found"

            });

        }


        const chat =
            conversation.rows[0];


        if (
            cleanUserId !== chat.user_one_id &&
            cleanUserId !== chat.user_two_id
        ) {

            return res.status(403).json({

                success: false,

                message:
                    "You are not part of this conversation"

            });

        }


        await pool.query(
            `
            UPDATE cherychat_messages
            SET is_read = TRUE
            WHERE conversation_id = $1
              AND sender_id <> $2
              AND is_read = FALSE
            `,
            [
                cleanConversationId,
                cleanUserId
            ]
        );


        res.json({

            success: true,

            message:
                "Messages marked as read"

        });


    } catch (error) {

        console.error(
            "CHERYCHAT READ MESSAGE ERROR:",
            error
        );


        res.status(500).json({

            success: false,

            message:
                "Unable to mark messages as read"

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
