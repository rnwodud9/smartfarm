export const MINUTE = 60_000;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;
const KST_OFFSET = 9 * HOUR;

// The column stores the distance from the sensor to the surface, in cm.
export const tank = { heightCm: 50, capacityL: 200, offsetCm: 0, lowL: 10 };
export const modes = {
    live:   { title: '실시간 · 최근 30분', range: 30 * MINUTE, gap: MINUTE, refresh: 30_000 },
    week:   { title: '최근 7일 · 5분 평균', period: '5min', range: 7 * DAY, gap: 7.5 * MINUTE, refresh: 5 * MINUTE },
    hourly: { title: '최근 2개월 · 1시간 평균', period: 'hour', range: 60 * DAY, gap: 1.5 * HOUR, refresh: 30 * MINUTE },
    all:    { title: '전체 기간 · 일별 평균', period: 'day', gap: 1.5 * DAY, refresh: HOUR },
};
export const sensors = {
    ph:       { title: 'pH', unit: '', color: '#c45235', axis: [0, 14], band: [6, 7], note: '상추 적정 pH 6.0–7.0' },
    ec:       { title: 'EC', unit: ' µS/cm', color: '#bc680e', axis: [0, 3000], expand: true, band: [1200, 1800], note: '상추 적정 EC 1,200–1,800 µS/cm' },
    temp:     { title: '기온', unit: ' °C', color: '#257daf', axis: [0, 40], expand: true, band: [19, 24], note: '상추 기온 기준 · 야간 19°C / 주간 24°C' },
    humidity: { title: '습도', unit: '%', color: '#137c60', axis: [0, 100], band: [50, 70], note: '상추 적정 습도 50–70%' },
    water:    { title: '잔여 물량', unit: ' L', color: '#247c9b', axis: [0, tank.capacityL], band: [0, tank.lowL], note: '물 부족 기준 · ' + tank.lowL + ' L 이하' },
};

export function finite(value) {
    if (typeof value !== 'number' && (typeof value !== 'string' || !value.trim())) return null;
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
}
// Firmware switched units between the last mS/cm sample (17:07 KST) and
// the first µS/cm sample (17:13 KST) on 2026-11-12. The 17:10 boundary
// falls in the upload gap and aligns with the five-minute history buckets.
const ecUnitChange = Date.parse('2026-11-12T17:10:00+09:00');
// These two archive buckets span both firmware versions. Their means were
// recomputed from individual valid raw EC samples before the 30-day expiry.
const transitionMeans = {
    hour: { bucket: Date.parse('2026-11-12T17:00:00+09:00'), ec: 240.916639 }, // 613 readings
    day: { bucket: Date.parse('2026-11-12T00:00:00+09:00'), ec: 1284.586820 }, // 9,393 readings
};
export function ecInMicrosiemens(value, time, period) {
    const ec = finite(value);
    if (ec === null) return null;
    const t = Date.parse(time);
    const transition = transitionMeans[period];
    if (transition && t === transition.bucket) return transition.ec;
    return t < ecUnitChange ? ec * 1000 : ec;
}

export function waterReading(value) {
    const cm = finite(value);
    // Zero is often a timeout. Accept ±2 cm at the empty-tank calibration point.
    if (cm === null || cm < 2 || cm > Math.min(400,tank.heightCm + tank.offsetCm + 2)) return null;
    const height = Math.max(0, Math.min(tank.heightCm,tank.heightCm + tank.offsetCm - cm));
    return { cm, height, liters: height / tank.heightCm * tank.capacityL };
}
export function seriesFor(rows, key, gap, from = -Infinity, until = Infinity) {
    const points = [];
    let last = null;
    let interrupted = false;
    for (const row of rows) {
        const raw = key === 'water' ? row.distance_cm : row[key];
        if (raw == null) continue; // Separate ESP32s write sparse rows.
        const reading = key === 'water' ? waterReading(raw) : null;
        const y = key === 'water' ? reading?.liters : finite(raw);
        const x = Date.parse(row.time);
        if (!Number.isFinite(x) || x < from || x > until) continue;
        if (y == null) { interrupted = true; continue; }
        if (last !== null && (interrupted || x - last > gap)) points.push({ x: (last + x) / 2, y: null });
        points.push(reading ? { x, y, cm: reading.cm } : { x, y });
        interrupted = false;
        last = x;
    }
    return points;
}
export function axesFor(key, points, mode, now) {
    const meta = sensors[key];
    let [bottom, top] = meta.axis;
    if (meta.expand) {
        for (const {y} of points) {
            if (y !== null) { bottom = Math.min(bottom, y); top = Math.max(top, y); }
        }
    }
    const first = points[0]?.x;
    const left = first < now ? first : now - (mode.range || DAY);
    return { left, right: now, bottom, top };
}
const tickIntervals = [1000, 5000, 10000, 30000, MINUTE, 5*MINUTE, 15*MINUTE, 30*MINUTE, HOUR, 3*HOUR,
    6*HOUR, 12*HOUR, DAY, 2*DAY, 7*DAY, 14*DAY, 30*DAY, 90*DAY, 180*DAY, 365*DAY];
export function xTicks(left, right, width) {
    const span = right - left;
    if (span <= 2) return [{ value: right }];
    const slots = Math.max(1, Math.min(8, Math.floor(width / 86)));
    const target = span / slots;
    const step = tickIntervals.find(s => s >= target) || Math.ceil(target / (365 * DAY)) * 365 * DAY;
    const ticks = [{ value: left }];
    for (let t = Math.ceil((left + KST_OFFSET) / step) * step - KST_OFFSET; t < right; t += step) {
        if (t - left >= target * .82 && right - t >= target * .82) ticks.push({ value: t });
    }
    ticks.push({ value: right });
    return ticks;
}
const clock = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const clockSeconds = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Seoul', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
const date = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', month: 'numeric', day: 'numeric' });
const fullDate = new Intl.DateTimeFormat('ko-KR', { timeZone: 'Asia/Seoul', year: 'numeric', month: 'numeric', day: 'numeric' });
export function tickLabel(t, span) {
    if (span < 2 * MINUTE) return clockSeconds.format(t);
    if (span < DAY) return clock.format(t);
    return span > 365 * DAY ? fullDate.format(t) : date.format(t);
}
export const nowLabel = t => '현재 ' + clock.format(t);
export function timestamp(t, daily = false) {
    return daily ? fullDate.format(t) : fullDate.format(t) + ' ' + clockSeconds.format(t);
}
export const fmt = (value, digits = 1) => value.toLocaleString('ko-KR', { maximumFractionDigits: digits });
