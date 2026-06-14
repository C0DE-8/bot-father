const fs = require("fs");
const path = require("path");
const { connectProject } = require("../diamond-sql");

const db = connectProject(process.env.SITE_ID, {
    apiKey: process.env.API_KEY,
    dbmsUrl: process.env.DBMS_URL,
    timeoutMs: process.env.DBMS_TIMEOUT_MS
});

function splitSqlStatements(sql) {
    return sql
        .split(";")
        .map((statement) => statement.trim())
        .filter(Boolean);
}

async function runMigrations() {
    await db.query(`
        CREATE TABLE IF NOT EXISTS schema_migrations (
            id INT AUTO_INCREMENT PRIMARY KEY,
            filename VARCHAR(255) NOT NULL UNIQUE,
            executed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
        )
    `);

    const migrationsDir = path.join(__dirname, "..", "migrations");
    const migrationFiles = fs
        .readdirSync(migrationsDir)
        .filter((file) => file.endsWith(".sql"))
        .sort();

    for (const file of migrationFiles) {
        const existing = await db.query("SELECT id FROM schema_migrations WHERE filename = ?", [file]);

        if (existing.length) {
            continue;
        }

        const sql = fs.readFileSync(path.join(migrationsDir, file), "utf8");
        const statements = splitSqlStatements(sql);

        for (const statement of statements) {
            await db.query(statement);
        }

        await db.query("INSERT INTO schema_migrations (filename) VALUES (?)", [file]);
        console.log(`Migration applied: ${file}`);
    }
}

module.exports = db;
module.exports.runMigrations = runMigrations;
