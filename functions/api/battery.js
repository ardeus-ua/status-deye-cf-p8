/**
 * Cloudflare Pages Function — DeyeCloud API Proxy
 * 
 * Отримує дані про рівень заряду батарей з DeyeCloud API.
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

// Маппінг: id → серійний номер інвертора
const INVERTERS = {
    1: '2407021154',  // Ліфт п1
    2: '2407024008',  // Ліфт п2
    3: '2407026195',  // Ліфт п3
    4: '2407026187',  // Вода
    5: '2407024186',  // Опалення
    6: '2510171041',  // Опалення 2
};

const BASE_URL = 'https://eu1-developer.deyecloud.com';
const DATA_CACHE_TTL = 300;   // 5 хвилин (секунди)
const TOKEN_CACHE_TTL = 5184000; // 60 днів (секунди)

// ─── Утиліти ──────────────────────────────────────────────

/**
 * SHA-256 хеш пароля (lowercase hex)
 */
async function sha256(text) {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * CORS заголовки
 */
function corsHeaders() {
    return {
        'Content-Type': 'application/json; charset=utf-8',
        'Access-Control-Allow-Origin': '*',
        'Cache-Control': 'public, max-age=300', // 5 хвилин CDN кеш
    };
}

/**
 * JSON відповідь помилки
 */
function errorResponse(message, status = 500) {
    return new Response(
        JSON.stringify({ error: message }),
        { status, headers: corsHeaders() }
    );
}

// ─── KV кеш обгортки ─────────────────────────────────────

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

/**
 * Отримати access token з кешу або через API
 */
async function getAccessToken(env) {
    const kv = env.DEYE_CACHE || null;

    // 1. Спроба з KV кешу
    const cached = await kvGet(kv, 'deye_token');
    if (cached && cached.token) {
        return cached.token;
    }

    // 2. Перевіряємо наявність credentials
    const appId = env.DEYE_APP_ID;
    const appSecret = env.DEYE_APP_SECRET;
    const email = env.DEYE_EMAIL;
    const password = env.DEYE_PASSWORD;

    if (!appId || !appSecret || !email || !password) {
        throw new Error(
            'Missing credentials. Set DEYE_APP_ID, DEYE_APP_SECRET, DEYE_EMAIL, DEYE_PASSWORD in Cloudflare Dashboard.'
        );
    }

    // 3. Хешуємо пароль SHA256
    const passwordHash = await sha256(password);

    // 4. Запит токена (appId — query параметр, решта — body)
    const response = await fetch(`${BASE_URL}/v1.0/account/token?appId=${appId}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            appSecret,
            email,
            password: passwordHash,
        }),
    });

    const text = await response.text();

    if (!response.ok) {
        throw new Error(`Token request failed: HTTP ${response.status} — ${text.substring(0, 300)}`);
    }

    let result;
    try {
        result = JSON.parse(text);
    } catch (e) {
        throw new Error(`Invalid JSON from token endpoint: ${text.substring(0, 300)}`);
    }

    if (!result.success && result.code) {
        throw new Error(`DeyeCloud error ${result.code}: ${result.msg || 'Unknown error'}`);
    }

    const token = result?.accessToken || result?.data?.accessToken || result?.data?.token;
    if (!token) {
        throw new Error(`No token in response: ${JSON.stringify(result).substring(0, 300)}`);
    }

    // 5. Кешуємо токен (60 днів)
    await kvPut(kv, 'deye_token', { token, createdAt: Date.now() }, TOKEN_CACHE_TTL);

    return token;
}

// ─── Отримання даних інвертора ────────────────────────────

/**
 * Отримати SOC та grid_freq для одного інвертора
 */
async function getInverterData(token, serialNumber) {
    const url = `${BASE_URL}/v1.0/device/list?sn=${serialNumber}`;

    const response = await fetch(url, {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
        },
    });

    const text = await response.text();

    if (!response.ok) {
        console.error(`Device ${serialNumber}: HTTP ${response.status} — ${text.substring(0, 200)}`);
        return { soc: null, gridFreq: null };
    }

    let result;
    try {
        result = JSON.parse(text);
    } catch (e) {
        console.error(`Device ${serialNumber}: Invalid JSON — ${text.substring(0, 200)}`);
        return { soc: null, gridFreq: null };
    }

    // Шукаємо SOC і grid frequency у dataList
    let soc = null;
    let gridFreq = null;

    const dataList = result?.data?.list?.[0]?.dataList || result?.data?.dataList || [];

    for (const item of dataList) {
        const key = (item.key || '').toLowerCase();
        const name = (item.name || '').toLowerCase();

        if (key === 'soc' || key === 'battery_soc' || name === 'soc') {
            soc = parseFloat(item.value);
        }
        if (key === 'grid_frequency' || key === 'gridfrequency' || name.includes('grid') && name.includes('freq')) {
            gridFreq = parseFloat(item.value);
        }
    }

    return { soc, gridFreq };
}

// ─── Головний обробник ──────────────────────────────────

export async function onRequest(context) {
    const { env, request } = context;

    // Обробка CORS preflight
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

        // 3. Отримуємо дані всіх інверторів паралельно
        const entries = Object.entries(INVERTERS);
        const results = await Promise.all(
            entries.map(async ([id, sn]) => {
                const data = await getInverterData(token, sn);
                return {
                    id: parseInt(id),
                    name: `sensor.soc_${sn}`,
                    level: data.soc !== null ? Math.round(data.soc) : 0,
                    grid_freq: data.gridFreq !== null ? data.gridFreq : 0,
                    timestamp: new Date().toISOString(),
                };
            })
        );

        // 4. Кешуємо результат
        await kvPut(kv, 'battery_data', {
            batteries: results,
            timestamp: Date.now(),
        }, DATA_CACHE_TTL);

        // 5. Відповідь
        return new Response(
            JSON.stringify({ data: results, cached: false }),
            { headers: corsHeaders() }
        );

    } catch (error) {
        console.error('Battery API error:', error.message);

        // Якщо є кешовані дані, повертаємо їх навіть якщо протухли
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
