// Проверка скрипта таблицы вне Google: Core + обработка событий на поддельной таблице.
// Запуск: node tests/backend.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// ---------- поддельные SpreadsheetApp / сервисы ----------
let gid = 0;
class Sheet {
  constructor(name, rows) { this.name = name; this.rows = rows.map(r => r.slice()); this.id = gid++; }
  getName() { return this.name; }
  getSheetId() { return this.id; }
  getLastRow() { return this.rows.length; }
  getLastColumn() { return Math.max(0, ...this.rows.map(r => r.length)); }
  getRange(r, c, nr = 1, nc = 1) {
    const sh = this;
    const pad = (row, n) => { while (sh.rows[row].length < n) sh.rows[row].push(''); };
    return {
      getValues() {
        const out = [];
        for (let i = 0; i < nr; i++) {
          const row = sh.rows[r - 1 + i] || [];
          out.push(Array.from({ length: nc }, (_, j) => (row[c - 1 + j] === undefined ? '' : row[c - 1 + j])));
        }
        return out;
      },
      setValues(v) {
        for (let i = 0; i < v.length; i++) {
          while (sh.rows.length < r + i) sh.rows.push([]);
          pad(r - 1 + i, c - 1 + v[i].length);
          for (let j = 0; j < v[i].length; j++) sh.rows[r - 1 + i][c - 1 + j] = v[i][j];
        }
        return this;
      },
      setValue(v) { return this.setValues([[v]]); },
      getValue() { return this.getValues()[0][0]; },
      setNumberFormat() { return this; }, setFontWeight() { return this; }
    };
  }
  appendRow(v) { this.rows.push(v.slice()); }
  setFrozenRows() {}
}
function makeSS(sheets) {
  return {
    getName: () => 'ТЕСТ OzonBooks',
    getSheetByName: n => sheets[n] || null,
    getSheets: () => Object.values(sheets),
    insertSheet: n => (sheets[n] = new Sheet(n, [])),
  };
}
const props = {};
const ctx = {
  SpreadsheetApp: null,
  PropertiesService: { getScriptProperties: () => ({ getProperty: k => props[k] || null, setProperty: (k, v) => { props[k] = v; } }) },
  CacheService: { getScriptCache: () => ({ get: () => null, put: () => {} }) },
  LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
  ContentService: { MimeType: { JSON: 'json' }, createTextOutput: t => ({ setMimeType: () => ({ text: t }) }) },
  Utilities: { getUuid: () => 'key-' + Math.random().toString(36).slice(2) },
  Logger: { log: () => {} },
  module: { exports: {} },
};
vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.join(__dirname, '../apps-script/Code.gs'), 'utf8'), ctx);
const Core = ctx.module.exports.Core;

// ---------- Core ----------
assert.strictEqual(Core.normBarcode(2000000311869), '2000000311869');
assert.strictEqual(Core.ean13ok('9785480000566'), true);
assert.strictEqual(Core.ean13ok('2000000000000'), false);
assert.strictEqual(Core.classify('991017004').cell, 'С17-П4');
assert.strictEqual(Core.classify('991999999').kind, 'desk');
assert.strictEqual(Core.classify('2,00E+12').kind, 'invalid');
assert.strictEqual(Core.classify('000777000098').kind, 'book');          // 12 цифр — реальная книга из 1С
assert.strictEqual(Core.classify('9785948870952').checksumOk, false);    // опечатка издателя — книга, но с предупреждением
assert.strictEqual(Core.cellCode('С17-П4'), '991017004');
assert.strictEqual(Core.packageFor(25, 17, 2, ctx.CFG ? ctx.CFG.PACKAGES : vm.runInContext('CFG.PACKAGES', ctx)), '201 - 2 см.');
assert.strictEqual(Core.packageFor(30, 22, 6, vm.runInContext('CFG.PACKAGES', ctx)), 'Ручная');

let a = Core.applyPlace({ cell: '', article: '' }, { ts: '2026-11-04T10:00:00Z', user: 'Ольга', cell: 'С19-П2', barcode: '2000000311869', pkg: { name: 'Развертка - 5 см.', L: 22, W: 15, H: 5 } });
assert.strictEqual(a.result, 'ok');
assert.strictEqual(a.changes.article, 'С19-П2_2000000311869');
a = Core.applyPlace({ cell: 'С5-П1', article: 'С5-П1_2000000311869', placedAt: '2026-11-03T10:00:00Z' }, { ts: '2026-11-04T10:00:00Z', cell: 'С19-П2', barcode: '2000000311869' });
assert.ok(a.result.startsWith('уже размещена в С5-П1'));
a = Core.applyPlace({ cell: 'С5-П1', article: 'С5-П1_2000000311869', placedAt: '2026-11-03T10:00:00Z' }, { ts: '2026-11-04T10:00:00Z', type: 'move', cell: 'С19-П2', barcode: '2000000311869' });
assert.strictEqual(a.result, 'ok'); assert.strictEqual(a.changes.cell, 'С19-П2'); assert.ok(!('article' in a.changes), 'артикул не меняется при перемещении');
a = Core.applyPlace({ cell: 'С5-П1', placedAt: '2026-11-04T12:00:00Z' }, { ts: '2026-11-04T10:00:00Z', type: 'move', cell: 'С19-П2', barcode: 'x' });
assert.ok(a.result.startsWith('устарело'));

assert.strictEqual(Core.msk('2026-11-04T09:24:05Z'), '04.11.2026 12:24:05');
assert.strictEqual(Core.toMs('04.11.2026 12:24:05'), Date.parse('2026-11-04T09:24:05Z'));
a = Core.applyPlace({ cell: 'С5-П1', placedAt: '04.11.2026 15:00:00' }, { ts: '2026-11-04T11:00:00Z', type: 'move', cell: 'С19-П2', barcode: 'x' });
assert.ok(a.result.startsWith('устарело') && a.result.includes('04.11.2026 15:00:00'), a.result);   // 11:00Z = 14:00 МСК < 15:00
a = Core.applyPlace({ cell: 'С5-П1', placedAt: '04.11.2026 13:00:00' }, { ts: '2026-11-04T11:00:00Z', type: 'move', cell: 'С19-П2', barcode: 'x' });
assert.strictEqual(a.result, 'ok'); assert.strictEqual(a.changes.placedAt, '04.11.2026 14:00:00');

// ---------- обработка событий на поддельной таблице ----------
const H = ['', 'Название книги', 'Авторы', 'Место хранения', 'НАШ ШТРИХКОД', 'Количество', 'Длина', 'Ширина', 'Высота', 'Статистика-формула'];
const books = new Sheet('Лист1', [H,
  [1, 'Книга А', 'Автор', '', 2000000311869, 1, 25, 17, 2, '=X'],
  [2, 'Книга Б', '', '', 2000000311852, 2, '', '', '', '=X'],
  [3, 'Книга В', '', 'С5-П1', 9785480000566, 1, 22, 15, 3, '=X'],
  [4, 'Дубль 1', '', '', 2000000311845, 1, '', '', '', ''],
  [5, 'Дубль 2', '', '', 2000000311845, 1, '', '', '', ''],
]);
const sheets = { 'Лист1': books };
ctx.SpreadsheetApp = { getActive: () => { throw new Error('скрипт отдельный — getActive() нельзя'); },
                      openById: id => { assert.strictEqual(id, vm.runInContext('SPREADSHEET_ID', ctx)); return makeSS(sheets); } };
vm.runInContext('setup()', ctx);
const keys = JSON.parse(props.DEVICE_KEYS);
const olgaKey = Object.keys(keys).find(k => keys[k] === 'Ольга');
assert.ok(olgaKey);
const hm = {}; books.rows[0].forEach((h, i) => { hm[h] = i; });
['Артикул', 'Упаковка', 'Размещено', 'Размещено кем'].forEach(h => assert.ok(h in hm, 'создан столбец ' + h));

function post(events) {
  const r = vm.runInContext('doPost', ctx)({ postData: { contents: JSON.stringify({ key: olgaKey, device: 't', events }) } });
  return JSON.parse(r.text);
}
let r = post([
  { id: 'e1', ts: '2026-11-04T10:00:00Z', type: 'place', cell: 'С19-П2', barcode: '2000000311869', pkg: null },
  { id: 'e2', ts: '2026-11-04T10:00:05Z', type: 'place', cell: 'С19-П2', barcode: '2000000311852', pkg: { name: 'Развертка - 5 см.' } },
  { id: 'e3', ts: '2026-11-04T10:00:09Z', type: 'place', cell: 'С19-П2', barcode: '9785480000566', pkg: null },
  { id: 'e4', ts: '2026-11-04T10:00:12Z', type: 'place', cell: 'С19-П2', barcode: '2,00E+12' },
  { id: 'e5', ts: '2026-11-04T10:00:15Z', type: 'place', cell: 'С19-П2', barcode: '2000000311845' },
  { id: 'e6', ts: '2026-11-04T10:00:18Z', type: 'place', cell: 'С19-П2', barcode: '2000000999990' },
]);
assert.ok(r.ok, r.error);
const res = Object.fromEntries(r.results.map(x => [x.id, x.result]));
assert.strictEqual(res.e1, 'ok');
assert.strictEqual(res.e2, 'ok');
assert.ok(res.e3.startsWith('уже размещена в С5-П1'), res.e3);
assert.ok(res.e4.includes('некорректный штрихкод'), res.e4);
assert.ok(res.e5.includes('дважды'), res.e5);
assert.ok(res.e6.includes('нет в'), res.e6);
const row = i => books.rows[i];
assert.strictEqual(row(1)[hm['Место хранения']], 'С19-П2');
assert.strictEqual(row(1)[hm['Артикул']], 'С19-П2_2000000311869');
assert.strictEqual(row(1)[hm['Длина']], 25, 'габариты из парсинга не тронуты, если упаковку не меняли');
assert.strictEqual(row(2)[hm['Длина']], 22); assert.strictEqual(row(2)[hm['Ширина']], 15); assert.strictEqual(row(2)[hm['Высота']], 5);
assert.strictEqual(row(2)[hm['Упаковка']], 'Развертка - 5 см.');
assert.strictEqual(row(3)[hm['Место хранения']], 'С5-П1', 'чужая ячейка не перезаписана');
assert.strictEqual(row(1)[hm['Статистика-формула']], '=X', 'чужие столбцы не тронуты');
assert.strictEqual(row(1)[hm['Размещено кем']], 'Ольга');
assert.strictEqual(row(1)[hm['Размещено']], '04.11.2026 13:00:00', 'время размещения по Москве');

// повторная отправка тех же событий — ничего не меняется
r = post([{ id: 'e1', ts: '2026-11-04T10:00:00Z', type: 'place', cell: 'С21-П4', barcode: '2000000311869' }]);
assert.strictEqual(r.results[0].result, 'уже получено');
assert.strictEqual(row(1)[hm['Место хранения']], 'С19-П2');

// отмена e2 -> строка как до пика
r = post([{ id: 'u1', ts: '2026-11-04T10:01:00Z', type: 'undo', undoOf: 'e2' }]);
assert.strictEqual(r.results[0].result, 'отменено');
assert.strictEqual(row(2)[hm['Место хранения']], '');
assert.strictEqual(row(2)[hm['Артикул']], '');
assert.strictEqual(row(2)[hm['Длина']], '');
// отмена неприменённого события
r = post([{ id: 'u2', ts: '2026-11-04T10:01:05Z', type: 'undo', undoOf: 'e3' }]);
assert.ok(r.results[0].result.includes('отменять нечего'));

// перемещение (инвентаризация): ячейка меняется, артикул — нет
r = post([{ id: 'm1', ts: '2026-11-04T11:00:00Z', type: 'move', cell: 'С21-П4', barcode: '2000000311869' }]);
assert.strictEqual(r.results[0].result, 'ok');
assert.strictEqual(row(1)[hm['Место хранения']], 'С21-П4');
assert.strictEqual(row(1)[hm['Артикул']], 'С19-П2_2000000311869');

// чужой ключ
const bad = JSON.parse(vm.runInContext('doPost', ctx)({ postData: { contents: JSON.stringify({ key: 'nope', events: [] }) } }).text);
assert.strictEqual(bad.ok, false);

// журнал и ошибки
const journal = sheets['Журнал размещения'];
assert.strictEqual(journal.rows.length - 1, 9, 'все 9 событий в журнале, повтор e1 не задвоен');
assert.ok(sheets['Ошибки'].rows.length - 1 >= 4);

// ---------- безопасная отмена ----------
const vladaKey = Object.keys(keys).find(k => keys[k] === 'Влада');
function postAs(key, events) {
  return JSON.parse(vm.runInContext('doPost', ctx)({ postData: { contents: JSON.stringify({ key, device: 't', events }) } }).text);
}
const W = books.rows[0].length;
function addBook(no, title, barcode, L = '', Wd = '', Hd = '') {
  const r = Array(W).fill(''); r[0] = no; r[hm['Название книги']] = title; r[hm['НАШ ШТРИХКОД']] = barcode;
  r[hm['Количество']] = 1; r[hm['Длина']] = L; r[hm['Ширина']] = Wd; r[hm['Высота']] = Hd;
  books.rows.push(r); return books.rows.length - 1;     // индекс строки в массиве
}
const byCode = bc => books.rows.find(x => String(x[hm['НАШ ШТРИХКОД']]) === bc);
const res1 = (rr) => rr.results[0].result;

// 1) строки сдвинулись между пиком и отменой — отмена находит книгу по штрихкоду
addBook(101, 'Сдвиг', '2000000400001', 25, 17, 2);
assert.strictEqual(res1(post([{ id: 's1', ts: '2026-11-05T10:00:00Z', type: 'place', cell: 'С30-П1', barcode: '2000000400001' }])), 'ok');
const filler = Array(W).fill(''); filler[hm['Название книги']] = 'Вставленная строка'; filler[hm['НАШ ШТРИХКОД']] = 2000000400099;
books.rows.splice(1, 0, filler);                       // кто-то вставил строку сверху — все номера сдвинулись
assert.strictEqual(res1(post([{ id: 's1u', ts: '2026-11-05T10:00:30Z', type: 'undo', undoOf: 's1' }])), 'отменено');
assert.strictEqual(byCode('2000000400001')[hm['Место хранения']], '', 'отмена попала в нужную книгу');
assert.strictEqual(byCode('2000000400001')[hm['Артикул']], '');
assert.strictEqual(byCode('2000000400099')[hm['Место хранения']], '', 'соседняя строка не тронута');
assert.strictEqual(String(books.rows[2][hm['Название книги']]), 'Книга А', 'Книга А на месте');
assert.strictEqual(books.rows[2][hm['Место хранения']], 'С21-П4', 'отмена не записала ничего в строку, где раньше была книга');
// повторная отмена того же пика
assert.strictEqual(res1(post([{ id: 's1u2', ts: '2026-11-05T10:00:40Z', type: 'undo', undoOf: 's1' }])), 'уже отменено');

// 2) после пика книгу переместили — отмена не затирает перемещение
addBook(102, 'Переместили', '2000000400002', 25, 17, 2);
assert.strictEqual(res1(post([{ id: 'p2', ts: '2026-11-05T10:01:00Z', type: 'place', cell: 'С30-П1', barcode: '2000000400002' }])), 'ok');
assert.strictEqual(res1(postAs(vladaKey, [{ id: 'p2m', ts: '2026-11-05T10:02:00Z', type: 'move', cell: 'С31-П1', barcode: '2000000400002' }])), 'ok');
let u = res1(post([{ id: 'p2u', ts: '2026-11-05T10:02:30Z', type: 'undo', undoOf: 'p2' }]));
assert.ok(u.includes('уже меняли') && u.includes('отмена не применена'), u);
assert.strictEqual(byCode('2000000400002')[hm['Место хранения']], 'С31-П1', 'перемещение не затёрто');

// 3) строку поправили руками — отмена не трогает
addBook(103, 'Руками', '2000000400003', 25, 17, 2);
assert.strictEqual(res1(post([{ id: 'p3', ts: '2026-11-05T10:03:00Z', type: 'place', cell: 'С30-П1', barcode: '2000000400003' }])), 'ok');
byCode('2000000400003')[hm['Место хранения']] = 'С32-П2';
u = res1(post([{ id: 'p3u', ts: '2026-11-05T10:03:30Z', type: 'undo', undoOf: 'p3' }]));
assert.ok(u.includes('вручную'), u);
assert.strictEqual(byCode('2000000400003')[hm['Место хранения']], 'С32-П2');

// 4) пик + исправление упаковки -> отмена пика убирает и исправление
addBook(104, 'Исправили упаковку', '2000000400004');
assert.strictEqual(res1(post([{ id: 'p4', ts: '2026-11-05T10:04:00Z', type: 'place', cell: 'С30-П1', barcode: '2000000400004', pkg: { name: 'Развертка - 5 см.' } }])), 'ok');
assert.strictEqual(res1(post([{ id: 'p4f', ts: '2026-11-05T10:04:20Z', type: 'place', cell: 'С30-П1', barcode: '2000000400004', pkg: { name: '201 - 2 см.' }, fixOf: 'p4' }])), 'ok');
assert.strictEqual(byCode('2000000400004')[hm['Длина']], 25);
assert.strictEqual(res1(post([{ id: 'p4u', ts: '2026-11-05T10:04:40Z', type: 'undo', undoOf: 'p4' }])), 'отменено');
const b4 = byCode('2000000400004');
assert.ok(b4[hm['Место хранения']] === '' && b4[hm['Длина']] === '' && b4[hm['Упаковка']] === '' && b4[hm['Артикул']] === '', 'строка как до пика');

// 5) «Размещено кем» возвращается после отмены
addBook(105, 'Кем', '2000000400005', 25, 17, 2);
assert.strictEqual(res1(post([{ id: 'p5', ts: '2026-11-05T10:05:00Z', type: 'place', cell: 'С30-П1', barcode: '2000000400005' }])), 'ok');
assert.strictEqual(res1(postAs(vladaKey, [{ id: 'p6', ts: '2026-11-05T10:06:00Z', type: 'place', cell: 'С30-П1', barcode: '2000000400005' }])), 'ok');
assert.strictEqual(byCode('2000000400005')[hm['Размещено кем']], 'Влада');
assert.strictEqual(res1(postAs(vladaKey, [{ id: 'p6u', ts: '2026-11-05T10:06:30Z', type: 'undo', undoOf: 'p6' }])), 'отменено');
assert.strictEqual(byCode('2000000400005')[hm['Размещено кем']], 'Ольга', 'вернулось «кем» до перепика');
assert.strictEqual(byCode('2000000400005')[hm['Размещено']], '05.11.2026 13:05:00', 'вернулось время Ольги');
assert.strictEqual(byCode('2000000400005')[hm['Место хранения']], 'С30-П1');
const jh = sheets['Журнал размещения'].rows[0];
assert.strictEqual(jh[21], 'к событию'); assert.strictEqual(jh[22], 'было: кем');

// справочник: все листы «Архив…» (новый архив подхватывается сам)
const AH = ['', 'Название книги', 'Авторы', 'Место хранения', 'НАШ ШТРИХКОД'];
sheets['Архив 1-7595'] = new Sheet('Архив 1-7595', [AH, [1, 'Старая 1', '', 'С1-П1', 2000000000111]]);
sheets['Архив 7596-9000'] = new Sheet('Архив 7596-9000', [AH, [7596, 'Старая 2', '', 'С2-П2', 2000000000222]]);
sheets['Журнал не архив'] = new Sheet('Журнал не архив', [AH, [1, 'Чужое', '', 'С9-П9', 2000000000333]]);
const cat = JSON.parse(vm.runInContext('doGet', ctx)({ parameter: { key: olgaKey, action: 'catalog' } }).text);
assert.strictEqual(cat.table, 'ТЕСТ OzonBooks', 'справочник говорит, какая это таблица');
assert.ok(cat.ok);
assert.strictEqual(cat.books['2000000311869'].c, 'С21-П4');
assert.strictEqual(cat.packages.length, 17);
assert.strictEqual(cat.books['2000000000111'].s.arch, 'С1-П1', 'первый архив');
assert.strictEqual(cat.books['2000000000222'].s.arch, 'С2-П2', 'второй архив подхвачен по названию «Архив…»');
assert.ok(!cat.books['2000000000333'], 'лист не «Архив…» не читается');

// Лист1 переименовали — скрипт находит его по gid 0
sheets['Книги'] = sheets['Лист1']; delete sheets['Лист1'];
const cat2 = JSON.parse(vm.runInContext('doGet', ctx)({ parameter: { key: olgaKey, action: 'catalog' } }).text);
assert.ok(cat2.ok && cat2.books['2000000311869'], 'переименованный Лист1 найден по gid 0');

// ---------- заказы WB (поддельный WB) ----------
assert.strictEqual(Core.barcodeFromArticle('С35-П5_2000000289069'), '2000000289069');
assert.strictEqual(Core.barcodeFromArticle('старый-артикул'), '');
let o = JSON.parse(vm.runInContext('doGet', ctx)({ parameter: { key: olgaKey, action: 'orders' } }).text);
assert.ok(!o.ok && o.error.includes('WB_TOKEN'), 'без ключа WB — понятная ошибка: ' + JSON.stringify(o));
props.WB_TOKEN = 'test-token';
const wbCalls = [];
const cacheStore = {};
ctx.CacheService = { getScriptCache: () => ({ get: k => cacheStore[k] || null, put: (k, v) => { cacheStore[k] = v; } }) };
ctx.Utilities.sleep = () => {};
const resp = (code, obj) => ({ getResponseCode: () => code, getContentText: () => JSON.stringify(obj) });
cacheStore['card2:501'] = JSON.stringify({ photo: '', brand: '', title: '' });   // пустая запись из прошлой версии
let busyOnce = true;            // первый запрос карточки — «подождите» (429), потом нормально
const noPhoto = new Set([503]);
ctx.UrlFetchApp = {
  fetch: (url, opts) => {
    wbCalls.push(url); assert.strictEqual(opts.headers.Authorization, 'test-token');
    if (url.includes('orders/new')) return resp(200, { orders: [
      { id: 11, article: 'С35-П5_2000000289069', nmId: 501, createdAt: '2026-11-05T20:55:00Z', price: 131100, salePrice: 168600, finalPrice: 120000, skus: ['2000000289069'] },
      { id: 12, article: 'С4-П2_2000000311869', nmId: 502, createdAt: '2026-11-05T21:10:00Z', price: 50000 },
      { id: 13, article: 'С4-П3_2000000311876', nmId: 503, createdAt: '2026-11-05T21:20:00Z', price: 40000 } ] });
    if (busyOnce) { busyOnce = false; return resp(429, {}); }
    const nm = Number(JSON.parse(opts.payload).settings.filter.textSearch);
    if (noPhoto.has(nm)) return resp(200, { cards: [] });
    return resp(200, { cards: [{ nmID: nm, title: 'Книга ' + nm, brand: 'Современник', photos: [{ c246x328: 'https://img/' + nm + '.webp' }] }] });
  }
};
o = JSON.parse(vm.runInContext('doGet', ctx)({ parameter: { key: olgaKey, action: 'orders' } }).text);
assert.ok(o.ok, o.error);
assert.strictEqual(o.orders.length, 3);
assert.strictEqual(o.orders[0].barcode, '2000000289069');
assert.strictEqual(o.orders[0].photo, 'https://img/501.webp', 'после «подождите» (429) фото всё равно получено');
assert.strictEqual(o.orders[0].brand, 'Современник');
assert.strictEqual(o.orders[0].price, 131100);
assert.strictEqual(o.orders[0].finalPrice, 120000);
assert.strictEqual(o.orders[2].photo, '');
assert.ok(!cacheStore['card2:503'], 'карточка без фото не кэшируется');
const n1 = wbCalls.length;
noPhoto.clear();
o = JSON.parse(vm.runInContext('doGet', ctx)({ parameter: { key: olgaKey, action: 'orders' } }).text);
assert.strictEqual(wbCalls.length - n1, 2, 'второй раз: список заказов + только карточка, которой не было в кэше');
assert.strictEqual(o.orders[2].photo, 'https://img/503.webp', 'фото появилось при следующем обновлении');
ctx.UrlFetchApp.fetch = (url) => url.includes('orders/new') ? resp(200, { orders: [{ id: 14, nmId: 900, article: 'x' }] }) : resp(401, {});
o = JSON.parse(vm.runInContext('doGet', ctx)({ parameter: { key: olgaKey, action: 'orders' } }).text);
assert.ok(o.ok && o.cardsErr.includes('401'), 'ошибка карточек видна: ' + o.cardsErr);
ctx.UrlFetchApp.fetch = () => resp(401, {});
o = JSON.parse(vm.runInContext('doGet', ctx)({ parameter: { key: olgaKey, action: 'orders' } }).text);
assert.ok(!o.ok && o.error.includes('401'), o.error);

console.log('Все проверки пройдены:', 'Core + события + безопасная отмена + перемещение + справочник + заказы WB');
