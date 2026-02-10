/**
 * Diagnostic endpoint — raw DeyeCloud API response viewer
 * URL: /api/debug
 */

const INVERTERS = {
    1: '2407021154',
    2: '2407024008',
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

        const endpoints = [
            // device/list as POST with sn in body
            { name: 'device/list POST body-sn', url: `${BASE_URL}/v1.0/device/list`, method: 'POST', body: { sn } },
            // device/list as POST with deviceSn in body
            { name: 'device/list POST body-deviceSn', url: `${BASE_URL}/v1.0/device/list`, method: 'POST', body: { deviceSn: sn } },
            // device/latest with deviceSnList (array)
            { name: 'device/latest POST snList', url: `${BASE_URL}/v1.0/device/latest`, method: 'POST', body: { deviceSnList: [sn] } },
            // device/latest with single sn
            { name: 'device/latest POST deviceSn', url: `${BASE_URL}/v1.0/device/latest`, method: 'POST', body: { deviceSn: sn } },
            // device/<sn>/latest
            { name: `device/${sn}/latest GET`, url: `${BASE_URL}/v1.0/device/${sn}/latest` },
            // station/list to find stationId first
            { name: 'station/list POST', url: `${BASE_URL}/v1.0/station/list`, method: 'POST', body: { page: 1, size: 10 } },
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
                try { parsed = JSON.parse(text); } catch (e) { parsed = text.substring(0, 1000); }

                results[ep.name] = { status: res.status, data: parsed };
            } catch (e) {
                results[ep.name] = { error: e.message };
            }
        }

        return new Response(JSON.stringify({ sn, token: token ? token.substring(0, 30) + '...' : null, results }, null, 2), { headers });
    } catch (e) {
        return new Response(JSON.stringify({ error: e.message }), { status: 500, headers });
    }
}
