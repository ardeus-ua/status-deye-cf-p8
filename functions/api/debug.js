/**
 * Debug: find the correct device data endpoint
 */
const BASE_URL = 'https://eu1-developer.deyecloud.com';
const SN = '2407021154';

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
    const { env, request } = context;
    const h = { 'Content-Type': 'application/json; charset=utf-8' };
    const url = new URL(request.url);
    const sn = url.searchParams.get('sn') || SN;

    try {
        const token = await getToken(env);

        // The PHP code used GET /v1.0/device/list?sn=XXX but our API said "GET not supported"
        // Let's try various approaches:
        const endpoints = [
            // POST with sn as query param (like the token endpoint uses appId as query)
            { name: 'device/list POST sn-query', url: `${BASE_URL}/v1.0/device/list?sn=${sn}`, method: 'POST', body: {} },
            // POST with page/size like station/list
            { name: 'device/list POST page+sn-query', url: `${BASE_URL}/v1.0/device/list?sn=${sn}`, method: 'POST', body: { page: 1, size: 10 } },
            // POST with stationId (from station/list) - station ID for Ліфти 1 парадне = 61392915
            { name: 'device/list POST stationId', url: `${BASE_URL}/v1.0/device/list`, method: 'POST', body: { stationId: 61392915, page: 1, size: 10 } },
            // Try v2.0
            { name: 'v2 device/list POST sn', url: `${BASE_URL}/v2.0/device/list?sn=${sn}`, method: 'POST', body: {} },
            // device/state
            { name: 'device/state POST', url: `${BASE_URL}/v1.0/device/state`, method: 'POST', body: { deviceSn: sn } },
            // device/data POST
            { name: 'device/data POST', url: `${BASE_URL}/v1.0/device/data`, method: 'POST', body: { deviceSn: sn } },
        ];

        const results = {};
        for (const ep of endpoints) {
            try {
                const opts = {
                    method: ep.method || 'GET',
                    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                };
                if (ep.body !== undefined) opts.body = JSON.stringify(ep.body);
                const r = await fetch(ep.url, opts);
                const t = await r.text();
                let p; try { p = JSON.parse(t); } catch (e) { p = t.substring(0, 500); }
                results[ep.name] = { status: r.status, data: p };
            } catch (e) { results[ep.name] = { error: e.message }; }
        }

        return new Response(JSON.stringify({ sn, results }, null, 2), { headers: h });
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: h });
    }
}
