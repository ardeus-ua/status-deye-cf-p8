/**
 * Cloudflare Pages Function - Solarman API Proxy (Compatible with Deye)
 * 
 * Отримує дані про рівень заряду батарей з Solarman API (використовується DeyeCloud)
 * Використовує Cloudflare KV для кешування
 * 
 * Environment Variables потрібно налаштувати в Cloudflare Dashboard:
 * - DEYE_EMAIL (Ваш логін Solarman/Deye)
 * - DEYE_PASSWORD (Ваш пароль - чистий текст!)
 * 
 * KV Namespace:
 * - DEYE_CACHE (binding name)
 */

// Конфігурація інверторів
const INVERTERS = {
    1: '2407021154',  // Ліфт п1
    2: '2407024008',  // Ліфт п2
    3: '2407026195',  // Ліфт п3
    4: '2407026187',  // Вода
    5: '2407024186',  // Опалення
    6: '2510171041',  // Опалення 2
};

const BATTERY_NAMES = {
    1: 'sensor.soc_2407021154',
    2: 'sensor.soc_2407024008',
    3: 'sensor.soc_2407026195',
    4: 'sensor.soc_2407026187',
    5: 'sensor.soc_2407024186',
    6: 'sensor.soc_2510171041',
};

// Публічні ключі Solarman Business (менш вірогідно заблоковані)
const SOLARMAN_APP_ID = '1300057030';
const SOLARMAN_APP_SECRET = '7b508493d9ce35539316be2f06764510';

// Час кешування
const CACHE_TTL = 300; // 5 хвилин
const TOKEN_CACHE_TTL = 60 * 60 * 24; // 24 години

/**
 * SHA256 hash для пароля
 */
async function sha256(message) {
    const msgBuffer = new TextEncoder().encode(message);
    const hashBuffer = await crypto.subtle.digest('SHA-256', msgBuffer);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Отримання access token з кешу або через API
 */
async function getAccessToken(env) {
    // Перевірка кешу токена
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

    // Запит нового токена
    const baseUrl = 'https://api.solarmanpv.com';
    const passwordHash = await sha256(env.DEYE_PASSWORD);

    // URL params for authentication
    const params = new URLSearchParams({
        appId: SOLARMAN_APP_ID,
        method: 'password', // login method
    });

    const authData = {
        password: passwordHash,
        username: env.DEYE_EMAIL, // Field name is 'username' for Solarman
        country_code: 'CN' // Default country code often required
    };

    const response = await fetch(`${baseUrl}/account/v1.0/token?${params.toString()}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(authData)
    });

    if (!response.ok) {
        const text = await response.text();
        throw new Error(`Failed to get token from ${baseUrl}: ${response.status} ${text}`);
    }

    const result = await response.json();

    if (!result.access_token) {
        throw new Error(`Invalid token response from ${baseUrl}: ${JSON.stringify(result)}. Payload: {username: "${authData.username}", ...}`);
    }

    const token = result.access_token;

    // Зберігаємо токен в KV
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
 * Отримання SOC для інвертора
 */
async function getInverterSOC(token, serialNumber) {
    const baseUrl = 'https://api.solarmanpv.com';

    // Solarman API endpoint for current data
    const response = await fetch(`${baseUrl}/device/v1.0/currentData?appId=${SOLARMAN_APP_ID}&language=en&sn=${serialNumber}`, {
        method: 'GET', // Sometimes POST is safer, but GET works for currentData
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`
        }
    });

    if (!response.ok) {
        // Silently fail for individual inverter to not break all
        console.error(`Failed to get data for inverter ${serialNumber}: ${response.status}`);
        return null;
    }

    const result = await response.json();

    // Пошук SOC в даних
    // Solarman returns { "dataList": [ { "key": "SOC", "value": "100" }, ... ] }
    if (result.dataList) {
        for (const item of result.dataList) {
            if (item.key === 'SoC' || item.key === 'SOC' || item.key === 'B_capacity_1') {
                return parseInt(item.value, 10);
            }
        }
    }

    console.error(`SOC not found for inverter ${serialNumber} in response:`, JSON.stringify(result).substring(0, 100)); // Log part of response
    return null;
}

/**
 * Основний обробник запитів
 */
export async function onRequest(context) {
    const { env, request } = context;

    // CORS headers
    const corsHeaders = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Cache-Control': 'public, max-age=300', // Браузерний кеш 5 хвилин
    };

    // Handle OPTIONS request
    if (request.method === 'OPTIONS') {
        return new Response(null, { headers: corsHeaders });
    }

    try {
        // Перевірка кешу API відповіді
        if (env.DEYE_CACHE) {
            try {
                const cachedData = await env.DEYE_CACHE.get('battery_data', { type: 'json' });
                if (cachedData && cachedData.data && cachedData.timestamp) {
                    const age = Math.floor(Date.now() / 1000) - cachedData.timestamp;
                    if (age < CACHE_TTL) {
                        return new Response(JSON.stringify({
                            data: cachedData.data,
                            cached: true,
                            age: age
                        }), {
                            headers: { 'Content-Type': 'application/json', ...corsHeaders }
                        });
                    }
                }
            } catch (e) {
                console.error('KV cache read error:', e);
            }
        }

        if (!env.DEYE_EMAIL || !env.DEYE_PASSWORD) {
            throw new Error('Missing DEYE_EMAIL or DEYE_PASSWORD in environment variables');
        }

        // Отримання токена
        const token = await getAccessToken(env);

        // Отримання даних для всіх інверторів
        const batteries = [];

        for (const [id, serialNumber] of Object.entries(INVERTERS)) {
            const soc = await getInverterSOC(token, serialNumber);

            batteries.push({
                id: parseInt(id, 10),
                name: BATTERY_NAMES[id] || `sensor.soc_${serialNumber}`,
                level: soc ?? 0,
                timestamp: new Date().toISOString()
            });

            // Невелика затримка між запитами (Rate limit friendly)
            await new Promise(resolve => setTimeout(resolve, 200));
        }

        // Зберігаємо в KV кеш
        if (env.DEYE_CACHE) {
            try {
                await env.DEYE_CACHE.put('battery_data', JSON.stringify({
                    data: batteries,
                    timestamp: Math.floor(Date.now() / 1000)
                }), {
                    expirationTtl: CACHE_TTL
                });
            } catch (e) {
                console.error('KV cache write error:', e);
            }
        }

        return new Response(JSON.stringify({
            data: batteries,
            cached: false
        }), {
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });

    } catch (error) {
        console.error('API Error:', error);

        return new Response(JSON.stringify({
            error: error.message || 'Internal server error'
        }), {
            status: 500,
            headers: { 'Content-Type': 'application/json', ...corsHeaders }
        });
    }
}
