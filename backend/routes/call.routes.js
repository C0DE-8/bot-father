const express = require("express");
const router = express.Router();
const db = require("../db/database");
const { apiUrl, createCall } = require("./call/call.functions");

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

        const call = await createCall(phone, telegramChatId, audioFile);

        await notifyTelegram(
            telegramChatId,
            `✅ Call ${call.callId} started\n📱 Number: ${phone}\n📌 Status: ${call.status}`
        );

        res.json({
            message: "Call created",
            ...call
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
        const dtmfUrl = `${apiUrl(`/webhook/dtmf?callId=${call.id}`)}`;

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
