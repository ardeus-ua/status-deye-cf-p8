/**
 * Cloudflare Pages Function — DeyeCloud API Proxy (Device Level)
 * 
 * Отримує детальні дані (SOC, Grid Voltage/Freq) через /v1.0/device/latest.
 * Підтримує агрегацію декількох інверторів для однієї точки (напр. Опалення).
 */

const CONFIG = [
    { id: 1, name: 'Ліфт п1', devices: ['2509174814'] },
    { id: 2, name: 'Ліфт п2', devices: ['2509174360'] },
    { id: 3, name: 'Ліфт п3', devices: ['2407102635'] },
    { id: 4, name: 'Вода', devices: ['2510143840'] },
    { id: 5, name: 'Опалення', devices: ['2510293833'] }
];

const BASE_URL = 'https://eu1-developer.deyecloud.com';
const DATA_CACHE_TTL = 300;      // 5 хвилин
const TOKEN_CACHE_TTL = 5184000; // 60 днів

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
        'Cache-Control': 'public, max-age=60',
    };
}

function errorResponse(message, status = 500) {
    return new Response(JSON.stringify({ error: message }), { status, headers: corsHeaders() });
}

// ─── KV Cache ─────────────────────────────────────────────

async function kvGet(kv, key) {
    if (!kv) return null;
    try {
        const value = await kv.get(key);
        return value ? JSON.parse(value) : null;
    } catch (e) { return null; }
}

async function kvPut(kv, key, value, ttl) {
    if (!kv) return;
    try { await kv.put(key, JSON.stringify(value), { expirationTtl: ttl }); } catch (e) { }
}

// ─── Error Logging ────────────────────────────────────────

async function logError(kv, context, message) {
    if (!kv) return;
    try {
        const existing = await kvGet(kv, 'error_log') || [];
        existing.unshift({
            time: new Date().toISOString(),
            context,
            message: String(message).substring(0, 200)
        });
        // Зберігаємо тільки останні 10 помилок
        const trimmed = existing.slice(0, 10);
        await kv.put('error_log', JSON.stringify(trimmed), { expirationTtl: 86400 * 7 }); // 7 днів
    } catch (e) { /* ignore logging errors */ }
}

// ─── Auth ─────────────────────────────────────────────────

async function getAccessToken(env) {
    const kv = env.DEYE_CACHE || null;

    // Check Cache
    const cached = await kvGet(kv, 'deye_token');
    if (cached && cached.token) return cached.token;

    const { DEYE_APP_ID, DEYE_APP_SECRET, DEYE_EMAIL, DEYE_PASSWORD } = env;
    if (!DEYE_APP_ID || !DEYE_APP_SECRET || !DEYE_EMAIL || !DEYE_PASSWORD) {
        throw new Error('Missing credentials env vars');
    }

    const passwordHash = await sha256(DEYE_PASSWORD);
    const response = await fetch(`${BASE_URL}/v1.0/account/token?appId=${DEYE_APP_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appSecret: DEYE_APP_SECRET, email: DEYE_EMAIL, password: passwordHash }),
    });

    const result = await response.json();
    const token = result.accessToken || result?.data?.accessToken;

    if (!token) throw new Error(`Failed to obtain token: ${result.msg || 'Unknown error'}`);

    await kvPut(kv, 'deye_token', { token, createdAt: Date.now() }, TOKEN_CACHE_TTL);
    return token;
}

// ─── Data Fetching ────────────────────────────────────────

async function fetchDevicesData(token, deviceSns) {
    // Використовуємо undocumented key { deviceList: [...] }
    const response = await fetch(`${BASE_URL}/v1.0/device/latest`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ deviceList: deviceSns }),
    });

    const result = await response.json();
    // API sometimes returns success=false even with valid data, check deviceDataList
    if (!result.deviceDataList && !result.success) {
        throw new Error(`API Error: ${result.msg}`);
    }
    return result.deviceDataList || [];
}

function parseDeviceData(sn, rawItem) {
    if (!rawItem || !rawItem.dataList) return null;

    const dataList = rawItem.dataList;
    const getValue = (keys) => {
        for (const k of keys) {
            const item = dataList.find(d => d.key === k || d.name === k);
            if (item && item.value !== undefined && item.value !== null) return item.value;
        }
        return null;
    };

    // SOC Logic: Prioritize BMSSOC over SOC if available and > 0
    let socVal = parseFloat(getValue(['BMSSOC', 'BMS_SOC'])) || 0;
    if (socVal === 0) {
        socVal = parseFloat(getValue(['SOC', 'Battery_SOC'])) || 0;
    }

    // Grid Status Logic: Check V/Hz
    const freq = parseFloat(getValue(['GridFrequency', 'Grid_Frequency'])) || 0;
    const v1 = parseFloat(getValue(['GridVoltageL1', 'GridVoltage', 'Grid_Voltage_L1'])) || 0;
    const v2 = parseFloat(getValue(['GridVoltageL2', 'Grid_Voltage_L2'])) || 0;
    const v3 = parseFloat(getValue(['GridVoltageL3', 'Grid_Voltage_L3'])) || 0;

    const maxVoltage = Math.max(v1, v2, v3);
    const isGridOn = freq > 45 || maxVoltage > 100;

    return {
        sn,
        soc: Math.round(socVal),
        gridRunning: isGridOn,
        gridFreq: freq > 0 ? freq : (isGridOn ? 50.0 : 0),
        timestamp: new Date().toISOString() // TODO: parse actual update time if available
    };
}

// ─── Main Handler ─────────────────────────────────────────

export async function onRequest(context) {
    const { env, request } = context;

    if (request.method === 'OPTIONS') {
        return new Response(null, {
            headers: {
                ...corsHeaders(),
                'Access-Control-Allow-Methods': 'GET, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type'
            }
        });
    }

    try {
        const kv = env.DEYE_CACHE || null;

        // 1. Cache Check (using v2 key to invalidate old structure)
        const cacheKey = 'battery_data_v3';
        const cachedData = await kvGet(kv, cacheKey);

        if (cachedData && cachedData.timestamp) {
            const age = Date.now() - cachedData.timestamp;
            if (age < DATA_CACHE_TTL * 1000) {
                return new Response(JSON.stringify({ data: cachedData.batteries, cached: true }), { headers: corsHeaders() });
            }
        }

        // 2. Get Token
        const token = await getAccessToken(env);

        // 3. Prepare SN list
        const allSns = CONFIG.flatMap(c => c.devices);

        // 4. Fetch Data
        const rawDataList = await fetchDevicesData(token, allSns);

        // 5. Map Data
        const deviceMap = {};
        rawDataList.forEach(item => {
            if (item.deviceSn) {
                deviceMap[item.deviceSn] = parseDeviceData(item.deviceSn, item);
            }
        });

        // 6. Aggregate per config item
        const resultBatteries = CONFIG.map(item => {
            const itemDevices = item.devices.map(sn => deviceMap[sn]).filter(Boolean);

            if (itemDevices.length === 0) {
                // No data found for this item
                return {
                    id: item.id,
                    name: item.name,
                    level: 0,
                    grid_freq: 0,
                    timestamp: new Date().toISOString()
                };
            }

            // Average SOC
            const totalSoc = itemDevices.reduce((sum, d) => sum + d.soc, 0);
            const avgSoc = Math.round(totalSoc / itemDevices.length);

            // Grid Status (OR logic: if any inverter has grid, show grid)
            const isGridOn = itemDevices.some(d => d.gridRunning);
            const maxFreq = Math.max(...itemDevices.map(d => d.gridFreq));

            return {
                id: item.id,
                name: item.name,
                level: avgSoc,
                grid_freq: isGridOn ? (maxFreq > 45 ? maxFreq : 50.0) : 0,
                timestamp: new Date().toISOString()
            };
        });

        // 7. Save to Cache
        await kvPut(kv, cacheKey, { batteries: resultBatteries, timestamp: Date.now() }, DATA_CACHE_TTL);

        return new Response(JSON.stringify({ data: resultBatteries, cached: false }), { headers: corsHeaders() });

    } catch (error) {
        // Log error to KV for debugging via /api/debug
        const kv = env.DEYE_CACHE || null;
        await logError(kv, 'battery_fetch', error.message);

        // Fallback to stale cache if error occurs
        try {
            const stale = await kvGet(kv, 'battery_data_v3');
            if (stale) {
                return new Response(JSON.stringify({
                    data: stale.batteries,
                    cached: true,
                    stale: true,
                    error: error.message
                }), { headers: corsHeaders() });
            }
        } catch (e) { }

        return errorResponse(error.message);
    }
}
