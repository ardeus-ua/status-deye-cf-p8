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

async function sha256(message) {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Отримання access token з DeyeCloud
 */
async function getAccessToken(env) {
    // 1. KV Cache
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
    const passwordHash = await sha256(env.DEYE_PASSWORD);

    // Спроба використати USERNAME ('ardeus') замість email if available
    // Витягуємо username з email (якщо це gmail), або використовуємо як є
    let loginAccount = env.DEYE_EMAIL;
    if (loginAccount.includes('@')) {
        // Для тесту спробуємо 'ardeus' якщо email 'ardeus@gmail.com'
        // Але краще передати обидва поля або спробувати одне
        const parts = loginAccount.split('@');
        if (parts[0] === 'ardeus') loginAccount = 'ardeus';
    }

    // Payload for DeyeCloud /token
    // Deye API documentation mentions 'email', but sometimes 'account' or 'username' works better
    const authData = {
        appId: env.DEYE_APP_ID,
        appSecret: env.DEYE_APP_SECRET,
        // Спробуємо передати і email і username, або замінити email на username
        email: loginAccount,
        password: passwordHash
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

    // Check for token in different places
    const token = result.data?.accessToken || result.data?.token || result.access_token;

    if (!token) {
        const safeAuth = { ...authData, password: '***', appSecret: '***' };
        throw new Error(`Invalid token response from ${baseUrl}: ${JSON.stringify(result)}. Payload: ${JSON.stringify(safeAuth)}`);
    }

    // 3. Save to KV
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

// Функція отримання даних (відновлена логіка)
async function fetchInverterData(token, sn) {
    const baseUrl = getBaseUrl();
    // Використовуємо device/detail для отримання даних
    const response = await fetch(`${baseUrl}/v1.0/device/detail?sn=${sn}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` }
    });

    if (!response.ok) return null;
    const json = await response.json();
    return json;
}

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

        // Авторизація пройшла! Пробуємо отримати дані.
        const batteries = [];

        // Запитуємо дані для кожного інвертора
        for (const [id, sn] of Object.entries(INVERTERS)) {
            // Для тесту запитаємо тільки перший, щоб не чекати довго
            // Або запустимо всі паралельно
            const data = await fetchInverterData(token, sn);

            // Тут треба парсити SOC. 
            // Поки що повернемо сирі дані першого, щоб подивитись структуру.
            if (id === '1') {
                return new Response(JSON.stringify({
                    firstDeviceRaw: data,
                    tokenObtained: true
                }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });
            }
        }

        return new Response(JSON.stringify({ message: "No inverters found" }), { headers: corsHeaders });

    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
    }
}
