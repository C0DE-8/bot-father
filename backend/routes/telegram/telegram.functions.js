const db = require("../../db/database");

// Builds the public base URL used in provider and webhook links.
function publicUrl() {
    return (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, "");
}

// Returns the API prefix used by server.js.
function apiBasePath() {
    return process.env.API_BASE_PATH || "/api";
}

// Builds the Telegram webhook URL for this backend.
function telegramWebhookUrl() {
    return `${publicUrl()}${apiBasePath()}/telegram/webhook`;
}

// Reads the optional local debug flag for config visibility.
function telegramLocalMode() {
    return process.env.TELEGRAM_LOCAL_MODE === "true";
}

// Builds the main Telegram admin button menu.
function mainMenuKeyboard() {
    return {
        inline_keyboard: [
            [{ text: "Start call", callback_data: "help_startcall" }],
            [
                { text: "Ping backend", callback_data: "ping_backend" },
                { text: "Webhook status", callback_data: "webhook_status" }
            ]
        ]
    };
}

// Builds buttons for a specific call after it starts.
function callKeyboard(callId) {
    return {
        inline_keyboard: [
            [
                { text: "Call details", callback_data: `call_details:${callId}` },
                { text: "Main menu", callback_data: "main_menu" }
            ]
        ]
    };
}

// Calls the Telegram Bot API and normalizes errors.
async function telegramApi(method, body) {
    if (!process.env.TELEGRAM_BOT_TOKEN) {
        throw new Error("TELEGRAM_BOT_TOKEN is missing");
    }

    const response = await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/${method}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body || {})
    });

    const data = await response.json().catch(() => null);

    if (!response.ok || !data || data.ok === false) {
        const description = data && data.description ? data.description : `Telegram API error ${response.status}`;
        const error = new Error(description);
        error.telegram = data;
        throw error;
    }

    return data;
}

// Sends a Telegram message to a chat.
async function sendTelegramMessage(chatId, text, options) {
    if (!process.env.TELEGRAM_BOT_TOKEN || !chatId) {
        return;
    }

    return telegramApi("sendMessage", {
        chat_id: chatId,
        text,
        ...(options || {})
    });
}

// Creates a call row and optionally triggers the call provider.
async function createCall(phone, chatId) {
    const baseUrl = publicUrl();
    const audioName = process.env.DEFAULT_AUDIO_FILE || "welcome.mp3";
    const audioUrl = `${baseUrl}/audio/${audioName}`;

    const insertResult = await db.query(
        "INSERT INTO calls (phone, status, telegram_chat_id, audio_url) VALUES (?, ?, ?, ?)",
        [phone, "QUEUED", chatId || null, audioUrl]
    );

    const callId = insertResult.insertId;
    const providerPayload = {
        callId,
        phone,
        audioUrl,
        voiceUrl: `${baseUrl}/call/${callId}/voice`,
        dtmfWebhookUrl: `${baseUrl}/webhook/dtmf`
    };

    let providerResponse = null;
    let status = "READY";

    if (process.env.CALL_PROVIDER_URL) {
        const response = await fetch(process.env.CALL_PROVIDER_URL, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(providerPayload)
        });

        providerResponse = await response.json().catch(() => ({ status: response.status }));
        status = response.ok ? "CALLING" : "PROVIDER_FAILED";

        await db.query(
            "UPDATE calls SET status = ?, provider_call_id = ? WHERE id = ?",
            [status, providerResponse.callId || providerResponse.id || providerResponse.sid || null, callId]
        );
    } else {
        await db.query("UPDATE calls SET status = ? WHERE id = ?", [status, callId]);
    }

    await db.query(
        "INSERT INTO call_logs (call_id, event, payload) VALUES (?, ?, ?)",
        [callId, "TELEGRAM_STARTCALL", JSON.stringify({ providerPayload, providerResponse })]
    );

    return { callId, status, providerPayload, providerResponse };
}

// Handles Telegram text commands such as /start and /startcall.
async function handleTelegramText(chatId, text, options) {
    const local = options && options.local;

    if (text === "/start") {
        await sendTelegramMessage(chatId, "Voice support admin panel", {
            reply_markup: mainMenuKeyboard()
        });
        return { handled: true, action: "help" };
    }

    if (!text.startsWith("/startcall")) {
        return { handled: false, action: "ignored" };
    }

    const phone = text.split(/\s+/)[1];

    if (!phone) {
        await sendTelegramMessage(chatId, "Missing phone number. Use /startcall PHONE_NUMBER");
        return { handled: true, action: "missing_phone" };
    }

    const call = await createCall(phone, chatId);

    await sendTelegramMessage(chatId, `Call ${call.callId} started for ${phone}. Status: ${call.status}`, {
        reply_markup: callKeyboard(call.callId)
    });

    return {
        handled: true,
        action: "startcall",
        local,
        phone,
        call
    };
}

// Handles Telegram inline button callback actions.
async function handleTelegramCallback(callbackQuery) {
    const data = callbackQuery.data;
    const chatId = callbackQuery.message && callbackQuery.message.chat && callbackQuery.message.chat.id;

    if (!chatId) {
        return { handled: false, action: "missing_chat" };
    }

    if (callbackQuery.id !== "local-callback") {
        await telegramApi("answerCallbackQuery", { callback_query_id: callbackQuery.id });
    }

    if (data === "main_menu") {
        await sendTelegramMessage(chatId, "Voice support admin panel", {
            reply_markup: mainMenuKeyboard()
        });
        return { handled: true, action: "main_menu" };
    }

    if (data === "help_startcall") {
        await sendTelegramMessage(chatId, "Send /startcall PHONE_NUMBER to start a call.", {
            reply_markup: mainMenuKeyboard()
        });
        return { handled: true, action: "help_startcall" };
    }

    if (data === "ping_backend") {
        await sendTelegramMessage(chatId, `Backend ping OK: ${new Date().toISOString()}`, {
            reply_markup: mainMenuKeyboard()
        });
        return { handled: true, action: "ping_backend" };
    }

    if (data === "webhook_status") {
        const info = await telegramApi("getWebhookInfo");
        await sendTelegramMessage(
            chatId,
            `Webhook URL: ${info.result.url || "not set"}\nPending updates: ${info.result.pending_update_count}`,
            { reply_markup: mainMenuKeyboard() }
        );
        return { handled: true, action: "webhook_status", webhook: info.result };
    }

    if (data && data.startsWith("call_details:")) {
        const callId = data.split(":")[1];
        const calls = await db.query("SELECT * FROM calls WHERE id = ?", [callId]);

        if (!calls.length) {
            await sendTelegramMessage(chatId, `Call ${callId} was not found.`, {
                reply_markup: mainMenuKeyboard()
            });
            return { handled: true, action: "call_not_found", callId };
        }

        const call = calls[0];
        await sendTelegramMessage(
            chatId,
            `Call ${call.id}\nPhone: ${call.phone}\nStatus: ${call.status}\nLast digit: ${call.last_digit || "none"}`,
            { reply_markup: callKeyboard(call.id) }
        );
        return { handled: true, action: "call_details", callId };
    }

    return { handled: false, action: "unknown_button", data };
}

// Processes one Telegram update from webhook or polling.
async function handleTelegramUpdate(update) {
    if (update.callback_query) {
        return handleTelegramCallback(update.callback_query);
    }

    const message = update.message || update.edited_message;
    const text = message && message.text;
    const chatId = message && message.chat && message.chat.id;

    if (!text || !chatId) {
        return { handled: false, action: "ignored_update" };
    }

    return handleTelegramText(chatId, text);
}

module.exports = {
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
};
