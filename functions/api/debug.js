/**
 * Diagnostic endpoint — raw DeyeCloud API response viewer
 * URL: /api/debug
 */

const INVERTERS = {
    1: '2407021154',
    2: '2407024008',
    3: '2407026195',
    4: '2407026187',
    5: '2407024186',
    6: '2510171041',
};

const BASE_URL = 'https://eu1-developer.deyecloud.com';

async function sha256(text) {
    const encoder = new TextEncoder();
    const data = encoder.encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

async function getToken(env) {
    // Try KV cache first
    if (env.DEYE_CACHE) {
        try {
            const cached = await env.DEYE_CACHE.get('deye_token');
            if (cached) {
                const { token } = JSON.parse(cached);
                if (token) return token;
            }
        } catch (e) { }
    }

    const passwordHash = await sha256(env.DEYE_PASSWORD);
    const res = await fetch(`${BASE_URL}/v1.0/account/token?appId=${env.DEYE_APP_ID}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            appSecret: env.DEYE_APP_SECRET,
            email: env.DEYE_EMAIL,
            password: passwordHash,
        }),
    });
    const data = await res.json();
    return data.accessToken || data?.data?.accessToken || data?.data?.token;
}

export async function onRequest(context) {
    const { env, request } = context;
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    const url = new URL(request.url);
    const sn = url.searchParams.get('sn') || INVERTERS[1];

    try {
        const token = await getToken(env);

        // Try multiple endpoints to find the right one
        const endpoints = [
            { name: 'device/list', url: `${BASE_URL}/v1.0/device/list?sn=${sn}` },
            { name: 'device/latest (POST)', url: `${BASE_URL}/v1.0/device/latest`, method: 'POST', body: { deviceSn: sn } },
            { name: 'device/latestData (POST)', url: `${BASE_URL}/v1.0/device/latestData`, method: 'POST', body: { deviceSn: sn } },
            { name: 'device/realtime (GET)', url: `${BASE_URL}/v1.0/device/realtime?sn=${sn}` },
        ];

        const results = {};
        for (const ep of endpoints) {
            try {
                const fetchOpts = {
                    method: ep.method || 'GET',
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${token}`,
                    },
                };
                if (ep.body) fetchOpts.body = JSON.stringify(ep.body);

                const res = await fetch(ep.url, fetchOpts);
                const text = await res.text();
                let parsed;
                try { parsed = JSON.parse(text); } catch (e) { parsed = text.substring(0, 500); }

                results[ep.name] = {
                    status: res.status,
                    data: parsed,
                };
            } catch (e) {
                results[ep.name] = { error: e.message };
            }
        }

        return new Response(JSON.stringify({
            sn,
            token: token ? token.substring(0, 30) + '...' : null,
            results,
        }, null, 2), { headers });

    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
    }
}
