/**
 * Размещение книг по ячейкам — скрипт Google-таблицы (бэкенд приложения).
 *
 * ОТДЕЛЬНЫЙ проект Apps Script (script.google.com → Новый проект), НЕ внутри таблицы:
 * в таблице уже есть свой Код.gs (приём карточек с парсинга) со своими doGet/doPost —
 * в одном проекте они бы конфликтовали. Этот скрипт открывает таблицу по SPREADSHEET_ID.
 * Телефон шлёт СОБЫТИЯ (пик книги в ячейку), скрипт пишет их в «Журнал размещения»
 * и только потом обновляет строку книги. Пишет только в свои столбцы.
 *
 * Первый запуск: выполнить setup() из редактора — создаст служебные листы и столбцы,
 * ключи устройств (смотреть в «Журнал выполнения»).
 */

// ---------------------------------------------------------------- настройки
var SCRIPT_VERSION = '1.9.2';   // видно в приложении: Меню -> «скрипт …»
// Какую таблицу открывать. Адрес таблицы: docs.google.com/spreadsheets/d/<ВОТ ЭТО>/edit
var SPREADSHEET_ID = '1AW5En8QFA7IRrn9FBgCT-TJU_8Qapbmqs4iojxsCsHE';   // ТЕСТ OzonBooks

var CFG = {
  BOOKS_SHEET: 'Лист1',              // новые книги: здесь ставим ячейку и габариты (если переименуют — берём первый лист, gid 0)
  ARCHIVE_PREFIX: 'Архив',           // все листы «Архив…» — только для поиска, НЕ меняются (как в Код.gs таблицы)
  STOCK_SHEET: 'Остатки 1С',         // выгрузка 1С, только для поиска, НЕ меняется
  JOURNAL_SHEET: 'Журнал размещения',
  ERRORS_SHEET: 'Ошибки',
  // Стандартные упаковки (из списка владелицы, 04.11.2026). Д = длина, Ш = ширина, В = высота, см.
  PACKAGES: [
    { name: '201 - 2 см.', L: 25, W: 17, H: 2 }, { name: '201 - 4 см.', L: 25, W: 17, H: 4 },
    { name: '202 - 1 см.', L: 27, W: 21, H: 1 }, { name: '202 - 3 см.', L: 27, W: 21, H: 3 },
    { name: '203 - 1 см.', L: 31, W: 24, H: 1 }, { name: '203 - 2 см.', L: 31, W: 24, H: 2 },
    { name: '203 - 4 см.', L: 31, W: 24, H: 4 }, { name: '224 - 2 см.', L: 30, W: 38, H: 2 },
    { name: 'Развертка - 3 см.', L: 22, W: 15, H: 3 }, { name: 'Развертка - 4 см.', L: 22, W: 15, H: 4 },
    { name: 'Развертка - 5 см.', L: 22, W: 15, H: 5 }, { name: 'Развертка - 6 см.', L: 22, W: 15, H: 6 },
    { name: 'Развертка - 7 см.', L: 22, W: 15, H: 7 }, { name: 'Развертка - 8 см.', L: 22, W: 15, H: 8 },
    { name: 'Развертка - 9 см.', L: 22, W: 15, H: 9 }, { name: 'Развертка - 10 см.', L: 22, W: 15, H: 10 },
    { name: 'Ручная', manual: true }
  ],
  USERS: ['Ольга', 'Влада'],
  // столбцы ищутся по заголовку, не по букве
  COL: {
    barcode: 'НАШ ШТРИХКОД', cell: 'Место хранения', qty: 'Количество',
    title: 'Название книги', author: 'Авторы',
    L: 'Длина', W: 'Ширина', H: 'Высота',
    // создаются setup(), если их нет:
    article: 'Артикул', pkg: 'Упаковка', placedAt: 'Размещено', placedBy: 'Размещено кем'
  },
  STOCK_COL: { barcode: 'Штрихкод', cell: 'Ячейка', article: 'Артикул', title: 'Наименование',
               author: 'Автор ("Общие")', free: 'Свободно' }
};

var JOURNAL_HEADER = ['id события', 'получено', 'время скана', 'кто', 'устройство', 'действие',
  'штрихкод', 'ячейка', 'упаковка', 'Д', 'Ш', 'В', 'результат', 'строка',
  'было: ячейка', 'было: артикул', 'было: упаковка', 'было: Д', 'было: Ш', 'было: В', 'было: размещено',
  'к событию',      // исправление упаковки -> id исходного пика; отмена -> id отменённого пика
  'было: кем'];
var J = { id: 0, ts: 2, type: 5, barcode: 6, cell: 7, result: 12, row: 13, prevCell: 14, prevArticle: 15, prevPkg: 16,
          prevL: 17, prevW: 18, prevH: 19, prevAt: 20, ref: 21, prevBy: 22 };

// ============================================================ ЧИСТАЯ ЛОГИКА
// (без обращений к таблице — проверяется тестами вне Google)

var Core = {};

/** Штрихкод -> строка цифр. Число 2000000311869 -> "2000000311869". */
Core.normBarcode = function (v) {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number') return isFinite(v) ? v.toFixed(0) : '';
  return String(v).trim();
};

/** EAN-13: true/false по контрольной цифре. */
Core.ean13ok = function (s) {
  if (!/^\d{13}$/.test(s)) return false;
  var sum = 0;
  for (var i = 0; i < 12; i++) sum += Number(s.charAt(i)) * (i % 2 ? 3 : 1);
  return (10 - sum % 10) % 10 === Number(s.charAt(12));
};

/** Тип отсканированного кода. */
Core.classify = function (raw) {
  var s = Core.normBarcode(raw);
  if (s === '991999999') return { kind: 'desk', code: s };
  if (/^991\d{6}$/.test(s)) return { kind: 'cell', code: s, cell: Core.cellName(s) };
  if (/^\d{12,13}$/.test(s)) return { kind: 'book', code: s, checksumOk: s.length === 13 && Core.ean13ok(s) };
  return { kind: 'invalid', code: s };
};

/** 991017004 -> "С17-П4" */
Core.cellName = function (code) {
  var m = /^991(\d{3})(\d{3})$/.exec(code);
  return m ? 'С' + Number(m[1]) + '-П' + Number(m[2]) : '';
};

/** "С17-П4" -> 991017004 */
Core.cellCode = function (cell) {
  var m = /^С(\d+)-П(\d+)$/.exec(String(cell).trim());
  if (!m) return '';
  return '991' + ('00' + m[1]).slice(-3) + ('00' + m[2]).slice(-3);
};

// Время в таблице пишется по Москве: "04.11.2026 12:24:05" (UTC+3, без перехода на летнее время).
var MSK_OFFSET_MS = 3 * 3600 * 1000;

/** Любое время (Date, ISO "2026-11-04T09:24:05Z", московское "04.11.2026 12:24:05") -> миллисекунды. */
Core.toMs = function (v) {
  if (v === null || v === undefined || v === '') return 0;
  if (Object.prototype.toString.call(v) === '[object Date]') return isNaN(v) ? 0 : v.getTime();
  var m = /^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(String(v).trim());
  if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +(m[6] || 0)) - MSK_OFFSET_MS;
  var t = Date.parse(String(v));
  return isNaN(t) ? 0 : t;
};

/** -> "04.11.2026 12:24:05" по Москве */
Core.msk = function (v) {
  var ms = Core.toMs(v);
  if (!ms) return '';
  var d = new Date(ms + MSK_OFFSET_MS);
  function p(n) { return (n < 10 ? '0' : '') + n; }
  return p(d.getUTCDate()) + '.' + p(d.getUTCMonth() + 1) + '.' + d.getUTCFullYear() + ' ' +
         p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ':' + p(d.getUTCSeconds());
};

Core.isCell = function (cell) { return /^С\d+-П\d+$/.test(String(cell || '').trim()); };

/** Упаковка по габаритам: совпадение со стандартной, иначе "Ручная". */
Core.packageFor = function (L, W, H, packages) {
  L = Number(L); W = Number(W); H = Number(H);
  if (!L || !W || !H) return '';
  for (var i = 0; i < packages.length; i++) {
    var p = packages[i];
    if (p.L === L && p.W === W && p.H === H) return p.name;
  }
  return 'Ручная';
};

/**
 * Применить событие к строке книги (в памяти).
 * row: {cell, article, pkg, L, W, H, placedAt, placedBy}
 * ev:  {id, ts (ISO), user, type: 'place'|'move', cell, barcode, pkg:{name,L,W,H}|null}
 * Возвращает {result, changes:{...}} — changes пишутся в строку только при result 'ok'.
 */
Core.applyPlace = function (row, ev) {
  if (!Core.isCell(ev.cell)) return { result: 'нет ячейки' };
  var changes = {};
  var cur = String(row.cell || '').trim();
  if (row.placedAt && ev.ts && Core.toMs(ev.ts) < Core.toMs(row.placedAt)) {
    return { result: 'устарело: есть более позднее размещение ' + Core.msk(row.placedAt) };
  }
  if (cur && cur !== ev.cell && ev.type !== 'move') {
    return { result: 'уже размещена в ' + cur };
  }
  if (cur !== ev.cell) changes.cell = ev.cell;
  // артикул создаётся один раз и потом НЕ меняется
  if (!String(row.article || '').trim()) changes.article = ev.cell + '_' + ev.barcode;
  if (ev.pkg && ev.pkg.L && ev.pkg.W && ev.pkg.H) {
    if (Number(row.L) !== Number(ev.pkg.L)) changes.L = Number(ev.pkg.L);
    if (Number(row.W) !== Number(ev.pkg.W)) changes.W = Number(ev.pkg.W);
    if (Number(row.H) !== Number(ev.pkg.H)) changes.H = Number(ev.pkg.H);
    if (String(row.pkg || '') !== String(ev.pkg.name || '')) changes.pkg = String(ev.pkg.name || '');
  }
  changes.placedAt = Core.msk(ev.ts);
  changes.placedBy = ev.user;
  return { result: 'ok', changes: changes };
};

/** Отмена: вернуть значения "было" из записи журнала исходного события. */
Core.undoChanges = function (prev) {
  return { cell: prev.cell, article: prev.article, pkg: prev.pkg, L: prev.L, W: prev.W, H: prev.H,
           placedAt: prev.placedAt, placedBy: prev.placedBy || '' };
};

/**
 * Можно ли отменить пик origId: в строке должно быть ровно то, что записал этот пик (или его исправление упаковки).
 * last — последнее применённое событие по этому штрихкоду {id, ref, cell, ts, undo}; row — строка сейчас.
 * Возвращает '' если можно, иначе причину.
 */
Core.undoBlocker = function (origId, last, row) {
  if (!last) return 'по этой книге нет применённых пиков';
  if (last.undo) return 'пик уже отменён';
  if (last.id !== origId && last.ref !== origId) return 'после этого пика книгу уже меняли (' + (last.cell || '?') + ', ' + Core.msk(last.ts) + ')';
  var cell = String(row.cell || '').trim();
  if (cell !== String(last.cell || '').trim() || Core.msk(row.placedAt) !== Core.msk(last.ts)) {
    return 'строку изменили вручную после пика (сейчас: ' + (cell || 'без ячейки') + ', ' + (Core.msk(row.placedAt) || 'без времени') + ')';
  }
  return '';
};

/**
 * Свести справочник для телефона из трёх источников.
 * Каждый источник: массив {barcode, title, author, cell, qty, L, W, H, article}.
 * Результат: barcode -> {t, a, c (ячейка из Лист1), q, d:[L,W,H], ar, s (ячейки по источникам)}
 */
Core.buildCatalog = function (books, archive, stock) {
  var out = {};
  function add(list, src) {
    for (var i = 0; i < list.length; i++) {
      var b = list[i]; if (!b.barcode) continue;
      var e = out[b.barcode];
      if (!e) e = out[b.barcode] = { t: b.title || '', a: b.author || '', s: {} };
      if (!e.t && b.title) e.t = b.title;
      if (!e.a && b.author) e.a = b.author;
      if (b.cell) e.s[src] = String(b.cell).trim();
      if (src === 'new') {
        e.n = 1; e.q = Number(b.qty) || 1; e.ar = b.article || '';
        if (b.L && b.W && b.H) e.d = [Number(b.L), Number(b.W), Number(b.H)];
        e.c = String(b.cell || '').trim();
      }
      if (src === '1c' && b.free !== undefined) e.f = Number(b.free) || 0;
      if (!e.ar && b.article) e.ar = b.article;
    }
  }
  add(books, 'new'); add(stock || [], '1c'); add(archive || [], 'arch');
  return out;
};

// ============================================================ ТАБЛИЦА

function ss_() { return SPREADSHEET_ID ? SpreadsheetApp.openById(SPREADSHEET_ID) : SpreadsheetApp.getActive(); }

/** Лист новых книг: по имени, а если его переименовали — лист с gid 0 (так его ищет и Код.gs таблицы). */
function booksSheet_(ss) {
  ss = ss || ss_();
  var sh = ss.getSheetByName(CFG.BOOKS_SHEET);
  if (sh) return sh;
  var all = ss.getSheets();
  for (var i = 0; i < all.length; i++) if (all[i].getSheetId() === 0) return all[i];
  throw new Error('Нет листа «' + CFG.BOOKS_SHEET + '»');
}

function archiveSheets_(ss) {
  return (ss || ss_()).getSheets().filter(function (sh) { return sh.getName().indexOf(CFG.ARCHIVE_PREFIX) === 0; });
}

function headerMap_(sheet) {
  var lastCol = sheet.getLastColumn();
  var h = sheet.getRange(1, 1, 1, lastCol).getValues()[0];
  var m = {};
  for (var i = 0; i < h.length; i++) { var k = String(h[i]).trim(); if (k && !(k in m)) m[k] = i + 1; }
  return m;
}

function need_(map, name, sheetName) {
  if (!map[name]) throw new Error('В листе «' + sheetName + '» нет столбца «' + name + '». Запись остановлена.');
  return map[name];
}

function readTable_(sheetOrName, colNames) {
  var sh = typeof sheetOrName === 'string' ? ss_().getSheetByName(sheetOrName) : sheetOrName;
  if (!sh || sh.getLastRow() < 2) return [];
  var map = headerMap_(sh);
  var vals = sh.getRange(2, 1, sh.getLastRow() - 1, sh.getLastColumn()).getValues();
  var out = [];
  for (var r = 0; r < vals.length; r++) {
    var o = {};
    for (var key in colNames) {
      var c = map[colNames[key]];
      o[key] = c ? vals[r][c - 1] : '';
    }
    o.barcode = Core.normBarcode(o.barcode);
    out.push(o);
  }
  return out;
}

function packages_() { return CFG.PACKAGES; }

// ------------------------------------------------------------ ключи устройств
function users_() {
  var raw = PropertiesService.getScriptProperties().getProperty('DEVICE_KEYS');
  return raw ? JSON.parse(raw) : {};
}

function auth_(key) {
  var u = users_()[String(key || '')];
  if (!u) throw new Error('Неизвестный ключ устройства');
  return u;
}

// ------------------------------------------------------------ первый запуск
function setup() {
  var ss = ss_();
  var books = booksSheet_(ss);
  var map = headerMap_(books);
  ['barcode', 'cell', 'qty', 'title', 'L', 'W', 'H'].forEach(function (k) { need_(map, CFG.COL[k], CFG.BOOKS_SHEET); });
  ['article', 'pkg', 'placedAt', 'placedBy'].forEach(function (k) {
    if (!map[CFG.COL[k]]) {
      var c = books.getLastColumn() + 1;
      books.getRange(1, c).setValue(CFG.COL[k]);
      map[CFG.COL[k]] = c;
    }
  });
  if (!ss.getSheetByName(CFG.JOURNAL_SHEET)) {
    var j = ss.insertSheet(CFG.JOURNAL_SHEET);
    j.getRange(1, 1, 1, JOURNAL_HEADER.length).setValues([JOURNAL_HEADER]).setFontWeight('bold');
    j.setFrozenRows(1);
  }
  if (!ss.getSheetByName(CFG.ERRORS_SHEET)) {
    var e = ss.insertSheet(CFG.ERRORS_SHEET);
    e.getRange(1, 1, 1, 6).setValues([['получено', 'кто', 'id события', 'штрихкод', 'ячейка', 'причина']]).setFontWeight('bold');
    e.setFrozenRows(1);
  }
  var keys = users_();
  if (!Object.keys(keys).length) {
    CFG.USERS.forEach(function (name) { keys[Utilities.getUuid()] = name; });
    PropertiesService.getScriptProperties().setProperty('DEVICE_KEYS', JSON.stringify(keys));
  }
  Logger.log('Ключи устройств (вставить в приложение на телефоне):');
  for (var k in keys) Logger.log(keys[k] + ': ' + k);
}

/** Отозвать ключ (потерян телефон): выполнить с нужным ключом. */
function revokeKey(key) {
  var keys = users_(); delete keys[key];
  PropertiesService.getScriptProperties().setProperty('DEVICE_KEYS', JSON.stringify(keys));
}

// ------------------------------------------------------------ веб-приложение
function json_(o) {
  return ContentService.createTextOutput(JSON.stringify(o)).setMimeType(ContentService.MimeType.JSON);
}

function doGet(e) {
  try {
    var user = auth_(e.parameter.key);
    if (e.parameter.action === 'ping') return json_({ ok: true, user: user, table: ss_().getName(), ver: SCRIPT_VERSION });
    if (e.parameter.action === 'catalog') return json_(catalog_());
    if (e.parameter.action === 'orders') return json_(wbOrders_());
    return json_({ ok: false, error: 'неизвестное действие' });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  }
}

function catalog_() {
  var ss = ss_();
  var books = readTable_(booksSheet_(ss), { barcode: CFG.COL.barcode, title: CFG.COL.title, author: CFG.COL.author,
    cell: CFG.COL.cell, qty: CFG.COL.qty, L: CFG.COL.L, W: CFG.COL.W, H: CFG.COL.H, article: CFG.COL.article });
  var archive = [];
  archiveSheets_(ss).forEach(function (sh) {
    archive = archive.concat(readTable_(sh, { barcode: CFG.COL.barcode, title: CFG.COL.title, author: CFG.COL.author, cell: CFG.COL.cell }));
  });
  var stock = readTable_(CFG.STOCK_SHEET, { barcode: CFG.STOCK_COL.barcode, title: CFG.STOCK_COL.title,
    author: CFG.STOCK_COL.author, cell: CFG.STOCK_COL.cell, article: CFG.STOCK_COL.article, free: CFG.STOCK_COL.free });
  return { ok: true, version: new Date().toISOString(), table: ss_().getName(), ver: SCRIPT_VERSION, packages: packages_(),
           books: Core.buildCatalog(books, archive, stock) };
}

/**
 * POST: {key, device, events:[{id, ts, type:'place'|'move'|'undo', cell, barcode, pkg, undoOf}]}
 * Ответ: {ok, results:[{id, result}]}. Телефон удаляет у себя событие только после ответа.
 */
function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    var body = JSON.parse(e.postData.contents);
    var user = auth_(body.key);
    lock.waitLock(30000);
    var results = processEvents_(user, String(body.device || ''), body.events || []);
    return json_({ ok: true, results: results });
  } catch (err) {
    return json_({ ok: false, error: String(err.message || err) });
  } finally {
    try { lock.releaseLock(); } catch (x) {}
  }
}

function processEvents_(user, device, events) {
  var ss = ss_();
  var books = booksSheet_(ss);
  var journal = ss.getSheetByName(CFG.JOURNAL_SHEET);
  var errors = ss.getSheetByName(CFG.ERRORS_SHEET);
  var map = headerMap_(books);
  var C = {};
  for (var k in CFG.COL) C[k] = need_(map, CFG.COL[k], CFG.BOOKS_SHEET);
  var packages = packages_();
  var now = new Date().toISOString();
  var out = [];

  // уже обработанные события (повторная отправка того же id пропускается)
  if (String(journal.getRange(1, J.ref + 1).getValue()) !== JOURNAL_HEADER[J.ref]) {      // журнал старого вида — дописать заголовки
    journal.getRange(1, J.ref + 1, 1, 2).setValues([[JOURNAL_HEADER[J.ref], JOURNAL_HEADER[J.prevBy]]]).setFontWeight('bold');
  }
  var done = {}, lastBy = {};
  function track(vals) {           // последнее применённое событие по штрихкоду — для проверки отмены
    var bc = Core.normBarcode(vals[J.barcode]), type = String(vals[J.type]), res = String(vals[J.result]);
    if (!bc) return;
    if ((type === 'place' || type === 'move') && res === 'ok') lastBy[bc] = { id: String(vals[J.id]), ref: String(vals[J.ref] || ''), cell: vals[J.cell], ts: vals[J.ts] };
    if (type === 'undo' && res === 'отменено') lastBy[bc] = { undo: true, ref: String(vals[J.ref] || '') };
  }
  if (journal.getLastRow() > 1) {
    var jv = journal.getRange(2, 1, journal.getLastRow() - 1, JOURNAL_HEADER.length).getValues();
    for (var i = 0; i < jv.length; i++) { done[String(jv[i][0])] = { row: i + 2, vals: jv[i] }; track(jv[i]); }
  }
  function readRow(n) {
    var rv = books.getRange(n, 1, 1, books.getLastColumn()).getValues()[0];
    return { cell: rv[C.cell - 1], article: rv[C.article - 1], pkg: rv[C.pkg - 1], L: rv[C.L - 1],
             W: rv[C.W - 1], H: rv[C.H - 1], placedAt: rv[C.placedAt - 1], placedBy: rv[C.placedBy - 1] };
  }
  // индекс штрихкод -> строка
  var last = books.getLastRow();
  var bcol = last > 1 ? books.getRange(2, C.barcode, last - 1, 1).getValues() : [];
  var index = {};
  for (var r = 0; r < bcol.length; r++) {
    var b = Core.normBarcode(bcol[r][0]);
    if (b) { if (index[b]) index[b] = -1; else index[b] = r + 2; }  // -1 = дубль
  }

  events.forEach(function (ev) {
    var id = String(ev.id || '');
    if (!id) { out.push({ id: id, result: 'нет id' }); return; }
    if (done[id]) { out.push({ id: id, result: 'уже получено' }); return; }
    var res, rowNum = '', prev = {}, pkg = ev.pkg || null, ref = '';
    try {
      if (ev.type === 'undo') {
        ref = String(ev.undoOf || '');
        var orig = done[ref];
        if (!orig) throw new Error('не найдено событие для отмены');
        if (orig.vals[J.result] !== 'ok') throw new Error('отменять нечего: исходный пик не был применён (' + orig.vals[J.result] + ')');
        var ubc = Core.normBarcode(orig.vals[J.barcode]);
        ev.barcode = ubc;
        if (lastBy[ubc] && lastBy[ubc].undo && lastBy[ubc].ref === ref) { res = 'уже отменено'; }
        else {
          // строку ищем заново по штрихкоду: строки могли сдвинуться (сортировка, перенос в архив)
          rowNum = index[ubc];
          if (!rowNum) throw new Error('книги больше нет в «' + CFG.BOOKS_SHEET + '» (перенесли?) — отмена не применена');
          if (rowNum === -1) throw new Error('штрихкод встречается в таблице дважды — отмена не применена, разберите вручную');
          var cur = readRow(rowNum);
          prev = cur;
          var why = Core.undoBlocker(ref, lastBy[ubc], cur);
          if (why) throw new Error(why + ' — отмена не применена, разберите вручную');
          var p = orig.vals;
          writeRow_(books, rowNum, C, Core.undoChanges({ cell: p[J.prevCell], article: p[J.prevArticle], pkg: p[J.prevPkg],
            L: p[J.prevL], W: p[J.prevW], H: p[J.prevH], placedAt: p[J.prevAt], placedBy: p[J.prevBy] }));
          res = 'отменено';
        }
      } else {
        var code = Core.classify(ev.barcode);
        if (code.kind !== 'book') throw new Error('некорректный штрихкод «' + code.code + '»');
        ev.barcode = code.code;
        rowNum = index[code.code];
        if (!rowNum) throw new Error('штрихкода нет в «' + CFG.BOOKS_SHEET + '»');
        if (rowNum === -1) throw new Error('штрихкод встречается в таблице дважды — разберите вручную');
        var row = readRow(rowNum);
        prev = row;
        ref = String(ev.fixOf || '');
        if (pkg && pkg.name && !pkg.L) {  // стандартная упаковка по имени
          for (var q = 0; q < packages.length; q++) if (packages[q].name === pkg.name) pkg = packages[q];
        }
        var a = Core.applyPlace(row, { id: id, ts: String(ev.ts || now), user: user, type: ev.type,
                                       cell: String(ev.cell || ''), barcode: code.code, pkg: pkg });
        res = a.result;
        if (res === 'ok') writeRow_(books, rowNum, C, a.changes);
      }
    } catch (err) {
      res = 'ошибка: ' + (err.message || err);
    }
    var jrow = [id, Core.msk(now), Core.msk(ev.ts), user, device, String(ev.type || ''), String(ev.barcode || ''),
      String(ev.cell || ''), pkg ? (pkg.name || '') : '', pkg ? (pkg.L || '') : '', pkg ? (pkg.W || '') : '',
      pkg ? (pkg.H || '') : '', res, rowNum, prev.cell || '', prev.article || '', prev.pkg || '',
      prev.L || '', prev.W || '', prev.H || '', prev.placedAt ? Core.msk(prev.placedAt) : '', ref, prev.placedBy || ''];
    journal.appendRow(jrow);
    journal.getRange(journal.getLastRow(), 2, 1, 2).setNumberFormat('@');   // время — текстом, как написано
    journal.getRange(journal.getLastRow(), 7).setNumberFormat('@');
    journal.getRange(journal.getLastRow(), 21).setNumberFormat('@');
    done[id] = { row: journal.getLastRow(), vals: jrow };
    track(jrow);
    if (res !== 'ok' && res !== 'отменено') errors.appendRow([Core.msk(now), user, id, String(ev.barcode || ''), String(ev.cell || ''), res]);
    out.push({ id: id, result: res });
  });
  return out;
}

function writeRow_(sheet, rowNum, C, ch) {
  if (ch.placedAt !== undefined) sheet.getRange(rowNum, C.placedAt).setNumberFormat('@');  // текстом, не датой
  var map = { cell: C.cell, article: C.article, pkg: C.pkg, L: C.L, W: C.W, H: C.H, placedAt: C.placedAt, placedBy: C.placedBy };
  for (var k in ch) {
    if (!map[k]) continue;
    sheet.getRange(rowNum, map[k]).setValue(ch[k] === undefined || ch[k] === null ? '' : ch[k]);
  }
}

// ============================================================ ЗАКАЗЫ WB (только чтение)
// Ключ WB (категории «Маркетплейс» + «Контент», «Только на чтение») хранится в свойствах скрипта:
// Apps Script → Настройки проекта → Свойства скрипта → WB_TOKEN. В коде и на телефонах его нет.
var WB = {
  ORDERS_NEW: 'https://marketplace-api.wildberries.ru/api/v3/orders/new',
  CARDS: 'https://content-api.wildberries.ru/content/v2/get/cards/list',
  CACHE_SEC: 6 * 3600
};

/** Артикул «С35-П5_2000000289069» -> «2000000289069» (наш штрихкод в конце артикула). */
Core.barcodeFromArticle = function (article) {
  var m = /_(\d{12,13})\s*$/.exec(String(article || ''));
  return m ? m[1] : '';
};

function wbToken_() {
  var t = PropertiesService.getScriptProperties().getProperty('WB_TOKEN');
  if (!t) throw new Error('нет ключа WB: Apps Script → Настройки проекта → Свойства скрипта → WB_TOKEN');
  return String(t).trim();
}

function wbFetch_(url, opts) {
  var r = UrlFetchApp.fetch(url, Object.assign({ muteHttpExceptions: true, headers: { Authorization: wbToken_() } }, opts || {}));
  return wbParse_(r);
}
function wbParse_(r) {
  var code = r.getResponseCode();
  if (code === 401) throw new Error('WB не принял ключ (401): проверьте WB_TOKEN и категории «Маркетплейс» и «Контент»');
  if (code === 429) throw new Error('WB просит подождать (429) — обновите через минуту');
  if (code >= 400) throw new Error('WB ответил ' + code + ': ' + String(r.getContentText()).slice(0, 200));
  return JSON.parse(r.getContentText() || '{}');
}

/** Одна карточка WB по nmId: {photo, brand, title} или ошибка. При «подождите» (429) — повтор. */
function wbCard_(nm) {
  var req = { method: 'post', contentType: 'application/json', muteHttpExceptions: true, headers: { Authorization: wbToken_() },
              payload: JSON.stringify({ settings: { filter: { textSearch: String(nm), withPhoto: -1 }, cursor: { limit: 10 } } }) };
  for (var attempt = 0; attempt < 3; attempt++) {
    var r = UrlFetchApp.fetch(WB.CARDS, req);
    if (r.getResponseCode() === 429) { Utilities.sleep(1500 * (attempt + 1)); continue; }
    var cards = (wbParse_(r).cards || []).filter(function (c) { return String(c.nmID) === String(nm); });
    if (!cards[0]) return { photo: '', brand: '', title: '', none: true };
    var ph = (cards[0].photos || [])[0] || {};
    return { photo: ph.c246x328 || ph.square || ph.tm || ph.big || '', brand: cards[0].brand || '', title: cards[0].title || '' };
  }
  throw new Error('WB просит подождать (429)');
}

/** Фото, издательство и название из карточек — по одной, без спешки (лимит WB), найденные — в кэш на 6 часов. */
function wbCards_(nmIds) {
  var cache = CacheService.getScriptCache(), out = {}, errs = [], t0 = Date.now();
  nmIds.forEach(function (nm) {
    var c = cache.get('card2:' + nm);                 // 'card2:' — память прежних версий (с пустыми карточками) не используем
    if (c) { var hit = JSON.parse(c); if (hit.photo) { out[nm] = hit; return; } }
    if (Date.now() - t0 > 20000) { errs.push('не успела — остальные фото при следующем обновлении'); return; }   // не держать телефон дольше 20 с
    try {
      var info = wbCard_(nm);
      out[nm] = info;
      if (info.photo) cache.put('card2:' + nm, JSON.stringify(info), WB.CACHE_SEC);   // пустое не кэшируем
      Utilities.sleep(650);                                                    // ~100 запросов в минуту
    } catch (e) { errs.push(String(e.message || e)); }
  });
  if (errs.length) out._err = errs.length + ' без фото: ' + errs[0];
  return out;
}

/** Новые сборочные задания FBS + фото. Ячейку и сортировку считает телефон по своему справочнику. */
function wbOrders_() {
  wbToken_();                                          // сначала понятная ошибка, если ключа нет
  var j = wbFetch_(WB.ORDERS_NEW);
  var orders = j.orders || [];
  var nms = {};
  orders.forEach(function (o) { if (o.nmId) nms[o.nmId] = 1; });
  var cards = {};
  var cardsErr = '';
  try { cards = wbCards_(Object.keys(nms)); cardsErr = cards._err || ''; } catch (e) { cardsErr = String(e.message || e); }
  return {
    ok: true, at: new Date().toISOString(), cardsErr: cardsErr, ver: SCRIPT_VERSION,
    orders: orders.map(function (o) {
      var c = cards[o.nmId] || {};
      return { id: o.id, article: o.article || '', barcode: Core.barcodeFromArticle(o.article), skus: o.skus || [],
               nmId: o.nmId || '', createdAt: o.createdAt || '', price: o.convertedPrice || o.price || 0,
               salePrice: o.salePrice || 0, finalPrice: o.convertedFinalPrice || o.finalPrice || 0, cargoType: o.cargoType || '',
               photo: c.photo || '', brand: c.brand || '', title: c.title || '' };
    })
  };
}

/** Проверка связи с WB из редактора: Выполнить -> checkWb. Ключ в журнал не пишется. */
function checkWb() {
  var tok = wbToken_();
  var r = UrlFetchApp.fetch(WB.ORDERS_NEW, { headers: { Authorization: tok }, muteHttpExceptions: true });
  var orders = (JSON.parse(r.getContentText() || '{}').orders || []);
  Logger.log('WB заказы: ' + r.getResponseCode() + ', новых: ' + orders.length);
  if (!orders[0]) return;
  var o = orders[0];
  Logger.log('цены ' + o.article + ': price ' + o.price + ', salePrice ' + o.salePrice + ', finalPrice ' + o.finalPrice);
  Logger.log('карточка: ' + JSON.stringify(wbCard_(o.nmId)));
}

// для тестов вне Google
if (typeof module !== 'undefined') module.exports = { Core: Core };
