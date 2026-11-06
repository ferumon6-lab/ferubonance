'use strict';
/* =========================================================
   Mis Finanzas — v3
   Un cuadro de texto por mes. Formato de cada párrafo:
     Nombre  (tipo)(MONEDA)(monto)(prefijo de cuenta)
     Pinceles -PEN50B
   ========================================================= */

const STORAGE_KEY = 'misFinanzas.v1';
const RATES_URL = 'https://open.er-api.com/v6/latest/USD';
const RATES_MAX_AGE = 12 * 3600 * 1000; // 12 horas

const TYPES = {
  '-': { key: 'gasto' },
  '+': { key: 'ingreso' },
  '%': { key: 'deuda' },
  '&': { key: 'medeben' },
  '#': { key: 'encargo' },
  '>': { key: 'transfer' },
};
const SYMBOL_OF = { gasto: '-', ingreso: '+', deuda: '%', medeben: '&', encargo: '#', transfer: '>' };
const LABEL_OF = { gasto: 'Gasto', ingreso: 'Ingreso', deuda: 'Debo', medeben: 'Me deben', encargo: 'Encargo', transfer: 'Transferencia' };

const KNOWN_CURRENCIES = ['PEN', 'USD', 'JPY', 'EUR', 'MXN', 'ARS', 'CLP', 'COP', 'BRL', 'GBP', 'CNY', 'KRW',
  'CAD', 'AUD', 'CHF', 'BOB', 'UYU', 'PYG', 'VES'];
const CUR_WORDS = {
  sol: 'PEN', soles: 'PEN',
  dolar: 'USD', dolares: 'USD', 'dólar': 'USD', 'dólares': 'USD',
  euro: 'EUR', euros: 'EUR',
  yen: 'JPY', yenes: 'JPY',
};
const COLOR_PRESETS = ['#f4a3ab', '#f6c89a', '#f3e2a0', '#9fdcb5', '#96dcd6', '#9cc8f0', '#c5b3f0', '#e8b4d8',
  '#ff4d5e', '#ff9f43', '#ffd34d', '#2fe07e', '#1ec8c8', '#4c9dff', '#9b6bff', '#ff5fcf',
  '#e8e4ec', '#a39aa8', '#c49a6c', '#7a8c5a'];

/* Grupos: 1 inicio | 2 tipo | 3 MONEDA antes del monto | 4 símbolo ($, S/) | 5 monto
           6 prefijo de cuenta (1 carácter pegado al monto) | 7 moneda escrita después (formato antiguo) */
const ENTRY_RE = /(^|\s)([-+%&#>])([A-Z]{3,5})?(US\$|S\/\.?|\$|€)?\s?(\d[\d.,]*)(?:([A-Z][a-z]?|[^\s\d.,A-Za-z*])(?=\s|$))?(?:\s*([a-zA-ZáéíóúÁÉÍÓÚ]{3,8})(?=\s|$))?/d;
const PARTIAL_RE = /(^|\s)([-+%&#>])([A-Z]{0,5})\s*$/d; // marcador al final, monto aún no escrito
// Transferencia: segundo bloque = lo que llegó (MONEDA)(monto)(prefijo de la cuenta destino)
const DEST_RE = /^(\s+)([A-Z]{3,5})?(\d[\d.,]*)(?:([A-Z][a-z]?|[^\s\d.,A-Za-z*])(?=\s|$))?/d;
const DEST_PARTIAL_RE = /^(\s+)([A-Z]{0,5})\s*$/;
const BUDGET_RE = /(^|\s)\*([^\s*]+)/d;                // presupuesto: *comida
const TAG_RE = /(^|\s)@([^\s@\d][^\s@]*)/d;          // formato antiguo: @Cuenta
const DAY_RE = /(^|\s)@(\d{1,2})(?=\s|$)/d;            // gastos fijos: @15 = se cobra el día 15
const MODE_RE = /(^|\s)(au|ma)(?=\s|$)/id;             // gastos fijos: Au = automático, Ma = manual
// Para comparar nombres: sin mayúsculas, tildes, puntuación ni espacios de más
const matchKey = (s) => norm(s).replace(/[.,;:!¡?¿"'()]/g, ' ').replace(/\s+/g, ' ').trim();

/* ---------------------------------------------------------
   Utilidades
   --------------------------------------------------------- */
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const clone = (o) => JSON.parse(JSON.stringify(o));
const pad = (n) => String(n).padStart(2, '0');
const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
const keyToDate = (k) => { const [y, m] = k.split('-').map(Number); return new Date(y, m - 1, 1); };
const nextMonthKey = (k) => { const d = keyToDate(k); d.setMonth(d.getMonth() + 1); return monthKey(d); };
const daysInMonth = (k) => { const d = keyToDate(k); return new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate(); };
const norm = (s) => String(s).toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim();
const escapeHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const slugOf = (name) => name.normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/[^A-Za-z0-9_-]/g, '') || 'Cuenta';

function monthName(k) {
  const d = keyToDate(k);
  const m = d.toLocaleDateString('es-PE', { month: 'long' });
  return `${m.charAt(0).toUpperCase()}${m.slice(1)} ${d.getFullYear()}`;
}
function fmtDateTime(ts) {
  if (!ts) return 'sin fecha';
  return new Date(ts).toLocaleString('es-PE', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}
let FIAT = null;
function isFiat(cur) {
  if (!FIAT) FIAT = new Set(Intl.supportedValuesOf ? Intl.supportedValuesOf('currency') : KNOWN_CURRENCIES);
  return FIAT.has(cur);
}
function fmtMoney(n, cur) {
  if (!isFiat(cur)) {
    const a = Math.abs(n);
    const dec = a === 0 ? 2 : a < 1 ? 8 : a < 100 ? 4 : 2;
    return `${cur} ${n.toLocaleString('es-PE', { minimumFractionDigits: 2, maximumFractionDigits: dec })}`;
  }
  try {
    return new Intl.NumberFormat('es-PE', { style: 'currency', currency: cur }).format(n);
  } catch {
    return `${cur} ${n.toFixed(2)}`;
  }
}
function fmtDelta(n, cur) {
  if (Math.abs(n) < 0.005) return '±' + fmtMoney(0, cur);
  return (n > 0 ? '+' : '−') + fmtMoney(Math.abs(n), cur);
}
// Hash sencillo para no guardar el PIN tal cual (no es cifrado fuerte)
function pinHash(pin) {
  let h = 2166136261;
  for (const ch of 'mis-finanzas:' + pin) { h ^= ch.charCodeAt(0); h = Math.imul(h, 16777619); }
  return (h >>> 0).toString(16);
}

/* ---------------------------------------------------------
   Estado
   --------------------------------------------------------- */
function freshState() {
  return {
    version: 3,
    settings: {
      defaultCurrency: 'PEN',
      displayCurrency: 'PEN',
      manualRate: 3.75,
      currencies: ['PEN', 'USD', 'JPY'], // ordenadas por uso reciente
      defaultAccount: '',
      pinHash: null,
      sound: true,
      volume: 0.6,
      anim: true,
    },
    currentKey: monthKey(new Date()),
    months: {},
    fijos: [],
    status: {},
    rates: null,
    accounts: [], // {id, name, prefix, color, currency, initial, startTs, real, note}
    goals: [],    // {id, name, target, currency, pct, date: 'AAAA-MM-DD', achieved}
    projects: [], // {id, name, tag, currency, cushion, end, text (partidas), closed: {partida: true}}
    fijoPaid: {}, // { 'AAAA-MM': { idDelFijo: fecha } } gastos fijos manuales marcados como pagados
    rateHistory: {}, // { 'AAAA-MM-DD': { USD: 1, PEN: 3.7, … } }
  };
}

let state = freshState();

function isCurrencyCode(c) {
  const up = String(c).toUpperCase();
  return KNOWN_CURRENCIES.includes(up) || state.settings.currencies.includes(up);
}
function currencyFromWord(w) {
  if (!w) return null;
  if (isCurrencyCode(w)) return w.toUpperCase();
  return CUR_WORDS[w.toLowerCase()] || null;
}

/* ---------------------------------------------------------
   Lectura de cada párrafo
   --------------------------------------------------------- */
function parseAmount(s) {
  s = s.replace(/[.,]+$/, '');
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot >= 0 && lastComma >= 0) {
    const dec = lastDot > lastComma ? '.' : ',';
    const thou = dec === '.' ? ',' : '.';
    s = s.split(thou).join('').replace(dec, '.');
  } else if (lastDot >= 0 || lastComma >= 0) {
    const sep = lastDot >= 0 ? '.' : ',';
    const parts = s.split(sep);
    s = (parts.length > 2 || parts[parts.length - 1].length === 3) ? parts.join('') : parts.join('.');
  }
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : NaN;
}

/* Encuentra el bloque (tipo)(MONEDA)(monto)(prefijo) y dónde está cada parte */
function matchEntry(text) {
  const m = ENTRY_RE.exec(text);
  if (!m) return null;
  const I = m.indices;
  let code = null, codeRange = null;
  let end = I[0][1];
  if (m[3]) { code = m[3]; codeRange = I[3]; }
  if (m[7]) {
    const c = currencyFromWord(m[7]);
    if (c) { if (!code) { code = c; codeRange = I[7]; } }
    else {
      end = I[7][0];
      while (end > I[5][1] && /\s/.test(text[end - 1])) end--;
    }
  }
  if (!code && m[4]) {
    if (m[4].startsWith('S/')) code = 'PEN';
    else if (m[4] === 'US$') code = 'USD';
    else if (m[4] === '€') code = 'EUR';
    if (code) codeRange = I[4];
  }
  const firstEnd = end;
  let dest = null, destPartial = null;
  if (m[2] === '>') {
    const rest = text.slice(end);
    const dm = DEST_RE.exec(rest);
    if (dm && parseAmount(dm[3]) > 0) {
      const at = (i) => [end + dm.indices[i][0], end + dm.indices[i][1]];
      dest = {
        code: dm[2] || null, codeRange: dm[2] ? at(2) : null,
        amountStr: dm[3].replace(/[.,]+$/, ''), amountRange: at(3),
        prefix: dm[4] || null, prefixRange: dm[4] ? at(4) : null,
      };
      end = end + dm.indices[0][1];
    } else {
      const dp = DEST_PARTIAL_RE.exec(rest);
      if (dp) destPartial = { code: dp[2], range: [end + dp[1].length, end + dp[1].length + dp[2].length] };
    }
  }
  return {
    start: I[2][0], end, firstEnd, dest, destPartial,
    sym: m[2], symRange: I[2],
    code, codeRange,
    amountStr: m[5].replace(/[.,]+$/, ''), amountRange: I[5],
    prefix: m[6] || null, prefixRange: m[6] ? I[6] : null,
  };
}

function parseLine(text, defaultCur) {
  const em = matchEntry(text);
  if (!em) return null;
  const amount = parseAmount(em.amountStr);
  if (!(amount > 0)) return null;

  let rest = text.slice(0, em.start) + ' ' + text.slice(em.end);
  let tag = null;
  const tm = TAG_RE.exec(rest);
  if (tm) {
    tag = tm[2];
    rest = rest.slice(0, tm.index) + tm[1] + rest.slice(tm.index + tm[0].length);
  }
  let budget = null;
  const bm = BUDGET_RE.exec(rest);
  if (bm) {
    budget = bm[2].toLowerCase();
    rest = rest.slice(0, bm.index) + bm[1] + rest.slice(bm.index + bm[0].length);
  }
  let day = null;
  const dm = DAY_RE.exec(rest);
  if (dm) {
    const d = Number(dm[2]);
    if (d >= 1 && d <= 31) day = d;
    rest = rest.slice(0, dm.index) + dm[1] + rest.slice(dm.index + dm[0].length);
  }
  const name = rest.replace(/\s+/g, ' ').trim().replace(/^[\s:\-–—,.]+|[\s:\-–—,]+$/g, '');
  const currency = em.code || defaultCur;
  const dest = em.dest ? { amount: parseAmount(em.dest.amountStr), currency: em.dest.code || currency, prefix: em.dest.prefix } : null;
  return {
    type: TYPES[em.sym].key, amount, currency,
    name: name || '(sin nombre)', prefix: em.prefix, tag, dest, day, budget,
  };
}

/* En qué paso va el párrafo (decide qué botones mostrar) */
function lineState(t) {
  const em = matchEntry(t);
  if (em && parseAmount(em.amountStr) > 0) {
    if (!em.code) return { s: 'currency', em };
    if (em.sym === '>') {
      if (!em.prefix) return { s: 'account', em };            // sale de…
      if (em.dest) {
        if (!em.dest.code) return { s: 'destCurrency', em };
        if (!em.dest.prefix) return { s: 'destAccount', em }; // llega a…
        return { s: 'done', em };
      }
      if (em.destPartial && isCurrencyCode(em.destPartial.code)) return { s: 'destAmount', em };
      return { s: 'destCurrency', em };                       // ¿cuánto llegó?
    }
    if (em.prefix || TAG_RE.test(t)) return { s: 'done', em };
    return { s: 'account', em };
  }
  const pm = PARTIAL_RE.exec(t);
  if (pm) return { s: pm[3] && isCurrencyCode(pm[3]) ? 'amount' : 'currency', pm };
  return { s: 'type' };
}

/* Mantiene el id y la fecha de cada párrafo aunque lo edites */
function syncLines(old, texts) {
  const res = new Array(texts.length).fill(null);
  const used = new Array(old.length).fill(false);
  const byText = new Map();
  old.forEach((l, i) => {
    if (!byText.has(l.text)) byText.set(l.text, []);
    byText.get(l.text).push(i);
  });
  texts.forEach((t, j) => {
    const arr = byText.get(t);
    if (arr && arr.length) {
      const i = arr.shift();
      used[i] = true;
      res[j] = { ...old[i], _oi: i };
    }
  });
  for (let j = 0; j < texts.length; j++) {
    if (res[j]) continue;
    let lo = -1, hi = old.length;
    for (let k = j - 1; k >= 0; k--) if (res[k] && res[k]._oi != null) { lo = res[k]._oi; break; }
    for (let k = j + 1; k < texts.length; k++) if (res[k] && res[k]._oi != null) { hi = res[k]._oi; break; }
    let pick = -1;
    for (let i = lo + 1; i < hi; i++) if (!used[i]) { pick = i; break; }
    if (pick >= 0) {
      used[pick] = true;
      res[j] = { id: old[pick].id, ts: old[pick].ts, text: texts[j], _oi: pick };
    } else {
      res[j] = { id: uid(), ts: null, text: texts[j], _oi: null };
    }
  }
  return res.map(({ _oi, ...r }) => r);
}

function stampLines(lines, defaultCur, stamp = Date.now()) {
  const now = stamp;
  for (const l of lines) if (!l.ts && parseLine(l.text, defaultCur)) l.ts = now;
  return lines;
}

/* ---------- Cuentas ---------- */
const accountById = (id) => state.accounts.find((a) => a.id === id) || null;
const accountByPrefix = (p) => p ? state.accounts.find((a) => a.prefix === p) || state.accounts.find((a) => a.prefix && a.prefix.toLowerCase() === p.toLowerCase()) || null : null;
function accountByTag(tag) {
  const t = norm(tag);
  return state.accounts.find((a) => norm(slugOf(a.name)) === t) || null;
}
function resolveAccount(p) {
  if (p.prefix) { const a = accountByPrefix(p.prefix); return a ? a.id : 'unknown'; }
  if (p.tag) { const a = accountByTag(p.tag); return a ? a.id : 'unknown'; }
  return state.settings.defaultAccount || null;
}
// Prefijo de cuenta: una mayúscula + una minúscula opcional (B, Bc) o un símbolo (€, ☆…)
function validPrefix(p) {
  return typeof p === 'string' && /^([A-Z][a-z]?|[^\s\d.,A-Za-z*\-+%&#@>])$/.test(p);
}
function freePrefixFor(name, exceptId) {
  const taken = (p) => state.accounts.some((a) => a.id !== exceptId && a.prefix && a.prefix === p);
  const letters = slugOf(name).replace(/[^A-Za-z]/g, '');
  const up = letters.charAt(0).toUpperCase();
  const candidates = [];
  if (up) {
    candidates.push(up);
    for (const ch of letters.slice(1).toLowerCase()) candidates.push(up + ch);
  }
  for (const ch of 'ABCDEFGHIJKLMNOPQRSTUVWXYZ') candidates.push(ch);
  return candidates.find((c) => validPrefix(c) && !taken(c)) || '';
}

function entriesFromLines(lines, defaultCur, extra = {}) {
  const out = [];
  for (const l of lines) {
    const p = parseLine(l.text, defaultCur);
    if (!p) continue;
    let destAccountId = null;
    if (p.dest && p.dest.prefix) { const a = accountByPrefix(p.dest.prefix); destAccountId = a ? a.id : 'unknown'; }
    out.push({ ...p, id: l.id, ts: l.ts, raw: l.text, accountId: resolveAccount(p), destAccountId, ...extra });
  }
  return out;
}

/* ---------------------------------------------------------
   Guardado
   --------------------------------------------------------- */
function ensureMonth(k) {
  if (!state.months[k]) state.months[k] = { lines: [], closed: false, fijos: null, rates: null, defaultCur: null };
  return state.months[k];
}

function adopt(s) {
  const f = freshState();
  state = { ...f, ...s, settings: { ...f.settings, ...(s.settings || {}) } };
  if (!Array.isArray(state.accounts)) state.accounts = [];
  if (!Array.isArray(state.goals)) state.goals = [];
  if (!Array.isArray(state.projects)) state.projects = [];
  for (const p of state.projects) {
    if (!p.startDate) p.startDate = isoDate(new Date(p.startTs || Date.now()));
    if (!p.planMode) p.planMode = p.end ? 'fecha' : 'duracion';
  }
  // presupuestos de la versión anterior → proyectos
  if (Array.isArray(state.budgets)) {
    for (const b of state.budgets) {
      if (b.kind !== 'proyecto' || state.projects.some((p) => p.tag === b.tag)) continue; // los mensuales (comida, etc.) ya no se usan
      const lines = (b.items || []).map((i) => `${i.name} ${i.est || ''}${b.currency}`.trim());
      state.projects.push({ id: b.id, name: b.name, tag: b.tag, currency: b.currency, cushion: 10, end: b.end || null,
        text: lines.length ? lines.join('\n') : `${b.name} ${b.amount}${b.currency}`, closed: {} });
    }
    delete state.budgets;
  }
  if (!state.fijoPaid || typeof state.fijoPaid !== 'object') state.fijoPaid = {};
  if (!state.rateHistory || typeof state.rateHistory !== 'object') state.rateHistory = {};
  if (!Array.isArray(state.settings.currencies) || !state.settings.currencies.length) state.settings.currencies = f.settings.currencies.slice();
  // Cuentas antiguas sin prefijo: se les asigna uno
  for (const a of state.accounts) {
    if (/^[a-z]$/.test(a.prefix || '')) a.prefix = a.prefix.toUpperCase();
    if (!validPrefix(a.prefix)) a.prefix = freePrefixFor(a.name, a.id);
    if (a.note === undefined) a.note = '';
  }
  ensureMonth(state.currentKey);
}

function load() {
  try {
    const raw = typeof localStorage !== 'undefined' && localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const s = JSON.parse(raw);
      if (s && s.months && s.settings) { adopt(s); return; }
    }
  } catch (e) {
    console.warn('No se pudo leer lo guardado', e);
  }
  ensureMonth(state.currentKey);
}

let saveTimer = null;
function save() {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(state)); } catch (e) { console.warn(e); }
}
function saveSoon() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 250);
}

function checkRollover(now = new Date()) {
  const k = monthKey(now);
  if (state.currentKey === k) return false;
  const old = state.months[state.currentKey];
  if (old) {
    old.closed = true;
    old.fijos = clone(state.fijos);
    old.defaultCur = state.settings.defaultCurrency;
    if (!old.rates && state.rates) old.rates = state.rates.rates;
  }
  state.currentKey = k;
  ensureMonth(k);
  save();
  return true;
}

const defCurOf = (k) => (state.months[k] && state.months[k].defaultCur) || state.settings.defaultCurrency;
const fijosOf = (k) => { const m = state.months[k]; return (m && m.closed && m.fijos) ? m.fijos : state.fijos; };
const sortedKeys = () => Object.keys(state.months).sort();
const prevKeyOf = (k) => { const ks = sortedKeys().filter((x) => x < k); return ks.length ? ks[ks.length - 1] : null; };

function monthEntries(k) {
  const m = state.months[k];
  return m ? entriesFromLines(m.lines, defCurOf(k), { monthKey: k }) : [];
}
function allEntries() {
  return sortedKeys().flatMap(monthEntries);
}
function fijosEntries(k = state.currentKey) {
  return entriesFromLines(fijosOf(k), defCurOf(k), { fijo: true }).map((e) => {
    const mm = MODE_RE.exec(e.name);
    e.mode = mm && mm[2].toLowerCase() === 'ma' ? 'ma' : 'au';
    if (mm) e.name = (e.name.slice(0, mm.index) + mm[1] + e.name.slice(mm.index + mm[0].length)).replace(/\s+/g, ' ').trim() || '(sin nombre)';
    return e;
  }).concat(projectFijos(k)); // partidas mensuales de proyectos activos
}
/* Estado de un fijo manual en un mes: pagado a mano, o pagado porque en el Mes hay un gasto con el mismo nombre */
function fijoStatus(e, k = state.currentKey) {
  if (e.mode !== 'ma') return { auto: true, paid: true };
  const key = matchKey(e.name);
  const byLine = monthEntries(k).find((x) => x.type === (e.type || 'gasto') && matchKey(x.name) === key) || null;
  const mark = (state.fijoPaid[k] && state.fijoPaid[k][e.id]) || null;
  return { auto: false, paid: !!(byLine || mark), byLine, mark };
}
// ¿Este fijo se cuenta como gasto del mes? (si se pagó escribiéndolo en el Mes, ya cuenta ese párrafo)
function fijoCounts(e, k) {
  if (e.mode !== 'ma') return true;
  const st = fijoStatus(e, k);
  return !!st.mark && !st.byLine;
}

/* Cambia el prefijo de una cuenta en todo lo escrito */
function rewriteInAllLines(fn) {
  const all = [state.fijos];
  for (const m of Object.values(state.months)) { all.push(m.lines); if (m.fijos) all.push(m.fijos); }
  for (const lines of all) for (const l of lines) l.text = fn(l.text);
}
function changePrefixInText(oldP, newP) {
  rewriteInAllLines((t) => {
    const em = matchEntry(t);
    if (!em || !em.prefix || em.prefix.toLowerCase() !== oldP.toLowerCase()) return t;
    return t.slice(0, em.prefixRange[0]) + newP + t.slice(em.prefixRange[1]);
  });
}
/* Tu dinero total en el tiempo: diario si llevas poco tiempo, mensual si llevas varios meses */
function renderBankChart() {
  const box = $('bankChart');
  if (!state.accounts.length) { box.innerHTML = ''; return; }
  const disp = state.settings.displayCurrency;
  const rates = ratesFor(state.currentKey);
  const first = Math.min(...state.accounts.map((a) => a.startTs || Date.now()));
  const now = Date.now();
  const spanDays = (now - first) / 86400000;
  const cutoffs = [];
  if (spanDays <= 62) {
    const d = new Date(first); d.setHours(23, 59, 59, 999);
    for (; d.getTime() < now; d.setDate(d.getDate() + 1)) cutoffs.push(d.getTime());
  } else {
    const d = keyToDate(monthKey(new Date(first)));
    for (; d.getTime() < now; d.setMonth(d.getMonth() + 1)) cutoffs.push(new Date(d.getFullYear(), d.getMonth() + 1, 0, 23, 59, 59).getTime());
  }
  cutoffs.push(now);
  const pts = [...new Set(cutoffs)].filter((t) => t <= now).map((t) => ({
    t,
    v: state.accounts.filter((a) => a.startTs <= t).reduce((s, a) => s + convert(accountBalance(a, t).bal, a.currency, disp, rates), 0),
  }));
  if (pts.length < 2) {
    box.innerHTML = `<div class="pace"><div class="sub">📈 Tu dinero en el tiempo</div><div class="sub">El gráfico aparecerá cuando tengas más de un día de movimientos.</div></div>`;
    return;
  }
  const W = 320, H = 110, P = 6;
  const vs = pts.map((p) => p.v);
  let min = Math.min(...vs), max = Math.max(...vs);
  if (max - min < Math.max(1, Math.abs(max)) * 1e-6) { min -= 1; max += 1; }
  const x = (i) => P + (i / (pts.length - 1)) * (W - 2 * P);
  const y = (v) => H - P - ((v - min) / (max - min)) * (H - 2 * P);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const delta = pts[pts.length - 1].v - pts[0].v;
  const color = delta >= 0 ? '#2ed578' : '#ff5c70';
  const fmtD = (t) => new Date(t).toLocaleDateString('es-PE', { day: 'numeric', month: 'short' });
  box.innerHTML = `<div class="pace">
    <div class="sub">📈 Tu dinero en el tiempo</div>
    <div class="big delta ${delta >= 0 ? 'good' : 'bad'}">${fmtDelta(delta, disp)}</div>
    <div class="sub">desde ${fmtD(pts[0].t)} · máx ${fmtMoney(Math.max(...vs), disp)} · mín ${fmtMoney(Math.min(...vs), disp)}</div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Dinero total en el tiempo">
      <path d="${line} L${x(pts.length - 1)},${H} L${x(0)},${H} Z" fill="${color}" opacity="0.12"/>
      <path d="${line}" fill="none" stroke="${color}" stroke-width="2.4" stroke-linejoin="round"/>
      <circle cx="${x(pts.length - 1)}" cy="${y(pts[pts.length - 1].v)}" r="3.5" fill="${color}"/>
    </svg>
    <div class="fx-axis"><span>${fmtD(pts[0].t)}</span><span>hoy</span></div>
  </div>`;
}

function renameAccountTags(oldSlug, newSlug) {
  if (oldSlug === newSlug) return;
  const re = new RegExp(`(^|\\s)@${escapeRe(oldSlug)}(?=\\s|$)`, 'gi');
  rewriteInAllLines((t) => t.replace(re, `$1@${newSlug}`));
}

/* ---------------------------------------------------------
   Monedas
   --------------------------------------------------------- */
function ratesFor(k) {
  const base = { USD: 1, PEN: Number(state.settings.manualRate) || 3.75 };
  const m = state.months[k];
  const live = (m && m.rates) || (state.rates && state.rates.rates) || {};
  return { ...base, ...live };
}
function convert(amount, from, to, rates) {
  if (from === to) return amount;
  const rf = rates[from], rt = rates[to];
  if (!rf || !rt) return amount;
  return (amount / rf) * rt;
}
function bumpCurrency(code) {
  const list = state.settings.currencies.filter((c) => c !== code);
  list.unshift(code);
  state.settings.currencies = list;
}
function missingRates() {
  const rates = ratesFor(state.currentKey);
  const used = new Set([state.settings.displayCurrency]);
  monthEntries(state.currentKey).concat(fijosEntries()).forEach((e) => used.add(e.currency));
  state.accounts.forEach((a) => used.add(a.currency));
  return [...used].filter((c) => !rates[c]);
}

async function fetchRates(force = false) {
  const fresh = state.rates && Date.now() - state.rates.fetched < RATES_MAX_AGE;
  if (fresh && !force) return;
  try {
    let rates = null;
    for (const url of HIST_URLS('latest')) {
      try {
        const r = await fetchT(url);
        if (!r.ok) continue;
        const j = await r.json();
        if (j && j.usd) {
          rates = { USD: 1 };
          for (const [k, v] of Object.entries(j.usd)) if (v) rates[k.toUpperCase()] = v;
          break;
        }
      } catch { /* siguiente */ }
    }
    if (!rates) {
      const r = await fetch(RATES_URL);
      const j = await r.json();
      if (j.result !== 'success' || !j.rates) throw new Error('respuesta inválida');
      rates = j.rates;
    }
    state.rates = { rates, fetched: Date.now() };
    ensureMonth(state.currentKey).rates = rates;
    recordTodayRates();
    save();
    renderAll();
    if (force) toast('Tasas actualizadas');
  } catch (e) {
    if (force) toast('Sin conexión: se usa la tasa manual');
    renderRateStatus();
  }
}

/* ---------------------------------------------------------
   Cálculos
   --------------------------------------------------------- */
// Comisión de una transferencia = lo que salió − lo que llegó (a la tasa del día)
function transferFee(e, cur, rates) {
  if (!e.dest) return 0;
  return convert(e.amount, e.currency, cur, rates) - convert(e.dest.amount, e.dest.currency, cur, rates);
}
// Comisión de plataforma de un encargo = monto del encargo − lo que llegó
function encargoFee(e, st, cur, rates) {
  if (!st || !st.done || st.received == null) return 0;
  return convert(e.amount, e.currency, cur, rates) - convert(st.received, st.recvCur || e.currency, cur, rates);
}
function monthSummary(k, uptoDay = null) {
  const disp = state.settings.displayCurrency;
  const rates = ratesFor(k);
  const conv = (e) => convert(e.amount, e.currency, disp, rates);
  const inRange = (ts) => {
    if (!ts) return !uptoDay;
    return !uptoDay || new Date(ts).getDate() <= uptoDay;
  };
  const s = { ingresos: 0, gastos: 0, deudasPagadas: 0, cobrados: 0, encargosCumplidos: 0, fijosG: 0, fijosI: 0, comisiones: 0 };

  for (const e of monthEntries(k)) {
    if (!inRange(e.ts)) continue;
    if (e.type === 'ingreso') s.ingresos += conv(e);
    else if (e.type === 'gasto') s.gastos += conv(e);
    else if (e.type === 'transfer') s.comisiones += transferFee(e, disp, rates);
  }
  for (const e of allEntries()) {
    const st = state.status[e.id];
    if (!st || !st.done || !st.ts) continue;
    if (monthKey(new Date(st.ts)) !== k || !inRange(st.ts)) continue;
    if (e.type === 'deuda') s.deudasPagadas += conv(e);
    else if (e.type === 'medeben') s.cobrados += conv(e);
    else if (e.type === 'encargo') { s.encargosCumplidos += conv(e); s.comisiones += encargoFee(e, st, disp, rates); }
  }
  for (const e of fijosEntries(k)) {
    if (!fijoCounts(e, k)) continue;
    if (e.type === 'gasto') s.fijosG += conv(e);
    else if (e.type === 'ingreso') s.fijosI += conv(e);
  }
  s.totalIn = s.ingresos + s.fijosI + s.cobrados + s.encargosCumplidos;
  s.totalOut = s.gastos + s.fijosG + s.deudasPagadas + s.comisiones;
  s.balance = s.totalIn - s.totalOut;
  return s;
}

function dailyCumulative(k) {
  const disp = state.settings.displayCurrency;
  const rates = ratesFor(k);
  const n = daysInMonth(k);
  const perDay = new Array(n + 1).fill(0);
  for (const e of monthEntries(k)) {
    if (e.type === 'gasto' && e.ts) perDay[new Date(e.ts).getDate()] += convert(e.amount, e.currency, disp, rates);
    if (e.type === 'transfer' && e.ts) perDay[new Date(e.ts).getDate()] += transferFee(e, disp, rates);
  }
  for (const e of allEntries()) {
    const st = state.status[e.id];
    if (e.type === 'deuda' && st && st.done && st.ts && monthKey(new Date(st.ts)) === k) {
      perDay[new Date(st.ts).getDate()] += convert(e.amount, e.currency, disp, rates);
    }
  }
  const cum = [0];
  for (let d = 1; d <= n; d++) cum[d] = cum[d - 1] + perDay[d];
  return cum;
}

// cutoff: calcular el saldo que tenía en esa fecha (para el gráfico de Bancos)
function accountBalance(acc, cutoff = Infinity) {
  let bal = Number(acc.initial) || 0;
  let count = 0;
  const add = (e, sign, k) => { bal += sign * convert(e.amount, e.currency, acc.currency, ratesFor(k)); count++; };
  for (const e of allEntries()) {
    const after = e.ts && e.ts >= acc.startTs && e.ts <= cutoff;
    if (e.type === 'transfer') {
      if (e.accountId === acc.id && after) add(e, -1, e.monthKey);
      if (e.dest && e.destAccountId === acc.id && after) {
        bal += convert(e.dest.amount, e.dest.currency, acc.currency, ratesFor(e.monthKey)); count++;
      }
      continue;
    }
    if (e.accountId !== acc.id) continue;
    if ((e.type === 'gasto' || e.type === 'ingreso') && after) add(e, e.type === 'gasto' ? -1 : 1, e.monthKey);
    const st = state.status[e.id];
    if (!(st && st.done && st.ts && st.ts >= acc.startTs && st.ts <= cutoff)) continue;
    if (e.type === 'deuda' || e.type === 'medeben') add(e, e.type === 'deuda' ? -1 : 1, monthKey(new Date(st.ts)));
    if (e.type === 'encargo') {
      const k = monthKey(new Date(st.ts));
      bal += convert(st.received != null ? st.received : e.amount, st.recvCur || e.currency, acc.currency, ratesFor(k)); count++;
    }
  }
  // Fijos automáticos: desde el mes siguiente a crear la cuenta. Manuales: cuando los marcas pagados.
  const startKey = monthKey(new Date(acc.startTs));
  let k = startKey;
  const lastKey = cutoff === Infinity ? state.currentKey : monthKey(new Date(cutoff));
  while (k <= lastKey) {
    for (const e of fijosEntries(k)) {
      if (e.accountId !== acc.id) continue;
      const sign = e.type === 'gasto' ? -1 : 1;
      if (e.mode === 'ma') {
        const st = fijoStatus(e, k);
        if (st.mark && !st.byLine && st.mark >= acc.startTs && st.mark <= cutoff) add(e, sign, k);
      } else if (k > startKey) add(e, sign, k);
    }
    k = nextMonthKey(k);
  }
  return { bal, count };
}

/* =========================================================
   Interfaz
   ========================================================= */
const $ = (id) => document.getElementById(id);
let selectedHistKey = null;
let compareMode = 'sameDay';
let compareTarget = 'prev'; // 'prev' | 'year' | 'pb'
let newAccColor = COLOR_PRESETS[5];
let bankUnlocked = false;

const currentView = () => (document.querySelector('.view.active') || { id: 'view-mes' }).id.replace('view-', '');

/* ---------- Colores dentro del texto ----------
   tipo + monto con efecto resaltador · MONEDA en negrita · cuenta en negrita y subrayada.
   La "negrita" se simula con un trazo para no cambiar el ancho de las letras. */
function renderSeg(text, from, to, list) {
  let out = '', pos = from;
  for (const r of list.slice().sort((a, b) => a.s - b.s)) {
    if (r.s < pos || r.e > to) continue;
    out += escapeHtml(text.slice(pos, r.s));
    const inner = r.kids && r.kids.length ? renderSeg(text, r.s, r.e, r.kids) : escapeHtml(text.slice(r.s, r.e));
    out += `<span class="${r.cls}"${r.style ? ` style="${r.style}"` : ''}>${inner}</span>`;
    pos = r.e;
  }
  return out + escapeHtml(text.slice(pos, to));
}

function highlightLine(text, fijo = false) {
  const marks = []; // {s, e, cls, style, kids}
  const preMark = (range, prefix) => {
    const a = accountByPrefix(prefix);
    marks.push({ s: range[0], e: range[1], cls: a ? 'hl-pre' : 'hl-pre unknown', style: a ? `color:${a.color}` : '' });
  };
  const em = matchEntry(text);
  if (em) {
    const type = TYPES[em.sym].key;
    // tipo y monto resaltados; la moneda queda sin resaltar y con su propio color
    marks.push({ s: em.symRange[0], e: em.symRange[1], cls: `hl-num t-${type}` });
    if (em.codeRange) marks.push({ s: em.codeRange[0], e: em.codeRange[1], cls: 'hl-cur' });
    marks.push({ s: em.amountRange[0], e: em.amountRange[1], cls: `hl-num t-${type}` });
    if (em.prefixRange) preMark(em.prefixRange, em.prefix);
    if (em.dest) {
      if (em.dest.codeRange) marks.push({ s: em.dest.codeRange[0], e: em.dest.codeRange[1], cls: 'hl-cur' });
      marks.push({ s: em.dest.amountRange[0], e: em.dest.amountRange[1], cls: 'hl-num t-transfer' });
      if (em.dest.prefixRange) preMark(em.dest.prefixRange, em.dest.prefix);
    } else if (em.destPartial && em.destPartial.code) {
      marks.push({ s: em.destPartial.range[0], e: em.destPartial.range[1], cls: 'hl-cur' });
    }
  } else {
    const pm = PARTIAL_RE.exec(text);
    if (pm) {
      marks.push({ s: pm.indices[2][0], e: pm.indices[2][1], cls: `hl-num t-${TYPES[pm[2]].key}` });
      if (pm[3]) marks.push({ s: pm.indices[3][0], e: pm.indices[3][1], cls: 'hl-cur' });
    }
  }
  const bdm = BUDGET_RE.exec(text);
  if (bdm) {
    const b = projectByTag(bdm[2]);
    marks.push({ s: bdm.indices[0][0] + bdm[1].length, e: bdm.indices[0][1], cls: b ? 'hl-budget' : 'hl-budget unknown' });
  }
  const dym = DAY_RE.exec(text);
  if (dym) marks.push({ s: dym.indices[0][0] + dym[1].length, e: dym.indices[0][1], cls: 'hl-day' });
  if (fijo) {
    const mo = MODE_RE.exec(text);
    if (mo) marks.push({ s: mo.indices[2][0], e: mo.indices[2][1], cls: 'hl-mode' });
  }
  const tm = TAG_RE.exec(text);
  if (tm) {
    const a = accountByTag(tm[2]);
    marks.push({ s: tm.indices[0][0] + tm[1].length, e: tm.indices[0][1], cls: 'hl-pre', style: a ? `color:${a.color}` : '' });
  }
  return renderSeg(text, 0, text.length, marks);
}

/* Monto del párrafo en la moneda que estás viendo (columna izquierda del cuaderno) */
// Símbolo corto para los botones (S/, $, ¥, €, ₿…); null si la moneda no tiene uno
const CRYPTO_SYM = { BTC: '₿', ETH: 'Ξ', USDT: '₮', USDC: '◎', LTC: 'Ł', DOGE: 'Ð', XRP: '✕', SOL: '◎' };
function shortSym(cur) {
  if (CRYPTO_SYM[cur]) return CRYPTO_SYM[cur];
  if (!isFiat(cur)) return null;
  try {
    const part = new Intl.NumberFormat('es-PE', { style: 'currency', currency: cur, currencyDisplay: 'narrowSymbol' }).formatToParts(1).find((x) => x.type === 'currency');
    return part && part.value !== cur ? part.value : null;
  } catch { return null; }
}
function curSymbol(cur) {
  if (!isFiat(cur)) return cur + ' ';
  try {
    const part = new Intl.NumberFormat('es-PE', { style: 'currency', currency: cur }).formatToParts(1).find((x) => x.type === 'currency');
    return part ? part.value + ' ' : cur + ' ';
  } catch { return cur + ' '; }
}
// 42,800 → "S/ 42.8K" · 1,250,000 → "S/ 1.3M" (los montos chicos se muestran completos)
function fmtCompact(v, cur) {
  const a = Math.abs(v);
  if (a < 10000) return fmtMoney(v, cur);
  const [n, suf] = a >= 1e9 ? [a / 1e9, 'B'] : a >= 1e6 ? [a / 1e6, 'M'] : [a / 1e3, 'K'];
  const txt = n >= 100 ? Math.round(n).toString() : (Math.round(n * 10) / 10).toString();
  return `${v < 0 ? '-' : ''}${curSymbol(cur)}${txt}${suf}`;
}
function lineAmountHTML(t, defCur) {
  const p = parseLine(t, defCur);
  if (!p) return '';
  const disp = state.settings.displayCurrency;
  const v = convert(p.amount, p.currency, disp, ratesFor(state.currentKey));
  const sign = { gasto: '−', ingreso: '+', deuda: '−', medeben: '+', encargo: '', transfer: '⇄ ' }[p.type];
  return `<span class="ln-amt t-${p.type}" title="${fmtMoney(v, disp)}">${sign}${fmtCompact(v, disp)}</span>`;
}

function renderHighlight(ta) {
  const fijo = ta.id === 'editorFijos';
  const back = fijo ? $('hlFijos') : $('hlMes');
  const defCur = fijo ? state.settings.defaultCurrency : defCurOf(editorKey());
  let n = 0;
  back.innerHTML = ta.value.split('\n').map((t) => {
    if (!t.trim()) return `<div class="ln empty">${t ? escapeHtml(t) : '<br>'}</div>`;
    n++;
    const side = `<span class="ln-num l">${n}</span><span class="ln-num r">${n}</span>${lineAmountHTML(t, defCur)}`;
    return `<div class="ln">${side}${highlightLine(t, fijo)}</div>`;
  }).join('');
  autoGrow(ta);
}
function autoGrow(ta) {
  ta.style.height = 'auto';
  ta.style.height = ta.scrollHeight + 2 + 'px';
}

/* ---------- Encabezado ---------- */
function renderHeader() {
  const k = state.currentKey;
  const disp = state.settings.displayCurrency;
  const s = monthSummary(k);
  const missing = missingRates();
  $('monthTitle').innerHTML = `${monthName(editorKey())} <span class="cal-caret">${calendarOpen ? '▴' : '▾'}</span>`;
  $('summary').innerHTML = `
    <span class="chip">Ingresos <b class="t-ingreso">${fmtMoney(s.totalIn, disp)}</b></span>
    <span class="chip">Gastos <b class="t-gasto">${fmtMoney(s.totalOut, disp)}</b></span>
    <span class="chip">Balance <b class="${s.balance >= 0 ? 't-ingreso' : 't-gasto'}">${fmtMoney(s.balance, disp)}</b></span>`
    + (missing.length ? `<span class="chip warn">⚠ Falta la tasa de ${missing.join(', ')}: conéctate a internet</span>` : '');
  // Conversor: cambia en qué moneda se ven los totales (lo escrito no cambia)
  $('curSwitch').innerHTML = `<span>Ver en</span>` + state.settings.currencies.slice().sort().map((c) => {
    const sym = shortSym(c);
    return `<button data-disp="${c}" class="${c === disp ? 'sel' : ''}"><b>${sym || c}</b><span>${sym ? c : '&nbsp;'}</span></button>`;
  }).join('');
}

/* ---------- Gastos fijos: próximo cobro ---------- */
function nextCharge(day) {
  const t = new Date(); t.setHours(0, 0, 0, 0);
  const at = (y, m) => new Date(y, m, Math.min(day, new Date(y, m + 1, 0).getDate()));
  let d = at(t.getFullYear(), t.getMonth());
  if (d < t) d = at(t.getFullYear(), t.getMonth() + 1);
  return { date: d, days: Math.round((d - t) / 86400000) };
}
function whenText(days) {
  if (days < 0) return `atrasado ${-days} día${days === -1 ? '' : 's'}`;
  return days === 0 ? 'hoy' : days === 1 ? 'mañana' : `en ${days} días`;
}
function fijosList() {
  const today = new Date().getDate();
  return fijosEntries().map((e) => {
    const st = fijoStatus(e);
    let nc = e.day ? nextCharge(e.day) : { date: null, days: 999 };
    // manual sin pagar cuyo día ya pasó este mes → atrasado
    if (e.mode === 'ma' && e.day && !st.paid && e.day < today) nc = { date: new Date(new Date().getFullYear(), new Date().getMonth(), e.day), days: e.day - today };
    // manual ya pagado este mes → el próximo cobro es el del mes que viene
    return { e, st, ...nc };
  }).sort((a, b) => a.days - b.days);
}
function upcomingFijos() {
  return fijosList().filter((x) => x.e.day && !(x.e.mode === 'ma' && x.st.paid));
}

/* ---------- Recordatorios: balance hipotético + meta más próxima ---------- */
function renderReminders() {
  const disp = state.settings.displayCurrency;
  const rates = ratesFor(state.currentKey);
  let html = '';
  if (state.accounts.length) {
    let total = 0;
    const chips = state.accounts.map((a) => {
      const { bal } = accountBalance(a);
      total += convert(bal, a.currency, disp, rates);
      return `<span><i style="background:${a.color}"></i>${escapeHtml(a.name)} ${fmtMoney(bal, a.currency)}</span>`;
    }).join('');
    html += `<button class="rem-card" data-goto="bancos">
      <div class="rem-label">Balance bancario hipotético</div>
      <div class="rem-big ${total < 0 ? 't-gasto' : ''}">${fmtMoney(total, disp)}</div>
      <div class="rem-accs">${chips}</div>
      ${(() => {
        const camino = allEntries().filter((e) => e.type === 'transfer' && !e.dest);
        return camino.length ? `<div class="sub" style="margin-top:6px">🚚 En camino: ${fmtMoney(pendingTotal(camino), disp)} (${camino.length})</div>` : '';
      })()}
    </button>`;
  }
  const alerts = projectAlerts();
  if (alerts.length) {
    html += `<button class="rem-card" data-goto="proyectos">
      <div class="rem-label">🧾 Proyectos</div>
      ${alerts.map(({ p, c }) => `<div class="rem-line"><span>${escapeHtml(p.name)} <b class="t-gasto">${c.spent > c.plan ? 'te pasaste' : 'podría pasarse'}</b></span><span>${fmtMoney(c.spent > c.plan ? c.spent - c.plan : c.fMax - c.plan, p.currency)}</span></div>`).join('')}
    </button>`;
  }
  const soon = upcomingFijos().filter((x) => x.days <= 3);
  if (soon.length) {
    html += `<button class="rem-card" data-goto="compromisos">
      <div class="rem-label">⏰ Próximos cobros</div>
      ${soon.map((x) => `<div class="rem-line"><span>${escapeHtml(x.e.name)} <b class="${x.days < 0 ? 't-gasto' : ''}">${whenText(x.days)}</b>${x.e.mode === 'ma' ? ' <span class="mode-chip ma">pagar a mano</span>' : ''}</span><span class="t-gasto">${fmtMoney(x.e.amount, x.e.currency)}</span></div>`).join('')}
    </button>`;
  }
  const g = nearestGoal();
  if (g) {
    const c = goalCalc(g);
    const big = c.done ? `<div class="rem-big t-ingreso">¡Ya tienes el dinero!</div>`
      : `<div class="rem-big t-accent">${fmtMoney(c.monthly, g.currency)} <span class="sub">al mes</span></div>`;
    html += `<button class="rem-card" data-goto="metas">
      <div class="rem-label">🎯 Meta más próxima · ${escapeHtml(g.name)} ${starsHTML(c)}</div>
      ${big}
      ${progressHTML(c)}
      <div class="sub">${c.label} · tienes ${fmtMoney(c.have, g.currency)} de ${fmtMoney(c.target, g.currency)}</div>
    </button>`;
  }
  $('reminders').innerHTML = html;
}

/* ---------- Proyectos ----------
   Partidas (una por párrafo):
     ArteProyecto 600USD            → se paga de a pocos; cuenta todo gasto con ese nombre o con *proyecto/partida
     Marketing 200-400USD           → rango si no estás seguro
     Claude -PEN70Bc @4 Au          → mensual: funciona como gasto fijo mientras el proyecto esté activo
   Plazo: duración (meses y días) o fecha final. El contador de días sigue hasta marcarlo completado. */
const projectSlug = (name) => slugOf(name).toLowerCase() || 'proyecto';
const itemSlug = (name) => slugOf(name).toLowerCase() || 'partida';
function projectByTag(t) {
  const p = String(t).toLowerCase().split('/')[0];
  return state.projects.find((x) => x.tag === norm(p)) || null;
}
let openPay = null; // "idProyecto:partida" con el formulario de pago abierto

const dayStart = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
function projStart(p) {
  return p.startDate ? new Date(p.startDate + 'T00:00:00') : dayStart(new Date(p.createdTs || Date.now()));
}
function projPlannedEnd(p) {
  const s = projStart(p);
  if (p.planMode === 'fecha') return p.end ? new Date(p.end + 'T23:59:59') : null;
  const m = Number(p.durMonths) || 0, d = Number(p.durDays) || 0;
  if (!m && !d) return null;
  const e = new Date(s);
  e.setMonth(e.getMonth() + m);
  e.setDate(e.getDate() + d);
  e.setHours(23, 59, 59);
  return e;
}
function projDays(p) {
  const s = projStart(p);
  const ref = p.done ? new Date(p.done) : new Date();
  const day = Math.max(1, Math.floor((dayStart(ref) - s) / 86400000) + 1);
  const pe = projPlannedEnd(p);
  const total = pe ? Math.max(1, Math.round((dayStart(pe) - s) / 86400000)) : null;
  return { day, total, plannedEnd: pe };
}
// Fechas de cobro (el día `day` de cada mes) entre a y b
function chargeDates(day, a, b) {
  const out = [];
  const d = new Date(a.getFullYear(), a.getMonth(), 1);
  const from = dayStart(a);
  while (d <= b) {
    const dim = new Date(d.getFullYear(), d.getMonth() + 1, 0).getDate();
    const c = new Date(d.getFullYear(), d.getMonth(), Math.min(day, dim));
    if (c >= from && c <= b) out.push(c);
    d.setMonth(d.getMonth() + 1);
  }
  return out;
}

function parseProjectItems(p) {
  const items = [];
  for (const raw of (p.text || '').split('\n')) {
    const t = raw.trim();
    if (!t) continue;
    // ¿Partida mensual escrita como gasto fijo? (Claude -PEN70Bc @4 Au)
    const pl = /(^|\s)-/.test(t) ? parseLine(t, p.currency) : null;
    if (pl && pl.type === 'gasto') {
      const mm = MODE_RE.exec(pl.name);
      const name = (mm ? pl.name.slice(0, mm.index) + mm[1] + pl.name.slice(mm.index + mm[0].length) : pl.name).replace(/\s+/g, ' ').trim() || '(sin nombre)';
      const slug = itemSlug(name);
      if (items.some((x) => x.slug === slug)) continue;
      items.push({ name, slug, recurring: true, monthly: pl.amount, cur: pl.currency, day: pl.day, prefix: pl.prefix,
        mode: mm && mm[2].toLowerCase() === 'ma' ? 'ma' : 'au' });
      continue;
    }
    const m = /^(.*?)\s*(?:([A-Za-z]{3,5})\s*)?(\d[\d.,]*)(?:\s*[-–]\s*(\d[\d.,]*))?\s*([A-Za-z]{3,5})?\s*$/d.exec(t);
    let name = t, min = null, max = null, cur = p.currency;
    const after = m && m[5] && currencyFromWord(m[5]);
    if (m && !(m[5] && !after)) {
      const before = m[2] && currencyFromWord(m[2]);
      name = before ? m[1] : t.slice(0, m.indices[3][0]);
      min = parseAmount(m[3]);
      max = m[4] ? parseAmount(m[4]) : min;
      if (max < min) [min, max] = [max, min];
      cur = before || after || p.currency;
    }
    name = name.replace(/[:\-–—,]+$/, '').trim() || '(sin nombre)';
    const slug = itemSlug(name);
    if (items.some((x) => x.slug === slug)) continue;
    items.push({ name, slug, recurring: false, min, max, cur });
  }
  return items;
}

/* Partidas mensuales de proyectos activos → se suman a los gastos fijos del mes k */
function projectFijos(k) {
  const out = [];
  const monthEnd = new Date(keyToDate(k).getFullYear(), keyToDate(k).getMonth() + 1, 0, 23, 59, 59);
  for (const p of state.projects || []) {
    const s = projStart(p);
    const limit = p.done ? new Date(Math.min(p.done, monthEnd.getTime())) : monthEnd;
    for (const it of parseProjectItems(p)) {
      if (!it.recurring || (p.closed && p.closed[it.slug])) continue;
      const dates = chargeDates(it.day || s.getDate(), s, limit).filter((d) => monthKey(d) === k);
      if (!dates.length) continue;
      out.push({
        type: 'gasto', amount: it.monthly, currency: it.cur, name: it.name, id: `p:${p.id}:${it.slug}`,
        ts: dates[0].getTime(), raw: '', prefix: it.prefix, tag: null, dest: null, budget: null,
        day: it.day || s.getDate(), mode: it.mode, fijo: true, project: p.name,
        accountId: resolveAccount({ prefix: it.prefix }), destAccountId: null,
      });
    }
  }
  return out;
}

function projectCalc(p) {
  const cur = p.currency;
  const rates = ratesFor(state.currentKey);
  const toP = (v, c, k) => convert(v, c, cur, k ? ratesFor(k) : rates);
  const now = new Date();
  const s = projStart(p);
  const until = p.done ? new Date(p.done) : now;
  const pe = projPlannedEnd(p);
  const horizon = p.done ? new Date(p.done) : (pe && pe > now ? pe : now); // proyección hasta el fin planeado
  const items = parseProjectItems(p).map((it) => ({ ...it, closed: !!(p.closed && p.closed[it.slug]), spent: 0, estMin: 0, estMax: 0 }));
  const oneTime = items.filter((it) => !it.recurring);
  let unassigned = 0;

  // Gastos de partidas únicas: con etiqueta *proyecto/partida, o con el mismo nombre que la partida
  for (const k of sortedKeys()) {
    for (const e of monthEntries(k)) {
      if (e.type !== 'gasto') continue;
      const v = toP(e.amount, e.currency, k);
      if (e.budget) {
        const [pt, sl] = e.budget.split('/');
        if (norm(pt) !== p.tag) continue;
        const it = sl && items.find((x) => x.slug === norm(sl));
        if (it) it.spent += v; else unassigned += v;
        continue;
      }
      if (e.ts && e.ts < s.getTime() - 86400000) continue;
      const it = oneTime.find((x) => matchKey(x.name) === matchKey(e.name));
      if (it) it.spent += v;
    }
  }
  for (const it of items) {
    if (it.recurring) {
      const day = it.day || s.getDate();
      const planned = it.closed ? [] : chargeDates(day, s, horizon);
      it.charges = planned.length;
      it.estMin = it.estMax = planned.length * toP(it.monthly, it.cur);
      // lo ya pagado: automáticos cuentan solos; manuales cuando se marcan o se escriben en el Mes
      // automáticos: cobros cuya fecha ya pasó · manuales: cualquier mes hasta el actual en que ya lo pagaste
      const untilMonthEnd = new Date(until.getFullYear(), until.getMonth() + 1, 0, 23, 59, 59);
      const paidRange = it.mode === 'au' ? chargeDates(day, s, until) : chargeDates(day, s, p.done ? until : untilMonthEnd);
      for (const d of paidRange) {
        const k = monthKey(d);
        if (it.mode === 'au') { it.spent += toP(it.monthly, it.cur, k); it.paidN = (it.paidN || 0) + 1; continue; }
        const st = fijoStatus({ id: `p:${p.id}:${it.slug}`, name: it.name, mode: 'ma' }, k);
        if (st.byLine) { it.spent += toP(st.byLine.amount, st.byLine.currency, k); it.paidN = (it.paidN || 0) + 1; }
        else if (st.mark) { it.spent += toP(it.monthly, it.cur, k); it.paidN = (it.paidN || 0) + 1; }
      }
      it.paidN = it.paidN || 0;
    } else {
      it.estMin = it.min != null ? toP(it.min, it.cur) : 0;
      it.estMax = it.max != null ? toP(it.max, it.cur) : 0;
    }
    it.fMin = it.closed ? it.spent : Math.max(it.spent, it.estMin);
    it.fMax = it.closed ? it.spent : Math.max(it.spent, it.estMax);
    it.diff = it.spent - it.estMax;
  }
  const sum = (f) => items.reduce((a, it) => a + it[f], 0);
  const estMin = sum('estMin'), estMax = sum('estMax');
  const spent = sum('spent') + unassigned;
  const fMin = sum('fMin') + unassigned, fMax = sum('fMax') + unassigned;
  const cushion = Number(p.cushion) || 0;
  const plan = fMax * (1 + cushion / 100); // lo que deberías reservar
  let goal = null;
  if (p.isGoal) {
    goal = goalCalc({ target: Math.max(0, plan - spent), currency: cur, pct: p.goalPct, date: pe ? isoDate(pe) : null, createdTs: s.getTime(),
      achieved: p.done || null, achievedStars: p.doneStars });
  }
  return { items, unassigned, estMin, estMax, spent, fMin, fMax, cushion, plan, goal };
}

function daysHTML(p) {
  const d = projDays(p);
  if (p.done) return `✓ Completado el ${new Date(p.done).toLocaleDateString('es-PE', { day: 'numeric', month: 'short', year: 'numeric' })} · en ${d.day} día${d.day === 1 ? '' : 's'}`;
  if (!d.total) return `📅 Día ${d.day} <span class="sub">(sin plazo)</span>`;
  const left = d.total - d.day;
  return `📅 Día ${d.day} de ${d.total} · ${left >= 0 ? `quedan ${left} día${left === 1 ? '' : 's'}` : `<span class="t-deuda">${-left} día${left === -1 ? '' : 's'} de más</span>`}`;
}

function projectBodyHTML(p, accOpts) {
  const c = projectCalc(p);
  const cur = p.currency;
  const m = (v) => fmtMoney(v, cur);
  const range = (a, b) => (Math.abs(a - b) < 0.005 ? m(a) : `${m(a)} – ${m(b)}`);
  const pct = c.plan > 0 ? (c.spent / c.plan) * 100 : 0;
  const lvl = c.spent > c.plan && c.plan > 0 ? 'over' : pct >= 85 ? 'warn' : 'ok';
  const rows = c.items.map((it) => {
    const key = `${p.id}:${it.slug}`;
    let est;
    if (it.recurring) est = `${fmtMoney(it.monthly, it.cur)}/mes${it.charges ? ` × ${it.charges}` : ''}`;
    else est = it.min == null ? '<span class="sub">sin estimar</span>' : (it.cur !== cur ? `${fmtMoney(it.min, it.cur)}${it.max !== it.min ? '–' + fmtMoney(it.max, it.cur) : ''}` : range(it.estMin, it.estMax));
    const diff = it.recurring || it.min == null || it.spent === 0 ? ''
      : it.diff > 0.005 ? ` <span class="t-gasto">+${m(it.diff)}</span>`
      : it.closed && it.diff < -0.005 ? ` <span class="t-ingreso">−${m(-it.diff)}</span>` : '';
    const progress = !it.recurring && it.estMax > 0
      ? `<div class="mini-bar"><div style="width:${Math.min(100, (it.spent / it.estMax) * 100)}%"></div></div>` : '';
    const form = openPay === key ? `<div class="buy-form">
        <span>Monto</span>
        <input type="number" step="0.01" data-pay="amount" value="">
        <select data-pay="cur">${curOptions(it.cur)}</select>
        <select data-pay="acc">${accOpts}</select>
        <label class="chk-label"><input type="checkbox" data-pay="close"> cerrar partida</label>
        <button class="primary" data-pay-ok="${key}">Anotar gasto</button>
        <button data-pay-cancel="1">Cancelar</button>
      </div>` : '';
    const actions = it.recurring
      ? `<span class="mode-chip ${it.mode}">${it.mode === 'ma' ? 'Manual' : 'Auto'}</span><button data-close-item="${key}" class="small">${it.closed ? 'Reactivar' : 'Cancelar'}</button>`
      : `<button data-pay-open="${key}" class="small">Pagar…</button><button data-close-item="${key}" class="small">${it.closed ? 'Reabrir' : 'Cerrar'}</button>`;
    return `<li class="pitem ${it.closed ? 'closed' : ''}">
      <span class="it-name">${it.closed ? '✓ ' : ''}${escapeHtml(it.name)}${it.recurring ? ' <span class="sub">mensual</span>' : ''}</span>
      <span class="it-est">${est}</span>
      <span class="it-spent">${it.spent ? m(it.spent) : '—'}${diff}${progress}</span>
      <span class="it-actions">${actions}</span>${form}</li>`;
  }).join('');
  let goalHTML = '';
  if (c.goal) {
    const g = c.goal;
    goalHTML = `<div class="proj-goal">
      <div class="rem-label">🎯 Como meta ${starsHTML(g)}</div>
      ${g.done ? `<div class="goal-month t-ingreso">¡Ya tienes el dinero que falta!</div>` : `<div class="goal-month">${fmtMoney(g.monthly, cur)} <span class="sub">al mes</span></div>`}
      ${progressHTML(g)}
      <div class="sub">te falta pagar ${m(Math.max(0, c.plan - c.spent))} · tienes ${m(g.have)} en tus cuentas${g.pctStars < 2 ? ` · para las ★★ del % necesitas ${m(g.ideal)}` : ''}</div>
    </div>`;
  }
  return `<div class="proj-days">${daysHTML(p)}</div>
    <div class="bud-nums">
      <span class="bud-left ${lvl}">Gastado ${m(c.spent)}</span>
      <span class="sub">de ${m(c.plan)} reservados${c.cushion ? ` (proyección + ${c.cushion}% de colchón)` : ''}</span>
    </div>
    <div class="bud-bar ${lvl}"><div style="width:${Math.min(100, pct)}%"></div></div>
    <div class="proj-stats">
      <div><span class="sub">Estimado</span><b>${range(c.estMin, c.estMax)}</b></div>
      <div><span class="sub">Proyección</span><b class="${c.fMax > c.estMax + 0.005 ? 't-gasto' : ''}">${range(c.fMin, c.fMax)}</b></div>
      <div><span class="sub">Te queda</span><b class="${c.plan - c.spent < 0 ? 't-gasto' : ''}">${m(c.plan - c.spent)}</b></div>
    </div>
    ${goalHTML}
    <ul class="pitems">
      ${rows ? `<li class="pitem head"><span class="it-name">Partida</span><span class="it-est">Estimado</span><span class="it-spent">Pagado</span><span class="it-actions"></span></li>${rows}` : ''}
      ${c.unassigned ? `<li class="pitem"><span class="it-name sub">Sin partida</span><span class="it-est"></span><span class="it-spent">${m(c.unassigned)}</span><span class="it-actions"></span></li>` : ''}
    </ul>
    <div class="sub">Un gasto cuenta si en el Mes tiene el mismo nombre que la partida, o si tocas el proyecto en la barra (<b class="hl-budget">*${escapeHtml(p.tag)}/partida</b>). Las mensuales se pagan como gastos fijos (aparecen en Compromisos).</div>`;
}

function renderProjects() {
  const accOpts = `<option value="">Sin cuenta</option>` + state.accounts.map((a) =>
    `<option value="${a.id}" ${a.id === state.settings.defaultAccount ? 'selected' : ''}>${escapeHtml(a.prefix)} · ${escapeHtml(a.name)}</option>`).join('');
  const list = $('projectsList');
  const focused = document.activeElement && document.activeElement.dataset && document.activeElement.dataset.ptext;
  const projects = state.projects.slice().sort((a, b) => (!!a.done - !!b.done));
  list.innerHTML = projects.map((p) => {
    if (p.done) {
      const c = projectCalc(p);
      return `<div class="proj-card compact" data-proj-id="${p.id}">
        <div class="acc-head">
          <span class="goal-title">${escapeHtml(p.name)}</span>
          ${c.goal ? starsHTML(c.goal) : '<span class="stars"><i class="on">✓</i></span>'}
          <button class="icon-btn" data-proj-reopen="${p.id}" title="Reabrir" aria-label="Reabrir proyecto">↺</button>
        </div>
        <div class="sub">${daysHTML(p)} · gastado ${fmtMoney(c.spent, p.currency)}</div>
      </div>`;
    }
    const mode = p.planMode === 'fecha' ? 'fecha' : 'duracion';
    return `<div class="proj-card" data-proj-id="${p.id}">
      <div class="acc-head">
        <input type="text" data-p="name" value="${escapeHtml(p.name)}" class="acc-name goal-name">
        <button data-del-proj="${p.id}" class="icon-btn" aria-label="Eliminar">✕</button>
      </div>
      <div class="proj-body" data-proj-body="${p.id}">${projectBodyHTML(p, accOpts)}</div>
      <div class="proj-label">Partidas (una por párrafo) · a la izquierda, cuánto llevas pagado</div>
      <div class="hl-wrap proj-wrap">
        <div class="hl-backdrop" data-pback="${p.id}" aria-hidden="true"></div>
        <textarea data-ptext="${p.id}" rows="3" spellcheck="false" placeholder="ArteProyecto 600USD&#10;Marketing 200-400USD&#10;Claude -PEN70Bc @4 Au">${escapeHtml(p.text || '')}</textarea>
      </div>
      <div class="row3 proj-edit">
        <label>Inicio <input type="date" data-p="startDate" value="${p.startDate || ''}"></label>
        <label>Plazo
          <select data-p="planMode"><option value="duracion" ${mode === 'duracion' ? 'selected' : ''}>Duración</option><option value="fecha" ${mode === 'fecha' ? 'selected' : ''}>Fecha final</option></select>
        </label>
        ${mode === 'fecha'
          ? `<label>Fecha final <input type="date" data-p="end" value="${p.end || ''}"></label>`
          : `<label>Duración <span class="dur"><input type="number" min="0" data-p="durMonths" value="${p.durMonths || ''}" placeholder="0"> m <input type="number" min="0" data-p="durDays" value="${p.durDays || ''}" placeholder="0"> d</span></label>`}
      </div>
      <div class="row3 proj-edit">
        <label>Moneda <select data-p="currency">${curOptions(p.currency)}</select></label>
        <label>Colchón % <input type="number" min="0" max="200" step="1" data-p="cushion" value="${p.cushion ?? 10}"></label>
        <label class="goal-toggle"><span><input type="checkbox" data-p="isGoal" ${p.isGoal ? 'checked' : ''}> Es una meta</span>
          ${p.isGoal ? `<input type="number" min="1" max="100" data-p="goalPct" value="${p.goalPct || ''}" placeholder="% máx. (opcional)">` : ''}</label>
      </div>
      <button class="small done-btn" data-proj-done="${p.id}">✓ Marcar proyecto completado</button>
    </div>`;
  }).join('') || '<p class="help">Aún no tienes proyectos.</p>';
  for (const p of projects) if (!p.done) renderProjBack(p);
  if (focused) {
    const ta = list.querySelector(`[data-ptext="${focused}"]`);
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }
  $('projCurrency').innerHTML = curOptions($('projCurrency').value || state.settings.defaultCurrency);
}

/* Cuaderno de partidas: número a los lados y lo pagado a la izquierda (×N si es mensual) */
function renderProjBack(p) {
  const back = document.querySelector(`[data-pback="${p.id}"]`);
  const ta = document.querySelector(`[data-ptext="${p.id}"]`);
  if (!back || !ta) return;
  const c = projectCalc(p);
  const bySlug = Object.fromEntries(c.items.map((it) => [it.slug, it]));
  let n = 0;
  back.innerHTML = ta.value.split('\n').map((t) => {
    if (!t.trim()) return `<div class="ln empty">${t ? escapeHtml(t) : '<br>'}</div>`;
    n++;
    const one = parseProjectItems({ ...p, text: t })[0];
    const it = one && bySlug[one.slug];
    let amt = '';
    if (it) {
      const over = !it.recurring && it.estMax > 0 && it.spent > it.estMax + 0.005;
      const cls = it.spent ? (over ? 't-gasto' : 'paid') : 'none';
      const times = it.recurring ? `<i class="times">×${it.paidN || 0}</i> ` : '';
      amt = `<span class="ln-amt ${cls}" title="${fmtMoney(it.spent, p.currency)}">${times}${it.spent ? fmtCompact(it.spent, p.currency) : '—'}</span>`;
    }
    return `<div class="ln"><span class="ln-num l">${n}</span><span class="ln-num r">${n}</span>${amt}${escapeHtml(t)}</div>`;
  }).join('');
  autoGrow(ta);
}

function refreshProjectBody(id) {
  const p = state.projects.find((x) => x.id === id);
  const box = document.querySelector(`[data-proj-body="${id}"]`);
  if (!p || !box) return;
  const accOpts = `<option value="">Sin cuenta</option>` + state.accounts.map((a) =>
    `<option value="${a.id}">${escapeHtml(a.prefix)} · ${escapeHtml(a.name)}</option>`).join('');
  box.innerHTML = projectBodyHTML(p, accOpts);
  renderProjBack(p);
}

/* En Metas: resumen de los proyectos marcados como meta */
function renderProjectGoals() {
  const box = $('projGoalsList');
  const ps = state.projects.filter((p) => p.isGoal);
  box.innerHTML = ps.length ? `<h3 class="sec-title">🧾 Proyectos que son metas</h3>` + ps.map((p) => {
    const c = projectCalc(p);
    const g = c.goal;
    return `<button class="goal-card compact proj-goal-link" data-goto="proyectos">
      <div class="acc-head"><span class="goal-title">${escapeHtml(p.name)}</span>${starsHTML(g)}<span class="sub">ver →</span></div>
      ${progressHTML(g)}
      <div class="sub">${p.done ? 'completado' : g.done ? '¡ya tienes el dinero que falta!' : `${fmtMoney(g.monthly, p.currency)} al mes · ${g.label}`}</div>
    </button>`;
  }).join('') : '';
}

/* Aviso en la ventana principal: proyectos que se pasan de lo reservado */
function projectAlerts() {
  return state.projects.filter((p) => !p.done).map((p) => ({ p, c: projectCalc(p) })).filter((x) => x.c.plan > 0 && x.c.spent > x.c.plan);
}

function renameProjectTags(oldTag, newTag) {
  if (oldTag === newTag) return;
  const re = new RegExp(`(^|\\s)\\*${escapeRe(oldTag)}(?=[\\s/]|$)`, 'gi');
  rewriteInAllLines((t) => t.replace(re, `$1*${newTag}`));
}

/* Pagar una partida: escribe el gasto en el Mes con su etiqueta */
function payItem(key, box) {
  const [pid, slug] = key.split(':');
  const p = state.projects.find((x) => x.id === pid);
  const it = p && parseProjectItems(p).find((x) => x.slug === slug);
  if (!it) return;
  const amount = parseFloat(box.querySelector('[data-pay="amount"]').value);
  if (!(amount > 0)) { toast('Escribe el monto'); return; }
  const cur = box.querySelector('[data-pay="cur"]').value;
  const acc = accountById(box.querySelector('[data-pay="acc"]').value);
  const line = `${it.name} -${cur}${String(+amount.toFixed(2))}${acc ? acc.prefix : ''} *${p.tag}/${it.slug}`;
  const ta = $('editor');
  const v = ta.value.replace(/\s+$/, '');
  ta.value = (v ? v + '\n' : '') + line;
  onEditorInput();
  if (box.querySelector('[data-pay="close"]').checked) { p.closed = p.closed || {}; p.closed[slug] = true; }
  openPay = null;
  save();
  renderAll();
  toast('Gasto anotado en el Mes');
}

/* ---------- Metas ----------
   El progreso se mide con tu dinero total (balance hipotético de todas tus cuentas).
   ★     ya tienes el monto de la meta
   ★★    la meta sería como máximo el doble del % que pusiste (ej. 50% si pusiste 25%)
   ★★★   la meta es como máximo el % que pusiste de tu dinero total (ej. 25%) */
function totalMoney(cur) {
  const rates = ratesFor(state.currentKey);
  return state.accounts.reduce((sum, a) => sum + convert(accountBalance(a).bal, a.currency, cur, rates), 0);
}

/* Estrellas (máximo 5):
   ★      la lograste (ya tienes el monto)
   +★★    si la lograste usando como máximo la mitad del tiempo (+★ si usaste hasta 3/4)
   +★★    si la meta es como máximo el % que pusiste de tu dinero total (+★ si es hasta el doble);
          sin % se usa 25% */
const idTime = (id) => { const t = parseInt(String(id || '').slice(0, -5), 36); return t > 1e12 && t < 4e12 ? t : null; };

function goalCalc(g) {
  const target = Number(g.target) || 0;
  const pct = Number(g.pct) > 0 && Number(g.pct) <= 100 ? Number(g.pct) : null;
  const lim = pct || 25;
  const have = Math.max(0, totalMoney(g.currency));
  const ideal = target / (lim / 100); // dinero total para que la meta sea ≤ lim%
  const created = g.createdTs || idTime(g.id) || Date.now();

  const today = new Date(); today.setHours(0, 0, 0, 0);
  const [y, m, d] = (g.date || '').split('-').map(Number);
  const due = y ? new Date(y, m - 1, d, 23, 59, 59) : null;
  const days = due ? Math.round((new Date(y, m - 1, d) - today) / 86400000) : NaN;

  const reached = !!g.achieved || (target > 0 && have >= target);
  let stars = 0, speedStars = 0, pctStars = 0;
  if (reached) {
    const doneAt = g.achieved || g.reachedTs || Date.now();
    if (due && due.getTime() > created && doneAt <= due.getTime()) { // lograda a tiempo: según cuánto del plazo usaste
      const frac = (doneAt - created) / (due.getTime() - created);
      speedStars = frac <= 0.5 ? 2 : frac <= 0.75 ? 1 : 0;
    }
    const share = have > 0 ? (target / have) * 100 : 100;
    pctStars = share <= lim ? 2 : share <= lim * 2 ? 1 : 0;
    stars = 1 + speedStars + pctStars;
  }
  if (g.achieved && g.achievedStars != null) stars = g.achievedStars; // meta cerrada: se congela

  let months = 1, label;
  const fmtD = (dt) => dt.toLocaleDateString('es-PE', { day: 'numeric', month: 'short', year: 'numeric' });
  if (g.achieved) label = `lograda el ${fmtD(new Date(g.achieved))}`;
  else if (!due) label = 'sin fecha';
  else if (days < 0) label = `venció el ${fmtD(due)}`;
  else {
    months = Math.max(1, (y - today.getFullYear()) * 12 + (m - 1 - today.getMonth()) + (d >= today.getDate() ? 1 : 0));
    label = `${fmtD(due)} · ${days === 0 ? 'es hoy' : `faltan ${months} mes${months === 1 ? '' : 'es'} (${days} días)`}`;
  }
  const monthly = Math.max(0, target - have) / months;
  const monthly3 = Math.max(0, ideal - have) / months;
  const overdue = !!(due && days < 0 && !g.achieved && !reached);
  return { target, pct, lim, have, ideal, stars, speedStars, pctStars, months, monthly, monthly3, label, overdue, done: reached };
}

function starsHTML(c) {
  return `<span class="stars5" title="${c.stars} de 5 estrellas">${[1, 2, 3, 4, 5].map((i) => `<i class="${c.stars >= i ? 'on' : ''}">★</i>`).join('')}</span>`;
}
// Color según el estado: verde lograda · rojo vencida · morado en camino
const goalColor = (c) => (c.done ? '#2ed578' : c.overdue ? '#ff4d5e' : '#e27bff');

function progressHTML(c) {
  const w = c.target > 0 ? Math.min(100, (c.have / c.target) * 100) : 0;
  const size = w > 0 ? (10000 / w).toFixed(1) : 100; // el degradado ocupa toda la barra: se intensifica al avanzar
  return `<div class="progress ${c.done ? 'done' : c.overdue ? 'overdue' : ''}"><div style="width:${c.done ? 100 : w}%;background-size:${c.done ? 100 : size}% 100%"></div></div>`;
}
function haveTotalHTML(c, cur) {
  return `<span class="have-total" style="color:${goalColor(c)}">${fmtMoney(Math.min(c.have, c.done ? c.target : c.have), cur)} <span>/ ${fmtMoney(c.target, cur)}</span></span>`;
}

function nearestGoal() {
  return state.goals
    .filter((g) => !g.achieved && g.date)
    .sort((a, b) => a.date.localeCompare(b.date))[0] || null;
}

function renderMetas() {
  const disp = state.settings.displayCurrency;
  const rates = ratesFor(state.currentKey);
  // anota cuándo alcanzaste el monto (para las estrellas de rapidez)
  let changed = false;
  for (const g of state.goals) {
    if (g.achieved) continue;
    if (!g.createdTs) { g.createdTs = idTime(g.id) || Date.now(); changed = true; }
    const have = totalMoney(g.currency);
    if (have >= (Number(g.target) || Infinity) && !g.reachedTs) { g.reachedTs = Date.now(); changed = true; setTimeout(() => celebrate(`¡Llegaste al monto de "${g.name}"!`), 300); }
    if (have < (Number(g.target) || 0) && g.reachedTs) { g.reachedTs = null; changed = true; }
  }
  if (changed) save();
  const goals = state.goals.slice().sort((a, b) => (!!a.achieved - !!b.achieved) || (a.date || '9').localeCompare(b.date || '9'));
  const noAcc = !state.accounts.length
    ? '<p class="help small">💡 El progreso se mide con tu dinero total. Agrega tus cuentas en <b>Bancos</b> para verlo.</p>' : '';
  $('goalsList').innerHTML = noAcc + (goals.map((g) => {
    const c = goalCalc(g);
    if (g.achieved) {
      return `<div class="goal-card achieved compact" data-goal-id="${g.id}">
        <div class="acc-head">
          <span class="goal-title">${escapeHtml(g.name)}</span>
          ${starsHTML(c)}
          <button class="icon-btn" data-achieve="${g.id}" title="Reabrir meta" aria-label="Reabrir meta">↺</button>
        </div>
        ${progressHTML(c)}
      </div>`;
    }
    const conv = (v) => (g.currency !== disp ? ` <span class="sub">≈ ${fmtMoney(convert(v, g.currency, disp, rates), disp)}</span>` : '');
    const headline = c.done
      ? `<div class="goal-month t-ingreso">¡Ya tienes el dinero!</div>`
      : `<div class="goal-month" style="color:${goalColor(c)}">${fmtMoney(c.monthly, g.currency)} <span class="sub">al mes</span>${conv(c.monthly)}</div>`;
    const tips = [];
    if (!c.done && c.overdue) tips.push('<span class="t-gasto">La fecha ya pasó: cámbiala o sigue juntando.</span>');
    if (c.pctStars < 2) tips.push(`Para las ★★ del %: que la meta sea como máx. el ${c.lim}% de tu dinero → necesitas ${fmtMoney(c.ideal, g.currency)} en total${c.months ? ` (${fmtMoney(c.monthly3, g.currency)} al mes)` : ''}.`);
    if (g.date && !c.done) tips.push('Las ★★ de rapidez se ganan si la logras usando como máximo la mitad del tiempo.');
    return `<div class="goal-card ${c.overdue ? 'overdue' : ''}" data-goal-id="${g.id}">
      <div class="acc-head">
        <input type="text" data-g="name" value="${escapeHtml(g.name)}" class="acc-name goal-name">
        ${starsHTML(c)}
        <button data-del-goal="${g.id}" class="icon-btn" aria-label="Eliminar">✕</button>
      </div>
      <div class="goal-row">${headline}${haveTotalHTML(c, g.currency)}</div>
      ${progressHTML(c)}
      <div class="sub ${c.overdue ? 't-gasto' : ''}">${c.label}</div>
      ${tips.map((t) => `<div class="sub">${t}</div>`).join('')}
      <div class="row2" style="margin-top:10px">
        <label>Monto <input type="number" step="0.01" data-g="target" value="${g.target}"></label>
        <label>Moneda <select data-g="currency">${curOptions(g.currency)}</select></label>
      </div>
      <div class="row2">
        <label>Fecha límite <input type="date" data-g="date" value="${g.date || ''}"></label>
        <label>% máx. de tu dinero <input type="number" step="1" min="1" max="100" data-g="pct" value="${g.pct || ''}" placeholder="25 (por defecto)"></label>
      </div>
      <button class="small" data-achieve="${g.id}">✓ Marcar como lograda</button>
    </div>`;
  }).join('') || '<p class="help">Aún no tienes metas.</p>');
  $('goalCurrency').innerHTML = curOptions($('goalCurrency').value || state.settings.defaultCurrency);
}

/* ---------- Monedas: valor actual e historial ----------
   Historial gratuito y sin clave: fawazahmed0/currency-api (jsDelivr, con respaldo en Cloudflare) */
const HIST_URLS = (d) => [
  `https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@${d}/v1/currencies/usd.min.json`,
  `https://${d}.currency-api.pages.dev/v1/currencies/usd.min.json`,
];
const FX_RANGES = {
  '1D': { days: 1, step: 1, label: '1 día' },
  '1S': { days: 7, step: 1, label: '1 semana' },
  '1M': { days: 30, step: 3, label: '1 mes' },
  '6M': { days: 182, step: 14, label: '6 meses' },
  '1A': { days: 364, step: 28, label: '1 año' },
};
let fxRange = '1M';
let fxLoading = false;
let fxFailed = false;
let fxRenderTimer = null;
let fxProgress = { done: 0, total: 0 };

const isoDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
function fxDates(range) {
  const { days, step } = FX_RANGES[range];
  const out = [];
  const t = new Date();
  for (let i = days; i > 0; i -= step) { const d = new Date(t); d.setDate(t.getDate() - i); out.push(isoDate(d)); }
  return out;
}
function fxCodes() {
  return [...new Set([...state.settings.currencies, state.settings.displayCurrency, ...state.accounts.map((a) => a.currency), 'USD'])];
}
function recordTodayRates() {
  if (!state.rates) return;
  const rec = {};
  for (const c of fxCodes()) if (state.rates.rates[c]) rec[c] = state.rates.rates[c];
  state.rateHistory[isoDate(new Date(state.rates.fetched))] = rec;
}
function fetchT(url, ms = 10000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return fetch(url, { signal: ctl.signal, cache: 'no-store' }).finally(() => clearTimeout(t));
}
async function fetchHistDay(date) {
  for (const url of HIST_URLS(date)) {
    try {
      const r = await fetchT(url);
      if (!r.ok) continue;
      const j = await r.json();
      if (j && j.usd) return j.usd;
    } catch { /* probar el siguiente */ }
  }
  return null;
}
async function loadHistory(range) {
  const codes = fxCodes();
  const missing = fxDates(range).filter((d) => {
    const h = state.rateHistory[d];
    return !h || codes.some((c) => h[c] == null);
  });
  if (!missing.length || fxLoading) return; // si ya está cargando, al terminar revisa el rango elegido
  fxLoading = true; fxFailed = false;
  fxProgress = { done: 0, total: missing.length };
  try { renderMonedas(); } catch (e) { console.warn(e); }
  let i = 0, ok = 0;
  const worker = async () => {
    while (i < missing.length) {
      const d = missing[i++];
      const usd = await fetchHistDay(d);
      if (!usd) continue;
      const rec = { USD: 1 };
      for (const c of codes) { const v = usd[c.toLowerCase()]; if (v) rec[c] = v; }
      state.rateHistory[d] = { ...(state.rateHistory[d] || {}), ...rec };
      ok++;
      fxProgress.done = ok;
      if (currentView() === 'monedas' && !fxRenderTimer) fxRenderTimer = setTimeout(() => { fxRenderTimer = null; renderMonedas(); }, 300);
    }
  };
  try {
    await Promise.all([worker(), worker(), worker(), worker()]);
  } finally {
    fxLoading = false; // aunque algo falle, no se queda "cargando" para siempre
  }
  fxFailed = ok === 0;
  save();
  if (currentView() === 'monedas') renderMonedas();
  if (range !== fxRange) loadHistory(fxRange); // el usuario cambió de rango mientras cargaba
}

// Valor de 1 unidad de `from` en `to` para cada fecha disponible del rango
function fxSeries(from, to, range) {
  const dates = fxDates(range);
  const today = isoDate(new Date());
  const pts = [];
  for (const d of [...dates, today]) {
    let h = state.rateHistory[d];
    if (d === today) h = ratesFor(state.currentKey);
    if (h && h[from] && h[to]) pts.push({ d, v: h[to] / h[from] });
  }
  return pts;
}
function fmtRateUnit(from, to, v) {
  const unit = v < 0.1 ? (v < 0.001 ? 1000 : 100) : 1;
  let txt;
  if (!isFiat(to)) txt = fmtMoney(v * unit, to);
  else {
    try {
      txt = new Intl.NumberFormat('es-PE', { style: 'currency', currency: to, minimumFractionDigits: 2, maximumFractionDigits: v * unit >= 100 ? 2 : 4 }).format(v * unit);
    } catch { txt = `${to} ${(v * unit).toFixed(4)}`; }
  }
  return `${unit} ${from} = ${txt}`;
}
function fxChart(pts, color) {
  const W = 320, H = 90, P = 4;
  const vs = pts.map((p) => p.v);
  let min = Math.min(...vs), max = Math.max(...vs);
  if (max - min < max * 1e-6) { min -= max * 0.01; max += max * 0.01; }
  const x = (i) => P + (i / Math.max(1, pts.length - 1)) * (W - 2 * P);
  const y = (v) => H - P - ((v - min) / (max - min)) * (H - 2 * P);
  const line = pts.map((p, i) => `${i ? 'L' : 'M'}${x(i).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const area = `${line} L${x(pts.length - 1).toFixed(1)},${H} L${x(0).toFixed(1)},${H} Z`;
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Historial">
    <path d="${area}" fill="${color}" opacity="0.12"/>
    <path d="${line}" fill="none" stroke="${color}" stroke-width="2.2" stroke-linejoin="round"/>
    <circle cx="${x(pts.length - 1)}" cy="${y(pts[pts.length - 1].v)}" r="3.5" fill="${color}"/>
  </svg>`;
}
const fmtShortDate = (iso) => { const [y, m, d] = iso.split('-').map(Number); return new Date(y, m - 1, d).toLocaleDateString('es-PE', { day: 'numeric', month: 'short' }); };

/* Lista de monedas que ofrece el servicio (con nombre), para validar y sugerir al agregar */
let namesLoading = false;
async function loadCurrencyNames() {
  if (state.currencyNames || namesLoading) return;
  namesLoading = true;
  for (const url of [
    'https://cdn.jsdelivr.net/npm/@fawazahmed0/currency-api@latest/v1/currencies.min.json',
    'https://latest.currency-api.pages.dev/v1/currencies.min.json',
  ]) {
    try {
      const r = await fetch(url);
      if (!r.ok) continue;
      const j = await r.json();
      if (j && j.usd) { state.currencyNames = j; save(); break; }
    } catch { /* siguiente */ }
  }
  namesLoading = false;
  if (currentView() === 'monedas') renderMonedas();
}
const currencyName = (c) => (state.currencyNames && state.currencyNames[c.toLowerCase()]) || '';

function convOptions(sel) {
  const mine = state.settings.currencies;
  const all = state.currencyNames
    ? Object.keys(state.currencyNames).map((k) => k.toUpperCase()).filter((c) => !mine.includes(c) && /^[A-Z]{3,5}$/.test(c)).sort()
    : [];
  return `<optgroup label="Mis monedas">${mine.map((c) => `<option value="${c}" ${c === sel ? 'selected' : ''}>${c}</option>`).join('')}</optgroup>`
    + (all.length ? `<optgroup label="Otras">${all.map((c) => `<option value="${c}" ${c === sel ? 'selected' : ''}>${c} · ${escapeHtml(currencyName(c))}</option>`).join('')}</optgroup>` : '');
}
/* ---------- Calculadora de monedas ----------
   Ej: "15000JPY - 500USD a PEN", "300JPY x 5000 a USD", "(1200PEN + 80USD) / 3"
   Cada monto con moneda se convierte a la moneda de destino; los números solos son multiplicadores. */
function evalCalc(input, fallbackTarget) {
  let expr = input.trim();
  let target = fallbackTarget;
  const tm = /(?:\s+(?:a|en|to)\s+|\s*(?:→|=|->)\s*)([A-Za-z]{3,5})\s*$/i.exec(expr);
  if (tm) {
    const c = currencyFromWord(tm[1]) || tm[1].toUpperCase();
    target = c; expr = expr.slice(0, tm.index);
  }
  const rates = ratesFor(state.currentKey);
  if (!rates[target]) throw new Error(`No tengo la tasa de ${target}`);
  const toCode = (w) => {
    const c = currencyFromWord(w) || w.toUpperCase();
    if (!rates[c]) throw new Error(`No reconozco la moneda "${w}"`);
    return c;
  };
  // Tokens: monto con moneda (100USD, USD100, 100 usd), número, operador, paréntesis
  const tokens = [];
  const re = /\s*(?:(\d[\d.,]*)\s*([A-Za-z]{3,5})(?![A-Za-z])|([A-Za-z]{3,5})\s*(\d[\d.,]*)|(\d[\d.,]*)|([-+*/x×÷()−]))/y;
  let pos = 0;
  while (pos < expr.length) {
    if (/^\s*$/.test(expr.slice(pos))) break;
    re.lastIndex = pos;
    const m = re.exec(expr);
    if (!m) throw new Error(`No entiendo "${expr.slice(pos).trim().slice(0, 12)}"`);
    pos = re.lastIndex;
    if (m[1] || m[3]) {
      const amount = parseAmount(m[1] || m[4]);
      const cur = toCode(m[2] || m[3]);
      tokens.push({ t: 'num', v: convert(amount, cur, target, rates), money: true, src: { amount, cur } });
    } else if (m[5]) tokens.push({ t: 'num', v: parseAmount(m[5]), money: false });
    else {
      const op = { 'x': '*', '×': '*', '÷': '/', '−': '-' }[m[6]] || m[6];
      tokens.push({ t: op });
    }
  }
  if (!tokens.length) throw new Error('Escribe una cuenta');
  let i = 0;
  const peek = () => tokens[i] && tokens[i].t;
  const expression = () => {
    let a = term();
    while (peek() === '+' || peek() === '-') {
      const op = tokens[i++].t; const b = term();
      a = { v: op === '+' ? a.v + b.v : a.v - b.v, money: a.money || b.money };
    }
    return a;
  };
  const term = () => {
    let a = factor();
    while (peek() === '*' || peek() === '/') {
      const op = tokens[i++].t; const b = factor();
      if (op === '*') a = { v: a.v * b.v, money: a.money || b.money };
      else {
        if (b.v === 0) throw new Error('No se puede dividir entre 0');
        a = { v: a.v / b.v, money: a.money && b.money ? false : a.money };
      }
    }
    return a;
  };
  const factor = () => {
    const tk = tokens[i];
    if (!tk) throw new Error('La cuenta está incompleta');
    if (tk.t === '-') { i++; const f = factor(); return { v: -f.v, money: f.money }; }
    if (tk.t === '+') { i++; return factor(); }
    if (tk.t === '(') {
      i++; const e = expression();
      if (peek() !== ')') throw new Error('Falta cerrar un paréntesis');
      i++; return e;
    }
    if (tk.t === 'num') { i++; return tk; }
    throw new Error(`Sobra "${tk.t}"`);
  };
  const result = expression();
  if (i < tokens.length) throw new Error(`Sobra "${tokens[i].t === 'num' ? 'un número' : tokens[i].t}"`);
  const parts = tokens.filter((t) => t.money).map((t) => ({ ...t.src, conv: t.v }));
  return { value: result.v, money: result.money || !parts.length ? true : result.money, plain: !result.money && parts.length > 0, target, parts };
}

function renderConverter() {
  const box = $('convResult');
  const fallback = $('calcTo').value || state.settings.displayCurrency;
  try {
    const r = evalCalc($('calcInput').value, fallback);
    const rates = ratesFor(state.currentKey);
    const main = r.plain
      ? `<div class="conv-big"><b>${r.value.toLocaleString('es-PE', { maximumFractionDigits: 6 })}</b></div>`
      : `<div class="conv-big">= <b>${fmtMoney(r.value, r.target)}</b></div>`;
    const breakdown = r.parts.filter((p) => p.cur !== r.target)
      .map((p) => `${fmtMoney(p.amount, p.cur)} = ${fmtMoney(p.conv, r.target)}`).join(' · ');
    const also = r.plain ? '' : state.settings.currencies.filter((c) => c !== r.target && rates[c]).slice(0, 4)
      .map((c) => fmtMoney(convert(r.value, r.target, c, rates), c)).join(' · ');
    box.innerHTML = main
      + (breakdown ? `<div class="sub">${breakdown}</div>` : '')
      + (also ? `<div class="sub">También: ${also}</div>` : '');
  } catch (e) {
    box.innerHTML = `<div class="sub t-deuda">${escapeHtml(e.message)}</div>`;
  }
}

/* ---------- Comparar dos monedas en el mismo gráfico (% de cambio) ---------- */
let cmpSel = null; // monedas elegidas para comparar
const CMP_COLORS = ['#5fb6ff', '#ff8ad8', '#ffd34d', '#4cd98a', '#ff9f5a', '#c69bff', '#3ec7c2', '#ff6b7a'];
function renderCompare() {
  const base = state.settings.displayCurrency;
  const R = FX_RANGES[fxRange];
  const opts = state.settings.currencies.filter((c) => c !== base);
  if (opts.length < 2) { $('fxCompare').hidden = true; return; }
  $('fxCompare').hidden = false;
  if (!cmpSel) cmpSel = opts.slice(0, 2);
  cmpSel = cmpSel.filter((c) => opts.includes(c));
  const colorOf = (c) => CMP_COLORS[opts.indexOf(c) % CMP_COLORS.length];
  $('cmpPick').innerHTML = opts.map((c) =>
    `<button data-cmp-cur="${c}" class="${cmpSel.includes(c) ? 'sel' : ''}" style="--c:${colorOf(c)}"><i></i>${c}</button>`).join('');
  const series = cmpSel.map((c) => ({ c, s: fxSeries(c, base, fxRange) })).filter((x) => x.s.length >= 2);
  if (!cmpSel.length) { $('cmpChart').innerHTML = '<div class="sub">Toca las monedas que quieres comparar.</div>'; return; }
  if (!series.length) {
    $('cmpChart').innerHTML = `<div class="sub">${fxLoading ? 'Descargando historial…' : 'Aún no hay historial para este rango.'}</div>`;
    return;
  }
  const pct = (S) => S.map((p) => ({ d: p.d, v: ((p.v - S[0].v) / S[0].v) * 100 }));
  const lines = series.map((x) => ({ c: x.c, P: pct(x.s) }));
  const W = 320, H = 130, P = 6;
  const all = lines.flatMap((l) => l.P.map((p) => p.v)).concat([0]);
  let min = Math.min(...all), max = Math.max(...all);
  if (max - min < 0.01) { min -= 0.5; max += 0.5; }
  const x = (i, len) => P + (i / Math.max(1, len - 1)) * (W - 2 * P);
  const y = (v) => H - P - ((v - min) / (max - min)) * (H - 2 * P);
  const path = (S) => S.map((p, i) => `${i ? 'L' : 'M'}${x(i, S.length).toFixed(1)},${y(p.v).toFixed(1)}`).join(' ');
  const label = (v) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(2)}%`;
  $('cmpChart').innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Comparación">
      <line x1="${P}" x2="${W - P}" y1="${y(0)}" y2="${y(0)}" stroke="#2a2a31" stroke-dasharray="3 3"/>
      ${lines.map((l) => `<path d="${path(l.P)}" fill="none" stroke="${colorOf(l.c)}" stroke-width="2.4" stroke-linejoin="round"/>`).join('')}
    </svg>
    <div class="legend-dots">
      ${lines.map((l) => `<span><i style="background:${colorOf(l.c)}"></i>${l.c} ${label(l.P[l.P.length - 1].v)}</span>`).join('')}
      <span>frente al ${base} · ${R.label}</span>
    </div>`;
}

function renderMonedas() {
  const base = state.settings.displayCurrency;
  loadCurrencyNames();
  // Calculadora (conserva la moneda elegida)
  $('calcTo').innerHTML = convOptions($('calcTo').value || base);
  renderConverter();
  renderCompare();
  // Mis monedas
  $('curChips').innerHTML = state.settings.currencies.map((c) =>
    `<span class="cur-chip" title="${escapeHtml(currencyName(c))}">${c}${state.settings.currencies.length > 1 ? `<button data-rm-cur="${c}" aria-label="Quitar ${c}">×</button>` : ''}</span>`).join('');
  $('curList').innerHTML = state.currencyNames
    ? Object.entries(state.currencyNames).map(([k, n]) => `<option value="${k.toUpperCase()}">${escapeHtml(n)}</option>`).join('') : '';
  const R = FX_RANGES[fxRange];
  $('fxBase').textContent = base;
  $('fxRange').innerHTML = Object.keys(FX_RANGES).map((k) =>
    `<button data-fx="${k}" class="${k === fxRange ? 'sel' : ''}">${FX_RANGES[k].label}</button>`).join('')
    + `<button data-fx-reload="1" class="reload" ${fxLoading ? 'disabled' : ''}>⟳ Descargar datos</button>`;
  $('fxStatus').innerHTML = fxLoading ? `Descargando historial… (${fxProgress.done}/${fxProgress.total})`
    : fxFailed ? 'No se pudo descargar el historial (¿sin internet?). <button data-fx-retry="1" class="small">Reintentar</button>' : '';

  const others = state.settings.currencies.filter((c) => c !== base);
  $('fxCards').innerHTML = others.map((c) => {
    const pts = fxSeries(c, base, fxRange);
    if (!pts.length) return `<div class="fx-card"><div class="fx-head"><b>${c}</b><span class="sub">sin datos todavía</span></div></div>`;
    const last = pts[pts.length - 1].v, first = pts[0].v;
    const ch = ((last - first) / first) * 100;
    const up = ch >= 0;
    const color = Math.abs(ch) < 0.05 ? 'var(--muted)' : up ? 'var(--ingreso)' : 'var(--gasto)';
    return `<div class="fx-card">
      <div class="fx-head">
        <span class="fx-rate">${fmtRateUnit(c, base, last)}</span>
        ${pts.length > 1 ? `<span class="fx-change" style="color:${color}">${up ? '▲' : '▼'} ${Math.abs(ch).toFixed(2)}% en ${R.label}</span>` : ''}
      </div>
      ${pts.length > 1 ? `<div class="sub">El ${c} ${Math.abs(ch) < 0.05 ? 'se mantuvo' : up ? 'subió' : 'bajó'} frente al ${base}: antes ${fmtRateUnit(c, base, first)}</div>`
        + fxChart(pts, color) + `<div class="fx-axis"><span>${fmtShortDate(pts[0].d)}</span><span>hoy</span></div>`
        : '<div class="sub">Aún no hay historial para este rango.</div>'}
    </div>`;
  }).join('') || '<p class="help">Agrega otras monedas en ⚙ Ajustes para compararlas.</p>';

  // ¿Se desvalorizó el dinero de cada cuenta?
  $('fxAccounts').innerHTML = state.accounts.map((a) => {
    const ref = a.currency !== base ? base : (state.settings.currencies.find((c) => c !== base) || 'USD');
    const { bal } = accountBalance(a);
    const pts = fxSeries(a.currency, ref, fxRange);
    if (pts.length < 2 || !bal) return `<div class="fx-acc" style="--acc:${a.color}"><b>${escapeHtml(a.name)}</b> · ${fmtMoney(bal, a.currency)}<div class="sub">${bal ? 'Sin historial suficiente todavía.' : 'Sin saldo.'}</div></div>`;
    const then = bal * pts[0].v, now = bal * pts[pts.length - 1].v;
    const diff = now - then, pct = (diff / Math.abs(then)) * 100;
    const cls = Math.abs(pct) < 0.05 ? '' : diff > 0 ? 't-ingreso' : 't-gasto';
    const verdict = Math.abs(pct) < 0.05 ? 'mantuvo su valor'
      : diff > 0 ? `ganó valor frente al ${ref}` : `perdió valor frente al ${ref}`;
    return `<div class="fx-acc" style="--acc:${a.color}">
      <b>${escapeHtml(a.name)}</b> · ${fmtMoney(bal, a.currency)}
      <div class="sub">Hace ${R.label} valía ${fmtMoney(then, ref)} · hoy ${fmtMoney(now, ref)}</div>
      <div class="${cls}"><b>${fmtDelta(diff, ref)} (${pct >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(2)}%)</b> · tu dinero en ${a.currency} ${verdict}</div>
    </div>`;
  }).join('') || '<p class="help">Agrega tus cuentas en Bancos para ver si su dinero perdió valor.</p>';
}

/* ---------- Listas (compromisos) ---------- */
function accountBadge(e) {
  if (!e.accountId) return '';
  if (e.accountId === 'unknown') return ` · <span class="acc-tag unknown">cuenta "${escapeHtml(e.prefix || e.tag)}" ?</span>`;
  const a = accountById(e.accountId);
  return a ? ` · <span class="acc-tag"><i style="background:${a.color}"></i>${escapeHtml(a.name)}</span>` : '';
}

let openForm = null; // id del encargo o transferencia con el formulario "¿cuánto llegó?" abierto

function arriveForm(e) {
  const isT = e.type === 'transfer';
  const acc = !isT && accountById(e.accountId);
  const title = isT ? '¿Cuánto llegó y a qué cuenta?' : `¿Cuánto te llegó${acc ? ` a ${escapeHtml(acc.name)}` : ''}?`;
  const accSel = isT
    ? `<select data-arr="acc"><option value="">Sin cuenta</option>${state.accounts.map((a) => `<option value="${a.id}">${escapeHtml(a.prefix)} · ${escapeHtml(a.name)}</option>`).join('')}</select>`
    : '';
  return `<div class="arrive">
    <div class="arrive-title">${title}</div>
    <div class="arrive-row">
      <input type="number" step="0.01" data-arr="amount" value="${isT ? '' : e.amount}" placeholder="0.00">
      <select data-arr="cur">${curOptions(e.currency)}</select>
      ${accSel}
    </div>
    ${isT ? '' : '<div class="sub">Si la plataforma (VGen u otra) se quedó una parte, escribe lo que realmente llegó: la diferencia cuenta como comisión.</div>'}
    <div class="arrive-row"><button class="primary" data-arr-ok="${e.id}">Confirmar</button><button data-arr-cancel="1">Cancelar</button></div>
  </div>`;
}

/* Ruta del dinero de un encargo: dónde llegó y por qué cuentas pasó.
   Las transferencias se enlazan al encargo si tienen el mismo nombre. */
function routeOf(enc) {
  const st = state.status[enc.id];
  if (!st || !st.done) return null;
  const start = { amount: enc.amount, cur: enc.currency };
  const firstAcc = enc.accountId && enc.accountId !== 'unknown' ? accountById(enc.accountId) : null;
  const steps = [{
    label: firstAcc ? firstAcc.name : 'Cobrado', color: firstAcc && firstAcc.color, acc: firstAcc,
    amount: st.received != null ? st.received : enc.amount, cur: st.recvCur || enc.currency,
  }];
  const legs = allEntries()
    .filter((e) => e.type === 'transfer' && norm(e.name) === norm(enc.name))
    .sort((a, b) => (a.ts || 0) - (b.ts || 0));
  let pending = null;
  for (const l of legs) {
    if (!l.dest) { pending = l; break; }
    const a = l.destAccountId && l.destAccountId !== 'unknown' ? accountById(l.destAccountId) : null;
    steps.push({ label: a ? a.name : 'otra cuenta', color: a && a.color, acc: a, amount: l.dest.amount, cur: l.dest.currency });
  }
  return { start, steps, pending };
}

function routeHTML(enc) {
  const r = routeOf(enc);
  if (!r) return '';
  const disp = state.settings.displayCurrency;
  const rates = ratesFor(state.currentKey);
  const v = (x) => convert(x.amount, x.cur, disp, rates);
  let prev = r.start;
  let html = `<span class="step">Encargo ${fmtMoney(r.start.amount, r.start.cur)}</span>`;
  for (const st of r.steps) {
    const lost = v(prev) - v(st);
    html += `<span class="arrow">→</span><span class="step"><i style="background:${st.color || '#6e6875'}"></i>${escapeHtml(st.label)} ${fmtMoney(st.amount, st.cur)}`
      + (Math.abs(lost) >= 0.005 ? ` <em class="${lost > 0 ? 't-gasto' : 't-ingreso'}">${lost > 0 ? '−' : '+'}${fmtMoney(Math.abs(lost), disp)}</em>` : '') + '</span>';
    prev = st;
  }
  if (r.pending) html += `<span class="arrow">→</span><span class="step t-deuda">en camino…</span>`;
  const totalLost = v(r.start) - v(prev);
  const pct = (totalLost / (v(r.start) || 1)) * 100;
  return `<div class="route">${html}</div>
    <div class="route-sum">${Math.abs(totalLost) >= 0.005
      ? `Se perdió <b class="t-gasto">${fmtMoney(totalLost, disp)}</b> (${pct.toFixed(1)}%) en el camino${r.pending ? ' hasta ahora' : ''}`
      : 'Llegó completo'}</div>`;
}

function lineHTML(e) {
  const disp = state.settings.displayCurrency;
  const st = state.status[e.id];
  const done = st && st.done;
  const converted = e.currency !== disp
    ? `<small>≈ ${fmtMoney(convert(e.amount, e.currency, disp, ratesFor(e.monthKey || state.currentKey)), disp)}</small>` : '';
  const sign = e.type === 'deuda' ? '−' : '';
  let meta = fmtDateTime(e.ts);
  if (e.monthKey && e.monthKey !== state.currentKey) meta += ` · ${monthName(e.monthKey)}`;
  if (done && st.ts) meta += ` · ✓ ${fmtDateTime(st.ts)}`;
  if (done && e.type === 'encargo' && st.received != null) meta += ` · llegó ${fmtMoney(st.received, st.recvCur || e.currency)}`;
  meta += (e.type === 'transfer' ? ' · sale de' : '') + accountBadge(e);

  let actions;
  if (e.type === 'transfer') actions = `<button data-arrive="${e.id}">Llegó…</button>`;
  else if (done) {
    const r = e.type === 'encargo' ? routeOf(e) : null;
    actions = (r && !r.pending ? `<button data-move="${e.id}">Mover →</button>` : '') + `<button data-undo="${e.id}">Deshacer</button>`;
  } else if (e.type === 'encargo') actions = `<button data-arrive="${e.id}">Cumplido ✓</button>`;
  else actions = `<button data-done="${e.id}">${{ deuda: 'Pagada ✓', medeben: 'Cobrado ✓' }[e.type]}</button>`;

  const extra = (openForm === e.id ? arriveForm(e) : '') + (e.type === 'encargo' && done ? routeHTML(e) : '');
  return `<li class="${done && e.type !== 'encargo' ? 'done' : ''}">
    <span class="bar bg-${e.type}"></span>
    <div><div class="name">${escapeHtml(e.name)}</div><div class="meta">${meta}</div></div>
    <div class="amt t-${e.type}">${sign}${fmtMoney(e.amount, e.currency)}${converted}</div>
    <div class="actions">${actions}</div>
    ${extra ? `<div class="li-extra">${extra}</div>` : ''}
  </li>`;
}
const emptyLi = (t) => `<li class="empty">${t}</li>`;

function pendingTotal(entries) {
  const disp = state.settings.displayCurrency;
  const rates = ratesFor(state.currentKey);
  return entries.reduce((a, e) => a + convert(e.amount, e.currency, disp, rates), 0);
}

function renderCompromisos() {
  const disp = state.settings.displayCurrency;
  const s = monthSummary(state.currentKey);
  $('totalFijos').innerHTML = `· <span class="t-gasto">−${fmtMoney(s.fijosG, disp)}</span>`
    + (s.fijosI ? ` <span class="t-ingreso">+${fmtMoney(s.fijosI, disp)}</span>` : '') + ' al mes';
  $('listFijos').innerHTML = fijosList().map(({ e, days, date, st }) => {
    let when = e.day ? `día ${e.day} · ${date.toLocaleDateString('es-PE', { day: 'numeric', month: 'short' })} · <b class="${days <= 3 ? 't-deuda' : ''}">${whenText(days)}</b>` : 'sin día de cobro (agrega @15)';
    let actions = '';
    const isIn = e.type === 'ingreso';
    const word = isIn ? 'recibido' : 'pagado';
    if (e.mode === 'ma') {
      if (st.byLine) when += ` · <b class="t-ingreso">✓ ${word} (lo escribiste en el Mes)</b>`;
      else if (st.mark) { when += ` · <b class="t-ingreso">✓ ${word} ${fmtDateTime(st.mark)}</b>`; actions = `<button data-fijo-unpay="${e.id}">Deshacer</button>`; }
      else actions = `<button data-fijo-pay="${e.id}">${isIn ? 'Recibido ✓' : 'Pagado ✓'}</button>`;
    }
    // elegir a qué cuenta entra o de cuál sale (los de proyectos se cambian en el proyecto)
    const accSel = !e.project && state.accounts.length ? `<select class="acc-pick" data-fijo-acc="${e.id}" title="${isIn ? 'Entra a' : 'Sale de'}">
        <option value="">${isIn ? 'Entra a…' : 'Sale de…'}</option>
        ${state.accounts.map((a) => `<option value="${a.id}" ${a.id === e.accountId && e.prefix ? 'selected' : ''}>${isIn ? '→' : '←'} ${escapeHtml(a.prefix)} · ${escapeHtml(a.name)}</option>`).join('')}
      </select>` : '';
    actions = actions || accSel ? `<div class="actions">${accSel}${actions}</div>` : '';
    return `<li class="${e.mode === 'ma' && st.paid ? 'done' : ''}">
      <span class="bar bg-${e.type}"></span>
      <div><div class="name">${escapeHtml(e.name)}<span class="mode-chip ${e.mode}">${e.mode === 'ma' ? 'Manual' : 'Auto'}</span>${e.project ? `<span class="mode-chip proj">🧾 ${escapeHtml(e.project)}</span>` : ''}</div>
        <div class="meta">${when}${accountBadge(e)}</div></div>
      <div class="amt t-${e.type}">${e.type === 'ingreso' ? '+' : '−'}${fmtMoney(e.amount, e.currency)}</div>
      ${actions}
    </li>`;
  }).join('') || '<li class="empty">Aún no tienes nada mensual</li>';

  const all = allEntries();
  const isDone = (e) => state.status[e.id] && state.status[e.id].done;
  const list = (type) => all.filter((e) => e.type === type && !isDone(e));
  const debo = list('deuda'), meDeben = list('medeben'), encargos = list('encargo');
  const camino = all.filter((e) => e.type === 'transfer' && !e.dest);
  const encDone = all.filter((e) => e.type === 'encargo' && isDone(e))
    .sort((a, b) => state.status[b.id].ts - state.status[a.id].ts).slice(0, 10);
  const deudasDone = all.filter((e) => (e.type === 'deuda' || e.type === 'medeben') && isDone(e));

  $('listDebo').innerHTML = debo.length ? debo.map(lineHTML).join('') : emptyLi('No debes nada 🎉');
  $('listMeDeben').innerHTML = meDeben.length ? meDeben.map(lineHTML).join('') : emptyLi('Nadie te debe');
  $('listEncargos').innerHTML = encargos.length ? encargos.map(lineHTML).join('') : emptyLi('Sin encargos pendientes');
  $('listEncargosDone').innerHTML = encDone.length ? encDone.map(lineHTML).join('') : emptyLi('Aún no cumples encargos');
  $('caminoBlock').hidden = !camino.length;
  $('listCamino').innerHTML = camino.map(lineHTML).join('');
  $('listDone').innerHTML = deudasDone.length ? deudasDone.slice().reverse().map(lineHTML).join('') : emptyLi('—');
  $('totDebo').textContent = debo.length ? `· ${fmtMoney(pendingTotal(debo), disp)}` : '';
  $('totMeDeben').textContent = meDeben.length ? `· ${fmtMoney(pendingTotal(meDeben), disp)}` : '';
  $('totEncargos').textContent = encargos.length ? `· ${fmtMoney(pendingTotal(encargos), disp)}` : '';
  $('totCamino').textContent = camino.length ? `· ${fmtMoney(pendingTotal(camino), disp)}` : '';
}

/* Formulario "¿cuánto llegó?" confirmado */
function confirmArrive(id, box) {
  const amount = parseFloat(box.querySelector('[data-arr="amount"]').value);
  const cur = box.querySelector('[data-arr="cur"]').value;
  if (!(amount >= 0) || box.querySelector('[data-arr="amount"]').value === '') { toast('Escribe cuánto llegó'); return; }
  const e = allEntries().find((x) => x.id === id);
  if (!e) return;
  if (e.type === 'encargo') {
    state.status[id] = { done: true, ts: Date.now(), received: amount, recvCur: cur };
    SFX.done();
  } else if (e.type === 'transfer') {
    const accId = box.querySelector('[data-arr="acc"]').value;
    const acc = accountById(accId);
    const m = state.months[e.monthKey];
    const line = m && m.lines.find((l) => l.id === id);
    if (!line) return;
    const em = matchEntry(line.text);
    line.text = line.text.slice(0, em.firstEnd) + ` ${cur}${String(+amount.toFixed(2))}${acc ? acc.prefix : ''}` + line.text.slice(em.end);
    if (e.monthKey === state.currentKey) loadEditors();
  }
  openForm = null;
  save();
  renderAll();
}

/* "Mover →": escribe en el Mes la siguiente transferencia de la ruta */
function moveEncargo(id) {
  const enc = allEntries().find((x) => x.id === id);
  const r = enc && routeOf(enc);
  if (!r) return;
  const last = r.steps[r.steps.length - 1];
  const line = `${enc.name} >${last.cur}${String(+Number(last.amount).toFixed(2))}${last.acc ? last.acc.prefix : ''}`;
  const ta = $('editor');
  const v = ta.value.replace(/\s+$/, '');
  ta.value = (v ? v + '\n' : '') + line;
  showView('mes');
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
  onEditorInput();
}

/* ¿En qué se va tu dinero? Gastos del mes agrupados por nombre (así salen los gastos hormiga) */
function topSpendHTML(k) {
  const disp = state.settings.displayCurrency;
  const rates = ratesFor(k);
  const groups = new Map();
  const addTo = (key, label, v) => {
    const g = groups.get(key) || { label, v: 0, n: 0 };
    g.v += v; g.n++; groups.set(key, g);
  };
  for (const e of monthEntries(k)) {
    if (e.type === 'gasto') addTo(matchKey(e.name), e.name, convert(e.amount, e.currency, disp, rates));
    if (e.type === 'transfer' && e.dest) { const f = transferFee(e, disp, rates); if (f > 0) addTo('__comisiones', 'Comisiones', f); }
  }
  for (const e of fijosEntries(k)) if (e.type === 'gasto' && fijoCounts(e, k)) addTo('fijo:' + matchKey(e.name), `${e.name} (mensual)`, convert(e.amount, e.currency, disp, rates));
  const all = [...groups.values()].sort((a, b) => b.v - a.v);
  if (!all.length) return '';
  const top = all.slice(0, 7);
  const rest = all.slice(7);
  if (rest.length) top.push({ label: `Otros (${rest.length})`, v: rest.reduce((s, g) => s + g.v, 0), n: rest.reduce((s, g) => s + g.n, 0) });
  const total = all.reduce((s, g) => s + g.v, 0);
  const max = Math.max(...top.map((g) => g.v));
  return `<div class="pace top-spend">
    <div class="sub">${monthName(k)}</div>
    ${top.map((g) => `<div class="ts-row">
      <div class="ts-label"><span>${escapeHtml(g.label)}${g.n > 1 ? ` <span class="sub">×${g.n}</span>` : ''}</span><span>${fmtMoney(g.v, disp)} <span class="sub">${Math.round((g.v / total) * 100)}%</span></span></div>
      <div class="ts-bar"><div style="width:${(g.v / max) * 100}%"></div></div>
    </div>`).join('')}
    <div class="sub" style="margin-top:6px">Lo que se repite muchas veces (×5, ×10…) suele ser el gasto hormiga.</div>
  </div>`;
}

/* ---------- Historial (dentro de Mes) ---------- */
function paceHTML(k, prevK, day) {
  const disp = state.settings.displayCurrency;
  const cur = dailyCumulative(k);
  const prev = prevK ? dailyCumulative(prevK) : null;
  const n = Math.max(cur.length - 1, prev ? prev.length - 1 : 0);
  day = Math.min(day, cur.length - 1);
  const curVal = cur[day];
  const prevVal = prev ? prev[Math.min(day, prev.length - 1)] : null;

  let big = `<div class="big">${fmtMoney(curVal, disp)}</div><div class="sub">gastado al día ${day} (sin fijos)</div>`;
  if (prev) {
    const d = curVal - prevVal;
    const cls = Math.abs(d) < 0.005 ? 'zero' : (d < 0 ? 'good' : 'bad');
    big = `<div class="big delta ${cls}">${fmtDelta(d, disp)}</div>
      <div class="sub">al día ${day}: ${fmtMoney(curVal, disp)} vs ${fmtMoney(prevVal, disp)} en ${compareTarget === 'pb' ? '★ ' : ''}${monthName(prevK)} · ${d < 0 ? 'vas adelante' : d > 0 ? 'vas atrás' : 'empate'}</div>`;
  }
  const W = 320, H = state.settings.chartsBig ? 150 : 64, P = 6;
  const maxY = Math.max(1, ...cur, ...(prev || [0]));
  const x = (d) => P + ((d - 1) / Math.max(1, n - 1)) * (W - 2 * P);
  const y = (v) => H - P - (v / maxY) * (H - 2 * P);
  const path = (arr, upTo) => arr.slice(1, upTo + 1).map((v, i) => `${i ? 'L' : 'M'}${x(i + 1).toFixed(1)},${y(v).toFixed(1)}`).join(' ');
  const svg = `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Gasto acumulado por día">
      <line x1="${x(day)}" x2="${x(day)}" y1="${P}" y2="${H - P}" stroke="#26262d" stroke-dasharray="3 3"/>
      ${prev ? `<path d="${path(prev, prev.length - 1)}" fill="none" stroke="#6e6875" stroke-width="2"/>` : ''}
      <path d="${path(cur, day)}" fill="none" stroke="var(--gasto)" stroke-width="2.5"/>
    </svg>
    <div class="legend-dots">
      <span><i style="background:var(--gasto)"></i>${monthName(k)}</span>
      ${prev ? `<span><i style="background:#6e6875"></i>${monthName(prevK)}</span>` : ''}
    </div>`;
  return `<div class="pace">${big}${svg}${candlesHTML(k, x, W, P, n)}</div>`;
}

/* ---------- Velas (estilo trading) ----------
   Cada día con movimientos es una vela del saldo del mes: abre con lo que tenías al empezar el día
   y cierra con lo que quedó. Verde si subió, roja si bajó. Toca una vela para ver qué la movió. */
let candleSel = null;
function dailyMoves(k) {
  const disp = state.settings.displayCurrency;
  const rates = ratesFor(k);
  const moves = [];
  const push = (ts, name, v, type) => { if (ts && Math.abs(v) >= 0.005) moves.push({ ts, day: new Date(ts).getDate(), name, v, type }); };
  for (const e of monthEntries(k)) {
    const v = convert(e.amount, e.currency, disp, rates);
    if (e.type === 'gasto') push(e.ts, e.name, -v, 'gasto');
    else if (e.type === 'ingreso') push(e.ts, e.name, v, 'ingreso');
    else if (e.type === 'transfer' && e.dest) push(e.ts, `Comisión · ${e.name}`, -transferFee(e, disp, rates), 'gasto');
  }
  for (const e of allEntries()) {
    const st = state.status[e.id];
    if (!st || !st.done || !st.ts || monthKey(new Date(st.ts)) !== k) continue;
    if (e.type === 'deuda') push(st.ts, `Pagaste: ${e.name}`, -convert(e.amount, e.currency, disp, rates), 'gasto');
    if (e.type === 'medeben') push(st.ts, `Cobraste: ${e.name}`, convert(e.amount, e.currency, disp, rates), 'ingreso');
    if (e.type === 'encargo') push(st.ts, `Encargo: ${e.name}`, convert(st.received != null ? st.received : e.amount, st.recvCur || e.currency, disp, rates), 'ingreso');
  }
  return moves.sort((a, b) => a.ts - b.ts);
}
function candlesHTML(k, x, W, P, n) {
  const moves = dailyMoves(k);
  if (!moves.length) return '';
  const days = [];
  let bal = 0;
  for (let d = 1; d <= daysInMonth(k); d++) {
    const ms = moves.filter((m) => m.day === d);
    if (!ms.length) continue;
    const open = bal;
    let hi = bal, lo = bal;
    for (const m of ms) { bal += m.v; hi = Math.max(hi, bal); lo = Math.min(lo, bal); }
    days.push({ d, open, close: bal, hi, lo, ms });
  }
  const H = state.settings.chartsBig ? 130 : 52;
  const min = Math.min(0, ...days.map((c) => c.lo)), max = Math.max(0, ...days.map((c) => c.hi));
  const span = max - min || 1;
  const y = (v) => 6 + (1 - (v - min) / span) * (H - 12);
  const bw = Math.max(4, Math.min(14, ((W - 2 * P) / Math.max(1, n)) * 0.7));
  const disp = state.settings.displayCurrency;
  const body = days.map((c) => {
    const up = c.close >= c.open;
    const col = up ? 'var(--ingreso)' : 'var(--gasto)';
    const cx = x(c.d);
    const top = y(Math.max(c.open, c.close)), bot = y(Math.min(c.open, c.close));
    const net = c.close - c.open;
    return `<g class="candle ${candleSel === c.d ? 'sel' : ''}" data-cday="${c.d}">
      <title>${c.d} · ${fmtDelta(net, disp)} (${c.ms.length} movimiento${c.ms.length === 1 ? '' : 's'})</title>
      <rect x="${cx - bw / 2 - 3}" y="0" width="${bw + 6}" height="${H}" fill="transparent"/>
      <line x1="${cx}" x2="${cx}" y1="${y(c.hi)}" y2="${y(c.lo)}" stroke="${col}" stroke-width="1.5"/>
      <rect x="${cx - bw / 2}" y="${top}" width="${bw}" height="${Math.max(2, bot - top)}" rx="1.5" fill="${col}"/>
    </g>`;
  }).join('');
  const zero = `<line x1="${P}" x2="${W - P}" y1="${y(0)}" y2="${y(0)}" stroke="#2a2a31" stroke-dasharray="3 3"/>`;
  let info = '<div class="sub candle-hint">Toca una vela para ver qué ingreso o gasto movió ese día.</div>';
  const sel = days.find((c) => c.d === candleSel);
  if (sel) {
    const net = sel.close - sel.open;
    info = `<div class="candle-info">
      <div class="ci-head"><b>${sel.d} de ${monthName(k).split(' ')[0].toLowerCase()}</b><b class="${net >= 0 ? 't-ingreso' : 't-gasto'}">${fmtDelta(net, disp)}</b></div>
      ${sel.ms.map((m) => `<div class="ci-row"><span>${escapeHtml(m.name)}</span><span class="${m.v >= 0 ? 't-ingreso' : 't-gasto'}">${fmtDelta(m.v, disp)}</span></div>`).join('')}
      <div class="sub">saldo del mes: ${fmtMoney(sel.open, disp)} → ${fmtMoney(sel.close, disp)}</div>
    </div>`;
  }
  return `<div class="candles">
    <div class="sub">🕯️ Movimientos por día (saldo del mes)</div>
    <svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Velas por día">${zero}${body}</svg>
    ${info}
  </div>`;
}

function renderPastBar() {
  const box = $('pastBar');
  if (!isPastView()) { box.innerHTML = ''; return; }
  box.innerHTML = `<button class="back-now" data-back-now="1">⟵ Volver a ${monthName(state.currentKey)}</button>
    <button class="edit-past ${pastEdit ? 'sel' : ''}" data-edit-past="1">${pastEdit ? '✓ Listo' : '✏️ Editar'}</button>
    <span class="sub">${pastEdit ? 'Editando un mes pasado: lo nuevo se fecha el último día de ese mes.' : 'Estás viendo un mes pasado (solo lectura).'}</span>`;
}

/* ---------- Calendario de meses ----------
   verde = terminaste con saldo a favor · rojo = gastaste más de lo que entró · marco amarillo = mejor mes del año */
let calendarOpen = false;
function renderCalendar() {
  const box = $('calendar');
  box.hidden = !calendarOpen;
  if (!calendarOpen) return;
  const disp = state.settings.displayCurrency;
  const keys = sortedKeys();
  const firstY = Number((keys[0] || state.currentKey).slice(0, 4));
  const lastY = Number(state.currentKey.slice(0, 4));
  const MESES = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
  let html = '';
  for (let yr = lastY; yr >= firstY; yr--) {
    const ks = MESES.map((_, i) => `${yr}-${pad(i + 1)}`);
    const bal = Object.fromEntries(ks.filter((k) => state.months[k]).map((k) => [k, monthSummary(k).balance]));
    const maxAbs = Math.max(1, ...Object.values(bal).map(Math.abs));
    const candidates = ks.filter((k) => bal[k] != null && !state.months[k].ignorePB && k !== state.currentKey);
    const best = candidates.length ? candidates.reduce((a, b) => (bal[b] > bal[a] ? b : a)) : null;
    html += `<div class="cal-year"><div class="cal-y">${yr}</div><div class="cal-grid">` + ks.map((k, i) => {
      const future = k > state.currentKey;
      const has = bal[k] != null;
      const inten = has ? 0.18 + 0.55 * Math.min(1, Math.abs(bal[k]) / maxAbs) : 0;
      const bg = has ? (bal[k] >= 0 ? `rgba(46,213,120,${inten})` : `rgba(255,77,94,${inten})`) : '';
      const cls = ['cal-m', future ? 'future' : '', has ? '' : 'empty', k === best ? 'best' : '', k === state.currentKey ? 'now' : '', k === editorKey() ? 'sel' : ''].join(' ');
      return `<button class="${cls}" ${future ? 'disabled' : `data-cal="${k}"`} style="${bg ? `background:${bg}` : ''}" title="${monthName(k)}${has ? ' · ' + fmtMoney(bal[k], disp) : ''}">
        <b>${MESES[i]}</b><span>${has ? fmtCompact(bal[k], disp) : ''}</span>${k === best ? '<i>★</i>' : ''}${has && state.months[k].ignorePB ? '<i class="dice">🎲</i>' : ''}</button>`;
    }).join('') + '</div></div>';
  }
  box.innerHTML = html + '<div class="cal-legend"><span><i class="g"></i>a favor</span><span><i class="r"></i>en contra</span><span><i class="y"></i>mejor mes del año</span></div>';
}

function renderHistorial() {
  const keys = sortedKeys();
  if (!selectedHistKey) selectedHistKey = state.currentKey;
  renderCalendar();
  const disp = state.settings.displayCurrency;


  const k = selectedHistKey;
  // ¿contra qué mes se compara? mes anterior · mismo mes del año pasado · tu mejor mes (PB)
  const [ky, km] = k.split('-');
  const lastYearK = `${Number(ky) - 1}-${km}`;
  const others = keys.filter((x) => x !== k && !state.months[x].ignorePB); // los meses "ignorados" no compiten por el PB
  const pbK = others.length ? others.reduce((best, x) => (monthSummary(x).balance > monthSummary(best).balance ? x : best), others[0]) : null;
  const prevK = compareTarget === 'year' ? (state.months[lastYearK] ? lastYearK : null)
    : compareTarget === 'pb' ? pbK : prevKeyOf(k);
  const isCurrent = k === state.currentKey;
  const today = new Date().getDate();
  const upto = (isCurrent && compareMode === 'sameDay') ? today : null;

  const cur = monthSummary(k, upto);
  const prev = prevK ? monthSummary(prevK, upto ? Math.min(upto, daysInMonth(prevK)) : null) : null;
  const ignored = !!(state.months[k] && state.months[k].ignorePB);
  const balances = others.map((x) => monthSummary(x).balance);
  const isPB = !isCurrent && !ignored && balances.length && monthSummary(k).balance > Math.max(...balances);

  const rows = [
    ['Ingresos', cur.ingresos + cur.fijosI, prev && prev.ingresos + prev.fijosI, +1, true],
    ['Encargos', cur.encargosCumplidos, prev && prev.encargosCumplidos, +1],
    ['Cobrado', cur.cobrados, prev && prev.cobrados, +1],
    ['Gastos', cur.gastos, prev && prev.gastos, -1, true],
    ['Mensuales', cur.fijosG, prev && prev.fijosG, -1],
    ['Deudas', cur.deudasPagadas, prev && prev.deudasPagadas, -1],
    ['Comisiones', cur.comisiones, prev && prev.comisiones, -1],
  ].filter(([, a, b, , always]) => always || Math.abs(a) >= 0.005 || Math.abs(b || 0) >= 0.005);

  const deltaCell = (a, b, dir) => {
    if (b == null) return '<td class="delta zero">—</td>';
    const d = a - b;
    const cls = Math.abs(d) < 0.005 ? 'zero' : (d * dir > 0 ? 'good' : 'bad');
    return `<td class="delta ${cls}">${fmtDelta(d, disp)}</td>`;
  };
  const targetBtns = `<div class="symbar cmp-target">
      <span class="sub">Comparar con</span>
      <button data-cmpt="prev" class="${compareTarget === 'prev' ? 'sel' : ''}">Mes anterior</button>
      <button data-cmpt="year" class="${compareTarget === 'year' ? 'sel' : ''}">${monthName(lastYearK).split(' ')[0]} del año pasado</button>
      <button data-cmpt="pb" class="${compareTarget === 'pb' ? 'sel' : ''}">★ Tu mejor mes</button>
    </div>`;
  const noRef = !prevK ? `<div class="sub">${compareTarget === 'year' ? `No hay datos de ${monthName(lastYearK)}.` : compareTarget === 'pb' ? 'Aún no hay otros meses para comparar.' : 'No hay un mes anterior registrado.'}</div>` : '';
  const ignoreBtn = !state.months[k] ? '' : `<div class="symbar"><button data-ignore-pb="${k}" class="${ignored ? 'sel' : ''}">🎲 ${ignored ? 'Ignorado para el PB (toca para volver a contarlo)' : 'Ignorar este mes para el PB'}</button></div>`;
  const toggle = targetBtns + noRef + ignoreBtn + (isCurrent && prevK ? `
    <div class="symbar">
      <button data-cmp="sameDay" class="${compareMode === 'sameDay' ? 't-encargo' : ''}">Al mismo día (${today})</button>
      <button data-cmp="full" class="${compareMode === 'full' ? 't-encargo' : ''}">Mes completo</button>
    </div>` : '');

  $('splits').innerHTML = `${toggle}
    <table class="splits">
      <tr><th></th><th>${prevK ? (compareTarget === 'pb' ? '★ ' : '') + (compareTarget === 'year' ? monthName(prevK) : monthName(prevK).split(' ')[0]) : '—'}</th><th>${monthName(k).split(' ')[0]}</th><th>Δ</th></tr>
      ${rows.map(([label, a, b, dir]) => `<tr><td>${label}</td><td>${b == null ? '—' : fmtMoney(b, disp)}</td><td>${fmtMoney(a, disp)}</td>${deltaCell(a, b, dir)}</tr>`).join('')}
      <tr class="total"><td>Balance ${isPB ? '<span class="badge" style="color:#ffd34d">★ PB</span>' : ''}</td>
        <td>${prev ? fmtMoney(prev.balance, disp) : '—'}</td>
        <td class="${cur.balance >= 0 ? 't-ingreso' : 't-gasto'}">${fmtMoney(cur.balance, disp)}</td>
        ${deltaCell(cur.balance, prev && prev.balance, +1)}</tr>
    </table>`;

  $('paceChart').innerHTML = paceHTML(k, prevK, isCurrent ? today : daysInMonth(k));
  $('topSpend').innerHTML = topSpendHTML(k);
}

/* ---------- Bancos ---------- */
const curOptions = (sel) => state.settings.currencies.map((c) => `<option value="${c}" ${c === sel ? 'selected' : ''}>${c}</option>`).join('');

function renderLock() {
  const creating = !state.settings.pinHash;
  $('lockedRow').hidden = bankUnlocked;
  $('unlockedRow').hidden = !bankUnlocked;
  $('changePinCard').hidden = !bankUnlocked;
  if (bankUnlocked) return;
  $('lockMsg').textContent = creating ? '🔒 Crea un PIN para tus notas' : '🔒 Notas bloqueadas';
  $('pinInput2').hidden = !creating;
  $('btnUnlock').textContent = creating ? 'Guardar PIN' : 'Ver notas';
}

function tryUnlock() {
  const p1 = $('pinInput').value.trim();
  const p2 = $('pinInput2').value.trim();
  if (!state.settings.pinHash) {
    if (!/^\d{4,12}$/.test(p1)) { toast('El PIN debe tener de 4 a 12 números'); return; }
    if (p1 !== p2) { toast('Los PIN no coinciden'); return; }
    state.settings.pinHash = pinHash(p1);
    save();
  } else if (pinHash(p1) !== state.settings.pinHash) {
    $('pinInput').value = '';
    toast('PIN incorrecto');
    return;
  }
  $('pinInput').value = ''; $('pinInput2').value = '';
  bankUnlocked = true;
  renderLock();
  renderBancos();
}

function lockBank() {
  const was = bankUnlocked;
  bankUnlocked = false;
  if (was && currentView() === 'bancos') renderBancos();
}

function renderBancos() {
  renderLock();
  const disp = state.settings.displayCurrency;
  const rates = ratesFor(state.currentKey);
  let totalHyp = 0, totalReal = 0, allReal = state.accounts.length > 0;

  $('accountsList').innerHTML = state.accounts.map((a) => {
    const { bal, count } = accountBalance(a);
    totalHyp += convert(bal, a.currency, disp, rates);
    const hasReal = a.real !== null && a.real !== undefined && a.real !== '';
    if (hasReal) totalReal += convert(Number(a.real), a.currency, disp, rates); else allReal = false;

    let diffHTML = '';
    if (hasReal) {
      const diff = Number(a.real) - bal;
      if (Math.abs(diff) < 0.005) diffHTML = `<div class="diff good">✓ Cuadra con tu estado de cuenta</div>`;
      else diffHTML = `<div class="diff ${diff < 0 ? 'bad' : 'good'}">
          ${diff < 0 ? `Te faltan <b>${fmtMoney(-diff, a.currency)}</b>: hay gastos que no anotaste (¿gastos hormiga?)`
                     : `Tienes <b>${fmtMoney(diff, a.currency)}</b> de más: hay ingresos que no anotaste`}
        </div>
        <button data-rebase="${a.id}" class="small">Empezar de nuevo desde el saldo real</button>`;
    }
    return `<div class="acc-card" data-acc-id="${a.id}" style="--acc:${a.color}">
      <div class="acc-head">
        <input type="color" data-f="color" value="${a.color}" aria-label="Color">
        <input type="text" data-f="name" value="${escapeHtml(a.name)}" class="acc-name">
        <input type="text" data-f="prefix" value="${escapeHtml(a.prefix)}" maxlength="2" class="acc-prefix" aria-label="Prefijo" style="background:${a.color}">
        <button data-del-acc="${a.id}" class="icon-btn" aria-label="Eliminar">✕</button>
      </div>
      <div class="acc-big">${fmtMoney(bal, a.currency)}</div>
      <div class="sub">hipotético hoy · ${count} movimiento${count === 1 ? '' : 's'} desde ${fmtDateTime(a.startTs)}</div>
      <div class="row2">
        <label>Saldo inicial <input type="number" step="0.01" data-f="initial" value="${a.initial}"></label>
        <label>Moneda <select data-f="currency">${curOptions(a.currency)}</select></label>
      </div>
      <label>Saldo real (de tu estado de cuenta)
        <input type="number" step="0.01" data-f="real" value="${hasReal ? a.real : ''}" placeholder="Opcional, para comparar">
      </label>
      ${diffHTML}
      ${bankUnlocked
        ? `<label>Nota
            <textarea data-f="note" class="note" rows="2" placeholder="Pistas para recordar (nunca la contraseña real)">${escapeHtml(a.note || '')}</textarea>
          </label>`
        : `<div class="note-locked">🔒 ${a.note ? 'Nota protegida' : 'Desbloquea con tu PIN para escribir una nota'}</div>`}
    </div>`;
  }).join('') || '<p class="help">Aún no agregas cuentas.</p>';

  $('bankTotal').innerHTML = state.accounts.length ? `<div class="pace">
      <div class="sub">Total hipotético de todas tus cuentas</div>
      <div class="big">${fmtMoney(totalHyp, disp)}</div>
      ${allReal ? `<div class="sub">Real: ${fmtMoney(totalReal, disp)} · diferencia <span class="delta ${totalReal - totalHyp < 0 ? 'bad' : 'good'}">${fmtDelta(totalReal - totalHyp, disp)}</span></div>` : ''}
    </div>` : '';

  renderBankChart();
  $('accCurrency').innerHTML = curOptions($('accCurrency').value || state.settings.defaultCurrency);
  $('accSwatches').innerHTML = COLOR_PRESETS.map((c) =>
    `<button data-swatch="${c}" class="swatch ${c === newAccColor ? 'sel' : ''}" style="background:${c}" aria-label="${c}"></button>`).join('')
    + `<label class="swatch custom ${COLOR_PRESETS.includes(newAccColor) ? '' : 'sel'}" title="Elegir cualquier color" style="background:${COLOR_PRESETS.includes(newAccColor) ? 'conic-gradient(red, yellow, lime, cyan, blue, magenta, red)' : newAccColor}">
        <input type="color" id="accColorCustom" value="${newAccColor}"></label>`;
  $('accColorCustom').addEventListener('input', (e) => { newAccColor = e.target.value; });
  $('accColorCustom').addEventListener('change', () => renderBancos());
  $('setDefaultAccount').innerHTML = `<option value="">Ninguna</option>` + state.accounts.map((a) =>
    `<option value="${a.id}" ${a.id === state.settings.defaultAccount ? 'selected' : ''}>${escapeHtml(a.prefix)} · ${escapeHtml(a.name)}</option>`).join('');
}

/* ---------- Pruebas: meses de ejemplo ---------- */
function addTestMonth() {
  const keys = sortedKeys();
  const d = keyToDate(keys[0] || state.currentKey);
  d.setMonth(d.getMonth() - 1);
  const k = monthKey(d);
  const cur = state.settings.defaultCurrency;
  const pfx = state.accounts.map((a) => a.prefix);
  const items = [
    ['Almuerzo', '-', 10, 35], ['Pinceles', '-', 20, 90], ['Comisión', '+', 150, 700], ['Taxi', '-', 8, 30],
    ['Supermercado', '-', 60, 220], ['Café', '-', 5, 15], ['Venta de prints', '+', 40, 250], ['Materiales', '-', 15, 120],
  ];
  const rnd = (a, b) => a + Math.random() * (b - a);
  const n = daysInMonth(k);
  const lines = [];
  const count = 10 + Math.floor(Math.random() * 8);
  for (let i = 0; i < count; i++) {
    const [name, sym, lo, hi] = items[Math.floor(Math.random() * items.length)];
    const amt = Math.round(rnd(lo, hi));
    const p = pfx.length && Math.random() < 0.7 ? pfx[Math.floor(Math.random() * pfx.length)] : '';
    const day = 1 + Math.floor(Math.random() * n);
    lines.push({ id: uid(), ts: new Date(d.getFullYear(), d.getMonth(), day, 9 + Math.floor(Math.random() * 12)).getTime(), text: `${name} ${sym}${cur}${amt}${p}` });
  }
  lines.sort((a, b) => a.ts - b.ts);
  state.months[k] = {
    lines, closed: true, fijos: clone(state.fijos), defaultCur: cur, test: true,
    rates: (state.rates && state.rates.rates) || null,
  };
  save();
  return k;
}

/* ---------- Ajustes ---------- */
function renderRateStatus() {
  const el = $('rateStatus');
  if (!el) return;
  const r = ratesFor(state.currentKey);
  el.textContent = state.rates
    ? `1 USD = ${fmtMoney(r.PEN, 'PEN')} · actualizado ${fmtDateTime(state.rates.fetched)} (open.er-api.com)`
    : `Sin tasas de internet todavía. Usando la manual: 1 USD = ${fmtMoney(r.PEN, 'PEN')}`;
}
function renderAjustes() {
  const tests = Object.entries(state.months).filter(([, m]) => m.test).map(([k]) => monthName(k));
  $('testInfo').textContent = tests.length ? `Meses de prueba: ${tests.join(', ')}` : '';
  $('setDefaultCur').innerHTML = curOptions(state.settings.defaultCurrency);
  $('setDisplayCur').innerHTML = curOptions(state.settings.displayCurrency);
  $('setManualRate').value = state.settings.manualRate;
  $('setSound').checked = state.settings.sound !== false;
  $('setVolume').value = state.settings.volume ?? 0.6;
  $('setAnim').checked = state.settings.anim !== false;
  renderRateStatus();
}

function renderAll() {
  renderHeader();
  renderHistorial();
  renderCompromisos();
  renderHighlight($('editor'));
  renderHighlight($('editorFijos'));
  renderReminders();
  if (currentView() === 'bancos') renderBancos();
  if (currentView() === 'metas') { renderMetas(); renderProjectGoals(); }
  if (currentView() === 'proyectos') renderProjects();
  if (currentView() === 'monedas') renderMonedas();
  renderToolbar();
}

/* ---------------------------------------------------------
   Barra de botones inteligente
     sin tipo      → Gasto · Ingreso · Debo · Me deben · Encargo
     sin moneda    → PEN · USD · JPY …
     sin cuenta    → cuentas (prefijo) · Listo ↵
   --------------------------------------------------------- */
function activeEditor() {
  return currentView() === 'compromisos' ? $('editorFijos') : $('editor');
}
function currentLine(ta) {
  const v = ta.value, pos = ta.selectionStart;
  const start = v.lastIndexOf('\n', pos - 1) + 1;
  let end = v.indexOf('\n', pos);
  if (end < 0) end = v.length;
  return { start, end, text: v.slice(start, end) };
}
function replaceLine(ta, cl, text) {
  ta.focus();
  ta.setRangeText(text, cl.start, cl.end, 'end');
}
function afterEdit(ta) {
  if (ta.id === 'editorFijos') onFijosInput(); else onEditorInput();
}
function jumpToNextLine(ta) {
  const cl = currentLine(ta);
  const pos = cl.end;
  const v = ta.value;
  const nextEnd = v.indexOf('\n', pos + 1);
  const nextText = v.slice(pos + 1, nextEnd < 0 ? v.length : nextEnd);
  if (v[pos] === '\n' && nextText.trim() === '') ta.setSelectionRange(pos + 1, pos + 1);
  else { ta.setSelectionRange(pos, pos); ta.setRangeText('\n', pos, pos, 'end'); }
}

function renderToolbar() {
  const bar = $('toolbar');
  const view = currentView();
  const ta = activeEditor();
  if ((view !== 'mes' && view !== 'compromisos') || (view === 'mes' && isPastView() && !pastEdit)) { bar.hidden = true; return; }
  bar.hidden = false;
  const wrap = ta.closest('.hl-wrap');
  if (bar.previousElementSibling !== wrap) { wrap.after(bar); bar._html = null; }

  const ls = lineState(currentLine(ta).text);
  let html = '';
  const card = (data, cls, big, small, extra = '') => `<button ${data} class="tb-card ${cls}" ${extra}><b>${big}</b><span>${small}</span></button>`;
  const lineNow = currentLine(ta).text;
  const accBtns = (selPrefix) => {
    if (!state.accounts.length) return card('data-goto="bancos"', 'add-acc', '＋', 'Crear cuenta');
    const sug = selPrefix ? null : suggestAccount(lineNow);
    const list = sug ? [sug, ...state.accounts.filter((a) => a.id !== sug.id)] : state.accounts;
    return list.map((a) => card(`data-acc="${a.id}"`,
      `acc ${selPrefix && a.prefix.toLowerCase() === selPrefix.toLowerCase() ? 'sel' : ''} ${sug && a.id === sug.id ? 'sug' : ''}`,
      `<i class="pfx" style="background:${a.color}">${escapeHtml(a.prefix)}</i>`,
      `${escapeHtml(a.name)}${sug && a.id === sug.id ? ' · sugerida' : ''}`)).join('');
  };
  const curBtns = (sel) => state.settings.currencies.map((c) => {
    const sym = shortSym(c);
    return card(`data-cur="${c}"`, `cur ${c === sel ? 'sel' : ''}`, sym || c, sym ? c : '&nbsp;');
  }).join('');
  const nextBtn = (label = 'Listo', icon = '↵') => card('data-next="1"', 'next', icon, label);

  const isT = ls.em && ls.em.sym === '>';
  const note = (t) => `<span class="bar-note">${t}</span>`;
  if (ls.s === 'type') {
    const types = view === 'compromisos' ? ['gasto', 'ingreso'] : ['gasto', 'ingreso', 'deuda', 'medeben', 'encargo', 'transfer'];
    const ICON = { gasto: '−', ingreso: '+', deuda: '%', medeben: '&', encargo: '#', transfer: '⇄' };
    html = types.map((k) => `<button data-type="${SYMBOL_OF[k]}" class="tb-type t-${k}"><b>${ICON[k]}</b><span>${LABEL_OF[k]}</span></button>`).join('');
  } else if (ls.s === 'currency') {
    html = curBtns(null);
  } else if (ls.s === 'amount') {
    html = note(ls.pm[2] === '>' ? 'Escribe cuánto salió' : 'Escribe el monto') + curBtns(ls.pm[3]);
  } else if (isT && ls.s === 'account') {
    html = note('Sale de') + accBtns(null);
  } else if (ls.s === 'destCurrency') {
    html = note('¿Cuánto llegó?') + curBtns(null) + nextBtn('Aún no llega', '⏳');
  } else if (ls.s === 'destAmount') {
    html = note('Escribe cuánto llegó') + curBtns(ls.em.destPartial.code);
  } else if (isT) {
    html = note('Llega a') + accBtns(ls.em.dest && ls.em.dest.prefix) + nextBtn();
  } else if (view === 'mes' && ls.em.sym === '-' && state.projects.length) {
    // gasto: primero el proyecto y su partida (no salta de línea), luego la cuenta
    const bm = BUDGET_RE.exec(currentLine(ta).text);
    const cur = bm ? bm[2].toLowerCase() : null;
    const curP = cur ? projectByTag(cur) : null;
    html = state.projects.map((p) => card(`data-budget="${escapeHtml(p.tag)}"`, `bud ${curP === p && !cur.includes('/') ? 'sel' : ''}`, '🧾', escapeHtml(p.name))).join('')
      + (curP ? parseProjectItems(curP).map((it) => {
        const tag = `${curP.tag}/${it.slug}`;
        return card(`data-budget="${escapeHtml(tag)}"`, `bud sub ${cur === tag ? 'sel' : ''}`, '›', escapeHtml(it.name));
      }).join('') : '')
      + '<span class="sep"></span>' + accBtns(ls.em.prefix) + nextBtn()
      + '<span class="sep"></span>' + curBtns(ls.em.code);
  } else {
    html = accBtns(ls.em.prefix) + nextBtn()
      + '<span class="sep"></span>' + curBtns(ls.em.code);
  }
  if (view === 'compromisos' && ['account', 'done'].includes(ls.s)) {
    const lt = currentLine(ta).text;
    const mo = MODE_RE.exec(lt);
    const mode = mo ? mo[2].toLowerCase() : null;
    html += '<span class="sep"></span>'
      + (DAY_RE.test(lt) ? '' : card('data-day="1"', '', '📅', 'Día de cobro'))
      + card('data-mode="Au"', `mode ${mode === 'au' ? 'sel' : ''}`, '⚙', 'Automático')
      + card('data-mode="Ma"', `mode ${mode === 'ma' ? 'sel' : ''}`, '✋', 'Manual');
  }
  if (bar._html !== html) { bar.innerHTML = html; bar._html = html; bar.scrollLeft = 0; }
}

function applyType(sym) {
  const ta = activeEditor();
  const cl = currentLine(ta);
  let t = cl.text;
  // Si termina en monto ("Pinceles 50" o "Pinceles PEN50B"), el tipo va delante
  const m = /(^|\s)([A-Z]{3,5})?(\d[\d.,]*)([A-Z][a-z]?|[^\s\d.,A-Za-z*])?\s*$/.exec(t);
  if (m && !/[-+%&#]$/.test(t.slice(0, m.index + m[1].length))) {
    const at = m.index + m[1].length;
    t = t.slice(0, at) + sym + t.slice(at).replace(/\s+$/, '');
  } else {
    const base = t.replace(/\s+$/, '');
    t = base + (base ? ' ' : '') + sym;
  }
  replaceLine(ta, cl, t);
  afterEdit(ta);
}

function applyCurrency(code) {
  const ta = activeEditor();
  const cl = currentLine(ta);
  const t = cl.text;
  const ls = lineState(t);
  const em = ls.em;
  bumpCurrency(code);
  if (em && em.sym === '>' && ['destCurrency', 'destAmount', 'destAccount', 'done'].includes(ls.s)) {
    // moneda de lo que llegó (segundo bloque)
    const second = em.dest ? `${code}${em.dest.amountStr}${em.dest.prefix || ''}` : code;
    replaceLine(ta, cl, t.slice(0, em.firstEnd) + ' ' + second + t.slice(em.end));
  } else if (em && parseAmount(em.amountStr) > 0) {
    const token = `${em.sym}${code}${em.amountStr}${em.prefix || ''}`;
    replaceLine(ta, cl, t.slice(0, em.start) + token + t.slice(em.firstEnd));
    if (em.sym !== '>' && (em.prefix || !state.accounts.length)) jumpToNextLine(ta);
  } else {
    const pm = PARTIAL_RE.exec(t);
    if (!pm) return;
    replaceLine(ta, cl, t.slice(0, pm.indices[2][1]) + code);
  }
  afterEdit(ta);
}

function applyAccount(id) {
  const ta = activeEditor();
  const cl = currentLine(ta);
  const acc = accountById(id);
  const ls = lineState(cl.text);
  const em = ls.em;
  if (!acc || !em) { flashHint('Escribe el monto primero 🙂'); return; }
  if (em.sym === '>') {
    const t = cl.text;
    if (ls.s === 'account') {           // cuenta de origen
      replaceLine(ta, cl, t.slice(0, em.start) + `>${em.code || ''}${em.amountStr}${acc.prefix}` + t.slice(em.firstEnd));
    } else if (em.dest) {               // cuenta de destino
      replaceLine(ta, cl, t.slice(0, em.firstEnd) + ` ${em.dest.code || ''}${em.dest.amountStr}${acc.prefix}` + t.slice(em.end));
      jumpToNextLine(ta);
    } else { flashHint('Escribe cuánto llegó primero 🙂'); return; }
    afterEdit(ta);
    return;
  }
  const token = `${em.sym}${em.code || ''}${em.amountStr}${acc.prefix}`;
  let t = cl.text.slice(0, em.start) + token + cl.text.slice(em.firstEnd);
  t = t.replace(new RegExp(TAG_RE.source, 'g'), '$1').replace(/\s+$/, ''); // quita @Cuenta antiguo
  replaceLine(ta, cl, t);
  jumpToNextLine(ta);
  afterEdit(ta);
}

let hintTimer = null;
function flashHint(msg) {
  $('hint').innerHTML = `<span class="t-deuda">${msg}</span>`;
  clearTimeout(hintTimer);
  hintTimer = setTimeout(updateSuggest, 1800);
}

/* ---------- Cuenta sugerida ---------- */
function suggestAccount(text) {
  if (!state.accounts.length) return null;
  const p = parseLine(text, state.settings.defaultCurrency);
  const all = allEntries().filter((e) => e.accountId && e.accountId !== 'unknown' && e.raw !== text)
    .sort((a, b) => (b.ts || 0) - (a.ts || 0));
  if (p) {
    const key = matchKey(p.name);
    const same = all.find((e) => matchKey(e.name) === key && p.name !== '(sin nombre)');
    if (same) return accountById(same.accountId);
    const sameType = all.find((e) => e.type === p.type);
    if (sameType) return accountById(sameType.accountId);
  }
  return accountById(state.settings.defaultAccount) || (all[0] && accountById(all[0].accountId)) || null;
}

/* ---------- Sugerencias mientras escribes ---------- */
function buildLine(e) {
  const num = String(+e.amount.toFixed(2));
  const acc = e.prefix ? accountByPrefix(e.prefix) : (e.accountId && e.accountId !== 'unknown' ? accountById(e.accountId) : null);
  return `${e.name} ${SYMBOL_OF[e.type]}${e.currency}${num}${acc ? acc.prefix : ''}`;
}

function updateSuggest() {
  const ta = $('editor');
  const box = $('suggest');
  const hint = $('hint');
  const info = currentLine(ta);
  const t = info.text.trim();
  box.innerHTML = '';
  if (!t || document.activeElement !== ta) { hint.textContent = ''; return; }

  const parsed = parseLine(t, state.settings.defaultCurrency);
  if (parsed) {
    const line = ((state.months[editorKey()] || {}).lines || []).find((l) => l.text === info.text);
    const accId = resolveAccount(parsed);
    const acc = accountById(accId);
    if (parsed.type === 'transfer') {
      const from = acc ? acc.name : 'otra cuenta';
      const to = parsed.dest && parsed.dest.prefix ? (accountByPrefix(parsed.dest.prefix) || { name: `"${parsed.dest.prefix}" ?` }).name : 'otra cuenta';
      let txt = `✓ <span class="t-transfer">Transferencia</span>: ${escapeHtml(from)} ${fmtMoney(parsed.amount, parsed.currency)}`;
      if (parsed.dest) {
        const disp = state.settings.displayCurrency;
        const fee = transferFee(parsed, disp, ratesFor(state.currentKey));
        const pct = fee / (convert(parsed.amount, parsed.currency, disp, ratesFor(state.currentKey)) || 1) * 100;
        txt += ` → ${escapeHtml(to)} ${fmtMoney(parsed.dest.amount, parsed.dest.currency)}`
          + (Math.abs(fee) >= 0.005 ? ` · <span class="${fee > 0 ? 't-gasto' : 't-ingreso'}">comisión ${fmtMoney(fee, disp)} (${pct.toFixed(1)}%)</span>` : ' · sin comisión');
      } else txt += ' → <span class="t-deuda">en camino</span>';
      hint.innerHTML = txt;
      return;
    }
    hint.innerHTML = `✓ <span class="t-${parsed.type}">${LABEL_OF[parsed.type]}</span>: ${escapeHtml(parsed.name)} · ${fmtMoney(parsed.amount, parsed.currency)}`
      + (acc ? ` · <span class="acc-tag"><i style="background:${acc.color}"></i>${escapeHtml(acc.name)}</span>` : '')
      + (accId === 'unknown' ? ` · <span class="acc-tag unknown">no hay cuenta con prefijo "${escapeHtml(parsed.prefix || parsed.tag)}"</span>` : '')
      + (line && line.ts ? ` · ${fmtDateTime(line.ts)}` : '');
    return;
  }
  if (/(^|\s)[-+%&#>][a-z]{3,5}\d/.test(t)) { hint.innerHTML = '<span class="t-deuda">La moneda va en MAYÚSCULAS (PEN, USD…)</span>'; return; }
  const ls = lineState(t);
  hint.textContent = ls.s === 'currency' ? 'Elige la moneda' : ls.s === 'amount' ? 'Escribe el monto' : 'Escribe el nombre y toca el tipo';

  const q = norm(t.replace(/\s*\S*\d[\d.,]*\S?\s*$/, ''));
  if (ls.s !== 'type' || q.length < 2) return;
  const seen = new Set();
  const cands = allEntries().concat(fijosEntries())
    .filter((e) => e.type !== 'transfer' && norm(e.name).includes(q))
    .sort((a, b) => (norm(b.name).startsWith(q) - norm(a.name).startsWith(q)) || ((b.ts || 0) - (a.ts || 0)))
    .filter((e) => { const k = e.type + '|' + norm(e.name); if (seen.has(k)) return false; seen.add(k); return true; })
    .slice(0, 3);

  box.innerHTML = cands.map((e, i) =>
    `<button data-sug="${i}" class="t-${e.type}">${escapeHtml(e.name)} · ${fmtMoney(e.amount, e.currency)}${(() => {
      const a = e.prefix ? accountByPrefix(e.prefix) : (e.accountId && e.accountId !== 'unknown' ? accountById(e.accountId) : null);
      return a ? ` <i class="pfx-mini" style="background:${a.color}">${escapeHtml(a.prefix)}</i> ${escapeHtml(a.name)}` : '';
    })()}</button>`).join('');
  box.querySelectorAll('button').forEach((b) => {
    b.addEventListener('pointerdown', (ev) => ev.preventDefault());
    b.addEventListener('click', () => {
      const e = cands[Number(b.dataset.sug)];
      replaceLine(ta, currentLine(ta), buildLine(e));
      jumpToNextLine(ta);
      onEditorInput();
    });
  });
}

/* ---------- Mes que se ve en el editor ----------
   Puedes abrir un mes pasado desde el calendario: se ve en gris (solo lectura) hasta que tocas Editar. */
let pastEdit = false;
const editorKey = () => (selectedHistKey && selectedHistKey !== state.currentKey ? selectedHistKey : state.currentKey);
const isPastView = () => editorKey() !== state.currentKey;
function monthForEdit(k) {
  if (!state.months[k]) {
    ensureMonth(k);
    if (k < state.currentKey) Object.assign(state.months[k], { closed: true, fijos: clone(state.fijos), defaultCur: state.settings.defaultCurrency });
  }
  return state.months[k];
}
function viewMonth(k) {
  selectedHistKey = k;
  pastEdit = false;
  candleSel = null;
  calendarOpen = false;
  loadEditors();
  renderAll();
}

/* ---------- Edición ---------- */
function onEditorInput() {
  const k = editorKey();
  const m = monthForEdit(k);
  // en un mes pasado, lo nuevo se fecha el último día de ese mes
  const stamp = k === state.currentKey ? Date.now() : new Date(keyToDate(k).getFullYear(), keyToDate(k).getMonth(), daysInMonth(k), 12).getTime();
  m.lines = stampLines(syncLines(m.lines, $('editor').value.split('\n')), defCurOf(k), stamp);
  saveSoon();
  renderHighlight($('editor'));
  renderHeader();
  renderHistorial();
  renderCompromisos();
  renderReminders();
  updateSuggest();
  renderToolbar();
}
function onFijosInput() {
  state.fijos = stampLines(syncLines(state.fijos, $('editorFijos').value.split('\n')), state.settings.defaultCurrency);
  saveSoon();
  renderHighlight($('editorFijos'));
  renderHeader();
  renderCompromisos();
  renderReminders();
  renderToolbar();
}

/* ---------------------------------------------------------
   Sonidos (Web Audio, sin archivos) y confeti
   --------------------------------------------------------- */
const SFX = (() => {
  let ctx = null;
  const ac = () => {
    if (!ctx) { const C = window.AudioContext || window.webkitAudioContext; if (!C) return null; ctx = new C(); }
    if (ctx.state === 'suspended') ctx.resume();
    return ctx;
  };
  function tone(freq, dur, { type = 'sine', vol = 1, delay = 0, slide = null } = {}) {
    if (!state.settings.sound) return;
    const c = ac(); if (!c) return;
    const t0 = c.currentTime + delay;
    const o = c.createOscillator(), g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t0 + dur);
    const v = Math.max(0.0001, (state.settings.volume ?? 0.6) * 0.25 * vol);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(v, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(c.destination);
    o.start(t0); o.stop(t0 + dur + 0.05);
  }
  return {
    tap: () => tone(880, 0.05, { type: 'triangle', vol: 0.35 }),
    tick: () => tone(1250, 0.035, { vol: 0.25 }),
    pop: () => tone(600, 0.08, { type: 'triangle', vol: 0.4, slide: 900 }),
    coin: () => { tone(988, 0.08, { type: 'square', vol: 0.3 }); tone(1319, 0.28, { type: 'square', vol: 0.3, delay: 0.07 }); },
    spend: () => tone(440, 0.18, { type: 'triangle', vol: 0.6, slide: 250 }),
    swoosh: () => { tone(500, 0.12, { type: 'sine', vol: 0.4, slide: 1000 }); tone(1000, 0.12, { type: 'sine', vol: 0.3, delay: 0.1, slide: 700 }); },
    done: () => [523, 659, 784].forEach((f, i) => tone(f, 0.2, { type: 'triangle', vol: 0.5, delay: i * 0.08 })),
    undo: () => [659, 523].forEach((f, i) => tone(f, 0.12, { type: 'triangle', vol: 0.35, delay: i * 0.07 })),
    fanfare: () => [523, 659, 784, 1047].forEach((f, i) => tone(f, i === 3 ? 0.55 : 0.15, { type: 'square', vol: 0.3, delay: i * 0.1 })),
  };
})();

/* Sonido según el tipo de movimiento */
function entrySound(type) {
  if (type === 'ingreso' || type === 'medeben' || type === 'encargo') SFX.coin();
  else if (type === 'transfer') SFX.swoosh();
  else SFX.spend();
}

/* Al pasar al siguiente párrafo, suena según el párrafo que terminaste */
function lineDoneSound(ta, pos) {
  const v = ta.value;
  const end = v.lastIndexOf('\n', pos - 1);
  if (end < 0) return;
  const start = v.lastIndexOf('\n', end - 1) + 1;
  const e = parseLine(v.slice(start, end), state.settings.defaultCurrency);
  if (e) entrySound(e.type);
}

function applyAnim() { document.body.classList.toggle('no-anim', state.settings.anim === false); }

function animOn() {
  return state.settings.anim !== false && !matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function confetti(n = 110) {
  if (!animOn()) return;
  const cv = document.createElement('canvas');
  cv.className = 'confetti';
  const dpr = window.devicePixelRatio || 1;
  const W = innerWidth, H = innerHeight;
  cv.width = W * dpr; cv.height = H * dpr;
  document.body.appendChild(cv);
  const x = cv.getContext('2d'); x.scale(dpr, dpr);
  const cols = ['#ffd84d', '#2fe07e', '#b98fa8', '#ff4d5e', '#7cc8ff', '#ffffff'];
  const ps = Array.from({ length: n }, () => ({
    x: W / 2 + (Math.random() - 0.5) * 80, y: H * 0.45,
    vx: (Math.random() - 0.5) * 13, vy: -Math.random() * 13 - 5,
    r: Math.random() * Math.PI, vr: (Math.random() - 0.5) * 0.35,
    w: 5 + Math.random() * 6, h: 8 + Math.random() * 8, c: cols[(Math.random() * cols.length) | 0],
  }));
  const t0 = performance.now();
  (function frame(t) {
    const el = t - t0;
    x.clearRect(0, 0, W, H);
    for (const p of ps) {
      p.vy += 0.38; p.vx *= 0.99; p.x += p.vx; p.y += p.vy; p.r += p.vr;
      x.save(); x.translate(p.x, p.y); x.rotate(p.r);
      x.globalAlpha = Math.max(0, 1 - el / 2600);
      x.fillStyle = p.c; x.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2)) + 1);
      x.restore();
    }
    if (el < 2600) requestAnimationFrame(frame); else cv.remove();
  })(t0);
}

function celebrate(msg) { SFX.fanfare(); confetti(); if (msg) toast(msg); }

function toast(msg) {
  const t = document.createElement('div');
  t.className = 'toast';
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.classList.add('out'), 1900);
  setTimeout(() => t.remove(), 2200);
}

function loadEditors() {
  const k = editorKey();
  const ta = $('editor');
  ta.value = (state.months[k] ? state.months[k].lines : []).map((l) => l.text).join('\n');
  const ro = isPastView() && !pastEdit;
  ta.readOnly = ro;
  ta.closest('.hl-wrap').classList.toggle('readonly', ro);
  renderPastBar();
  $('editorFijos').value = state.fijos.map((l) => l.text).join('\n');
  renderHighlight($('editor'));
  renderHighlight($('editorFijos'));
}

function showView(name) {
  if (name !== currentView()) SFX.tick();
  if (name !== 'bancos') lockBank();
  document.querySelectorAll('#tabs button').forEach((x) => x.classList.toggle('active', x.dataset.view === name));
  document.querySelectorAll('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  if (name === 'ajustes') renderAjustes();
  if (name === 'bancos') renderBancos();
  if (name === 'mes') autoGrow($('editor'));
  if (name === 'compromisos') autoGrow($('editorFijos'));
  if (name === 'metas') { renderMetas(); renderProjectGoals(); }
  if (name === 'proyectos') renderProjects();
  if (name === 'monedas') { try { renderMonedas(); } catch (e) { console.error(e); } loadHistory(fxRange); }
  renderToolbar();
  window.scrollTo(0, 0);
  const v = $('view-' + name);
  if (v) { v.classList.remove('entering'); void v.offsetWidth; v.classList.add('entering'); clearTimeout(v._entT); v._entT = setTimeout(() => v.classList.remove('entering'), 1300); }
}

function init() {
  load();
  applyAnim();
  if (checkRollover()) toast('¡Nuevo mes! El anterior quedó en el Historial');
  loadEditors();

  $('tabs').addEventListener('click', (ev) => {
    const b = ev.target.closest('button[data-view]');
    if (b) showView(b.dataset.view);
  });
  $('btnSettings').addEventListener('click', () => showView(currentView() === 'ajustes' ? 'mes' : 'ajustes'));

  // Editores
  for (const ta of [$('editor'), $('editorFijos')]) {
    ta.addEventListener('input', (ev) => {
      if (ev.inputType === 'insertLineBreak' || (ev.inputType === 'insertText' && ev.data == null)) lineDoneSound(ta, ta.selectionStart);
      afterEdit(ta);
    });
    ta.addEventListener('focus', () => {
      if (matchMedia('(pointer: coarse)').matches) document.body.classList.add('typing');
      renderToolbar();
      if (ta.id === 'editor') updateSuggest();
    });
    ta.addEventListener('blur', () => {
      document.body.classList.remove('typing');
      setTimeout(renderToolbar, 0);
      if (ta.id === 'editor') setTimeout(updateSuggest, 0);
    });
  }
  document.addEventListener('selectionchange', () => {
    const a = document.activeElement;
    if (a && (a.id === 'editor' || a.id === 'editorFijos')) {
      renderToolbar();
      if (a.id === 'editor') updateSuggest();
    }
  });
  window.addEventListener('resize', () => { autoGrow($('editor')); autoGrow($('editorFijos')); });

  // Barra de botones (pointerdown evita que se cierre el teclado)
  const bar = $('toolbar');
  bar.addEventListener('pointerdown', (ev) => { if (ev.target.closest('button')) ev.preventDefault(); });
  bar.addEventListener('click', (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (!b.dataset.next) SFX.tap();
    if (b.dataset.type) applyType(b.dataset.type);
    else if (b.dataset.cur) applyCurrency(b.dataset.cur);
    else if (b.dataset.acc) applyAccount(b.dataset.acc);
    else if (b.dataset.budget) {
      const ta = activeEditor();
      const cl = currentLine(ta);
      const bm = BUDGET_RE.exec(cl.text);
      const same = bm && bm[2].toLowerCase() === b.dataset.budget;
      let t = cl.text.replace(new RegExp(BUDGET_RE.source, 'g'), '$1').replace(/\s+$/, '');
      if (!same) t += ` *${b.dataset.budget}`;
      replaceLine(ta, cl, t);
      afterEdit(ta);
    }
    else if (b.dataset.mode) {
      const ta = activeEditor();
      const cl = currentLine(ta);
      const clean = cl.text.replace(new RegExp(MODE_RE.source, 'gi'), '$1').replace(/\s+$/, '');
      replaceLine(ta, cl, `${clean} ${b.dataset.mode}`);
      afterEdit(ta);
    }
    else if (b.dataset.goto) showView(b.dataset.goto);
    else if (b.dataset.day) {
      const ta = activeEditor();
      const cl = currentLine(ta);
      replaceLine(ta, cl, cl.text.replace(/\s+$/, '') + ' @');
      afterEdit(ta);
    }
    else if (b.dataset.next) { const ta = activeEditor(); ta.focus(); jumpToNextLine(ta); lineDoneSound(ta, ta.selectionStart); afterEdit(ta); }
  });

  // Clics generales
  document.body.addEventListener('click', (ev) => {
    const done = ev.target.closest('[data-done]');
    const undo = ev.target.closest('[data-undo]');
    if (done) { state.status[done.dataset.done] = { done: true, ts: Date.now() }; SFX.done(); }
    if (undo) { delete state.status[undo.dataset.undo]; SFX.undo(); }
    if (done || undo) { save(); renderAll(); return; }

    const fp = ev.target.closest('[data-fijo-pay]');
    const ig = ev.target.closest('[data-ignore-pb]');
    if (ig) {
      const m = state.months[ig.dataset.ignorePb];
      m.ignorePB = !m.ignorePB;
      save(); renderHistorial(); toast(m.ignorePB ? 'Este mes ya no cuenta para el PB' : 'Este mes vuelve a contar para el PB');
      return;
    }
    const fu = ev.target.closest('[data-fijo-unpay]');
    if (fp || fu) {
      const k = state.currentKey;
      state.fijoPaid[k] = state.fijoPaid[k] || {};
      if (fp) { state.fijoPaid[k][fp.dataset.fijoPay] = Date.now(); SFX.done(); }
      else { delete state.fijoPaid[k][fu.dataset.fijoUnpay]; SFX.undo(); }
      save(); renderAll(); return;
    }
    const ar = ev.target.closest('[data-arrive]');
    if (ar) { openForm = ar.dataset.arrive; renderCompromisos(); return; }
    if (ev.target.closest('[data-arr-cancel]')) { openForm = null; renderCompromisos(); return; }
    const ok = ev.target.closest('[data-arr-ok]');
    if (ok) { confirmArrive(ok.dataset.arrOk, ok.closest('.arrive')); return; }
    const mv = ev.target.closest('[data-move]');
    if (mv) { moveEncargo(mv.dataset.move); return; }

    const mb = ev.target.closest('[data-month]');
    if (mb) { selectedHistKey = mb.dataset.month; candleSel = null; renderHistorial(); return; }
    if (ev.target.closest('#monthTitle')) { calendarOpen = !calendarOpen; SFX.pop(); renderHeader(); renderCalendar(); return; }
    const calB = ev.target.closest('[data-cal]');
    if (calB) { viewMonth(calB.dataset.cal); return; }
    if (ev.target.closest('[data-back-now]')) { viewMonth(state.currentKey); return; }
    if (ev.target.closest('[data-edit-past]')) { pastEdit = !pastEdit; loadEditors(); renderToolbar(); if (pastEdit) $('editor').focus(); return; }
    if (ev.target.closest('[data-chart-size]')) { state.settings.chartsBig = !state.settings.chartsBig; save(); renderHistorial(); return; }
    const bt = ev.target.closest('.block[data-collapse-id] > .block-title, .block[data-collapse-id] > .block-head > .block-title');
    if (bt) {
      const blk = bt.closest('[data-collapse-id]');
      const id = blk.dataset.collapseId;
      state.settings.collapsed = state.settings.collapsed || {};
      state.settings.collapsed[id] = !state.settings.collapsed[id];
      blk.classList.toggle('collapsed', state.settings.collapsed[id]);
      save(); return;
    }
    const cd = ev.target.closest('[data-cday]');
    if (cd) { const d = Number(cd.dataset.cday); candleSel = candleSel === d ? null : d; renderHistorial(); return; }
    const ct = ev.target.closest('[data-cmpt]');
    if (ct) { compareTarget = ct.dataset.cmpt; renderHistorial(); return; }
    const cb = ev.target.closest('[data-cmp]');
    if (cb) { compareMode = cb.dataset.cmp; renderHistorial(); return; }

    const sw = ev.target.closest('[data-swatch]');
    if (sw) { newAccColor = sw.dataset.swatch; renderBancos(); return; }
    const del = ev.target.closest('[data-del-acc]');
    if (del) {
      const a = accountById(del.dataset.delAcc);
      if (a && confirm(`¿Eliminar la cuenta "${a.name}"? Tus movimientos no se borran.`)) {
        state.accounts = state.accounts.filter((x) => x.id !== a.id);
        if (state.settings.defaultAccount === a.id) state.settings.defaultAccount = '';
        save(); renderAll();
      }
      return;
    }
    const rb = ev.target.closest('[data-rebase]');
    if (rb) {
      const a = accountById(rb.dataset.rebase);
      a.initial = Number(a.real); a.startTs = Date.now(); a.real = null;
      save(); renderBancos(); toast('Listo: la cuenta empieza desde su saldo real');
      return;
    }
    const rm = ev.target.closest('[data-rm-cur]');
    if (rm) {
      const c = rm.dataset.rmCur;
      state.settings.currencies = state.settings.currencies.filter((x) => x !== c);
      const first = state.settings.currencies[0];
      if (state.settings.defaultCurrency === c) state.settings.defaultCurrency = first;
      if (state.settings.displayCurrency === c) state.settings.displayCurrency = first;
      save(); renderAll();
    }
  });

  // Conversor y accesos desde la ventana principal
  $('curSwitch').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-disp]');
    if (!b) return;
    state.settings.displayCurrency = b.dataset.disp;
    save(); renderAll();
  });
  $('fxRange').addEventListener('click', (ev) => {
    if (ev.target.closest('[data-fx-reload]')) {
      for (const d of fxDates(fxRange)) delete state.rateHistory[d];
      fxFailed = false;
      fetchRates(true);
      loadHistory(fxRange);
      return;
    }
    const b = ev.target.closest('[data-fx]');
    if (!b) return;
    fxRange = b.dataset.fx;
    renderMonedas();
    loadHistory(fxRange);
  });
  $('reminders').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-goto]');
    if (b) showView(b.dataset.goto);
  });

  // Proyectos
  $('btnAddProject').addEventListener('click', () => {
    const name = $('projName').value.trim();
    if (!name) { toast('Ponle un nombre al proyecto'); return; }
    const tag = projectSlug(name);
    if (projectByTag(tag)) { toast('Ya tienes un proyecto con ese nombre'); return; }
    state.projects.push({ id: uid(), name, tag, currency: $('projCurrency').value, cushion: 10,
      startDate: isoDate(new Date()), planMode: 'duracion',
      durMonths: parseInt($('projMonths').value, 10) || 0, durDays: parseInt($('projDays').value, 10) || 0,
      end: null, text: $('projText').value.trim(), closed: {}, isGoal: $('projIsGoal').checked, goalPct: null, done: null });
    for (const id of ['projName', 'projText', 'projMonths', 'projDays']) $(id).value = '';
    $('projIsGoal').checked = false;
    save(); renderProjects(); renderToolbar(); toast('Proyecto creado');
  });
  const projList = $('projectsList');
  let ptextTimer = null;
  projList.addEventListener('input', (ev) => {
    const id = ev.target.dataset.ptext;
    if (!id) return;
    const p = state.projects.find((x) => x.id === id);
    p.text = ev.target.value;
    renderProjBack(p);
    clearTimeout(ptextTimer);
    ptextTimer = setTimeout(() => { save(); refreshProjectBody(id); renderProjBack(p); renderReminders(); }, 250);
  });
  projList.addEventListener('change', (ev) => {
    const card = ev.target.closest('[data-proj-id]');
    const f = ev.target.dataset.p;
    if (!card || !f) return;
    const p = state.projects.find((x) => x.id === card.dataset.projId);
    const v = ev.target.value;
    if (f === 'name') {
      const name = v.trim();
      const tag = projectSlug(name);
      if (!name || (projectByTag(tag) && projectByTag(tag).id !== p.id)) { toast('Nombre no válido o repetido'); renderProjects(); return; }
      renameProjectTags(p.tag, tag);
      p.name = name; p.tag = tag;
      loadEditors();
    } else if (f === 'cushion') p.cushion = Math.max(0, parseFloat(v) || 0);
    else if (f === 'durMonths' || f === 'durDays') p[f] = Math.max(0, parseInt(v, 10) || 0);
    else if (f === 'goalPct') p.goalPct = v === '' ? null : Math.min(100, Math.max(1, parseFloat(v) || 0)) || null;
    else if (f === 'isGoal') p.isGoal = ev.target.checked;
    else p[f] = v || null;
    save(); renderAll();
  });
  projList.addEventListener('click', (ev) => {
    const t = ev.target;
    const dn = t.closest('[data-proj-done]');
    if (dn) {
      const p = state.projects.find((x) => x.id === dn.dataset.projDone);
      if (!confirm(`¿Marcar "${p.name}" como completado? Se detiene el contador y sus partidas mensuales.`)) return;
      const c = projectCalc(p);
      p.done = Date.now();
      p.doneStars = c.goal ? c.goal.stars : null;
      save(); renderAll(); celebrate('¡Proyecto completado!');
      return;
    }
    const ro = t.closest('[data-proj-reopen]');
    if (ro) {
      const p = state.projects.find((x) => x.id === ro.dataset.projReopen);
      p.done = null; p.doneStars = null;
      save(); renderAll();
      return;
    }
    const del = t.closest('[data-del-proj]');
    if (del) {
      const p = state.projects.find((x) => x.id === del.dataset.delProj);
      if (p && confirm(`¿Eliminar el proyecto "${p.name}"? Tus gastos no se borran.`)) {
        state.projects = state.projects.filter((x) => x.id !== p.id);
        save(); renderAll();
      }
      return;
    }
    const open = t.closest('[data-pay-open]');
    if (open) { openPay = openPay === open.dataset.payOpen ? null : open.dataset.payOpen; refreshProjectBody(open.dataset.payOpen.split(':')[0]); return; }
    const cancel = t.closest('[data-pay-cancel]');
    if (cancel) { const id = openPay && openPay.split(':')[0]; openPay = null; if (id) refreshProjectBody(id); return; }
    const ok = t.closest('[data-pay-ok]');
    if (ok) { payItem(ok.dataset.payOk, ok.closest('.buy-form')); return; }
    const cl = t.closest('[data-close-item]');
    if (cl) {
      const [pid, slug] = cl.dataset.closeItem.split(':');
      const p = state.projects.find((x) => x.id === pid);
      p.closed = p.closed || {};
      if (p.closed[slug]) delete p.closed[slug]; else p.closed[slug] = true;
      save(); refreshProjectBody(pid); renderReminders();
    }
  });

  // Metas
  $('btnAddGoal').addEventListener('click', () => {
    const name = $('goalName').value.trim();
    const target = parseFloat($('goalTarget').value);
    if (!name) { toast('Ponle un nombre a la meta'); return; }
    if (!(target > 0)) { toast('Escribe el monto objetivo'); return; }
    if (!$('goalDate').value) { toast('Elige la fecha límite'); return; }
    const pct = parseFloat($('goalPct').value);
    state.goals.push({
      id: uid(), createdTs: Date.now(), name, target, currency: $('goalCurrency').value,
      pct: pct > 0 && pct <= 100 ? pct : null, date: $('goalDate').value, achieved: null,
    });
    for (const id of ['goalName', 'goalTarget', 'goalPct', 'goalDate']) $(id).value = '';
    save(); renderMetas(); renderReminders(); toast('Meta agregada');
  });
  $('goalsList').addEventListener('change', (ev) => {
    const card = ev.target.closest('[data-goal-id]');
    const f = ev.target.dataset.g;
    if (!card || !f) return;
    const g = state.goals.find((x) => x.id === card.dataset.goalId);
    const v = ev.target.value;
    if (f === 'target') g[f] = parseFloat(v) || 0;
    else if (f === 'pct') g.pct = v === '' ? null : Math.min(100, Math.max(1, parseFloat(v) || 0)) || null;
    else if (f === 'name') g.name = v.trim() || g.name;
    else g[f] = v;
    save(); renderMetas(); renderReminders();
  });
  $('goalsList').addEventListener('click', (ev) => {
    const ach = ev.target.closest('[data-achieve]');
    if (ach) {
      const g = state.goals.find((x) => x.id === ach.dataset.achieve);
      let party = false;
      if (g.achieved) { g.achieved = null; g.achievedStars = null; SFX.undo(); }
      else { const c = goalCalc(g); g.achieved = Date.now(); g.achievedStars = c.stars; party = true; }
      save(); renderMetas(); renderReminders();
      if (party) celebrate(`¡Meta lograda!${g.achievedStars ? ' ' + '★'.repeat(g.achievedStars) : ''}`);
      if (party) { const el = document.querySelector(`[data-goal-id="${g.id}"]`); if (el) el.classList.add('just-done'); }
      return;
    }
    const del = ev.target.closest('[data-del-goal]');
    if (!del) return;
    const g = state.goals.find((x) => x.id === del.dataset.delGoal);
    if (g && confirm(`¿Eliminar la meta "${g.name}"?`)) {
      state.goals = state.goals.filter((x) => x.id !== g.id);
      save(); renderMetas(); renderReminders();
    }
  });

  // PIN
  $('btnUnlock').addEventListener('click', tryUnlock);
  for (const id of ['pinInput', 'pinInput2']) $(id).addEventListener('keydown', (e) => { if (e.key === 'Enter') tryUnlock(); });
  $('btnLock').addEventListener('click', () => { lockBank(); });
  $('btnChangePin').addEventListener('click', () => {
    const p1 = $('newPin').value.trim(), p2 = $('newPin2').value.trim();
    if (!/^\d{4,12}$/.test(p1)) { toast('El PIN debe tener de 4 a 12 números'); return; }
    if (p1 !== p2) { toast('Los PIN no coinciden'); return; }
    state.settings.pinHash = pinHash(p1);
    $('newPin').value = ''; $('newPin2').value = '';
    save(); toast('PIN actualizado');
  });

  // Mensual: elegir cuenta
  $('listFijos').addEventListener('change', (ev) => {
    const sel = ev.target.closest('[data-fijo-acc]');
    if (!sel) return;
    const line = state.fijos.find((l) => l.id === sel.dataset.fijoAcc);
    const em = line && matchEntry(line.text);
    if (!em) return;
    const acc = accountById(sel.value);
    const pfx = acc ? acc.prefix : '';
    line.text = em.prefixRange
      ? line.text.slice(0, em.prefixRange[0]) + pfx + line.text.slice(em.prefixRange[1])
      : line.text.slice(0, em.amountRange[1]) + pfx + line.text.slice(em.amountRange[1]);
    loadEditors(); save(); renderAll();
  });

  // Cuentas
  $('accName').addEventListener('input', () => {
    if (!$('accPrefix').dataset.touched) $('accPrefix').value = freePrefixFor($('accName').value || 'A');
  });
  $('accPrefix').addEventListener('input', () => { $('accPrefix').dataset.touched = '1'; });
  $('btnAddAccount').addEventListener('click', () => {
    const name = $('accName').value.trim();
    const prefix = $('accPrefix').value.trim() || freePrefixFor(name);
    if (!name) { toast('Ponle un nombre a la cuenta'); return; }
    if (!validPrefix(prefix)) { toast('El prefijo: 1 mayúscula y opcional 1 minúscula (B, Bc) o un símbolo'); return; }
    if (accountByPrefix(prefix)) { toast(`El prefijo "${prefix}" ya lo usa otra cuenta`); return; }
    state.accounts.push({
      id: uid(), name, prefix, color: newAccColor, currency: $('accCurrency').value,
      initial: parseFloat($('accInitial').value) || 0, startTs: Date.now(), real: null, note: '',
    });
    $('accName').value = ''; $('accInitial').value = ''; $('accPrefix').value = ''; delete $('accPrefix').dataset.touched;
    newAccColor = COLOR_PRESETS[state.accounts.length % COLOR_PRESETS.length];
    save(); renderAll(); toast('Cuenta agregada');
  });
  $('accountsList').addEventListener('change', (ev) => {
    const card = ev.target.closest('[data-acc-id]');
    const f = ev.target.dataset.f;
    if (!card || !f) return;
    const a = accountById(card.dataset.accId);
    const v = ev.target.value;
    if (f === 'name') {
      const name = v.trim();
      if (!name) { toast('Ponle un nombre'); renderBancos(); return; }
      renameAccountTags(slugOf(a.name), slugOf(name));
      a.name = name;
      loadEditors();
    } else if (f === 'prefix') {
      const p = v.trim();
      const other = accountByPrefix(p);
      if (!validPrefix(p) || (other && other.id !== a.id)) { toast('Prefijo no válido o repetido'); renderBancos(); return; }
      changePrefixInText(a.prefix, p);
      a.prefix = p;
      loadEditors();
    } else if (f === 'initial') a.initial = parseFloat(v) || 0;
    else if (f === 'real') a.real = v === '' ? null : parseFloat(v);
    else a[f] = v;
    save();
    if (f === 'note') return; // no hace falta redibujar
    renderAll();
  });
  $('setDefaultAccount').addEventListener('change', (e) => { state.settings.defaultAccount = e.target.value; save(); renderAll(); });

  // Ajustes
  const addCurrency = () => {
    const c = ($('newCur').value.trim().split(/[\s·—-]/)[0] || '').toUpperCase();
    const names = state.currencyNames || {};
    const known = names[c.toLowerCase()] || isFiat(c);
    if (!/^[A-Z0-9]{2,6}$/.test(c) || !known) { toast('No encuentro esa moneda. Prueba con su código: EUR, MXN, USDT, BTC…'); return; }
    if (!state.settings.currencies.includes(c)) state.settings.currencies.push(c);
    $('newCur').value = '';
    save(); renderMonedas(); renderAll(); loadHistory(fxRange);
    if (!state.rates || !state.rates.rates[c]) fetchRates(true);
  };
  $('btnAddCur').addEventListener('click', addCurrency);
  $('newCur').addEventListener('keydown', (e) => { if (e.key === 'Enter') addCurrency(); });
  // Calculadora de monedas
  $('calcInput').addEventListener('input', renderConverter);
  $('calcTo').addEventListener('change', renderConverter);
  $('calcExamples').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-calc]');
    if (b) { $('calcInput').value = b.dataset.calc; renderConverter(); }
  });
  $('cmpPick').addEventListener('click', (ev) => {
    const b = ev.target.closest('[data-cmp-cur]');
    if (!b) return;
    const c = b.dataset.cmpCur;
    cmpSel = cmpSel.includes(c) ? cmpSel.filter((x) => x !== c) : [...cmpSel, c];
    renderCompare();
  });
  $('fxStatus').addEventListener('click', (ev) => {
    if (ev.target.closest('[data-fx-retry]')) { fxFailed = false; loadHistory(fxRange); }
  });
  // Pruebas (debug)
  $('btnTestMonth').addEventListener('click', () => { const k = addTestMonth(); toast(`Mes de prueba creado: ${monthName(k)}`); renderAll(); renderAjustes(); });
  $('btnTestClear').addEventListener('click', () => {
    const n = Object.values(state.months).filter((m) => m.test).length;
    if (!n) { toast('No hay meses de prueba'); return; }
    if (!confirm(`¿Borrar ${n} mes(es) de prueba?`)) return;
    for (const [k, m] of Object.entries(state.months)) if (m.test) delete state.months[k];
    selectedHistKey = null; save(); renderAll(); renderAjustes(); toast('Meses de prueba borrados');
  });
  $('setDefaultCur').addEventListener('change', (e) => { state.settings.defaultCurrency = e.target.value; save(); renderAll(); });
  $('setDisplayCur').addEventListener('change', (e) => { state.settings.displayCurrency = e.target.value; save(); renderAll(); });
  $('setSound').addEventListener('change', (e) => { state.settings.sound = e.target.checked; save(); if (e.target.checked) SFX.coin(); });
  $('setVolume').addEventListener('change', (e) => { state.settings.volume = parseFloat(e.target.value); save(); SFX.coin(); });
  $('setAnim').addEventListener('change', (e) => { state.settings.anim = e.target.checked; save(); applyAnim(); if (e.target.checked) confetti(60); });
  $('setManualRate').addEventListener('change', (e) => { state.settings.manualRate = parseFloat(e.target.value) || 3.75; save(); renderAll(); renderRateStatus(); });
  $('btnRates').addEventListener('click', () => fetchRates(true));

  $('btnExport').addEventListener('click', () => {
    save();
    const blob = new Blob([JSON.stringify(state, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    const d = new Date();
    a.href = URL.createObjectURL(blob);
    a.download = `mis-finanzas-${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  });
  $('fileImport').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      const s = JSON.parse(await f.text());
      if (!s.months || !s.settings) throw new Error('formato');
      if (!confirm('¿Reemplazar todos tus datos actuales por los de esta copia?')) return;
      adopt(s);
      checkRollover();
      save();
      loadEditors();
      renderAll();
      renderAjustes();
      toast('Copia importada');
    } catch {
      toast('Ese archivo no es una copia válida');
    }
    e.target.value = '';
  });

  setInterval(() => {
    if (checkRollover()) { selectedHistKey = null; pastEdit = false; loadEditors(); renderAll(); toast('¡Nuevo mes! El anterior quedó en el Historial'); }
  }, 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { save(); if (currentView() === 'bancos') lockBank(); }
  });

  // bloques que dejaste minimizados
  for (const [id, on] of Object.entries(state.settings.collapsed || {})) {
    const el = document.querySelector(`[data-collapse-id="${id}"]`);
    if (el) el.classList.toggle('collapsed', !!on);
  }
  renderAll();
  fetchRates();

  if (navigator.storage && navigator.storage.persist) navigator.storage.persist().catch(() => {});
  const secure = location.protocol === 'https:' || ['localhost', '127.0.0.1'].includes(location.hostname);
  if ('serviceWorker' in navigator && secure) navigator.serviceWorker.register('sw.js').catch(() => {});
}

if (typeof document !== 'undefined') init();
