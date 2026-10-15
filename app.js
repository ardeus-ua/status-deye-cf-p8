/**
 * Battery Status - Main Application Logic
 *
 * Дані: /api/battery (раз на 5 хв їх приносить deye-fetch). На кожну систему:
 *   level, grid_freq (> 0 — є мережа), grid_since (коли змінилась мережа), forecast_min, threshold, timestamp
 */

// --- Constants & Config ---
const CONFIG = {
    BATTERIES: [
        { id: 1, name: 'Ліфт п1', type: 'elevator' },
        { id: 2, name: 'Ліфт п2', type: 'elevator' },
        { id: 3, name: 'Ліфт п3', type: 'elevator' },
        { id: 4, name: 'Вода', type: 'infra' },
        { id: 5, name: 'Опалення', type: 'infra' }
    ],
    API_URL: '/api/battery',
    CACHE_KEY: 'battery_data_cache',
    CACHE_TTL: 24 * 60 * 60 * 1000,   // показуємо збережене одразу при відкритті, свіжість видно в статусі
    // Нові дані з'являються о :00, :05 ... UTC (deye-fetch) + до 60 с edge-кешу /api/battery,
    // тож запитуємо через 75 с після кожної 5-хвилинної позначки (+ до 15 с розкиду між вкладками)
    DATA_PERIOD: 5 * 60 * 1000,
    DATA_DELAY: 75 * 1000,
    JITTER: 15 * 1000,
    STALE_THRESHOLD: 15 * 60 * 1000, // дані старші за 15 хв — застарілі
    ELEVATOR_THRESHOLD: 20
};

// --- State Management ---
const State = {
    data: null,             // останні дані з сервера або кешу
    previousLevels: {},
    criticalAlerted: new Set(),
    isFirstLoad: true
};

// --- DOM Elements ---
const $ = (id) => document.getElementById(id);
const DOM = {
    elevatorList: $('elevator-list'),
    infraList: $('infra-list'),
    statusDot: $('status-dot'),
    statusText: $('status-text'),
    hero: $('hero'),
    heroIcon: $('hero-icon'),
    heroTitle: $('hero-title'),
    heroSub: $('hero-sub'),
    toastEl: $('toast'),
    forecastNote: $('forecast-note'),
    dynamicFavicon: $('dynamic-favicon'),
    themeSwitch: $('theme-switch'),
    metaThemeColor: $('meta-theme-color')
};

// --- Utilities ---
const Utils = {
    kyivTime(iso) {
        return new Date(iso).toLocaleTimeString('uk-UA', { timeZone: 'Europe/Kyiv', hour: '2-digit', minute: '2-digit' });
    },

    // "40 хв", "3 год 19 хв"
    duration(ms) {
        const mins = Math.max(0, Math.round(ms / 60000));
        const h = Math.floor(mins / 60), m = mins % 60;
        return h ? `${h} год${m ? ` ${m} хв` : ''}` : `${m} хв`;
    },

    // Прогноз: "≈ 40 хв", "≈ 2 год", "≈ 2,5 год"
    forecast(mins) {
        if (mins < 60) return `≈ ${Math.max(10, Math.round(mins / 10) * 10)} хв`;
        const h = Math.round(mins / 30) / 2;
        return `≈ ${String(h).replace('.', ',')} год`;
    },

    hasGrid: (b) => b.grid_freq > 0,
    age: (b) => b.timestamp ? Date.now() - new Date(b.timestamp).getTime() : Infinity
};

// --- UI ---
const UI = {
    createRow(config) {
        const row = document.createElement('div');
        row.className = `row ${config.type} skeleton`;
        row.dataset.id = String(config.id);
        row.innerHTML = `
            <div class="grid" id="grid-${config.id}"></div>
            <div class="name">${config.name}<small id="sub-${config.id}">&nbsp;</small></div>
            <div class="bar"><div class="fill" id="fill-${config.id}"></div></div>
            <div class="pct" id="pct-${config.id}">&nbsp;</div>`;
        return row;
    },

    initLists() {
        CONFIG.BATTERIES.forEach(config => {
            (config.type === 'elevator' ? DOM.elevatorList : DOM.infraList).appendChild(this.createRow(config));
        });
    },

    updateConnectionStatus(status, text) {
        DOM.statusDot.className = 'dot ' + status;
        DOM.statusText.textContent = text;
    },

    // Статус за свіжістю даних, а не за тим, звідки їх взяли (кеш / мережа)
    updateFreshness(batteries, fetchFailed = false) {
        const b = batteries[0];
        if (!b || !b.timestamp) return;
        const stale = Utils.age(b) > CONFIG.STALE_THRESHOLD;
        const time = `о ${Utils.kyivTime(b.timestamp)}`;
        if (stale) this.updateConnectionStatus(fetchFailed ? 'offline' : 'stale', `Дані застарілі · ${time}`);
        else this.updateConnectionStatus('', `Оновлено ${time}`);
    },

    showToast(message) {
        DOM.toastEl.textContent = message;
        DOM.toastEl.classList.add('show');
        clearTimeout(this.toastTimer);
        this.toastTimer = setTimeout(() => DOM.toastEl.classList.remove('show'), 2500);
    },

    updateFavicon(batteries) {
        const minLevel = Math.min(...batteries.map(b => b.level));
        const anyGridOff = batteries.some(b => !Utils.hasGrid(b));
        const emoji = minLevel <= CONFIG.ELEVATOR_THRESHOLD ? '🪫' : (anyGridOff ? '⚡' : '🔋');
        const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>${emoji}</text></svg>`;
        DOM.dynamicFavicon.href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
    },

    // Світло є / немає / частково — інвертори підключені по-різному, тому дивимось на кожен
    updateHero(batteries) {
        const off = batteries.filter(b => !Utils.hasGrid(b));
        const sinces = (list) => list.map(b => b.grid_since).filter(Boolean).map(s => new Date(s).getTime());
        let cls, icon, title, sub;

        if (!off.length) {
            const t = sinces(batteries);
            cls = 'on'; icon = '🟢'; title = 'Світло є';
            sub = 'усі системи від мережі' + (t.length ? ` · з ${Utils.kyivTime(Math.max(...t))}` : '');
        } else if (off.length === batteries.length) {
            // «з …» — коли зникло на першому інверторі
            const t = sinces(off);
            const start = t.length ? Math.min(...t) : null;
            cls = 'off'; icon = '🔴'; title = 'Світла немає';
            sub = start ? `з ${Utils.kyivTime(start)} · вже ${Utils.duration(Date.now() - start)} · усе від батарей` : 'усе працює від батарей';
        } else {
            cls = 'part'; icon = '🟡'; title = 'Світло частково';
            sub = `від батарей: ${off.map(b => b.name || CONFIG.BATTERIES.find(c => c.id === b.id).name).join(', ')}`;
        }

        DOM.hero.className = `hero ${cls}`;
        DOM.heroIcon.textContent = icon;
        DOM.heroTitle.textContent = title;
        DOM.heroSub.textContent = sub;
    },

    // Підпис під назвою: від мережі — заряд; від батареї — прогноз або попередження
    subtitle(b) {
        if (Utils.hasGrid(b)) {
            return { cls: 'on', text: b.level >= 99 ? 'заряджено' : 'заряджається' };
        }
        const threshold = b.threshold ?? CONFIG.ELEVATOR_THRESHOLD;
        if (b.level <= threshold) return { cls: 'warn', text: `⛔ нижче ${threshold}%` };
        if (b.forecast_min == null) return { cls: '', text: 'від батареї · рахуємо…' };
        return { cls: '', text: `вистачить ${Utils.forecast(b.forecast_min)}` };
    },

    updateRow(b, animate = false) {
        const row = document.querySelector(`.row[data-id="${b.id}"]`);
        if (!row) return;
        row.classList.remove('skeleton');

        const grid = Utils.hasGrid(b);
        const gridEl = $(`grid-${b.id}`);
        gridEl.className = `grid ${grid ? 'on' : 'off'}`;
        gridEl.textContent = grid ? '⚡' : '🔌';
        gridEl.title = grid ? `Мережа є (${b.grid_freq.toFixed(1)} Гц)` : 'Мережі немає — працює від батареї';

        const sub = this.subtitle(b);
        const subEl = $(`sub-${b.id}`);
        subEl.className = sub.cls;
        subEl.textContent = sub.text;

        const threshold = b.threshold ?? CONFIG.ELEVATOR_THRESHOLD;
        const low = b.level <= threshold;
        const fill = $(`fill-${b.id}`);
        fill.style.width = `${b.level}%`;
        fill.className = `fill ${low ? 'low' : b.level <= 50 ? 'mid' : ''}`;

        const pct = $(`pct-${b.id}`);
        pct.textContent = `${b.level}%`;
        pct.className = `pct ${low ? 'low' : ''}`;

        if (animate && State.previousLevels[b.id] !== undefined && State.previousLevels[b.id] !== b.level) {
            row.classList.remove('updated');
            void row.offsetWidth; // перезапуск CSS-анімації
            row.classList.add('updated');
        }
        State.previousLevels[b.id] = b.level;

        // Вібрація, коли ліфт опускається нижче 20%
        const isElevator = CONFIG.BATTERIES.find(c => c.id === b.id)?.type === 'elevator';
        if (isElevator && b.level <= CONFIG.ELEVATOR_THRESHOLD && !State.criticalAlerted.has(b.id)) {
            State.criticalAlerted.add(b.id);
            if ('vibrate' in navigator) {
                try { navigator.vibrate([200, 100, 200]); } catch (e) { }
            }
        }
        if (b.level > CONFIG.ELEVATOR_THRESHOLD) State.criticalAlerted.delete(b.id);
    },

    render(batteries, { animate = false, fetchFailed = false } = {}) {
        State.data = batteries;
        batteries.forEach(b => this.updateRow(b, animate));
        this.updateHero(batteries);
        // Пояснення про точність — тільки коли на екрані є прогноз
        DOM.forecastNote.hidden = !batteries.some(b => !Utils.hasGrid(b) && b.forecast_min > 0);
        this.updateFavicon(batteries);
        this.updateFreshness(batteries, fetchFailed);
    }
};

// --- Data Service ---
const DataService = {
    getCached() {
        try {
            const cached = localStorage.getItem(CONFIG.CACHE_KEY);
            if (cached) {
                const { data, timestamp } = JSON.parse(cached);
                const age = Date.now() - timestamp;
                if (age < CONFIG.CACHE_TTL) return { data, age, fetchedAt: timestamp };
            }
        } catch (e) { console.error('Cache read error', e); }
        return null;
    },

    setCached(data) {
        try {
            localStorage.setItem(CONFIG.CACHE_KEY, JSON.stringify({ data, timestamp: Date.now() }));
        } catch (e) { console.error('Cache write error', e); }
    },

    // Остання позначка, після якої на сервері вже мають бути нові дані
    lastDue(now = Date.now()) {
        return Math.floor((now - CONFIG.DATA_DELAY) / CONFIG.DATA_PERIOD) * CONFIG.DATA_PERIOD + CONFIG.DATA_DELAY;
    },

    nextDue(now = Date.now()) {
        return this.lastDue(now) + CONFIG.DATA_PERIOD;
    },

    async fetchAndRender() {
        const cached = this.getCached();

        if (cached) {
            UI.render(cached.data);
            // Після останнього запиту нових даних ще не було — запит нічого не дасть
            if (cached.fetchedAt >= this.lastDue()) return;
        }

        try {
            if (!cached) UI.updateConnectionStatus('loading', 'Оновлення...');
            const response = await fetch(CONFIG.API_URL, { headers: { 'Accept': 'application/json' } });

            if (!response.ok) throw new Error(`HTTP ${response.status}`);
            const result = await response.json();
            // stale: deye-fetch не приносить свіжих даних, сервер віддав останні збережені — показуємо їх
            if (result.error && !Array.isArray(result.data)) throw new Error(result.error);

            const batteries = result.data || result;
            this.setCached(batteries);
            UI.render(batteries, { animate: true });

            if (!State.isFirstLoad) UI.showToast('✅ Дані оновлено');
            State.isFirstLoad = false;
        } catch (error) {
            console.error(error);
            if (cached) {
                UI.render(cached.data, { fetchFailed: true });
            } else if (State.data) {
                UI.render(State.data, { fetchFailed: true });
            } else {
                UI.updateConnectionStatus('offline', "Помилка з'єднання");
                DOM.hero.className = 'hero';
                DOM.heroIcon.textContent = '⚠️';
                DOM.heroTitle.textContent = 'Немає даних';
                DOM.heroSub.textContent = 'Спробуємо ще раз за кілька хвилин';
            }
            State.isFirstLoad = false;
        }
    }
};

// --- Theme Management ---
const ThemeManager = {
    init() {
        const savedTheme = localStorage.getItem('theme');
        const systemDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
        this.applyTheme(savedTheme ? savedTheme === 'dark' : systemDark);

        // Слухаємо зміну системної теми (якщо не вибрано вручну)
        window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', e => {
            if (!localStorage.getItem('theme')) this.applyTheme(e.matches);
        });

        DOM.themeSwitch.addEventListener('change', (e) => {
            this.applyTheme(e.target.checked);
            localStorage.setItem('theme', e.target.checked ? 'dark' : 'light');
        });
    },

    applyTheme(isDark) {
        document.body.classList.toggle('dark-theme', isDark);
        DOM.themeSwitch.checked = isDark;
        DOM.metaThemeColor.setAttribute('content', isDark ? '#000000' : '#f2f2f7');
    }
};

// --- Application Core ---
const App = {
    init() {
        UI.initLists();
        ThemeManager.init();
        localStorage.removeItem('active_elevator'); // залишок від старого фільтра «свій ліфт»

        // Перше завантаження — навіть у фоновій вкладці, щоб сторінка не була порожньою
        DataService.fetchAndRender();
        this.schedule();

        // Щохвилини — «вже N хв» у статусі й позначка застарілості, без запитів до сервера
        setInterval(() => { if (State.data) UI.render(State.data); }, 60000);

        // Фонова вкладка / згорнутий PWA — не опитуємо; повернення — запит, якщо з'явились нові дані
        document.addEventListener('visibilitychange', () => {
            if (document.visibilityState === 'visible') {
                DataService.fetchAndRender();
                this.schedule();
            } else {
                clearTimeout(this.timer);
            }
        });

        this.registerServiceWorker();
    },

    // Наступний запит — одразу після появи нових даних на сервері, тільки у видимій вкладці
    schedule() {
        clearTimeout(this.timer);
        if (document.visibilityState !== 'visible') return;
        const delay = DataService.nextDue() - Date.now() + Math.random() * CONFIG.JITTER;
        this.timer = setTimeout(() => {
            DataService.fetchAndRender();
            this.schedule();
        }, delay);
    },

    registerServiceWorker() {
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.register('/sw.js').catch(err => {
                console.warn('ServiceWorker registration failed', err);
            });
        }
    }
};

// Запуск додатку
App.init();
