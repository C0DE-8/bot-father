const express = require("express");
const router = express.Router();

const {
    apiBasePath,
    callKeyboard,
    createCall,
    handleTelegramCallback,
    handleTelegramText,
    handleTelegramUpdate,
    publicUrl,
    sendTelegramMessage,
    telegramApi,
    telegramLocalMode,
    telegramWebhookUrl
} = require("./telegram/telegram.functions");

let lastUpdateId = 0;

// Shows Telegram-related environment and webhook config.
router.get("/debug/config", (req, res) => {
    const baseUrl = publicUrl();

    res.json({
        ok: true,
        hasBotToken: Boolean(process.env.TELEGRAM_BOT_TOKEN),
        hasAdminChatId: Boolean(process.env.TELEGRAM_ADMIN_CHAT_ID),
        localMode: telegramLocalMode(),
        publicUrl: baseUrl,
        apiBasePath: apiBasePath(),
        webhookUrl: telegramWebhookUrl()
    });
});

// Tests whether the Telegram bot token can reach getMe.
router.get("/debug/bot", async (req, res) => {
    try {
        const bot = await telegramApi("getMe");

        res.json({
            ok: true,
            connected: true,
            bot: bot.result
        });
    } catch (error) {
        console.error("Telegram bot debug failed:", error);
        res.status(500).json({
            ok: false,
            connected: false,
            error: error.message,
            telegram: error.telegram || null
        });
    }
});

// Sends a ping message to Telegram to prove delivery works.
router.all("/debug/ping", async (req, res) => {
    try {
        const chatId = req.body.chatId || req.query.chatId || process.env.TELEGRAM_ADMIN_CHAT_ID;

        if (!chatId) {
            return res.status(400).json({
                ok: false,
                error: "chatId or TELEGRAM_ADMIN_CHAT_ID is required"
            });
        }

        const message = await telegramApi("sendMessage", {
            chat_id: chatId,
            text: `Backend ping OK: ${new Date().toISOString()}`
        });

        res.json({
            ok: true,
            connected: true,
            sent: true,
            chatId,
            message: message.result
        });
    } catch (error) {
        console.error("Telegram ping failed:", error);
        res.status(500).json({
            ok: false,
            connected: false,
            sent: false,
            error: error.message,
            telegram: error.telegram || null
        });
    }
});

// Deletes the Telegram webhook so local getUpdates polling can receive messages.
router.post("/debug/webhook/delete", async (req, res) => {
    try {
        const result = await telegramApi("deleteWebhook", {
            drop_pending_updates: req.body.dropPendingUpdates === true
        });

        res.json({
            ok: true,
            deleted: result.result
        });
    } catch (error) {
        console.error("Telegram delete webhook failed:", error);
        res.status(500).json({
            ok: false,
            error: error.message,
            telegram: error.telegram || null
        });
    }
});

// Pulls Telegram updates locally and runs the same handlers as the webhook.
router.all("/debug/poll-updates", async (req, res) => {
    try {
        const reset = req.body.reset === true || req.query.reset === "true";

        if (reset) {
            lastUpdateId = 0;
        }

        const updates = await telegramApi("getUpdates", {
            offset: lastUpdateId ? lastUpdateId + 1 : undefined,
            timeout: Number(req.body.timeout || req.query.timeout || 0),
            allowed_updates: ["message", "edited_message", "callback_query"]
        });

        const handled = [];

        for (const update of updates.result) {
            lastUpdateId = update.update_id;
            handled.push({
                updateId: update.update_id,
                result: await handleTelegramUpdate(update)
            });
        }

        res.json({
            ok: true,
            updateCount: updates.result.length,
            lastUpdateId,
            handled
        });
    } catch (error) {
        console.error("Telegram poll updates failed:", error);
        res.status(500).json({
            ok: false,
            error: error.message,
            telegram: error.telegram || null
        });
    }
});

// Sends a custom debug message to a Telegram chat.
router.post("/debug/message", async (req, res) => {
    try {
        const chatId = req.body.chatId || process.env.TELEGRAM_ADMIN_CHAT_ID;
        const text = req.body.text || "Hello Queen debug message from backend.";

        if (!chatId) {
            return res.status(400).json({ ok: false, error: "chatId or TELEGRAM_ADMIN_CHAT_ID is required" });
        }

        const message = await telegramApi("sendMessage", {
            chat_id: chatId,
            text
        });

        res.json({
            ok: true,
            sent: true,
            chatId,
            message: message.result
        });
    } catch (error) {
        console.error("Telegram debug message failed:", error);
        res.status(500).json({
            ok: false,
            sent: false,
            error: error.message,
            telegram: error.telegram || null
        });
    }
});

// Sets the Telegram webhook when using a public HTTPS URL.
router.post("/debug/webhook/set", async (req, res) => {
    try {
        const url = req.body.url || telegramWebhookUrl();

        const result = await telegramApi("setWebhook", { url });

        res.json({
            ok: true,
            webhookUrl: url,
            result: result.result
        });
    } catch (error) {
        console.error("Telegram set webhook failed:", error);
        res.status(500).json({
            ok: false,
            error: error.message,
            telegram: error.telegram || null
        });
    }
});

// Simulates a Telegram webhook update without calling Telegram.
router.post("/debug/local-update", async (req, res) => {
    try {
        const chatId = req.body.chatId || process.env.TELEGRAM_ADMIN_CHAT_ID || "local-debug-chat";
        const text = req.body.text || "/start";
        const result = await handleTelegramText(chatId, text, { local: true });

        res.json({
            ok: true,
            simulated: true,
            chatId,
            text,
            result
        });
    } catch (error) {
        console.error("Telegram local update debug failed:", error);
        res.status(500).json({
            ok: false,
            error: error.message
        });
    }
});

// Simulates pressing a Telegram inline button locally.
router.post("/debug/local-button", async (req, res) => {
    try {
        const callbackQuery = {
            id: "local-callback",
            data: req.body.data || "main_menu",
            message: {
                chat: {
                    id: req.body.chatId || process.env.TELEGRAM_ADMIN_CHAT_ID || "local-debug-chat"
                }
            }
        };
        const result = await handleTelegramCallback(callbackQuery);

        res.json({
            ok: true,
            simulated: true,
            callbackQuery,
            result
        });
    } catch (error) {
        console.error("Telegram local button debug failed:", error);
        res.status(500).json({
            ok: false,
            error: error.message
        });
    }
});

// Creates a call locally without going through Telegram.
router.post("/debug/local-startcall", async (req, res) => {
    try {
        const phone = req.body.phone;
        const chatId = req.body.chatId || process.env.TELEGRAM_ADMIN_CHAT_ID || "local-debug-chat";

        if (!phone) {
            return res.status(400).json({ ok: false, error: "phone is required" });
        }

        const call = await createCall(phone, chatId);

        res.json({
            ok: true,
            simulated: true,
            chatId,
            phone,
            call
        });
    } catch (error) {
        console.error("Telegram local startcall debug failed:", error);
        res.status(500).json({
            ok: false,
            error: error.message
        });
    }
});

// Reads the current Telegram webhook status.
router.get("/debug/webhook", async (req, res) => {
    try {
        const info = await telegramApi("getWebhookInfo");

        res.json({
            ok: true,
            webhook: info.result
        });
    } catch (error) {
        console.error("Telegram webhook debug failed:", error);
        res.status(500).json({
            ok: false,
            error: error.message,
            telegram: error.telegram || null
        });
    }
});

// Starts a call from an HTTP request that acts like the admin panel.
router.post("/startcall", async (req, res) => {
    try {
        const { phone, chatId } = req.body;

        if (!phone) {
            return res.status(400).json({ error: "phone is required" });
        }

        const targetChatId = chatId || process.env.TELEGRAM_ADMIN_CHAT_ID;
        const call = await createCall(phone, targetChatId);

        await sendTelegramMessage(
            targetChatId,
            `✅ Call ${call.callId} started\n📱 Number: ${phone}\n📌 Status: ${call.status}`,
            { reply_markup: callKeyboard(call.callId) }
        );

        res.json({
            message: "Call started",
            phone,
            ...call
        });
    } catch (error) {
        console.error("Telegram startcall failed:", error);
        res.status(500).json({ error: "Failed to start call" });
    }
});

// Receives real Telegram webhook updates.
router.post("/webhook", async (req, res) => {
    try {
        await handleTelegramUpdate(req.body);
        res.sendStatus(200);
    } catch (error) {
        console.error("Telegram webhook failed:", error);
        res.sendStatus(200);
    }
});

module.exports = router;
