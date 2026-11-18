import { MINUTE, modes, sensors, tank, finite, waterReading, seriesFor, axesFor, xTicks, tickLabel, timestamp, fmt } from './sensors.mjs';

const rawTable = window.SUPABASE_TABLE_RAW || 'sensor_data';
const historyTable = 'sensor_history';
const rawColumns = 'id,time:created_at,ph:PH,ec:EC,temp:온도,humidity:습도,distance_cm:초음파';
const historyColumns = 'time:bucket,ph,ec,temp,humidity,distance_cm';
const status = document.querySelector('#status');
const message = document.querySelector('#plot-message');
const guide = document.querySelector('#guide');
let sensor = 'ph';
let mode = 'live';
let records = [];
let asOf = Date.now();
let phase = 'loading';
let chart, client, chartRequest, latestRequest, chartTimer, cardTimer;

const referenceBand = {
    id: 'referenceBand',
    beforeDraw(chart, _args, options) {
        const { ctx, chartArea, scales } = chart;
        if (!chartArea) return;
        const { left, right } = chartArea;
        const top = scales.y.getPixelForValue(options.high);
        const bottom = scales.y.getPixelForValue(options.low);
        ctx.save();
        ctx.fillStyle = options.water ? '#fff0ca' : '#e2f1e6';
        ctx.fillRect(left, top, right - left, bottom - top);
        ctx.strokeStyle = options.water ? '#a47409' : '#548462';
        ctx.setLineDash([5, 4]);
        ctx.beginPath();
        for (const y of [top, bottom]) { ctx.moveTo(left, y); ctx.lineTo(right, y); }
        ctx.stroke();
        ctx.restore();
    },
};
function pointRadius({ dataIndex: i, dataset }) {
    const pts = dataset.data;
    if (!pts[i] || pts[i].y === null) return 0;
    return pts.length < 60 || i === 0 || i === pts.length - 1 || pts[i-1]?.y === null || pts[i+1]?.y === null ? 2.5 : 0;
}
function showStatus(text, error = false) {
    status.textContent = text;
    status.classList.toggle('error', error);
}
function draw() {
    const meta = sensors[sensor], period = modes[mode];
    const points = seriesFor(records, sensor, period.gap);
    const bounds = axesFor(sensor, points, period, asOf);
    const [low, high] = meta.band;
    const dataset = { label: meta.title, data: points, borderColor: meta.color, backgroundColor: meta.color,
        borderWidth: 2, fill: false, tension: 0, spanGaps: false, pointRadius, pointHoverRadius: 4, pointHitRadius: 7 };
    const band = { low, high, water: sensor === 'water' };
    const x = {
        type: 'linear', min: bounds.left, max: bounds.right, offset: false, bounds: 'data',
        afterBuildTicks(scale) { scale.ticks = xTicks(scale.min, scale.max, scale.width || scale.chart.width); },
        ticks: { autoSkip: false, align: 'inner', maxRotation: 0, minRotation: 0,
            callback: value => tickLabel(value, bounds.right - bounds.left) },
        grid: { color: '#eaf0f2', offset: false },
    };
    const y = {
        type: 'linear', min: bounds.bottom, max: bounds.top, offset: false,
        ticks: { includeBounds: true, maxTicksLimit: sensor === 'ph' ? 8 : 7,
            callback: value => fmt(value, 3) + (sensor === 'humidity' ? '%' : '') },
        grid: { color: '#dce6e9aa' },
    };
    const tooltip = { callbacks: {
        title: items => items.length ? timestamp(items[0].parsed.x, mode === 'all') + ' KST' : '',
        label: item => {
            const suffix = sensor === 'water' ? ' · 거리 ' + fmt(item.raw.cm, 2) + ' cm' : '';
            return meta.title + ' ' + fmt(item.parsed.y, sensor === 'water' ? 1 : 3) + meta.unit + suffix;
        },
    } };
    if (chart) {
        chart.data.datasets[0] = dataset;
        chart.options.scales.x = x;
        chart.options.scales.y = y;
        chart.options.plugins.referenceBand = band;
        chart.options.plugins.tooltip = tooltip;
        chart.update('none');
    } else {
        chart = new Chart(document.querySelector('#sensorChart'), {
            type: 'line', data: { datasets: [dataset] }, plugins: [referenceBand],
            options: {
                responsive: true, maintainAspectRatio: false, animation: false, parsing: false,
                interaction: { mode: 'nearest', axis: 'x', intersect: false },
                plugins: { legend: { display: false }, tooltip, referenceBand: band },
                scales: { x, y },
            },
        });
    }
    document.querySelector('#chart-title').textContent = meta.title + (meta.unit.trim() ? ' (' + meta.unit.trim() + ')' : '');
    guide.textContent = meta.note;
    guide.classList.toggle('water', sensor === 'water');
    const count = points.reduce((n, point) => n + (point.y !== null ? 1 : 0), 0);
    const state = phase === 'loading' ? '측정 기록을 불러오는 중…' : phase === 'error' ? '기록을 불러오지 못했어.' :
        count ? '' : sensor === 'water' ? '이 기간에 유효한 초음파 측정값이 없어.' : '이 기간에 측정값이 없어.';
    message.hidden = !state;
    message.textContent = state;
    if (phase === 'ready') {
        const coverage = count ? timestamp(points[0].x, mode === 'all') +
            (points[0].x === points.at(-1).x ? '' : ' ~ ' + timestamp(points.at(-1).x, mode === 'all')) + ' KST' : '측정 대기';
        showStatus(period.title + ' · ' + coverage + (count ? ' · ' + fmt(count, 0) + '개' : ''));
    } else if (phase === 'loading') showStatus(period.title + ' · 불러오는 중…');
}

// Seek past the last returned record instead of assuming the server's Max rows.
// Hold the upper bound fixed so incoming samples do not move a page boundary.
async function periodRows(period, until, signal) {
    const live = !period.period, timeKey = live ? 'created_at' : 'bucket';
    const rows = [];
    let last;
    for (;;) {
        let q = client.from(live ? rawTable : historyTable).select(live ? rawColumns : historyColumns)
            .lte(timeKey, new Date(until).toISOString()).order(timeKey, { ascending: true });
        if (period.range) q = q.gte(timeKey, new Date(until - period.range).toISOString());
        if (live) q = q.order('id', { ascending: true });
        else q = q.eq('period', period.period);
        if (last) {
            if (live) {
                q = q.or('created_at.gt.' + last.time + ',and(created_at.eq.' + last.time + ',id.gt.' + last.id + ')');
            } else q = q.gt(timeKey, last.time);
        }
        const { data, error } = await q.limit(500).abortSignal(signal);
        if (error) throw error;
        if (!data.length) return rows;
        rows.push(...data);
        last = data[data.length - 1];
    }
}
async function loadChart() {
    chartRequest?.abort();
    const request = new AbortController();
    chartRequest = request;
    const requestedMode = mode, until = Date.now();
    try {
        const rows = await periodRows(modes[requestedMode], until, request.signal);
        if (request !== chartRequest || request.signal.aborted || requestedMode !== mode) return;
        records = rows;
        asOf = until;
        phase = 'ready';
        if (mode === 'live') updateCards([...rows].reverse());
        draw();
    } catch (error) {
        if (request !== chartRequest || request.signal.aborted) return;
        phase = 'error';
        if (mode === 'live') updateCards([], true);
        draw();
        showStatus('그래프 조회 오류 · ' + error.message, true);
    }
}
function updateCards(rows, failed = false) {
    const now = Date.now();
    const fresh = rows.filter(row => {
        const age = now - Date.parse(row.time);
        return age >= 0 && age <= 3 * MINUTE;
    });
    for (const key of Object.keys(sensors)) {
        const col = key === 'water' ? 'distance_cm' : key;
        const row = fresh.find(row => row[col] != null);
        let value = finite(row?.[col]);
        if (key === 'water') {
            const r = row ? waterReading(row[col]) : null;
            value = r?.liters ?? null;
            const low = value !== null && value <= tank.lowL;
            document.querySelector('[data-sensor="water"]').classList.toggle('warning', low);
            document.querySelector('#tank-detail').textContent = r ?
                (low ? '물 부족 · ' : '') + '거리 ' + fmt(r.cm, 2) + ' cm · 수위 ' + fmt(r.height, 2) + ' cm' :
                failed ? '센서 조회 오류' : row ? '초음파 측정 오류' : '초음파 수신 대기';
        }
        document.querySelector('#val-' + key).textContent = value === null ? '—' : fmt(value, key === 'water' ? 1 : 3);
    }
}
async function loadLatest() {
    latestRequest?.abort();
    const request = new AbortController();
    latestRequest = request;
    try {
        // Separate boards send sparse rows. Read the whole freshness window so
        // the faster board's rows cannot push the slower board off the first page.
        const rows = await periodRows({ range: 3 * MINUTE }, Date.now(), request.signal);
        if (!request.signal.aborted) updateCards(rows.reverse());
    } catch {
        if (!request.signal.aborted) updateCards([], true);
    }
}
function refresh() {
    if (document.hidden || !client) return;
    loadChart();
    if (mode !== 'live') loadLatest();
}
function startPolling() {
    clearInterval(chartTimer);
    clearInterval(cardTimer);
    latestRequest?.abort();
    refresh();
    chartTimer = setInterval(() => { if (!document.hidden) loadChart(); }, modes[mode].refresh);
    if (mode !== 'live') cardTimer = setInterval(() => { if (!document.hidden) loadLatest(); }, modes.live.refresh);
}
function press(group, attr, value) {
    for (const button of group.querySelectorAll('button')) button.setAttribute('aria-pressed', String(button.dataset[attr] === value));
}
document.querySelector('.cards-grid').addEventListener('click', e => {
    const key = e.target.closest('[data-sensor]')?.dataset.sensor;
    if (!key || !chart) return;
    sensor = key;
    press(e.currentTarget, 'sensor', key);
    draw();
});
document.querySelector('.mode-switch').addEventListener('click', e => {
    const key = e.target.closest('[data-mode]')?.dataset.mode;
    if (!key || key === mode || !client) return;
    mode = key;
    records = [];
    asOf = Date.now();
    phase = 'loading';
    press(e.currentTarget, 'mode', mode);
    draw();
    startPolling();
});
window.addEventListener('load', () => {
    if (!window.Chart || !window.supabase || !window.SUPABASE_URL || !window.SUPABASE_ANON_KEY) {
        showStatus('그래프 또는 데이터 연결 설정을 불러오지 못했어.', true);
        return;
    }
    client = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY, {
        auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    draw();
    startPolling();
    document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
});
