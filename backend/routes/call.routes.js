const express = require("express");
const router = express.Router();
const db = require("../db/database");

function publicUrl() {
    return (process.env.PUBLIC_URL || `http://localhost:${process.env.PORT || 3000}`).replace(/\/$/, "");
}

async function notifyTelegram(chatId, text) {
    if (!process.env.TELEGRAM_BOT_TOKEN || !chatId) {
        return;
    }

    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text })
    });
}

router.post("/create", async (req, res) => {
    try {
        const { phone, telegramChatId, audioFile } = req.body;

        if (!phone) {
            return res.status(400).json({ error: "phone is required" });
        }

        const baseUrl = publicUrl();
        const audioName = audioFile || process.env.DEFAULT_AUDIO_FILE || "welcome.mp3";
        const audioUrl = `${baseUrl}/audio/${audioName}`;

        const insertResult = await db.query(
            "INSERT INTO calls (phone, status, telegram_chat_id, audio_url) VALUES (?, ?, ?, ?)",
            [phone, "QUEUED", telegramChatId || null, audioUrl]
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
        let providerTriggered = false;

        if (process.env.CALL_PROVIDER_URL) {
            const response = await fetch(process.env.CALL_PROVIDER_URL, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(providerPayload)
            });

            providerResponse = await response.json().catch(() => ({ status: response.status }));
            providerTriggered = response.ok;

            await db.query(
                "UPDATE calls SET status = ?, provider_call_id = ? WHERE id = ?",
                [
                    response.ok ? "CALLING" : "PROVIDER_FAILED",
                    providerResponse.callId || providerResponse.id || providerResponse.sid || null,
                    callId
                ]
            );
        } else {
            await db.query("UPDATE calls SET status = ? WHERE id = ?", ["READY", callId]);
        }

        await db.query(
            "INSERT INTO call_logs (call_id, event, payload) VALUES (?, ?, ?)",
            [callId, "CALL_CREATED", JSON.stringify({ providerTriggered, providerPayload, providerResponse })]
        );

        await notifyTelegram(
            telegramChatId,
            `Call ${callId} started for ${phone}. Status: ${providerTriggered ? "CALLING" : "READY"}`
        );

        res.json({
            message: "Call created",
            callId,
            providerTriggered,
            providerResponse,
            audioUrl,
            voiceUrl: providerPayload.voiceUrl,
            dtmfWebhookUrl: providerPayload.dtmfWebhookUrl
        });
    } catch (error) {
        console.error("Create call failed:", error);
        res.status(500).json({ error: "Failed to create call" });
    }
});

router.post("/startcall", async (req, res) => {
    req.url = "/create";
    router.handle(req, res);
});

router.get("/:id/voice", async (req, res) => {
    try {
        const rows = await db.query("SELECT * FROM calls WHERE id = ?", [req.params.id]);

        if (!rows.length) {
            return res.status(404).send("Call not found");
        }

        const call = rows[0];
        const dtmfUrl = `${publicUrl()}/webhook/dtmf?callId=${call.id}`;

        await db.query(
            "INSERT INTO call_logs (call_id, event, payload) VALUES (?, ?, ?)",
            [call.id, "AUDIO_PLAYED", JSON.stringify({ audioUrl: call.audio_url })]
        );

        res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Gather input="dtmf" numDigits="1" action="${dtmfUrl}" method="POST" timeout="10">
        <Play>${call.audio_url}</Play>
    </Gather>
</Response>`);
    } catch (error) {
        console.error("Voice response failed:", error);
        res.status(500).send("Failed to build voice response");
    }
});

router.get("/:id", async (req, res) => {
    const calls = await db.query("SELECT * FROM calls WHERE id = ?", [req.params.id]);

    if (!calls.length) {
        return res.status(404).json({ error: "Call not found" });
    }

    const logs = await db.query(
        "SELECT id, event, digit, payload, created_at FROM call_logs WHERE call_id = ? ORDER BY id ASC",
        [req.params.id]
    );

    res.json({ call: calls[0], logs });
});

module.exports = router;
