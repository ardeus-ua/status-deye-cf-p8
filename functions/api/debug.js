/**
 * Debug: try different auth methods for device/list
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
    const { env, request } = context;
    const h = { 'Content-Type': 'application/json; charset=utf-8' };
    const url = new URL(request.url);
    const sn = url.searchParams.get('sn') || '2407021154';

    try {
        const token = await getToken(env);

        const endpoints = [
            // Try token as custom header instead of Bearer
            {
                name: 'device/list POST token-header',
                url: `${BASE_URL}/v1.0/device/list?sn=${sn}`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'token': token },
                body: {},
            },
            // Try token as query parameter
            {
                name: 'device/list POST token-query',
                url: `${BASE_URL}/v1.0/device/list?sn=${sn}&token=${token}`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: {},
            },
            // GET with token header (not Bearer)
            {
                name: 'device/list GET token-header',
                url: `${BASE_URL}/v1.0/device/list?sn=${sn}`,
                method: 'GET',
                headers: { 'Content-Type': 'application/json', 'token': token },
            },
            // POST with appId+token combo
            {
                name: 'device/list POST appId+token',
                url: `${BASE_URL}/v1.0/device/list?sn=${sn}`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}`, 'token': token },
                body: {},
            },
            // station detail endpoint
            {
                name: 'station/detail POST',
                url: `${BASE_URL}/v1.0/station/detail`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: { stationId: 61392915 },
            },
            // device/page POST with stationId
            {
                name: 'device/page POST',
                url: `${BASE_URL}/v1.0/device/page`,
                method: 'POST',
                headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
                body: { stationId: 61392915, page: 1, size: 10 },
            },
        ];

        const results = {};
        for (const ep of endpoints) {
            try {
                const opts = {
                    method: ep.method || 'GET',
                    headers: ep.headers,
                };
                if (ep.body !== undefined) opts.body = JSON.stringify(ep.body);
                const r = await fetch(ep.url, opts);
                const t = await r.text();
                let p; try { p = JSON.parse(t); } catch (e) { p = t.substring(0, 1000); }
                results[ep.name] = { status: r.status, data: p };
            } catch (e) { results[ep.name] = { error: e.message }; }
        }

        return new Response(JSON.stringify({ sn, results }, null, 2), { headers: h });
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers: h });
    }
}
