/**
 * Debug v5: Probe station/device to get individual inverters for Heating (averaging)
 * and look for grid voltage/freq data.
 */
const BASE_URL = 'https://eu1-developer.deyecloud.com';

async function sha256(text) {
    const enc = new TextEncoder();
    const buf = await crypto.subtle.digest('SHA-256', enc.encode(text));
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getToken(env) {
    if (env.DEYE_CACHE) {
        try {
            const c = await env.DEYE_CACHE.get('deye_token');
            if (c) { const { token } = JSON.parse(c); if (token) return token; }
        } catch (e) { }
    }
    const ph = await sha256(env.DEYE_PASSWORD);
    const r = await fetch(`${BASE_URL}/v1.0/account/token?appId=${env.DEYE_APP_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appSecret: env.DEYE_APP_SECRET, email: env.DEYE_EMAIL, password: ph }),
    });
    const d = await r.json();
    return d.accessToken || d?.data?.accessToken;
}

export async function onRequest(context) {
    const { env } = context;
    const h = { 'Content-Type': 'application/json; charset=utf-8' };

    // ID станції "ІТП 2-а" (Опалення)
    const HEATING_STATION_ID = 61392922;

    try {
        const token = await getToken(env);

        // Перевіряємо, які пристрої є в станції і які дані по ним віддає API
        const r = await fetch(`${BASE_URL}/v1.0/station/device`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            body: JSON.stringify({
                stationId: HEATING_STATION_ID,
                page: 1,
                size: 20
            }),
        });

        const data = await r.json();

        return new Response(JSON.stringify({
            endpoint: 'station/device',
            stationId: HEATING_STATION_ID,
            result: data
        }, null, 2), { headers: h });

    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: h });
    }
}
