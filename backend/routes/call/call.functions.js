const twilio = require("twilio");
const db = require("../../db/database");

// Builds the public base URL used by Twilio callbacks.
function publicUrl() {
    return (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, "");
}

// Builds an API URL because the app mounts routes under /api.
function apiUrl(path) {
    return `${publicUrl()}/api${path}`;
}

// Creates a Twilio REST client from environment credentials.
function twilioClient() {
    if (!process.env.TWILIO_ACCOUNT_SID || !process.env.TWILIO_AUTH_TOKEN) {
        return null;
    }

    return twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN);
}

// Starts the real outbound call through Twilio.
async function startTwilioCall(callId, phone, voiceUrl) {
    const client = twilioClient();

    if (!client || !process.env.TWILIO_PHONE_NUMBER) {
        return {
            triggered: false,
            status: "READY",
            response: {
                message: "Twilio is not configured. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, and TWILIO_PHONE_NUMBER."
            }
        };
    }

    const call = await client.calls.create({
        to: phone,
        from: process.env.TWILIO_PHONE_NUMBER,
        url: voiceUrl,
        method: "GET",
        statusCallback: apiUrl(`/webhook/twilio/status?callId=${callId}`),
        statusCallbackMethod: "POST",
        statusCallbackEvent: ["initiated", "ringing", "answered", "completed"]
    });

    return {
        triggered: true,
        status: "CALLING",
        response: {
            sid: call.sid,
            status: call.status,
            to: call.to,
            from: call.from,
            direction: call.direction
        }
    };
}

// Creates a call record and triggers Twilio when credentials are configured.
async function createCall(phone, telegramChatId, audioFile) {
    const audioName = audioFile || process.env.DEFAULT_AUDIO_FILE || "welcome.mp3";
    const audioUrl = `${publicUrl()}/audio/${audioName}`;

    const insertResult = await db.query(
        "INSERT INTO calls (phone, status, telegram_chat_id, audio_url) VALUES (?, ?, ?, ?)",
        [phone, "QUEUED", telegramChatId || null, audioUrl]
    );

    const callId = insertResult.insertId;
    const voiceUrl = apiUrl(`/call/${callId}/voice`);
    const dtmfWebhookUrl = apiUrl("/webhook/dtmf");

    let twilioResult;

    try {
        twilioResult = await startTwilioCall(callId, phone, voiceUrl);
    } catch (error) {
        twilioResult = {
            triggered: false,
            status: "TWILIO_FAILED",
            response: {
                error: error.message,
                code: error.code || null,
                status: error.status || null
            }
        };
    }

    await db.query(
        "UPDATE calls SET status = ?, provider_call_id = ? WHERE id = ?",
        [twilioResult.status, twilioResult.response.sid || null, callId]
    );

    await db.query(
        "INSERT INTO call_logs (call_id, event, payload) VALUES (?, ?, ?)",
        [
            callId,
            "CALL_CREATED",
            JSON.stringify({
                provider: "twilio",
                twilioTriggered: twilioResult.triggered,
                voiceUrl,
                audioUrl,
                dtmfWebhookUrl,
                twilioResponse: twilioResult.response
            })
        ]
    );

    return {
        callId,
        status: twilioResult.status,
        phone,
        audioUrl,
        voiceUrl,
        dtmfWebhookUrl,
        twilioTriggered: twilioResult.triggered,
        twilioResponse: twilioResult.response,
        providerPayload: {
            provider: "twilio",
            callId,
            phone,
            audioUrl,
            voiceUrl,
            dtmfWebhookUrl
        },
        providerResponse: twilioResult.response
    };
}

module.exports = {
    apiUrl,
    createCall,
    publicUrl,
    startTwilioCall
};
