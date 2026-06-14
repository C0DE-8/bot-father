const db = require("../../db/database");

const pendingPhoneChats = new Map();

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
            [{ text: "📞 Start Call", callback_data: "help_startcall" }],
            [
                { text: "🟢 Ping Backend", callback_data: "ping_backend" },
                { text: "🔗 Webhook Status", callback_data: "webhook_status" }
            ]
        ]
    };
}

// Builds a small back/menu keyboard for simple prompt screens.
function backMenuKeyboard() {
    return {
        inline_keyboard: [
            [
                { text: "⬅️ Back", callback_data: "main_menu" },
                { text: "📞 Start Call", callback_data: "help_startcall" }
            ]
        ]
    };
}

// Builds buttons for a specific call after it starts.
function callKeyboard(callId) {
    return {
        inline_keyboard: [
            [
                { text: "🔎 Call Details", callback_data: `call_details:${callId}` },
                { text: "📞 New Call", callback_data: "help_startcall" }
            ],
            [
                { text: "🏠 Main Menu", callback_data: "main_menu" }
            ]
        ]
    };
}

// Builds the welcome text shown to the Telegram admin.
function mainMenuText() {
    return "Hello Queen 👑\n\nYour voice support panel is ready.\nChoose what you want to do:";
}

// Checks whether a message looks like an international phone number.
function isPhoneNumber(text) {
    return /^\+\d{3,15}$/.test(String(text || "").trim());
}

// Prompts the admin to type a phone number after pressing Start Call.
async function promptForPhone(chatId) {
    pendingPhoneChats.set(String(chatId), true);

    await sendTelegramMessage(
        chatId,
        "📞 Send the phone number now.\n\nExamples:\n+2347065785436\n+136",
        { reply_markup: backMenuKeyboard() }
    );
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
    const trimmedText = String(text || "").trim();
    const pendingKey = String(chatId);

    if (trimmedText === "/start") {
        pendingPhoneChats.delete(pendingKey);
        await sendTelegramMessage(chatId, mainMenuText(), {
            reply_markup: mainMenuKeyboard()
        });
        return { handled: true, action: "help" };
    }

    if (pendingPhoneChats.has(pendingKey) && !isPhoneNumber(trimmedText)) {
        await sendTelegramMessage(chatId, "That number does not look right. Please send it like +2347065785436.", {
            reply_markup: backMenuKeyboard()
        });
        return { handled: true, action: "invalid_phone" };
    }

    if (pendingPhoneChats.has(pendingKey) && isPhoneNumber(trimmedText)) {
        pendingPhoneChats.delete(pendingKey);
        const call = await createCall(trimmedText, chatId);

        await sendTelegramMessage(chatId, `✅ Call ${call.callId} started\n📱 Number: ${trimmedText}\n📌 Status: ${call.status}`, {
            reply_markup: callKeyboard(call.callId)
        });

        return {
            handled: true,
            action: "startcall",
            local,
            phone: trimmedText,
            call
        };
    }

    if (!trimmedText.startsWith("/startcall")) {
        await sendTelegramMessage(chatId, "I am ready when you are, Queen 👑", {
            reply_markup: mainMenuKeyboard()
        });
        return { handled: false, action: "ignored" };
    }

    const phone = trimmedText.split(/\s+/)[1];

    if (!phone) {
        await promptForPhone(chatId);
        return { handled: true, action: "missing_phone" };
    }

    if (!isPhoneNumber(phone)) {
        await sendTelegramMessage(chatId, "That number does not look right. Please send it like +2347065785436.", {
            reply_markup: backMenuKeyboard()
        });
        return { handled: true, action: "invalid_phone" };
    }

    const call = await createCall(phone, chatId);

    await sendTelegramMessage(chatId, `✅ Call ${call.callId} started\n📱 Number: ${phone}\n📌 Status: ${call.status}`, {
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
        pendingPhoneChats.delete(String(chatId));
        await sendTelegramMessage(chatId, mainMenuText(), {
            reply_markup: mainMenuKeyboard()
        });
        return { handled: true, action: "main_menu" };
    }

    if (data === "help_startcall") {
        await promptForPhone(chatId);
        return { handled: true, action: "help_startcall" };
    }

    if (data === "ping_backend") {
        await sendTelegramMessage(chatId, `✅ Backend is online\n🕒 ${new Date().toISOString()}`, {
            reply_markup: mainMenuKeyboard()
        });
        return { handled: true, action: "ping_backend" };
    }

    if (data === "webhook_status") {
        const info = await telegramApi("getWebhookInfo");
        await sendTelegramMessage(
            chatId,
            `🔗 Webhook Status\n\nURL: ${info.result.url || "not set"}\nPending updates: ${info.result.pending_update_count}`,
            { reply_markup: mainMenuKeyboard() }
        );
        return { handled: true, action: "webhook_status", webhook: info.result };
    }

    if (data && data.startsWith("call_details:")) {
        const callId = data.split(":")[1];
        const calls = await db.query("SELECT * FROM calls WHERE id = ?", [callId]);

        if (!calls.length) {
            await sendTelegramMessage(chatId, `⚠️ Call ${callId} was not found.`, {
                reply_markup: mainMenuKeyboard()
            });
            return { handled: true, action: "call_not_found", callId };
        }

        const call = calls[0];
        await sendTelegramMessage(
            chatId,
            `🔎 Call ${call.id}\n\n📱 Number: ${call.phone}\n📌 Status: ${call.status}\n⌨️ Last digit: ${call.last_digit || "none"}`,
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
