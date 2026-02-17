/**
 * Debug endpoint — показує стан системи для відлагодження.
 * GET /api/debug
 * 
 * Перевіряє:
 * - Environment variables (без значень, тільки SET/MISSING)
 * - KV кеш: токен, дані батарей, лог помилок
 * - Час останнього оновлення даних
 */

async function kvGet(kv, key) {
    if (!kv) return null;
    try {
        const value = await kv.get(key);
        return value ? JSON.parse(value) : null;
    } catch (e) { return null; }
}

export async function onRequest(context) {
    const { env } = context;

    // 1. Перевірка env vars
    const envCheck = {
        DEYE_APP_ID: env.DEYE_APP_ID ? 'SET' : '❌ MISSING',
        DEYE_APP_SECRET: env.DEYE_APP_SECRET ? 'SET' : '❌ MISSING',
        DEYE_EMAIL: env.DEYE_EMAIL ? 'SET' : '❌ MISSING',
        DEYE_PASSWORD: env.DEYE_PASSWORD ? 'SET' : '❌ MISSING',
        DEYE_CACHE: env.DEYE_CACHE ? 'CONNECTED' : '❌ MISSING'
    };

    const kv = env.DEYE_CACHE || null;

    // 2. Перевірка кешу токена
    let tokenStatus = 'NO KV';
    if (kv) {
        const tokenData = await kvGet(kv, 'deye_token');
        if (tokenData && tokenData.token) {
            const ageMs = Date.now() - (tokenData.createdAt || 0);
            const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
            const ageHours = Math.floor((ageMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            tokenStatus = `✅ Valid (created ${ageDays}d ${ageHours}h ago)`;
        } else {
            tokenStatus = '⚠️ No token cached (will fetch on next request)';
        }
    }

    // 3. Перевірка кешу даних батарей
    let dataStatus = 'NO KV';
    let batteryPreview = null;
    if (kv) {
        const batteryData = await kvGet(kv, 'battery_data_v3');
        if (batteryData && batteryData.timestamp) {
            const ageMs = Date.now() - batteryData.timestamp;
            const ageMin = Math.floor(ageMs / 60000);
            const ageSec = Math.floor((ageMs % 60000) / 1000);
            const isStale = ageMs > 300000; // > 5 хв
            dataStatus = `${isStale ? '⚠️ Stale' : '✅ Fresh'} (updated ${ageMin}m ${ageSec}s ago)`;

            // Короткий превʼю даних
            if (batteryData.batteries) {
                batteryPreview = batteryData.batteries.map(b => ({
                    id: b.id,
                    name: b.name,
                    level: `${b.level}%`,
                    grid: b.grid_freq > 45 ? `⚡ ON (${b.grid_freq}Hz)` : '❌ OFF'
                }));
            }
        } else {
            dataStatus = '⚠️ No data cached yet';
        }
    }

    // 4. Лог останніх помилок
    let recentErrors = [];
    if (kv) {
        const errorLog = await kvGet(kv, 'error_log');
        if (errorLog && Array.isArray(errorLog)) {
            recentErrors = errorLog;
        }
    }

    const result = {
        status: 'ok',
        project: 'status-deye-cf-p8',
        timestamp: new Date().toISOString(),
        env_check: envCheck,
        token_status: tokenStatus,
        data_cache_status: dataStatus,
        battery_preview: batteryPreview,
        recent_errors: recentErrors.length > 0 ? recentErrors : 'No errors logged',
        help: {
            clear_token: 'Delete "deye_token" key from KV to force re-auth',
            clear_data: 'Delete "battery_data_v3" key from KV to force data refresh',
            clear_errors: 'Delete "error_log" key from KV to clear error history'
        }
    };

    return new Response(JSON.stringify(result, null, 2), {
        headers: {
            'Content-Type': 'application/json',
            'Cache-Control': 'no-cache'
        }
    });
}
