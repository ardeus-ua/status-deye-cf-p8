/**
 * Cloudflare Pages Function — DeyeCloud API Proxy
 * 
 * Отримує дані про рівень заряду батарей з DeyeCloud API.
 * Використовує /v1.0/station/list для отримання batterySOC.
 * Кешує токен (60 днів) та дані (5 хв) через Cloudflare KV.
 * 
 * Environment Variables (Cloudflare Dashboard → Pages → Settings):
 *   DEYE_APP_ID      — AppId з developer.deyecloud.com
 *   DEYE_APP_SECRET  — AppSecret
 *   DEYE_EMAIL       — Email акаунту DeyeCloud
 *   DEYE_PASSWORD    — Пароль (у відкритому вигляді, хешується SHA256 тут)
 * 
 * KV Namespace Binding:
 *   DEYE_CACHE       — для кешування токена і даних
 */

// Маппінг: id → stationId (з DeyeCloud /v1.0/station/list)
const STATIONS = {
    1: { stationId: 61392915, name: 'Ліфти 1 парадне' },  // Ліфт п1
    2: { stationId: 61392916, name: 'Ліфти 2 парадне' },  // Ліфт п2
    3: { stationId: 61392918, name: 'Ліфти 3 парадне' },  // Ліфт п3
    4: { stationId: 61392925, name: 'Насосна 2-а' },       // Вода
    5: { stationId: 61392922, name: 'ІТП 2-а' },           // Опалення
    // TODO: Опалення 2 — потрібно уточнити stationId
};

const BASE_URL = 'https://eu1-developer.deyecloud.com';
const DATA_CACHE_TTL = 300;      // 5 хвилин (секунди)
const TOKEN_CACHE_TTL = 5184000; // 60 днів (секунди)

// ─── Утиліти ──────────────────────────────────────────────

async function sha256(text) {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function corsHeaders() {
    return {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300',
    };
}

function errorResponse(message, status = 500) {
    return new Response(
        JSON.stringify({ error: message }),
        { status, headers: corsHeaders() }
    );
}

// ─── KV кеш ──────────────────────────────────────────────

async function kvGet(kv, key) {
    if (!kv) return null;
    try {
        const value = await kv.get(key);
        return value ? JSON.parse(value) : null;
    } catch (e) {
        console.error(`KV get error (${key}):`, e.message);
        return null;
    }
}

async function kvPut(kv, key, value, ttl) {
    if (!kv) return;
    try {
        await kv.put(key, JSON.stringify(value), { expirationTtl: ttl });
    } catch (e) {
        console.error(`KV put error (${key}):`, e.message);
    }
}

// ─── DeyeCloud Auth ───────────────────────────────────────

async function getAccessToken(env) {
    const kv = env.DEYE_CACHE || null;

    // 1. Спроба з KV кешу
    const cached = await kvGet(kv, 'deye_token');
    if (cached && cached.token) {
        return cached.token;
    }

    // 2. Перевіряємо наявність credentials
    const { DEYE_APP_ID: appId, DEYE_APP_SECRET: appSecret, DEYE_EMAIL: email, DEYE_PASSWORD: password } = env;

    if (!appId || !appSecret || !email || !password) {
        throw new Error('Missing credentials. Set DEYE_APP_ID, DEYE_APP_SECRET, DEYE_EMAIL, DEYE_PASSWORD.');
    }

    // 3. Хешуємо пароль SHA256
    const passwordHash = await sha256(password);

    // 4. Запит токена
    const response = await fetch(`${BASE_URL}/v1.0/account/token?appId=${appId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appSecret, email, password: passwordHash }),
    });

    const result = await response.json();

    if (!result.success) {
        throw new Error(`DeyeCloud auth error: ${result.msg || JSON.stringify(result).substring(0, 200)}`);
    }

    const token = result.accessToken || result?.data?.accessToken || result?.data?.token;
    if (!token) {
        throw new Error(`No token in response: ${JSON.stringify(result).substring(0, 200)}`);
    }

    // 5. Кешуємо токен
    await kvPut(kv, 'deye_token', { token, createdAt: Date.now() }, TOKEN_CACHE_TTL);

    return token;
}

// ─── Отримання даних станцій ──────────────────────────────

async function fetchStationList(token) {
    const response = await fetch(`${BASE_URL}/v1.0/station/list`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ page: 1, size: 50 }),
    });

    const result = await response.json();

    if (!result.success || !result.stationList) {
        throw new Error(`Station list error: ${result.msg || JSON.stringify(result).substring(0, 200)}`);
    }

    return result.stationList;
}

// ─── Головний обробник ──────────────────────────────────

export async function onRequest(context) {
    const { env, request } = context;

    // CORS preflight
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            headers: {
                ...corsHeaders(),
                'Access-Control-Allow-Methods': 'GET, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type',
            },
        });
    }

    try {
        const kv = env.DEYE_CACHE || null;

        // 1. Перевіряємо кеш даних
        const cachedData = await kvGet(kv, 'battery_data');
        if (cachedData && cachedData.batteries) {
            const age = Date.now() - (cachedData.timestamp || 0);
            if (age < DATA_CACHE_TTL * 1000) {
                return new Response(
                    JSON.stringify({ data: cachedData.batteries, cached: true }),
                    { headers: corsHeaders() }
                );
            }
        }

        // 2. Отримуємо токен
        const token = await getAccessToken(env);

        // 3. Отримуємо список станцій (один запит замість N!)
        const stationList = await fetchStationList(token);

        // 4. Маппінг stationId → наші батареї
        const stationMap = {};
        for (const station of stationList) {
            stationMap[station.id] = station;
        }

        const batteries = [];
        for (const [id, config] of Object.entries(STATIONS)) {
            const station = stationMap[config.stationId];
            const now = new Date().toISOString();

            if (station) {
                batteries.push({
                    id: parseInt(id),
                    name: config.name,
                    level: station.batterySOC !== null && station.batterySOC !== undefined
                        ? Math.round(station.batterySOC)
                        : 0,
                    grid_freq: station.connectionStatus === 'NORMAL' ? 50.0 : 0.0,
                    timestamp: station.lastUpdateTime
                        ? new Date(station.lastUpdateTime * 1000).toISOString()
                        : now,
                });
            } else {
                batteries.push({
                    id: parseInt(id),
                    name: config.name,
                    level: 0,
                    grid_freq: 0,
                    timestamp: now,
                });
            }
        }

        // 5. Кешуємо
        await kvPut(kv, 'battery_data', {
            batteries,
            timestamp: Date.now(),
        }, DATA_CACHE_TTL);

        // 6. Відповідь
        return new Response(
            JSON.stringify({ data: batteries, cached: false }),
            { headers: corsHeaders() }
        );

    } catch (error) {
        console.error('Battery API error:', error.message);

        // Fallback: stale cache
        const kv = env.DEYE_CACHE || null;
        const staleData = await kvGet(kv, 'battery_data');
        if (staleData && staleData.batteries) {
            return new Response(
                JSON.stringify({
                    data: staleData.batteries,
                    cached: true,
                    stale: true,
                    warning: error.message,
                }),
                { headers: corsHeaders() }
            );
        }

        return errorResponse(error.message);
    }
}
