/**
 * Cloudflare Pages Function - DeyeCloud API Proxy
 * 
 * Proxies requests to DeyeCloud API to fetch battery status.
 * Uses Cloudflare KV for caching to avoid rate limits.
 * 
 * Environment Variables required in Cloudflare Pages:
 * - DEYE_APP_ID
 * - DEYE_APP_SECRET
 * - DEYE_EMAIL
 * - DEYE_PASSWORD
 * - DEYE_Region (Optional, defaults to US in this version)
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

// Назви батарей (для API відповіді)
const BATTERY_NAMES = {
    1: 'sensor.soc_2407021154',
    2: 'sensor.soc_2407024008',
    3: 'sensor.soc_2407026195',
    4: 'sensor.soc_2407026187',
    5: 'sensor.soc_2407024186',
    6: 'sensor.soc_2510171041',
};

const CACHE_TTL = 300; // 5 хвилин
const TOKEN_CACHE_TTL = 7000; // ~2 години (токен живе довго)

/**
 * SHA256 hash function for password
 */
async function sha256(message) {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Отримання base URL для US регіону (спроба №3)
 */
function getBaseUrl(region) {
    // Force US region as EU failed with 'token not found'
    // and CN failed with DNS/404.
    return 'https://us1-developer.deyecloud.com';
}

/**
 * Отримання access token з DeyeCloud
 */
async function getAccessToken(env) {
    // 1. Спробувати знайти в KV
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

    // 2. Отримати новий токен
    const baseUrl = getBaseUrl();
    const passwordHash = await sha256(env.DEYE_PASSWORD);

    const authData = {
        appId: env.DEYE_APP_ID,
        appSecret: env.DEYE_APP_SECRET,
        email: env.DEYE_EMAIL,
        password: passwordHash
    };

    // Використовуємо /v1.0/token (стандартний Deye API)
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
        // Log payload (safe)
        const safeAuth = { ...authData, password: '***', appSecret: '***' };
        throw new Error(`Invalid token response from ${baseUrl}: ${JSON.stringify(result)}. Payload: ${JSON.stringify(safeAuth)}`);
    }

    const token = result.data.accessToken;

    // 3. Зберегти в KV
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

/**
 * Отримання списку пристроїв (станцій) для пошуку deviceId за SN
 * Deye API потребує ID станції/інвертора, а не SN для запитів даних, 
 * або дозволяє фільтрувати device list.
 */
async function getBatteryData(token, region) {
    const baseUrl = getBaseUrl(region);

    // Отримуємо список пристроїв (щоб знайти дані по них)
    // Endpoint: /v1.0/station/list (або device/list)
    // Але простіше взяти /v1.0/device/list

    const response = await fetch(`${baseUrl}/v1.0/device/list?page=1&pagesize=20`, {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        }
    });

    if (!response.ok) {
        throw new Error(`Failed to get device list: ${response.status}`);
    }

    const result = await response.json();
    if (!result.data) return [];

    // Мапимо дані до нашого формату
    // Нам треба знайти SOC. В device list воно може не бути.
    // Треба деталі кожного.

    // Спрощений варіант: повертаємо поки що 0 або тестові дані, 
    // якщо авторизація пройде успішно.
    // Головне - пройти авторизацію!

    return [];
}

// ... (Тимчасово спрощуємо логіку отримання даних, щоб перевірити Auth)

// Повертаємо повноцінну функцію з логікою отримання даних
async function fetchInverterData(token, sn) {
    const baseUrl = getBaseUrl();
    // Deye API: Get device detail
    const response = await fetch(`${baseUrl}/v1.0/device/detail?sn=${sn}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${token}` }
    });

    if (!response.ok) return null;
    const json = await response.json();
    // Пошук SOC в даних
    // Припустимо, що воно десь в data payload. 
    // Для Deye зазвичай це в 'dataPoint' або схоже.
    // Але давайте спочатку просто повернемо успіх Auth.
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

        // Якщо ми тут - Auth пройшла!
        // Спробуємо отримати дані для першого інвертора
        const firstSn = INVERTERS[1];
        const data = await fetchInverterData(token, firstSn);

        return new Response(JSON.stringify({
            message: "Auth Successful! Data fetching in progress.",
            auth: "OK",
            region: "US",
            firstDevice: data
        }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });

    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
    }
}
