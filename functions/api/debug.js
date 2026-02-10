/**
 * Debug v8: Get detail data for Heating inverters to find SOC and Grid Voltage
 */
const BASE_URL = 'https://eu1-developer.deyecloud.com';
const SNs = ["2407024186", "2510171041"];

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

    try {
        const token = await getToken(env);
        const results = {};

        // 1. Try device/latest with array of SNs (undocumented but common)
        try {
            const r = await fetch(`${BASE_URL}/v1.0/device/latest`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify(SNs), // Just array
            });
            results.latestArray = await r.json();
        } catch (e) { results.latestArray = e.message; }

        // 2. Try device/latest with deviceList wrapper
        try {
            const r = await fetch(`${BASE_URL}/v1.0/device/latest`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ deviceList: SNs }),
            });
            results.latestWrapper = await r.json();
        } catch (e) { results.latestWrapper = e.message; }

        // 3. Try device/latest with deviceSn parameter (one by one)
        try {
            const r = await fetch(`${BASE_URL}/v1.0/device/latest`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: JSON.stringify({ deviceSn: SNs[0] }),
            });
            results.latestSingle = await r.json();
        } catch (e) { results.latestSingle = e.message; }

        // 4. Try device/shadow (sometimes used for state)
        try {
            const r = await fetch(`${BASE_URL}/v1.0/device/shadow?deviceSn=${SNs[0]}`, {
                method: 'GET',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
            });
            results.deviceShadow = await r.json();
        } catch (e) { results.deviceShadow = e.message; }

        return new Response(JSON.stringify({ results }, null, 2), { headers: h });
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: h });
    }
}
