/**
 * Cloudflare Pages Worker (Direct Upload mode — тому _worker.js, а не functions/)
 *
 * До Deye звідси НЕ ходимо: CloudFront DeyeCloud блокує IP Cloudflare (403). Дані раз на 5 хв
 * приносить публічний репо ardeus-ua/deye-fetch (GitHub Actions) на /api/battery_ingest,
 * сайт віддає їх з KV.
 *
 * Endpoints:
 *   GET  /api/battery         — рівні заряду (edge-кеш 60 с)
 *   POST /api/battery_ingest  — прийом даних від deye-fetch (Authorization: Bearer $INGEST_TOKEN)
 *        { fetchedAt, deviceDataList: [...] }  — сира відповідь Deye /v1.0/device/latest
 *        { fetchedAt, error }                  — Deye не відповів; останні дані лишаються (stale)
 */

const CONFIG = [
    { id: 1, name: 'Ліфт п1', devices: ['2509174814'] },
    { id: 2, name: 'Ліфт п2', devices: ['2509174360'] },
    { id: 3, name: 'Ліфт п3', devices: ['2407102635'] },
    { id: 4, name: 'Вода', devices: ['2510143840'] },
    { id: 5, name: 'Опалення', devices: ['2510293833'] }
];

const STATE_KEY = 'battery_state';         // { batteries, fetchedAt, receivedAt, error }
const EDGE_CACHE_S = 60;
const STALE_AFTER_MS = 15 * 60 * 1000;     // deye-fetch мовчить 15 хв (3 цикли) — дані застарілі

// ─── Утиліти ──────────────────────────────────────────────

function json(body, status = 200, maxAge = 0) {
    return new Response(JSON.stringify(body), {
        status,
        headers: {
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': maxAge ? `public, max-age=${maxAge}` : 'no-store',
        },
    });
}

async function readState(kv) {
    try { return JSON.parse(await kv.get(STATE_KEY) || 'null'); } catch { return null; }
}

// ─── Розбір відповіді Deye ────────────────────────────────

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
    };
}

function aggregate(rawDataList) {
    const deviceMap = {};
    (rawDataList || []).forEach(item => {
        if (item && item.deviceSn) deviceMap[item.deviceSn] = parseDeviceData(item.deviceSn, item);
    });

    return CONFIG.map(item => {
        const itemDevices = item.devices.map(sn => deviceMap[sn]).filter(Boolean);
        if (itemDevices.length === 0) return { id: item.id, name: item.name, level: 0, grid_freq: 0 };

        const avgSoc = Math.round(itemDevices.reduce((sum, d) => sum + d.soc, 0) / itemDevices.length);
        const isGridOn = itemDevices.some(d => d.gridRunning);
        const maxFreq = Math.max(...itemDevices.map(d => d.gridFreq));

        return {
            id: item.id,
            name: item.name,
            level: avgSoc,
            grid_freq: isGridOn ? (maxFreq > 45 ? maxFreq : 50.0) : 0,
        };
    });
}

// ─── GET /api/battery ─────────────────────────────────────

async function batteryResponse(env) {
    const kv = env.DEYE_CACHE;
    if (!kv) return json({ error: 'KV not bound' }, 500);

    const state = await readState(kv);
    if (!state?.batteries) return json({ error: state?.error || 'No data yet' }, 503, EDGE_CACHE_S);

    // timestamp — час даних, а не відповіді: «Оновлено» на сторінці показує, наскільки вони свіжі
    const ts = new Date(state.fetchedAt).toISOString();
    const data = state.batteries.map(b => ({ ...b, timestamp: ts }));
    const silent = Date.now() - (state.receivedAt || state.fetchedAt) > STALE_AFTER_MS;
    const error = state.error || (silent ? 'deye-fetch не надсилає даних' : null);

    return error
        ? json({ data, cached: true, stale: true, error }, 200, EDGE_CACHE_S)
        : json({ data, cached: true }, 200, EDGE_CACHE_S);
}

async function handleBattery(request, env, ctx) {
    if (request.method === 'OPTIONS') {
        return new Response(null, {
            headers: {
                'Access-Control-Allow-Origin': '*',
                'Access-Control-Allow-Methods': 'GET, OPTIONS',
                'Access-Control-Allow-Headers': 'Content-Type'
            }
        });
    }

    // Edge-кеш (per-colo), ключ — тільки шлях: ?t=... не обходить кеш. На *.pages.dev Cache API не працює.
    const cache = caches.default;
    const url = new URL(request.url);
    const key = new Request(url.origin + url.pathname, { method: 'GET' });
    const hit = await cache.match(key);
    if (hit) return hit;

    let res;
    try {
        res = await batteryResponse(env);
    } catch (e) {
        res = json({ error: e.message }, 500);
    }
    if (res.status === 200 || res.status === 503) ctx.waitUntil(cache.put(key, res.clone()));
    return res;
}

// ─── POST /api/battery_ingest ─────────────────────────────

async function handleIngest(request, env) {
    if (request.method !== 'POST') return json({ error: 'POST only' }, 405);
    const kv = env.DEYE_CACHE;
    if (!kv) return json({ error: 'KV not bound' }, 500);

    const auth = request.headers.get('Authorization') || '';
    if (!env.INGEST_TOKEN || auth !== `Bearer ${env.INGEST_TOKEN}`) return json({ error: 'unauthorized' }, 401);

    let body;
    try {
        body = await request.json();
    } catch (e) {
        return json({ error: `JSON parse error: ${e.message}` }, 400);
    }

    const state = await readState(kv) || {};
    state.receivedAt = Date.now();

    if (Array.isArray(body.deviceDataList)) {
        const found = body.deviceDataList.filter(d => d && d.deviceSn).length;
        if (!found) {
            state.error = 'Deye: порожній deviceDataList';
        } else {
            state.batteries = aggregate(body.deviceDataList);
            const t = Date.parse(body.fetchedAt);
            state.fetchedAt = Number.isFinite(t) ? t : Date.now();
            state.error = null;
        }
    } else {
        state.error = String(body.error || 'unknown error').slice(0, 300);
    }

    // Один запис KV на виклик (~288/добу при ліміті 1000)
    await kv.put(STATE_KEY, JSON.stringify(state));
    return json({ ok: true, error: state.error || null, batteries: state.batteries || null });
}

// ─── Worker Router ────────────────────────────────────────

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);

        if (url.pathname === '/api/battery') return handleBattery(request, env, ctx);
        if (url.pathname === '/api/battery_ingest') return handleIngest(request, env);

        // Static Assets Fallback
        return env.ASSETS.fetch(request);
    }
};
