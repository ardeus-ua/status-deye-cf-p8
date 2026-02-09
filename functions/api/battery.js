/**
 * Cloudflare Pages Function - DeyeCloud API Proxy
 * 
 * Proxies requests to DeyeCloud API to fetch battery status.
 * Supports manual token injection to bypass auth issues.
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

// Використовуємо BaseUrl EU, оскільки токен був виданий з `dataCenter=eu`
function getBaseUrl() {
    return 'https://eu1-developer.deyecloud.com';
}

/**
 * Отримання access token
 * Пріоритет:
 * 1. DEYE_MANUAL_TOKEN (якщо задано вручну в змінних)
 * 2. KV Cache
 * 3. Логін через API (який у нас не працював)
 */
async function getAccessToken(env) {
    // 1. Manual Token Bypass
    if (env.DEYE_MANUAL_TOKEN) {
        return env.DEYE_MANUAL_TOKEN;
    }

    // 2. KV Cache
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

    // 3. Login attempt (Fallback)
    // ... (попередня логіка, яка не працювала)
    throw new Error("No manual token provided and auto-login failed previously. Please set DEYE_MANUAL_TOKEN.");
}

// Функція отримання даних
async function fetchInverterData(token, sn) {
    const baseUrl = getBaseUrl();
    // Deye API: Get device detail
    const response = await fetch(`${baseUrl}/v1.0/device/detail?sn=${sn}`, {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
        }
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Device API Error: ${response.status} ${text}`);
    }
    const json = await response.json();
    return json;
}

// Парсинг SOC з даних
function parseSOC(data) {
    // Структура відповіді може бути різною. 
    // Зазвичай data.devicePointList або схоже
    // Шукаємо Point з назвою "SOC" або "Battery Capacity"
    // Поки повернемо заглушку або сирі дані для аналізу
    return 0;
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
        const token = await getAccessToken(env);

        // Спробуємо отримати дані для першого інвертора
        const firstSn = INVERTERS[1];

        try {
            const data = await fetchInverterData(token, firstSn);

            // Якщо успішно - повертаємо дані для аналізу структури
            return new Response(JSON.stringify({
                message: "Data access successful with manual token!",
                firstDeviceData: data
            }), { headers: { 'Content-Type': 'application/json', ...corsHeaders } });

        } catch (apiError) {
            return new Response(JSON.stringify({
                error: "Token accepted locally but rejected by API",
                details: apiError.message
            }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders } });
        }

    } catch (error) {
        return new Response(JSON.stringify({ error: error.message }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
    }
}
