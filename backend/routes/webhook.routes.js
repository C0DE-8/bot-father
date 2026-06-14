const express = require("express");
const router = express.Router();
const db = require("../db/database");

async function sendTelegramMessage(chatId, text) {
    if (!process.env.TELEGRAM_BOT_TOKEN || !chatId) {
        return;
    }

    await fetch(`https://api.telegram.org/bot${process.env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text })
    });
}

router.post("/dtmf", async (req, res) => {
    try {
        const callId = req.body.callId || req.query.callId;
        const digit = req.body.digit || req.body.Digits || req.body.dtmf;

        if (!callId || !digit) {
            return res.status(400).json({ error: "callId and digit are required" });
        }

        const calls = await db.query("SELECT * FROM calls WHERE id = ?", [callId]);

        if (!calls.length) {
            return res.status(404).json({ error: "Call not found" });
        }

        const call = calls[0];

        await db.query(
            "INSERT INTO call_logs (call_id, event, digit, payload) VALUES (?, ?, ?, ?)",
            [call.id, "DTMF_RECEIVED", digit, JSON.stringify(req.body)]
        );

        await db.query(
            "UPDATE calls SET status = ?, last_digit = ? WHERE id = ?",
            ["DTMF_RECEIVED", digit, call.id]
        );

        console.log(`Call ${call.id} pressed: ${digit}`);
        await sendTelegramMessage(call.telegram_chat_id, `Call ${call.id} pressed digit: ${digit}`);

        if ((req.headers.accept || "").includes("xml") || req.body.Digits || req.body.CallSid) {
            return res.type("text/xml").send(`<?xml version="1.0" encoding="UTF-8"?>
<Response>
    <Say>Thank you.</Say>
</Response>`);
        }

        res.json({ ok: true, callId: call.id, digit });
    } catch (error) {
        console.error("DTMF webhook failed:", error);
        res.status(500).json({ error: "Failed to handle DTMF" });
    }
});

router.post("/twilio/status", async (req, res) => {
    try {
        const callId = req.body.callId || req.query.callId;
        const twilioStatus = req.body.CallStatus || req.body.CallStatusCallbackEvent || req.body.status;
        const twilioSid = req.body.CallSid || req.body.callSid;

        if (!callId) {
            return res.status(400).json({ error: "callId is required" });
        }

        const calls = await db.query("SELECT * FROM calls WHERE id = ?", [callId]);

        if (!calls.length) {
            return res.status(404).json({ error: "Call not found" });
        }

        const call = calls[0];
        const status = twilioStatus ? `TWILIO_${String(twilioStatus).toUpperCase()}` : call.status;

        await db.query("UPDATE calls SET status = ?, provider_call_id = COALESCE(provider_call_id, ?) WHERE id = ?", [
            status,
            twilioSid || null,
            call.id
        ]);

        await db.query(
            "INSERT INTO call_logs (call_id, event, payload) VALUES (?, ?, ?)",
            [call.id, "TWILIO_STATUS", JSON.stringify(req.body)]
        );

        await sendTelegramMessage(call.telegram_chat_id, `📞 Call ${call.id} update: ${status}`);

        res.json({ ok: true, callId: call.id, status });
    } catch (error) {
        console.error("Twilio status webhook failed:", error);
        res.status(500).json({ error: "Failed to handle Twilio status" });
    }
});

module.exports = router;
