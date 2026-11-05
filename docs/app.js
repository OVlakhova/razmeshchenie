'use strict';
// Размещение книг по ячейкам — приложение для телефона.
// Сканер работает как клавиатура: печатает код и Enter в скрытое поле.

const API = window.RAZM_API ||
  'https://script.google.com/macros/s/AKfycbxzKklN_XquWi7e9ZKml2iGv7lnRI_gpab86hkXPs7SxT-FT3N4hD2cqfMTwvAksUxyPw/exec';
const APP_VERSION = '1.9';
const ORDERS_EVERY_MS = 3 * 60 * 1000;      // вкладка «Заказы» открыта — обновлять раз в 3 минуты
const CATALOG_EVERY_MS = 10 * 60 * 1000;     // пока приложение открыто — обновлять справочник раз в 10 минут
const CATALOG_STALE_MS = 30 * 60 * 1000;     // старше — кнопка «Справочник» жёлтая
const RECENT_MS = 30 * 60 * 1000;            // свои пики помним 30 минут и накладываем поверх свежего справочника
const SYNC_EVERY_MS = 5000;
const DOUBLE_SCAN_MS = 1500;
const HOLD_MS = 2000;
const autoCloseMs = () => window.RAZM_AUTO_CLOSE_MS || 5 * 60 * 1000;   // 5 минут без пиков: последняя книга записывается, ячейка отпускается
const MANUAL_MAX = { L: 45, W: 45, H: 15 };                               // больше — переспросить (опечатка?)

// ------------------------------------------------------------ коды
const Codes = {
  norm: v => String(v == null ? '' : v).trim(),
  ean13ok(s) {
    if (!/^\d{13}$/.test(s)) return false;
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(s[i]) * (i % 2 ? 3 : 1);
    return (10 - sum % 10) % 10 === Number(s[12]);
  },
  classify(raw) {
    const s = Codes.norm(raw);
    if (s === '991999999') return { kind: 'desk', code: s };
    if (/^991\d{6}$/.test(s)) return { kind: 'cell', code: s, cell: Codes.cellName(s) };
    if (/^\d{12,13}$/.test(s)) return { kind: 'book', code: s, checksumOk: s.length === 13 && Codes.ean13ok(s) };
    return { kind: 'invalid', code: s };
  },
  cellName(code) {
    const m = /^991(\d{3})(\d{3})$/.exec(code);
    return m ? `С${Number(m[1])}-П${Number(m[2])}` : '';
  },
  /** "5-480-00056-Х" (ISBN-10, русская или латинская Х) -> EAN-13 */
  isbn10to13(isbn) {
    const s = String(isbn || '').toUpperCase().replace(/Х/g, 'X').replace(/[^0-9X]/g, '');
    if (!/^\d{9}[\dX]$/.test(s)) return '';
    const b = '978' + s.slice(0, 9);
    let sum = 0;
    for (let i = 0; i < 12; i++) sum += Number(b[i]) * (i % 2 ? 3 : 1);
    return b + ((10 - sum % 10) % 10);
  },
  short(name) {  // "Развертка - 5 см." -> "Разв·5", "201 - 2 см." -> "201·2"
    const m = /^(.+?)\s*-\s*(\d+)\s*см/.exec(name || '');
    if (!m) return name || '';
    return (m[1] === 'Развертка' ? 'Разв' : m[1]) + '·' + m[2];
  }
};

// ------------------------------------------------------------ хранилище (IndexedDB)
const DB = {
  db: null,
  open() {
    return new Promise((res, rej) => {
      const r = indexedDB.open('razm', 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('kv');
        r.result.createObjectStore('queue', { keyPath: 'id' });
      };
      r.onsuccess = () => { DB.db = r.result; res(); };
      r.onerror = () => rej(r.error);
    });
  },
  tx(store, mode, fn) {
    return new Promise((res, rej) => {
      const t = DB.db.transaction(store, mode);
      const out = fn(t.objectStore(store));
      t.oncomplete = () => res(out && out.result !== undefined ? out.result : undefined);
      t.onerror = () => rej(t.error);
    });
  },
  get: k => DB.tx('kv', 'readonly', s => s.get(k)),
  set: (k, v) => DB.tx('kv', 'readwrite', s => s.put(v, k)),
  qAll: () => DB.tx('queue', 'readonly', s => s.getAll()),
  qPut: ev => DB.tx('queue', 'readwrite', s => s.put(ev)),
  qDel: id => DB.tx('queue', 'readwrite', s => s.delete(id)),
};

// ------------------------------------------------------------ состояние
const S = {
  key: '', user: '', device: '',
  mode: 'place',               // 'place' | 'find' | 'orders'
  orders: [], ordersAt: '', ordersErr: '', ordersLoading: false, picked: {},   // заказы WB (только чтение)
  cell: '',                    // активная ячейка
  catalog: {}, packages: [], catalogAt: '',
  current: null,               // текущий пик, ещё не поставлен в очередь: {ev, book, needsPkg}
  lastPkg: null,               // упаковка прошлой книги
  shelf: [],                   // пики на текущей полке: {id, barcode, title, pkg, prevC, queued}
  counts: {},                  // штрихкод -> сколько экземпляров пикнуто на этой полке
  queued: 0, online: navigator.onLine, syncing: false, problems: [],
  tableErr: '', table: '', busy: false,
  lastActivity: 0,             // время последнего действия — для сброса ячейки после перерыва
  pkgByCode: {},
  rejected: {},                // id пика -> причина, если таблица его не приняла
  recent: {},                  // штрихкод -> {cell, at}: свои недавние пики (справочник с сервера мог их ещё не увидеть)               // упаковка, выбранная на этой полке для штрихкода (для 2-го, 3-го экземпляра)
  lastScan: { code: '', at: 0 },
  pendingMove: null, pendingUnknown: null,
};

const $ = id => document.getElementById(id);
const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

// ------------------------------------------------------------ звук и вибрация
let audio;
function beep(kind) {
  try {
    audio = audio || new (window.AudioContext || window.webkitAudioContext)();
    const plan = { ok: [[880, .08]], warn: [[520, .1], [520, .1]], bad: [[220, .35]] }[kind] || [[660, .08]];
    let t = audio.currentTime;
    plan.forEach(([f, d]) => {
      const o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = f; g.gain.value = .15; o.connect(g); g.connect(audio.destination);
      o.start(t); o.stop(t + d); t += d + .06;
    });
  } catch (e) { /* без звука */ }
  try { navigator.vibrate && navigator.vibrate(kind === 'bad' ? [200, 80, 200] : kind === 'warn' ? [80, 60, 80] : 40); } catch (e) {}
}

// ------------------------------------------------------------ сеть
async function api(method, params, body) {
  const url = API + '?' + new URLSearchParams(Object.assign({ key: S.key }, params || {}));
  let r, j;
  try {
    r = await fetch(url, method === 'GET' ? {} : {
      method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' },
      body: JSON.stringify(Object.assign({ key: S.key, device: S.device }, body))
    });
  } catch (e) { throw Object.assign(new Error('нет сети'), { net: true }); }
  try { j = await r.json(); }
  catch (e) { throw new Error('таблица ответила не так — скрипт не опубликован или нужно разрешение'); }
  if (!j.ok) throw new Error(j.error || 'ошибка таблицы');
  if (j.table) S.table = j.table;
  return j;
}

let catalogLoading = null;
/** force — обновить сейчас; иначе только если справочник старше maxAge (по умолчанию 10 минут). */
function loadCatalog(force, maxAge) {
  if (!force && S.catalogAt && Date.now() - Date.parse(S.catalogAt) < (maxAge || CATALOG_EVERY_MS)) return Promise.resolve(true);
  if (!catalogLoading) catalogLoading = fetchCatalog().finally(() => { catalogLoading = null; });
  return catalogLoading;
}
async function fetchCatalog() {
  try {
    const j = await api('GET', { action: 'catalog' });
    S.catalog = j.books || {}; S.packages = j.packages || []; S.catalogAt = j.version || new Date().toISOString();
    await overlayQueue();
    await DB.set('catalog', { books: S.catalog, packages: S.packages, at: S.catalogAt, table: S.table });
    netOk(); renderPackages(); renderTop(); renderOrders();
    return true;
  } catch (e) {
    netFail(e); renderTop();
    return false;
  }
}

async function sync() {
  if (S.syncing || !S.key) return;
  const q = (await DB.qAll()).sort((a, b) => a.seq - b.seq);
  S.queued = q.length; renderTop();
  if (!q.length) return;
  S.syncing = true;
  try {
    const batch = q.slice(0, 50).map(({ seq, ...ev }) => ev);
    const j = await api('POST', {}, { events: batch });
    let refused = false;
    for (const r of j.results || []) {
      if (!['ok', 'уже получено', 'отменено', 'уже отменено'].includes(r.result)) {
        const ev = batch.find(e => e.id === r.id) || {};
        const title = ev.title || (S.catalog[ev.barcode] || {}).t || ev.barcode || '';
        if (ev.barcode && S.recent[ev.barcode]) delete S.recent[ev.barcode];
        const what = ev.type === 'undo' ? 'отмена: ' : ev.fixOf ? 'упаковка: ' : '';
        S.problems.unshift(`${title} — ${what}${r.result.replace(/^ошибка: /, '')}`);
        S.problems = S.problems.slice(0, 10);
        if (ev.type !== 'undo') {
          const pick = ev.fixOf || ev.id;
          S.rejected[pick] = { why: (ev.fixOf ? 'упаковка не принята: ' : '') + r.result.replace(/^ошибка: /, ''), pickOk: !!ev.fixOf };
          const it = S.shelf.find(x => x.id === pick);
          if (it && !ev.fixOf && S.counts[it.barcode]) S.counts[it.barcode]--;   // книга не на этой полке — можно пикнуть снова
        }
        refused = true;
      }
      await DB.qDel(r.id);
    }
    if (refused) {
      const ids = Object.keys(S.rejected); if (ids.length > 300) ids.slice(0, ids.length - 300).forEach(k => delete S.rejected[k]);
      await DB.set('recent', S.recent); await DB.set('rejected', S.rejected); await DB.set('problems', S.problems);
      await saveSession(); renderShelf();
      setTimeout(() => loadCatalog(true), 0);                    // справочник — по правде таблицы
    }
    netOk();
  } catch (e) {
    netFail(e);
  } finally {
    S.syncing = false;
    S.queued = (await DB.qAll()).length;
    renderTop(); renderProblems();
  }
}

function netOk() { S.online = true; S.tableErr = ''; }
function netFail(e) {
  if (e && e.net) { S.online = false; S.tableErr = ''; }
  else { S.online = true; S.tableErr = String((e && e.message) || e); }
}

/** Пики, ещё не дошедшие до таблицы, должны оставаться видны в справочнике. */
async function overlayQueue() {
  const now = Date.now();
  for (const b in S.recent) {
    if (now - S.recent[b].at > RECENT_MS) { delete S.recent[b]; continue; }
    if (S.catalog[b]) S.catalog[b].c = S.recent[b].cell;
  }
  (await DB.qAll()).sort((a, b) => a.seq - b.seq).forEach(ev => {
    if (ev.type !== 'undo' && ev.barcode && S.catalog[ev.barcode]) S.catalog[ev.barcode].c = ev.cell;
  });
}

async function remember(barcode, cell) {
  if (!barcode) return;
  S.recent[barcode] = { cell: cell || '', at: Date.now() };
  await DB.set('recent', S.recent);
}

let seq = Date.now();
async function enqueue(ev) {
  ev.seq = seq++;
  await DB.qPut(ev);
  S.queued++; renderTop();
}

// ------------------------------------------------------------ упаковки
function pkgByDims(d) {
  if (!d) return null;
  const p = S.packages.find(p => !p.manual && p.L === d[0] && p.W === d[1] && p.H === d[2]);
  return p ? { name: p.name, L: p.L, W: p.W, H: p.H } : { name: 'Ручная', L: d[0], W: d[1], H: d[2] };
}

function pkgLabel(p) {
  if (!p) return '';
  return p.name === 'Ручная' ? `Ручная ${p.L}×${p.W}×${p.H}` : Codes.short(p.name);
}

// ------------------------------------------------------------ сканы
async function onScan(raw) {
  const code = Codes.classify(raw);
  const now = Date.now();
  if (code.code === S.lastScan.code && now - S.lastScan.at < DOUBLE_SCAN_MS) return;  // двойной пик
  S.lastScan = { code: code.code, at: now };
  S.lastActivity = now;
  S.lastUndoAt = 0; S.undoArmed = null;
  if (S.busy) { beep('bad'); show('warn', 'ПОДОЖДИТЕ', '', 'Обновляю справочник', 'Пикните ещё раз через пару секунд'); S.lastScan = { code: '', at: 0 }; return; }
  hideActions();
  const accepted = await handleScan(code);
  if (!accepted) S.lastScan = { code: '', at: 0 };   // отклонённый пик можно сразу повторить
}

/** true — пик принят; false — отклонён (повторный пик того же кода не считается двойным). */
async function handleScan(code) {

  if (code.kind === 'invalid') {
    show('bad', 'НЕКОРРЕКТНЫЙ КОД', '', `«${code.code}» — это не штрихкод`, 'Пик не принят');
    return false;
  }
  if (code.kind === 'desk') { await setMode('find'); return true; }
  if (S.mode === 'find') { code.kind === 'cell' ? showFindCell(code) : showFind(code); return true; }
  if (S.mode === 'orders') { orderScan(code); return true; }

  if (code.kind === 'cell') {
    if (!await commitCurrent()) return false;
    if (S.cell !== code.cell) { S.cell = code.cell; S.shelf = []; S.counts = {}; S.pkgByCode = {}; }
    await saveSession();
    beep('ok');
    render();
    show('info', 'ЯЧЕЙКА', '', code.cell, 'Пикайте книги, которые ставите на эту полку');
    return true;
  }

  // книга
  if (!S.cell) { beep('bad'); show('bad', 'СНАЧАЛА ЯЧЕЙКА', '', 'Пикните этикетку ячейки', 'Книга не записана'); return false; }
  if (!await commitCurrent()) return false;
  const book = S.catalog[code.code];
  const warn = code.checksumOk || code.code.length !== 13 ? '' : 'Проверьте штрихкод: контрольная цифра не сходится';

  if (!book && !code.recheck && navigator.onLine && (!S.catalogAt || Date.now() - Date.parse(S.catalogAt) > 30 * 1000)) {
    S.busy = true; renderTop();
    show('info', 'ИЩУ В ТАБЛИЦЕ', '', code.code, 'Книги нет в справочнике телефона — обновляю его');
    await loadCatalog(true);
    S.busy = false; renderTop();
    return handleScan(Object.assign({}, code, { recheck: true }));
  }
  if (!book) {
    S.pendingUnknown = code.code;
    beep('bad');
    show('bad', 'НЕИЗВЕСТНЫЙ ШТРИХКОД', '', code.code, `Нет в справочнике (обновлён в ${hhmm(S.catalogAt)}). Отложите книгу или сохраните — таблица проверит при отправке.`, isbnHint(code.code));
    $('unknownActions').classList.remove('hidden');
    return false;
  }
  if (!book.n) {   // не новая книга: есть только в архиве или 1С
    const where = book.s['1c'] || book.s.arch || '—';
    beep('warn');
    show('gray', 'НЕ НОВАЯ КНИГА', 'Место: ' + where, book.t, [book.a, 'новые книги ставятся из «Лист1»'].filter(Boolean).join(' · '), isbnHint(code.code));
    return false;
  }
  if (book.c && book.c !== S.cell) {
    S.pendingMove = { code, book };
    beep('bad');
    show('bad', 'УЖЕ РАЗМЕЩЕНА', 'на ' + book.c, book.t, 'Эту книгу на эту полку не ставим. Артикул остаётся прежним.', isbnHint(code.code));
    $('moveActions').classList.remove('hidden');
    $('moveNo').textContent = `Понятно, отнесу на ${book.c}`;
    return false;
  }
  const q = book.q || 1;
  if ((S.counts[code.code] || 0) >= q) {   // эту книгу уже пикнули на этой полке столько раз, сколько экземпляров в таблице
    beep('warn');
    show('warn', 'УЖЕ ПИКНУТА', S.cell, book.t,
         q > 1 ? `Все ${q} экземпляра уже пикнуты. Повторный пик не записан.` : 'Эта книга уже пикнута на этой полке. Повторный пик не записан — отменять ничего не нужно.',
         'Если таких книг правда больше — поправьте «Количество» в таблице.');
    return true;
  }
  await startCurrent(code, book, 'place', warn);
  return true;
}

async function startCurrent(code, book, type, warn) {
  const fromTable = pkgByDims(book.d);
  const ev = { id: uid(), ts: new Date().toISOString(), type, cell: S.cell, barcode: code.code, pkg: null };
  let needsPkg = false;
  if (!fromTable) {
    const same = S.pkgByCode[code.code];          // тот же штрихкод уже был на этой полке — та же книга, та же упаковка
    if (same) ev.pkg = Object.assign({}, same); else needsPkg = true;
  }
  S.counts[code.code] = (S.counts[code.code] || 0) + 1;
  S.current = { ev, book, needsPkg, fromTable, prevC: book.c || '', touchedAt: Date.now() };
  await DB.set('current', S.current);
  await saveSession();
  const n = S.counts[code.code], q = book.q || 1;
  let lbl = book.c === S.cell ? 'УЖЕ НА ЭТОЙ ПОЛКЕ' : 'НОВОЕ МЕСТО · ' + S.cell, kind = 'ok';
  let meta = [book.a, code.code].filter(Boolean).join(' · ');
  if (q > 1) { lbl = `ЭКЗЕМПЛЯР ${n} ИЗ ${q}`; kind = 'info'; meta = n < q ? `Пикните ещё ${q - n} — они должны стоять здесь же` : 'Все экземпляры на месте'; }
  if (n > q) { lbl = `ЭКЗЕМПЛЯР ${n}, А В ТАБЛИЦЕ ${q}`; kind = 'warn'; }
  if (type === 'move') { lbl = 'ПЕРЕМЕЩЕНИЕ · ' + S.cell; kind = 'warn'; }
  beep(needsPkg || warn ? 'warn' : 'ok');
  show(kind, lbl, '', book.t, meta, needsPkg ? 'Выберите упаковку' : warn);
  renderPackages(); renderShelf();
}

/** Поставить текущий пик в очередь. false — нельзя (не выбрана упаковка). */
async function commitCurrent() {
  const c = S.current;
  if (!c) return true;
  if (c.needsPkg && !c.ev.pkg) {
    beep('bad');
    show('bad', 'ВЫБЕРИТЕ УПАКОВКУ', '', c.book.t, 'У этой книги нет габаритов в таблице', 'Следующий пик не принят');
    renderPackages();
    return false;
  }
  await enqueue(c.ev);
  if (c.ev.pkg) { S.lastPkg = Object.assign({}, c.ev.pkg); S.pkgByCode[c.ev.barcode] = Object.assign({}, c.ev.pkg); }
  if (S.catalog[c.ev.barcode]) S.catalog[c.ev.barcode].c = c.ev.cell;
  await remember(c.ev.barcode, c.ev.cell);
  S.shelf.unshift({ id: c.ev.id, barcode: c.ev.barcode, title: c.book.t, pkg: c.ev.pkg || c.fromTable, prevC: c.prevC });
  S.current = null;
  await DB.set('current', null);
  await saveSession();
  renderShelf();
  return true;
}

async function choosePkg(p) {
  if (S.current) {
    S.current.ev.pkg = Object.assign({}, p);
    S.current.needsPkg = false;
    S.current.touchedAt = S.lastActivity = Date.now();
    renderShelf();
    await DB.set('current', S.current);
    show(stateKind(), $('stLbl').textContent, '', S.current.book.t, $('stMeta').textContent, '');
  } else if (S.editShelf) {      // исправить упаковку уже поставленной книги
    const it = S.editShelf; S.editShelf = null;
    it.pkg = Object.assign({}, p);
    S.pkgByCode[it.barcode] = Object.assign({}, p);
    await saveSession();
    delete S.rejected[it.id];
    await enqueue({ id: uid(), ts: new Date().toISOString(), type: 'place', cell: S.cell, barcode: it.barcode, pkg: it.pkg, fixOf: it.id, title: it.title });
    S.lastPkg = Object.assign({}, p);
    renderShelf();
    show('ok', 'УПАКОВКА ИЗМЕНЕНА', '', it.title, pkgLabel(p));
  } else {
    S.lastPkg = Object.assign({}, p);
  }
  renderPackages();
}

async function undo() {
  hideActions();
  const now = Date.now();
  S.lastActivity = now;
  // вторая отмена подряд — только после подтверждения: иначе легко «съесть» соседнюю книгу
  if (!S.current && S.shelf.length && S.lastUndoAt && now - S.lastUndoAt < 15000 && S.undoArmed !== S.shelf[0].id) {
    S.undoArmed = S.shelf[0].id;
    beep('warn');
    return show('warn', 'ОТМЕНИТЬ ЕЩЁ ОДНУ?', '', S.shelf[0].title,
                'Вы только что уже отменили пик. Если нужно отменить и эту книгу — нажмите «Отменить» ещё раз.');
  }
  S.lastUndoAt = now; S.undoArmed = null;
  if (S.current) {
    S.counts[S.current.ev.barcode]--;
    const t = S.current.book.t;
    S.current = null; await DB.set('current', null);
    await saveSession();
    renderPackages(); renderShelf();
    return show('gray', 'ОТМЕНЕНО', '', t, 'Пик удалён, в таблицу ничего не ушло');
  }
  const last = S.shelf.shift();
  if (!last) { S.lastUndoAt = 0; return show('gray', 'НЕЧЕГО ОТМЕНЯТЬ', '', '', ''); }
  S.counts[last.barcode] = Math.max(0, (S.counts[last.barcode] || 1) - 1);
  if (S.catalog[last.barcode]) S.catalog[last.barcode].c = last.prevC;
  await remember(last.barcode, last.prevC);
  const q = await DB.qAll();
  for (const e of q) if (e.fixOf === last.id) await DB.qDel(e.id);  // неотправленные исправления упаковки этого пика — тоже убрать
  if (q.find(e => e.id === last.id)) await DB.qDel(last.id);       // сам пик ещё не отправлен — просто удалить
  else if (!(S.rejected[last.id] && !S.rejected[last.id].pickOk)) await enqueue({ id: uid(), ts: new Date().toISOString(), type: 'undo', undoOf: last.id, title: last.title });
  delete S.rejected[last.id]; await DB.set('rejected', S.rejected);
  S.queued = (await DB.qAll()).length;
  await saveSession();
  renderShelf(); renderTop();
  show('gray', 'ОТМЕНЕНО', '', last.title, 'Таблица вернёт строку как было');
}

// ------------------------------------------------------------ конец полки
/** «Полка готова»: записать последнюю книгу, отправить, показать итог и отпустить ячейку. */
async function shelfDone() {
  hideActions();
  if (!S.cell) return show('gray', 'ЯЧЕЙКА НЕ ВЫБРАНА', '', 'Пикните этикетку ячейки', '');
  if (!await commitCurrent()) return;
  const cell = S.cell, n = S.shelf.length, items = S.shelf.slice();
  releaseCell();
  await saveSession();
  render();
  beep('ok');
  show('ok', 'ПОЛКА ГОТОВА', cell, `${n} ${plural(n, 'книга', 'книги', 'книг')}`, 'Отправляю в таблицу…');
  for (let i = 0; S.syncing && i < 50; i++) await new Promise(r => setTimeout(r, 200));   // дождаться идущей отправки
  await sync();
  const left = S.queued;
  const rej = items.filter(it => S.rejected[it.id]);
  if (rej.length) {
    beep('bad');
    const notPlaced = rej.filter(it => !S.rejected[it.id].pickOk).length;
    show('bad', 'ПОЛКА ГОТОВА — ЕСТЬ ОТКАЗЫ', cell,
         notPlaced ? `${n - notPlaced} из ${n} записаны, не принято: ${notPlaced}` : `${n} ${plural(n, 'книга', 'книги', 'книг')}, но есть отказы`,
         rej.slice(0, 3).map(it => `${it.title} — ${S.rejected[it.id].why}`).join(' · ') + (rej.length > 3 ? ' · …' : ''),
         'Эти книги отложите и разберите: подробности на листе «Ошибки».' + (left ? ` Ещё ждут отправки: ${left}.` : ''));
  } else {
    show(left ? 'warn' : 'ok', 'ПОЛКА ГОТОВА', cell, `${n} ${plural(n, 'книга', 'книги', 'книг')}`,
         left ? `Ждут отправки: ${left}. Отправятся сами, когда будет сеть — приложение не удаляйте.` : 'Всё отправлено в таблицу. Можно уходить.');
  }
  loadCatalog(true);                                  // пауза между полками — обновить справочник
}

function plural(n, one, few, many) {
  const a = n % 10, b = n % 100;
  return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many;
}

function releaseCell() { S.cell = ''; S.shelf = []; S.counts = {}; S.pkgByCode = {}; S.editShelf = null; }

/** 5 минут без пиков: последняя книга записывается, ячейка отпускается — после перерыва полку пикают заново. */
async function autoClose() {
  if (S.mode !== 'place' || (!S.cell && !S.current)) return;
  if (Date.now() - (S.lastActivity || 0) < autoCloseMs()) return;
  const c = S.current;
  if (c && c.needsPkg && !c.ev.pkg) return;             // без упаковки не закрываем — ждём выбора
  if (c && !await commitCurrent()) return;
  const cell = S.cell;
  releaseCell();
  await saveSession();
  render();
  show('warn', 'ПЕРЕРЫВ — ПИКНИТЕ ПОЛКУ', cell || '', c ? 'Последняя книга записана: ' + c.book.t : 'Ячейка отпущена',
       `5 минут не было пиков, поэтому ячейка ${cell || ''} отпущена — чтобы следующие книги не ушли на старую полку.`);
  sync();
}

// ------------------------------------------------------------ «Где книга?»
function showFind(code) {
  if (code.kind !== 'book') return;
  const b = S.catalog[code.code];
  if (!b) { beep('bad'); return show('bad', 'НЕ НАЙДЕНА', '', code.code, 'Нет ни в таблице, ни в архиве, ни в 1С'); }
  const place = b.c || b.s['1c'] || b.s.arch || '';
  const srcs = [];
  if (b.c) srcs.push('таблица: ' + b.c);
  if (b.s['1c']) srcs.push('1С: ' + b.s['1c']);
  if (b.s.arch && !b.c) srcs.push('архив: ' + b.s.arch);
  const differ = new Set([b.c, b.s['1c']].filter(Boolean)).size > 1;
  beep(differ ? 'warn' : 'ok');
  show(differ ? 'warn' : 'ok', place ? 'ВЕРНУТЬ НА' : 'МЕСТО НЕ ЗАДАНО', place, b.t,
       [b.a, b.ar, b.f !== undefined ? `остаток в 1С: ${b.f}` : ''].filter(Boolean).join(' · '),
       srcs.join(' · ') + (differ ? ' — места расходятся, проверьте' : ''));
}

function showFindCell(code) {
  const list = Object.entries(S.catalog).filter(([, b]) => (b.c || b.s['1c']) === code.cell);
  beep('ok');
  show('info', 'ЯЧЕЙКА ' + code.cell, `${list.length} книг`, '', list.slice(0, 6).map(([, b]) => b.t).join(' · '));
}

// ------------------------------------------------------------ «Заказы» WB: что собрать и в каком порядке
const cellKey = cell => {                     // «С35-П5» -> [35, 5]; латинские C/P тоже понимаем
  const m = /^\s*[СC](\d+)\s*-\s*[ПP](\d+)/i.exec(String(cell || ''));
  return m ? [Number(m[1]), Number(m[2])] : null;
};
let arIdx = null, arIdxAt = '';
function bookForOrder(o) {
  let bc = o.barcode && S.catalog[o.barcode] ? o.barcode : (o.skus || []).find(s => S.catalog[s]);
  if (!bc && o.article) {
    if (!arIdx || arIdxAt !== S.catalogAt) {
      arIdx = {}; arIdxAt = S.catalogAt;
      for (const [k, b] of Object.entries(S.catalog)) if (b.ar) arIdx[String(b.ar).trim()] = k;
    }
    bc = arIdx[String(o.article).trim()];
  }
  return bc ? { bc, b: S.catalog[bc] } : { bc: o.barcode || '', b: null };
}
function orderPlace(o) {
  const { bc, b } = bookForOrder(o);
  if (b && b.c) return { cell: b.c, src: '', bc, b };
  if (b && b.s && b.s['1c']) return { cell: b.s['1c'], src: 'по 1С', bc, b };
  if (b && b.s && b.s.arch) return { cell: b.s.arch, src: 'по архиву', bc, b };
  const fromArt = /^\s*[СC]\d+\s*-\s*[ПP]\d+/i.exec(o.article || '');
  return { cell: fromArt ? fromArt[0].trim() : '', src: fromArt ? 'по артикулу' : '', bc, b };
}
function sortedOrders() {
  return S.orders.map(o => Object.assign({ o }, orderPlace(o))).sort((x, y) => {
    const a = cellKey(x.cell) || [1e9, 1e9], b = cellKey(y.cell) || [1e9, 1e9];
    return a[0] - b[0] || a[1] - b[1] || String(x.o.createdAt).localeCompare(String(y.o.createdAt));
  });
}

async function loadOrders(force) {
  if (S.ordersLoading) return;
  if (!force && S.ordersAt && Date.now() - Date.parse(S.ordersAt) < ORDERS_EVERY_MS) return;
  S.ordersLoading = true; renderOrders();
  try {
    const j = await api('GET', { action: 'orders' });
    S.orders = j.orders || []; S.ordersAt = j.at || new Date().toISOString(); S.ordersErr = j.cardsErr ? 'фото: ' + j.cardsErr : '';
    const ids = new Set(S.orders.map(o => String(o.id)));
    for (const k of Object.keys(S.picked)) if (!ids.has(k)) delete S.picked[k];   // ушедшие заказы забываем
    await DB.set('orders', { orders: S.orders, at: S.ordersAt, picked: S.picked });
    netOk();
  } catch (e) {
    S.ordersErr = e.net ? 'нет сети — показан список от ' + (S.ordersAt ? hhmm(S.ordersAt) : '—') : String(e.message || e);
  } finally {
    S.ordersLoading = false; renderOrders(); renderTop();
  }
}

function ago(iso) {
  const m = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60000));
  if (!isFinite(m)) return '';
  return m < 60 ? `${m} мин назад` : m < 1440 ? `${Math.floor(m / 60)} ч ${m % 60} мин назад` : `${Math.floor(m / 1440)} д назад`;
}

function renderOrders() {
  const box = $('ordersList'); if (!box) return;
  $('ordersView').classList.toggle('hidden', S.mode !== 'orders');
  if (S.mode !== 'orders') return;
  const list = sortedOrders();
  const done = list.filter(x => S.picked[String(x.o.id)]).length;
  $('ordersHead').textContent = S.ordersLoading && !S.ordersAt ? 'Загружаю заказы WB…' :
    `Новых заказов: ${list.length}` + (done ? ` · собрано ${done}` : '') + (S.ordersAt ? ` · ${hhmm(S.ordersAt)}` : '');
  $('ordersRefresh').textContent = S.ordersLoading ? 'Обновляю…' : 'Обновить ↻';
  $('ordersErr').textContent = S.ordersErr; $('ordersErr').classList.toggle('hidden', !S.ordersErr);
  box.innerHTML = '';
  if (!list.length && S.ordersAt && !S.ordersLoading) {
    const e = document.createElement('div'); e.className = 'ord-empty'; e.textContent = 'Новых заказов нет'; box.appendChild(e);
  }
  let rack = null;
  list.forEach(x => {
    const k = cellKey(x.cell), r = k ? k[0] : -1;
    if (r !== rack) {
      rack = r;
      const h = document.createElement('div'); h.className = 'ord-rack';
      h.textContent = k ? `Стеллаж С${r}` : 'Место неизвестно';
      box.appendChild(h);
    }
    const o = x.o, id = String(o.id);
    const card = document.createElement('div'); card.className = 'ord' + (S.picked[id] ? ' picked' : ''); card.id = 'ord-' + id;
    const img = document.createElement(o.photo ? 'img' : 'div'); img.className = 'ord-img';
    if (o.photo) { img.src = o.photo; img.alt = ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer'; }
    const mid = document.createElement('div'); mid.className = 'ord-mid';
    const t = document.createElement('b'); t.textContent = o.title || (x.b && x.b.t) || 'Без названия';
    const a = document.createElement('span'); a.textContent = 'Арт. ' + (o.article || '—');
    const p = document.createElement('span');
    const rub = o.salePrice || o.price ? Math.round((o.salePrice || o.price) / 100).toLocaleString('ru-RU') + ' ₽' : '';
    p.textContent = [o.brand, rub, o.createdAt ? ago(o.createdAt) : ''].filter(Boolean).join(' · ');
    mid.append(t, a, p);
    const c = document.createElement('div'); c.className = 'ord-cell';
    c.textContent = x.cell || '?';
    if (x.src) { const s = document.createElement('small'); s.textContent = x.src; c.appendChild(s); }
    if (S.picked[id]) { const s = document.createElement('small'); s.textContent = '✓ взята'; c.appendChild(s); }
    card.append(img, mid, c); box.appendChild(card);
  });
}

/** Пик в «Заказах»: подсказать, есть ли книга в новых заказах, и отметить «взята». Ничего не пишет ни в WB, ни в таблицу. */
function orderScan(code) {
  if (code.kind === 'cell') {
    const here = sortedOrders().filter(x => x.cell === code.cell);
    beep('ok');
    return show('info', 'ПОЛКА ' + code.cell, here.length ? `${here.length} в заказах` : '', here.length ? here.map(x => x.o.title || (x.b && x.b.t) || x.o.article).join(' · ') : 'На этой полке новых заказов нет', '');
  }
  if (code.kind !== 'book') return;
  const hit = sortedOrders().filter(x => x.bc === code.code || (x.o.skus || []).includes(code.code));
  if (!hit.length) {
    beep('bad');
    const b = S.catalog[code.code];
    return show('bad', 'НЕТ В НОВЫХ ЗАКАЗАХ', '', b ? b.t : code.code, 'Эту книгу сейчас не заказывали. Верните на место.', S.ordersAt ? 'Список заказов от ' + hhmm(S.ordersAt) : '');
  }
  const free = hit.find(x => !S.picked[String(x.o.id)]);
  if (!free) { beep('warn'); return show('warn', 'УЖЕ ВЗЯТА', hit[0].cell, hit[0].o.title || (hit[0].b && hit[0].b.t) || '', 'Эту книгу из заказа уже пикали.', ''); }
  S.picked[String(free.o.id)] = Date.now();
  DB.set('orders', { orders: S.orders, at: S.ordersAt, picked: S.picked });
  beep('ok');
  show('ok', 'ЕСТЬ В ЗАКАЗЕ', free.cell, free.o.title || (free.b && free.b.t) || '', 'Арт. ' + free.o.article, hit.length > 1 ? `Таких заказов: ${hit.length}` : '');
  renderOrders();
  const el = $('ord-' + free.o.id); if (el) el.scrollIntoView({ block: 'center', behavior: 'smooth' });
}

// ------------------------------------------------------------ интерфейс
function stateKind() {
  const c = $('status').className.match(/s-(\w+)/);
  return c ? c[1] : 'ok';
}

function show(kind, lbl, big, title, meta, note) {
  const st = $('status');
  st.className = 'status s-' + kind;
  $('stLbl').textContent = lbl;
  $('stBig').textContent = big || ''; $('stBig').classList.toggle('hidden', !big);
  $('stTitle').textContent = title || '';
  $('stMeta').textContent = meta || '';
  $('stNote').textContent = note || ''; $('stNote').classList.toggle('hidden', !note);
}

function hideActions() {
  $('moveActions').classList.add('hidden');
  $('unknownActions').classList.add('hidden');
  S.pendingMove = null; S.pendingUnknown = null;
}

function renderTop() {
  $('who').textContent = S.user;
  const s = $('sync');
  if (S.tableErr) { s.className = 'sync bad'; s.textContent = `Таблица не принимает: ${S.tableErr} · ждут отправки: ${S.queued}`; }
  else if (!S.online) { s.className = 'sync off'; s.textContent = `Нет сети · ждут отправки: ${S.queued}`; }
  else { s.className = 'sync'; s.textContent = S.queued ? `Отправляется: ${S.queued}` : 'Онлайн · всё отправлено'; }
  const test = /тест/i.test(S.table || '');
  $('infobar').classList.toggle('test', test);
  $('tblName').textContent = test ? 'ТЕСТОВАЯ ТАБЛИЦА' : (S.table || '');
  $('catBtn').classList.toggle('stale', !S.busy && (!S.catalogAt || Date.now() - Date.parse(S.catalogAt) > CATALOG_STALE_MS));
  $('catBtn').textContent = S.busy ? 'Обновляю…' : `Справочник ${S.catalogAt ? hhmm(S.catalogAt) : '—'} ↻`;
}

function hhmm(iso) { const d = new Date(iso); return isNaN(d) ? '—' : d.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }); }

async function saveSession() {
  // список «На этой полке» тоже хранится в телефоне — переживает обновление страницы и перезапуск
  await DB.set('session', { cell: S.cell, lastPkg: S.lastPkg, lastActivity: S.lastActivity,
                            shelf: S.shelf.slice(0, 200), counts: S.counts, pkgByCode: S.pkgByCode });
}

/** Обновить справочник по кнопке; если на экране неизвестный штрихкод — сразу проверить его снова. */
async function refreshCatalog() {
  if (S.busy) return;
  const again = S.pendingUnknown;
  S.busy = true; renderTop();
  const ok = await loadCatalog(true);
  S.busy = false; renderTop();
  if (again) { hideActions(); return onScan(again); }
  if (ok) show('info', 'СПРАВОЧНИК ОБНОВЛЁН', '', `${Object.keys(S.catalog).length} книг`, S.cell ? 'Ячейка ' + S.cell + ' — пикайте книги' : 'Пикните этикетку ячейки');
  else show('warn', 'НЕ УДАЛОСЬ ОБНОВИТЬ', '', S.tableErr || 'нет сети', 'Работаю со справочником от ' + hhmm(S.catalogAt));
}

function isbnHint(code) {
  return /^97[89]/.test(code) ? 'Это заводской штрихкод. Если на книге есть наша наклейка 200… — пикните её.' : '';
}

function renderPackages() {
  const show = S.mode === 'place' && !!(S.current || S.editShelf);
  $('pkgBlock').classList.toggle('hidden', !show);
  if (!show) return;
  const cur = S.current, sel = cur ? (cur.ev.pkg || cur.fromTable) : null;
  const grid = $('pkgGrid'); grid.innerHTML = '';
  S.packages.filter(p => !p.manual).forEach(p => {
    const b = document.createElement('button');
    b.type = 'button'; b.textContent = Codes.short(p.name);
    if (sel && sel.name === p.name) b.classList.add('sel');
    if (cur && !cur.ev.pkg && cur.fromTable && cur.fromTable.name === p.name) b.classList.add('from-table');
    b.onclick = () => choosePkg({ name: p.name, L: p.L, W: p.W, H: p.H });
    grid.appendChild(b);
  });
  $('pkgManual').classList.toggle('sel', !!(sel && sel.name === 'Ручная'));
  $('pkgManual').textContent = sel && sel.name === 'Ручная' ? `Ручная ${sel.L}×${sel.W}×${sel.H} — изменить` : 'Ручная — ввести размеры';
  $('pkgHint').textContent = cur ? (cur.ev.pkg ? (cur.needsPkg ? '' : 'выбрана') : cur.fromTable ? 'из таблицы' : 'не выбрана') : 'исправление';
  $('pkgInfo').textContent = sel ? `${pkgLabel(sel)} · ${sel.L} × ${sel.W} × ${sel.H} см. Пикните следующую книгу — упаковка подтвердится сама.` : 'У книги нет габаритов в таблице — выберите упаковку.';
}

function renderShelf() {
  $('shelfCount').textContent = S.shelf.length + (S.current ? 1 : 0);
  const box = $('shelf'); box.innerHTML = '';
  if (S.current) {                 // открытая книга: ещё не записана, запишется следующим пиком
    const row = document.createElement('div'); row.className = 'row cur';
    const d = document.createElement('div');
    const b = document.createElement('b'); b.textContent = S.current.book.t;
    const s = document.createElement('span');
    const p = S.current.ev.pkg || S.current.fromTable;
    s.textContent = 'на экране — запишется следующим пиком' + (p ? ' · ' + pkgLabel(p) : ' · выберите упаковку');
    d.append(b, s); row.append(d); box.appendChild(row);
  }
  S.shelf.slice(0, 8).forEach(it => {
    const row = document.createElement('div'); row.className = 'row';
    const d = document.createElement('div');
    const b = document.createElement('b'); b.textContent = it.title;
    const s = document.createElement('span'); s.textContent = pkgLabel(it.pkg) || 'габариты из таблицы';
    const rj = S.rejected[it.id];
    if (rj) { row.className = 'row bad'; s.textContent = (rj.pickOk ? '' : 'НЕ ПРИНЯТА: ') + rj.why; }
    d.append(b, s);
    const btn = document.createElement('button'); btn.type = 'button'; btn.textContent = 'Упаковка';
    btn.onclick = async () => { if (!await commitCurrent()) return; S.editShelf = it; renderPackages(); show('info', 'ИСПРАВИТЬ УПАКОВКУ', '', it.title, 'Выберите упаковку'); };
    row.append(d, btn); box.appendChild(row);
  });
}

function renderProblems() {
  const p = $('problems');
  p.classList.toggle('hidden', !S.problems.length);
  p.textContent = S.problems.length ? 'Не принято таблицей (подробно — лист «Ошибки»): ' + S.problems.join(' · ') + '  ✕ скрыть' : '';
}

function render() {
  $('cellName').textContent = S.cell || '—';
  $('doneBtn').classList.toggle('hidden', !S.cell);
  $('cellbar').classList.toggle('hidden', S.mode !== 'place');
  $('modePlace').classList.toggle('on', S.mode === 'place');
  $('modeFind').classList.toggle('on', S.mode === 'find');
  $('modeOrders').classList.toggle('on', S.mode === 'orders');
  $('shelf').classList.toggle('hidden', S.mode !== 'place');
  $('undoBtn').classList.toggle('hidden', S.mode !== 'place');
  renderTop(); renderPackages(); renderShelf(); renderProblems(); renderOrders();
}

async function setMode(m) {
  if (m === S.mode) return;
  if (m !== 'place' && !await commitCurrent()) return;
  S.mode = m; hideActions(); render();
  if (m === 'orders') { show('info', 'ЗАКАЗЫ WB', '', 'Новые заказы по стеллажам и полкам', 'Пикните книгу — покажу, есть ли она в заказе. Ничего не меняется ни в WB, ни в таблице.'); loadOrders(true); return; }
  if (m === 'find') show('info', 'ГДЕ КНИГА?', '', 'Пикните книгу', 'Покажу её место. Ничего не записывается.');
  else show('info', 'РАЗМЕЩЕНИЕ', '', S.cell ? 'Ячейка ' + S.cell : 'Пикните этикетку ячейки', '');
}

// ручная упаковка
function openManual() {
  const sel = S.current ? (S.current.ev.pkg || S.current.fromTable) : (S.lastPkg && S.lastPkg.name === 'Ручная' ? S.lastPkg : null);
  const base = sel && sel.name === 'Ручная' ? sel : (S.lastManual || { L: 30, W: 22, H: 5 });
  $('mL').value = base.L; $('mW').value = base.W; $('mH').value = base.H;
  resetManualCheck();
  $('manualSheet').classList.remove('hidden');
}
function resetManualCheck() { S.manualOk = ''; $('mMsg').textContent = ''; $('mOk').textContent = 'Готово'; }
function closeManual() { $('manualSheet').classList.add('hidden'); focusScan(); }

// удержание для перемещения
let holdTimer = null, holdStart = 0, holdRaf = 0;
function holdDown() {
  holdStart = Date.now();
  const tick = () => {
    const k = Math.min(1, (Date.now() - holdStart) / HOLD_MS);
    $('holdFill').style.width = (k * 100) + '%';
    if (k < 1) holdRaf = requestAnimationFrame(tick);
  };
  tick();
  holdTimer = setTimeout(async () => {
    const pm = S.pendingMove; hideActions(); $('holdFill').style.width = '0';
    if (pm) await startCurrent(pm.code, pm.book, 'move', '');
  }, HOLD_MS);
}
function holdUp() { clearTimeout(holdTimer); cancelAnimationFrame(holdRaf); $('holdFill').style.width = '0'; }

// ------------------------------------------------------------ камера (если сканера нет под рукой)
// Один пик за раз: прочитала код -> закрылась -> код обработан как пик сканера.
const ZXING_URLS = ['https://cdn.jsdelivr.net/npm/@zxing/library@0.21.3/umd/index.min.js',
                    'https://unpkg.com/@zxing/library@0.21.3/umd/index.min.js',
                    'https://cdn.jsdelivr.net/npm/@zxing/library@0.20.0/umd/index.min.js'];
const Cam = { stream: null, raf: 0, reader: null, busy: false };

function loadScript(src) {
  return new Promise((res, rej) => {
    const el = document.createElement('script'); el.src = src; el.async = true;
    el.onload = res; el.onerror = rej; document.head.appendChild(el);
  });
}

async function zxing() {
  if (window.ZXing) return window.ZXing;
  for (const u of ZXING_URLS) { try { await loadScript(u); if (window.ZXing) return window.ZXing; } catch (e) {} }
  throw new Error('не удалось загрузить распознавание (нужен интернет при первом запуске камеры)');
}

async function nativeDetector() {
  if (!('BarcodeDetector' in window)) return null;
  try {
    const fmts = await window.BarcodeDetector.getSupportedFormats();
    const want = ['ean_13', 'code_128', 'ean_8', 'upc_a'].filter(f => fmts.includes(f));
    return want.includes('ean_13') && want.includes('code_128') ? new window.BarcodeDetector({ formats: want }) : null;
  } catch (e) { return null; }
}

async function openCamera() {
  if (Cam.busy) return;
  Cam.busy = true;
  $('camMsg').textContent = 'Наведите камеру на штрихкод';
  $('camSheet').classList.remove('hidden');
  const video = $('camVideo');
  const done = code => { closeCamera(); if (code) onScan(code); };
  try {
    const det = await nativeDetector();
    if (det) {
      Cam.stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: 'environment', width: { ideal: 1280 } }, audio: false });
      video.srcObject = Cam.stream; await video.play();
      let last = 0;
      const loop = async t => {
        if (!Cam.busy) return;
        if (t - last > 150 && video.readyState >= 2) {
          last = t;
          try { const r = await det.detect(video); if (r && r[0] && r[0].rawValue) return done(r[0].rawValue); } catch (e) {}
        }
        Cam.raf = requestAnimationFrame(loop);
      };
      Cam.raf = requestAnimationFrame(loop);
    } else {
      const Z = await zxing();
      const hints = new Map();
      hints.set(Z.DecodeHintType.POSSIBLE_FORMATS, [Z.BarcodeFormat.EAN_13, Z.BarcodeFormat.CODE_128, Z.BarcodeFormat.EAN_8, Z.BarcodeFormat.UPC_A]);
      Cam.reader = new Z.BrowserMultiFormatReader(hints);
      await Cam.reader.decodeFromConstraints({ video: { facingMode: 'environment' } }, video, res => { if (res && Cam.busy) done(res.getText()); });
    }
  } catch (e) {
    $('camMsg').textContent = 'Камера недоступна: ' + (e.message || e.name || e) + '. Разрешите доступ к камере в настройках Chrome.';
  }
}

function closeCamera() {
  Cam.busy = false;
  cancelAnimationFrame(Cam.raf);
  try { Cam.reader && Cam.reader.reset(); } catch (e) {}
  Cam.reader = null;
  if (Cam.stream) Cam.stream.getTracks().forEach(t => t.stop());
  Cam.stream = null;
  $('camVideo').srcObject = null;
  $('camSheet').classList.add('hidden');
  focusScan();
}

// поле сканера всегда в фокусе
function focusScan() {
  if (!$('manualSheet').classList.contains('hidden') || !$('menuSheet').classList.contains('hidden') || !$('camSheet').classList.contains('hidden')) return;
  if (!$('mainView').classList.contains('hidden')) $('scan').focus({ preventScroll: true });
}

// ------------------------------------------------------------ запуск
async function start() {
  if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});   // сразу: без него Chrome ставит ярлык, а не приложение
  await DB.open();
  try { navigator.storage && navigator.storage.persist && navigator.storage.persist(); } catch (e) {}
  S.device = (await DB.get('device')) || uid(); await DB.set('device', S.device);
  const auth = await DB.get('auth');
  if (auth) { S.key = auth.key; S.user = auth.user; }
  S.recent = await DB.get('recent') || {};
  S.rejected = await DB.get('rejected') || {};
  S.problems = await DB.get('problems') || [];
  const ord = await DB.get('orders');
  if (ord) { S.orders = ord.orders || []; S.ordersAt = ord.at || ''; S.picked = ord.picked || {}; }
  const cat = await DB.get('catalog');
  if (cat) { S.catalog = cat.books || {}; S.packages = cat.packages || []; S.catalogAt = cat.at || ''; S.table = cat.table || ''; await overlayQueue(); }
  const sess = await DB.get('session');
  if (sess) {
    S.cell = sess.cell || ''; S.lastPkg = sess.lastPkg || null; S.lastActivity = sess.lastActivity || 0;
    if (S.cell) { S.shelf = sess.shelf || []; S.counts = sess.counts || {}; S.pkgByCode = sess.pkgByCode || {}; }
  }
  S.current = await DB.get('current') || null;
  S.queued = (await DB.qAll()).length;

  bind();
  if (!S.key) { $('setupView').classList.remove('hidden'); return; }
  enterMain();
}

function enterMain() {
  $('setupView').classList.add('hidden');
  $('mainView').classList.remove('hidden');
  render();
  if (S.current) show('ok', 'ВОССТАНОВЛЕН ПОСЛЕДНИЙ ПИК', '', S.current.book.t, 'Пикните следующую книгу или отмените');
  else show('info', 'ГОТОВО', '', S.cell ? 'Ячейка ' + S.cell + ' — пикайте книги' : 'Пикните этикетку ячейки', '');
  focusScan();
  loadCatalog(true);                                  // при каждом открытии — свежий справочник
  sync();
  setInterval(sync, SYNC_EVERY_MS);
  setInterval(autoClose, 15 * 1000);
  autoClose();
  setInterval(() => loadCatalog(false), 60 * 1000);
  setInterval(() => { if (S.mode === 'orders' && !document.hidden) loadOrders(false); }, 30 * 1000);
  setInterval(() => { if (S.mode === 'orders') renderOrders(); }, 60 * 1000);   // «N мин назад»
}

function bind() {
  $('keySave').onclick = async () => {
    const key = $('keyInput').value.trim();
    if (!key) return;
    $('keyMsg').textContent = 'Проверяю…';
    S.key = key;
    try {
      const j = await api('GET', { action: 'ping' });
      S.user = j.user;
      await DB.set('auth', { key, user: j.user });
      enterMain();
    } catch (e) {
      S.key = '';
      $('keyMsg').textContent = 'Не получилось: ' + e.message + '. Нужен интернет и правильный ключ.';
    }
  };
  const scan = $('scan');
  scan.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); const v = scan.value; scan.value = ''; if (v.trim()) onScan(v); }
  });
  scan.addEventListener('blur', () => setTimeout(focusScan, 150));
  document.addEventListener('click', () => setTimeout(focusScan, 50));
  document.addEventListener('visibilitychange', () => { if (!document.hidden) { focusScan(); autoClose().then(sync); loadCatalog(false, 60 * 1000); if (S.mode === 'orders') loadOrders(false); } });
  window.addEventListener('online', () => { S.online = true; sync(); loadCatalog(false); });
  window.addEventListener('offline', () => { S.online = false; renderTop(); });

  $('modePlace').onclick = () => setMode('place');
  $('modeFind').onclick = () => setMode('find');
  $('modeOrders').onclick = () => setMode('orders');
  $('ordersRefresh').onclick = () => loadOrders(true);
  $('undoBtn').onclick = undo;
  $('doneBtn').onclick = () => { S.lastActivity = Date.now(); shelfDone(); };
  $('catBtn').onclick = refreshCatalog;
  $('problems').onclick = async () => { S.problems = []; await DB.set('problems', []); renderProblems(); };
  $('unkRefresh').onclick = refreshCatalog;
  ['mL', 'mW', 'mH'].forEach(id => $(id).addEventListener('input', resetManualCheck));
  $('pkgManual').onclick = openManual;
  $('moveNo').onclick = () => { hideActions(); show('gray', 'НЕ РАЗМЕЩЕНА', '', 'Отнесите книгу на её полку', ''); };
  const mh = $('moveHold');
  mh.addEventListener('pointerdown', holdDown);
  ['pointerup', 'pointerleave', 'pointercancel'].forEach(ev => mh.addEventListener(ev, holdUp));
  $('unkSave').onclick = async () => {
    const code = S.pendingUnknown; hideActions();
    if (!code) return;
    await enqueue({ id: uid(), ts: new Date().toISOString(), type: 'place', cell: S.cell, barcode: code, pkg: null });
    show('warn', 'СОХРАНЕНО', '', code, 'Таблица проверит при отправке. Если книги нет — она попадёт в «Ошибки».');
  };
  document.querySelectorAll('#manualSheet .step button').forEach(b => {
    b.onclick = () => { const i = $('m' + b.dataset.d); i.value = Math.max(1, (Number(i.value) || 0) + Number(b.dataset.s)); };
  });
  $('mBack').onclick = closeManual;
  $('mOk').onclick = () => {
    const L = Number($('mL').value), W = Number($('mW').value), H = Number($('mH').value);
    if (!(L > 0 && W > 0 && H > 0)) { $('mMsg').textContent = 'Все три размера должны быть больше нуля.'; return; }
    const big = [['Длина', L, MANUAL_MAX.L], ['Ширина', W, MANUAL_MAX.W], ['Высота', H, MANUAL_MAX.H]].filter(([, v, m]) => v > m);
    const key = `${L}x${W}x${H}`;
    if (big.length && S.manualOk !== key) {
      S.manualOk = key; beep('warn');
      $('mMsg').textContent = 'Проверьте: ' + big.map(([n, v]) => `${n.toLowerCase()} ${v} см`).join(', ') + ' — это очень много. Если всё верно — нажмите ещё раз.';
      $('mOk').textContent = 'Да, верно';
      return;
    }
    resetManualCheck();
    S.lastManual = { L, W, H };
    closeManual();
    choosePkg({ name: 'Ручная', L, W, H });
  };
  $('camBtn').onclick = openCamera;
  $('camClose').onclick = closeCamera;
  $('menuBtn').onclick = () => {
    $('mInfo').textContent = `Версия ${APP_VERSION} · таблица: ${S.table || 'неизвестно'} · справочник: ${S.catalogAt ? new Date(S.catalogAt).toLocaleString('ru-RU') : 'не загружен'} · книг в справочнике: ${Object.keys(S.catalog).length}`;
    $('menuSheet').classList.remove('hidden');
  };
  $('mClose').onclick = () => { $('menuSheet').classList.add('hidden'); focusScan(); };
  $('mSync').onclick = () => { $('menuSheet').classList.add('hidden'); sync(); focusScan(); };
  $('mCatalog').onclick = () => { $('menuSheet').classList.add('hidden'); refreshCatalog(); focusScan(); };
  $('mExport').onclick = async () => {
    const q = await DB.qAll();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([JSON.stringify({ user: S.user, device: S.device, events: q }, null, 1)], { type: 'application/json' }));
    a.download = `неотправленное_${S.user}_${new Date().toISOString().slice(0, 16).replace(':', '-')}.json`;
    a.click();
  };
  $('mKey').onclick = async () => {
    if ((await DB.qAll()).length) { $('mInfo').textContent = 'Сначала дождитесь отправки всех пиков.'; return; }
    await DB.set('auth', null); location.reload();
  };
}

if (typeof window !== 'undefined' && !window.RAZM_NO_START) start();
if (typeof module !== 'undefined') module.exports = { Codes };
