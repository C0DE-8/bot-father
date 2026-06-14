const express = require("express");
const path = require("path");
require("dotenv").config();

const db = require("./db/database");
const app = express();

app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use("/audio", express.static(path.join(__dirname, "audio")));

app.use("/api/telegram", require("./routes/telegram.routes"));
app.use("/api/call", require("./routes/call.routes"));
app.use("/api/webhook", require("./routes/webhook.routes"));

const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
    res.json({
        ok: true,
        message: "Bot server is working",
        service: "voice-support-bot",
        port: Number(PORT)
    });
});

app.get("/api/dbms/status", async (req, res) => {
    try {
        const status = await db.status();

        res.json({
            ok: true,
            connected: Boolean(status.online || status.connected),
            siteId: process.env.SITE_ID || null,
            dbmsUrl: process.env.DBMS_URL || "http://localhost:4000",
            gateway: status
        });
    } catch (error) {
        res.status(503).json({
            ok: false,
            connected: false,
            siteId: process.env.SITE_ID || null,
            dbmsUrl: process.env.DBMS_URL || "http://localhost:4000",
            error: error.message
        });
    }
});

app.get("/health", async (req, res) => {
    try {
        const status = await db.status();
        res.json({ ok: true, gateway: status });
    } catch (error) {
        res.status(503).json({ ok: false, error: error.message });
    }
});

db.runMigrations()
    .then(() => {
        app.listen(PORT, () => {
            console.log(`Voice system running on port http://localhost:${PORT}`);
        });
    })
    .catch((error) => {
        console.error("Database initialization failed:", error);
        process.exit(1);
    });
