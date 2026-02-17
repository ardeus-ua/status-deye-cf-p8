/**
 * Cloudflare Pages Worker — DeyeCloud API Proxy (Direct Upload mode)
 * 
 * Використовуємо _worker.js замість functions/ тому що деплой через Direct Upload
 * не підтримує папку functions/.
 * 
 * Endpoints:
 *   /api/battery — дані батарей
 *   /api/debug   — стан системи для відлагодження
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
        const trimmed = existing.slice(0, 10);
        await kv.put('error_log', JSON.stringify(trimmed), { expirationTtl: 86400 * 7 }); // 7 днів
    } catch (e) { /* ignore logging errors */ }
}

// ─── Auth ─────────────────────────────────────────────────

async function getAccessToken(env) {
    const kv = env.DEYE_CACHE || null;

    const cached = await kvGet(kv, 'deye_token');
    if (cached && cached.token) return cached.token;

    const { DEYE_APP_ID, DEYE_APP_SECRET, DEYE_EMAIL, DEYE_PASSWORD } = env;
    if (!DEYE_APP_ID || !DEYE_APP_SECRET || !DEYE_EMAIL || !DEYE_PASSWORD) {
        throw new Error('Missing credentials env vars');
    }

    const passwordHash = await sha256(DEYE_PASSWORD);
    const authUrl = `${BASE_URL}/v1.0/account/token?appId=${DEYE_APP_ID}`;
    const headers = { 'Content-Type': 'application/json' };

    // Спроба 1: логін через email
    let response = await fetch(authUrl, {
        method: 'POST', headers,
        body: JSON.stringify({ appSecret: DEYE_APP_SECRET, email: DEYE_EMAIL, password: passwordHash }),
    });
    let result = await response.json();
    let token = result.accessToken || result?.data?.accessToken;

    // Спроба 2: якщо email не спрацював — пробуємо username
    if (!token) {
        await logError(kv, 'auth_email_failed', `Email login failed: ${result.msg || JSON.stringify(result).substring(0, 150)}`);

        response = await fetch(authUrl, {
            method: 'POST', headers,
            body: JSON.stringify({ appSecret: DEYE_APP_SECRET, username: DEYE_EMAIL, password: passwordHash }),
        });
        result = await response.json();
        token = result.accessToken || result?.data?.accessToken;
    }

    if (!token) throw new Error(`Failed to obtain token (tried email+username): ${result.msg || JSON.stringify(result).substring(0, 150)}`);

    await kvPut(kv, 'deye_token', { token, createdAt: Date.now() }, TOKEN_CACHE_TTL);
    return token;
}

// ─── Data Fetching ────────────────────────────────────────

async function fetchDevicesData(token, deviceSns) {
    const response = await fetch(`${BASE_URL}/v1.0/device/latest`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ deviceList: deviceSns }),
    });

    const result = await response.json();
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

    let socVal = parseFloat(getValue(['BMSSOC', 'BMS_SOC'])) || 0;
    if (socVal === 0) {
        socVal = parseFloat(getValue(['SOC', 'Battery_SOC'])) || 0;
    }

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
        timestamp: new Date().toISOString()
    };
}

// ─── Battery Handler ──────────────────────────────────────

async function handleBatteryRequest(env, request) {
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

        const cacheKey = 'battery_data_v3';
        const cachedData = await kvGet(kv, cacheKey);

        if (cachedData && cachedData.timestamp) {
            const age = Date.now() - cachedData.timestamp;
            if (age < DATA_CACHE_TTL * 1000) {
                return new Response(JSON.stringify({ data: cachedData.batteries, cached: true }), { headers: corsHeaders() });
            }
        }

        const token = await getAccessToken(env);
        const allSns = CONFIG.flatMap(c => c.devices);
        const rawDataList = await fetchDevicesData(token, allSns);

        const deviceMap = {};
        rawDataList.forEach(item => {
            if (item.deviceSn) {
                deviceMap[item.deviceSn] = parseDeviceData(item.deviceSn, item);
            }
        });

        const resultBatteries = CONFIG.map(item => {
            const itemDevices = item.devices.map(sn => deviceMap[sn]).filter(Boolean);

            if (itemDevices.length === 0) {
                return {
                    id: item.id, name: item.name,
                    level: 0, grid_freq: 0,
                    timestamp: new Date().toISOString()
                };
            }

            const totalSoc = itemDevices.reduce((sum, d) => sum + d.soc, 0);
            const avgSoc = Math.round(totalSoc / itemDevices.length);
            const isGridOn = itemDevices.some(d => d.gridRunning);
            const maxFreq = Math.max(...itemDevices.map(d => d.gridFreq));

            return {
                id: item.id, name: item.name,
                level: avgSoc,
                grid_freq: isGridOn ? (maxFreq > 45 ? maxFreq : 50.0) : 0,
                timestamp: new Date().toISOString()
            };
        });

        await kvPut(kv, cacheKey, { batteries: resultBatteries, timestamp: Date.now() }, DATA_CACHE_TTL);

        return new Response(JSON.stringify({ data: resultBatteries, cached: false }), { headers: corsHeaders() });

    } catch (error) {
        const kv = env.DEYE_CACHE || null;
        await logError(kv, 'battery_fetch', error.message);

        try {
            const stale = await kvGet(kv, 'battery_data_v3');
            if (stale) {
                return new Response(JSON.stringify({
                    data: stale.batteries, cached: true, stale: true, error: error.message
                }), { headers: corsHeaders() });
            }
        } catch (e) { }

        return errorResponse(error.message);
    }
}

// ─── Debug Handler ────────────────────────────────────────

async function handleDebugRequest(env) {
    const envCheck = {
        DEYE_APP_ID: env.DEYE_APP_ID ? 'SET' : '❌ MISSING',
        DEYE_APP_SECRET: env.DEYE_APP_SECRET ? 'SET' : '❌ MISSING',
        DEYE_EMAIL: env.DEYE_EMAIL ? 'SET' : '❌ MISSING',
        DEYE_PASSWORD: env.DEYE_PASSWORD ? 'SET' : '❌ MISSING',
        DEYE_CACHE: env.DEYE_CACHE ? 'CONNECTED' : '❌ MISSING'
    };

    const kv = env.DEYE_CACHE || null;

    // Token status
    let tokenStatus = 'NO KV';
    if (kv) {
        const tokenData = await kvGet(kv, 'deye_token');
        if (tokenData && tokenData.token) {
            const ageMs = Date.now() - (tokenData.createdAt || 0);
            const ageDays = Math.floor(ageMs / (1000 * 60 * 60 * 24));
            const ageHours = Math.floor((ageMs % (1000 * 60 * 60 * 24)) / (1000 * 60 * 60));
            tokenStatus = `✅ Valid (created ${ageDays}d ${ageHours}h ago)`;
        } else {
            tokenStatus = '⚠️ No token cached';
        }
    }

    // Data cache status
    let dataStatus = 'NO KV';
    let batteryPreview = null;
    if (kv) {
        const batteryData = await kvGet(kv, 'battery_data_v3');
        if (batteryData && batteryData.timestamp) {
            const ageMs = Date.now() - batteryData.timestamp;
            const ageMin = Math.floor(ageMs / 60000);
            const ageSec = Math.floor((ageMs % 60000) / 1000);
            const isStale = ageMs > 300000;
            dataStatus = `${isStale ? '⚠️ Stale' : '✅ Fresh'} (updated ${ageMin}m ${ageSec}s ago)`;
            if (batteryData.batteries) {
                batteryPreview = batteryData.batteries.map(b => ({
                    id: b.id, name: b.name,
                    level: `${b.level}%`,
                    grid: b.grid_freq > 45 ? `⚡ ON (${b.grid_freq}Hz)` : '❌ OFF'
                }));
            }
        } else {
            dataStatus = '⚠️ No data cached yet';
        }
    }

    // Error log
    let recentErrors = [];
    if (kv) {
        const errorLog = await kvGet(kv, 'error_log');
        if (errorLog && Array.isArray(errorLog)) {
            recentErrors = errorLog;
        }
    }

    return new Response(JSON.stringify({
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
    }, null, 2), {
        headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' }
    });
}

// ─── Worker Router ────────────────────────────────────────

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (url.pathname === '/api/battery') {
            return handleBatteryRequest(env, request);
        }

        if (url.pathname === '/api/debug') {
            return handleDebugRequest(env);
        }

        // Static Assets Fallback
        return env.ASSETS.fetch(request);
    }
};
