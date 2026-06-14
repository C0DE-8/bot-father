function connectProject(siteId, options = {}) {
    const resolvedSiteId = siteId || options.siteId || process.env.SITE_ID;
    const apiKey = options.apiKey || process.env.API_KEY;
    const dbmsUrl = normalizeUrl(options.dbmsUrl || process.env.DBMS_URL || "http://localhost:4000");
    const timeoutMs = Number(options.timeoutMs || process.env.DBMS_TIMEOUT_MS || 15000);

    if (!resolvedSiteId) throw new Error("siteId or SITE_ID is required");
    if (!apiKey) throw new Error("API_KEY is required");
    if (!dbmsUrl) throw new Error("DBMS_URL is required");
    if (!globalThis.fetch) {
        throw new Error("global fetch is required. Use Node.js 18+.");
    }

    async function gatewayRequest(path, body) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
            const response = await fetch(`${dbmsUrl}${path}`, {
                method: path === "/gateway/status" ? "GET" : "POST",
                headers: {
                    "Content-Type": "application/json",
                    "x-site-id": resolvedSiteId,
                    "x-api-key": apiKey
                },
                body: body ? JSON.stringify(body) : undefined,
                signal: controller.signal
            });

            const payload = await response.json().catch(() => ({}));

            if (!response.ok) {
                throw new Error(payload.error || payload.message || `DBMS request failed with ${response.status}`);
            }

            return payload;
        } catch (error) {
            if (error.name === "AbortError") {
                throw new Error(`DBMS request timed out after ${timeoutMs}ms`);
            }

            throw error;
        } finally {
            clearTimeout(timeout);
        }
    }

    return {
        siteId: resolvedSiteId,
        dbmsUrl,

        async query(sql, params = []) {
            const payload = await gatewayRequest("/gateway/query", { sql, params });
            return payload.rows || [];
        },

        async execute(sql, params = []) {
            return this.query(sql, params);
        },

        async status() {
            return gatewayRequest("/gateway/status");
        }
    };
}

function normalizeUrl(url) {
    return String(url || "").replace(/\/$/, "");
}

module.exports = { connectProject };
