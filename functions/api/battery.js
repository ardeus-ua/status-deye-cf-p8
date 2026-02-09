/**
 * Cloudflare Pages Function - DeyeCloud API Proxy
 * 
 * Proxies requests to DeyeCloud API to fetch battery status.
 */

// Конфігурація інверторів
const INVERTERS = {
    1: '2407021154',
    2: '2407024008',
    3: '2407026195',
    4: '2407026187',
    5: '2407024186',
    6: '2510171041',
};

const BATTERY_NAMES = {
    1: 'sensor.soc_2407021154',
    2: 'sensor.soc_2407024008',
    3: 'sensor.soc_2407026195',
    4: 'sensor.soc_2407026187',
    5: 'sensor.soc_2407024186',
    6: 'sensor.soc_2510171041',
};

const CACHE_TTL = 300;
const TOKEN_CACHE_TTL = 7000;

function getBaseUrl() {
    return 'https://eu1-developer.deyecloud.com';
}

/**
 * Отримання access token з DeyeCloud (PLAIN PASSWORD VERSION)
 */
async function getAccessToken(env) {
    if (env.DEYE_CACHE) {
        try {
            const cachedToken = await env.DEYE_CACHE.get('access_token', { type: 'json' });
            if (cachedToken && cachedToken.token) {
                return cachedToken.token;
            }
        } catch (e) {
            console.error('KV cache read error:', e);
        }
    }

    const baseUrl = getBaseUrl();

    // WARNING: Sending plain password! Usually secure over HTTPS.
    // Deye sometimes requires this if hash fails.
    const passwordPlain = env.DEYE_PASSWORD;

    const authData = {
        appId: env.DEYE_APP_ID,
        appSecret: env.DEYE_APP_SECRET,
        email: env.DEYE_EMAIL,
        password: passwordPlain // Plain text!
    };

    const response = await fetch(`${baseUrl}/v1.0/token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authData)
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to get token from ${baseUrl}: ${response.status} ${text}`);
    }

    const result = await response.json();

    if (!result.data || !result.data.accessToken) {
        const safeAuth = { ...authData, password: '***', appSecret: '***' };
        throw new Error(`Invalid token response from ${baseUrl}: ${JSON.stringify(result)}. Payload: ${JSON.stringify(safeAuth)}`);
    }

    const token = result.data.accessToken;

    if (env.DEYE_CACHE) {
        try {
            await env.DEYE_CACHE.put('access_token', JSON.stringify({ token }), {
                expirationTtl: TOKEN_CACHE_TTL
            });
        } catch (e) {
            console.error('KV cache write error:', e);
        }
    }

    return token;
}

// ... (Rest of logic similar to previous working stub)

export async function onRequest(context) {
    const { env, request } = context;
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
    };

    if (request.method === 'OPTIONS') return new Response(null, { headers: corsHeaders });

    try {
        if (!env.DEYE_APP_ID || !env.DEYE_APP_SECRET) {
            throw new Error("Missing Credentials");
        }

        const token = await getAccessToken(env);

        return new Response(JSON.stringify({
            message: "Auth Successful! (Plain Password worked)",
            auth: "OK",
            region: "EU"
        }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });

    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
    }
}
