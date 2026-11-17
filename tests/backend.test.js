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
  LockService: { getScriptLock: () => ({ waitLock() {}, tryLock() { return true; }, releaseLock() {} }) },
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
assert.deepStrictEqual(Object.values(keys).sort(), ['Айфон', 'Влада', 'Ольга'], 'три ключа: Ольга, Влада, Айфон');
// новый пользователь добавляется, старые ключи не меняются
const two = Object.fromEntries(Object.entries(keys).filter(([, n]) => n !== 'Айфон'));
props.DEVICE_KEYS = JSON.stringify(two);
vm.runInContext('setup()', ctx);
const keys2 = JSON.parse(props.DEVICE_KEYS);
assert.strictEqual(Object.keys(keys2).length, 3);
for (const k of Object.keys(two)) assert.strictEqual(keys2[k], two[k], 'старый ключ на месте: ' + two[k]);
vm.runInContext('setup()', ctx);
assert.strictEqual(Object.keys(JSON.parse(props.DEVICE_KEYS)).length, 3, 'повторный setup ключей не плодит');
Object.assign(keys, keys2);
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
assert.ok(bad.ver, 'версия скрипта есть даже в ответе с ошибкой');

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

// ---------- состояние книги (фотостол и размещение) ----------
let rs = post([
  { id: 'st1', ts: '2026-11-13T10:00:00Z', type: 'state', barcode: '2000000777001', state: { f: 'pocket', d: ['skew', 'flood_bottom'], n: ['marks'], o: '' } },
  { id: 'st2', ts: '2026-11-13T10:01:00Z', type: 'state', barcode: '2000000777002', state: { f: 'reduced', d: [], n: [], o: 'надорван форзац' } },
  { id: 'st3', ts: '2026-11-13T10:02:00Z', type: 'state', barcode: '2,00E+12', state: { f: 'normal' } },
  { id: 'st4', ts: '2026-11-13T10:03:00Z', type: 'state', barcode: '2000000777003', state: { f: 'huge' } },
]);
assert.deepStrictEqual(rs.results.map(x => x.result.slice(0, 20)), ['ok', 'ok', 'ошибка: некорректный', 'ошибка: непонятная о']);
const stSh = sheets['Состояние'];
assert.ok(stSh, 'лист «Состояние» создан сам');
assert.deepStrictEqual(stSh.rows[0], ['штрихкод', 'формат', 'дефекты', 'особенности', 'другой дефект', 'кто', 'когда', 'id события']);
assert.deepStrictEqual(stSh.rows[1].slice(0, 6), ['2000000777001', 'карманный', 'скос блока; залив — нижний край', 'подчёркивания и пометки в тексте', '', 'Ольга']);
assert.deepStrictEqual(stSh.rows[2].slice(0, 5), ['2000000777002', 'уменьшенный', '', '', 'надорван форзац']);
// повторная отметка той же книги — правка строки, а не вторая строка; два залива -> один
rs = postAs(vladaKey, [{ id: 'st5', ts: '2026-11-13T11:00:00Z', type: 'state', barcode: '2000000777001', state: { f: 'normal', d: ['flood_top', 'flood_side', 'tear'], n: [], o: '' } }]);
assert.strictEqual(rs.results[0].result, 'ok');
assert.strictEqual(stSh.rows.length, 3, 'строк не прибавилось');
assert.deepStrictEqual(stSh.rows[1].slice(0, 6), ['2000000777001', 'обычный', 'залив — верхний край; надрыв страницы', '', '', 'Влада']);
const jr = sheets['Журнал размещения'].rows.find(r => r[0] === 'st5');
assert.strictEqual(jr[23], 'обычный; залив — верхний край; надрыв страницы', 'в журнале видно, что отметили');
assert.strictEqual(sheets['Журнал размещения'].rows[0][23], 'состояние');
// справочник отдаёт отметки, и для книг, которых ещё нет в Лист1
const catS = JSON.parse(vm.runInContext('doGet', ctx)({ parameter: { key: olgaKey, action: 'catalog' } }).text);
assert.deepStrictEqual(catS.states['2000000777001'], { f: 'normal', d: ['flood_top', 'tear'], n: [], o: '' });
assert.deepStrictEqual(catS.states['2000000777002'], { f: 'reduced', d: [], n: [], o: 'надорван форзац' });
// три особенности; старые подписи на листе читаются
rs = post([{ id: 'st6', ts: '2026-11-15T10:00:00Z', type: 'state', barcode: '2000000777004', state: { f: 'normal', d: [], n: ['gift', 'autograph', 'marks'], o: '' } }]);
assert.strictEqual(rs.results[0].result, 'ok');
assert.strictEqual(stSh.rows[stSh.rows.length - 1][3], 'дарственная надпись; автограф автора; подчёркивания и пометки в тексте');
stSh.rows.push(['2000000777005', 'обычный', '', 'надписи и пометки; дарственная надпись / автограф', '', 'Ольга', '', 'old']);
const catOld = JSON.parse(vm.runInContext('doGet', ctx)({ parameter: { key: olgaKey, action: 'catalog' } }).text);
assert.deepStrictEqual(catOld.states['2000000777005'].n.sort(), ['gift', 'marks']);
assert.deepStrictEqual(catOld.states['2000000777004'].n, ['gift', 'autograph', 'marks']);
// 2.4: библиотечный штамп — особенность, не дефект
rs = post([{ id: 'st7', ts: '2026-11-16T10:00:00Z', type: 'state', barcode: '2000000777006', state: { f: 'normal', d: [], n: ['stamp'], o: '' } }]);
assert.strictEqual(rs.results[0].result, 'ok');
assert.strictEqual(stSh.rows[stSh.rows.length - 1][3], 'библиотечный штамп');
assert.strictEqual(stSh.rows[stSh.rows.length - 1][2], '');
// другой человек изменил чужую отметку -> лист «Изменения отметок»; свои правки и одинаковые отметки — нет
const lgRows = () => (sheets['Изменения отметок'] ? sheets['Изменения отметок'].rows.length : 0);
assert.strictEqual(lgRows(), 2, 'раньше в тестах Влада изменила отметку Ольги (st5) — это уже одна запись');
const n0lg = lgRows();
rs = post([{ id: 'hk1', ts: '2026-11-16T16:36:00Z', type: 'state', barcode: '2000000312637', state: { f: 'normal', d: [], n: [], o: '' } }]);
assert.strictEqual(rs.results[0].result, 'ok');
assert.strictEqual(lgRows(), n0lg, 'первая отметка — ничего не логируем');
rs = post([{ id: 'hk2', ts: '2026-11-16T16:37:00Z', type: 'state', barcode: '2000000312637', state: { f: 'pocket', d: [], n: [], o: '' } }]);
assert.strictEqual(lgRows(), n0lg, 'своя правка — не логируем');
rs = postAs(vladaKey, [{ id: 'hk3', ts: '2026-11-16T16:38:00Z', type: 'state', barcode: '2000000312637', state: { f: 'reduced', d: ['skew'], n: [], o: '' } }]);
assert.strictEqual(rs.results[0].result, 'ok');
const lg = sheets['Изменения отметок'];
assert.strictEqual(lg.rows.length, n0lg + 1, 'чужая правка — одна запись');
assert.deepStrictEqual([...lg.rows[0]], ['когда', 'штрихкод', 'книга', 'было', 'кто отметил раньше', 'когда раньше', 'стало', 'кто изменил']);
assert.strictEqual(JSON.stringify(lg.rows[lg.rows.length - 1].slice(1)), JSON.stringify(['2000000312637', '', 'карманный', 'Ольга', '16.11.2026 19:37:00', 'уменьшенный; скос блока', 'Влада']));
assert.strictEqual(stSh.rows.find(r => r[0] === '2000000312637')[1], 'уменьшенный', 'последняя отметка остаётся как есть, без объединения');
rs = post([{ id: 'hk4', ts: '2026-11-16T16:39:00Z', type: 'state', barcode: '2000000312637', state: { f: 'reduced', d: ['skew'], n: [], o: '' } }]);
assert.strictEqual(lg.rows.length, n0lg + 1, 'та же отметка другим человеком — не расхождение');
rs = post([{ id: 'hk5', ts: '2026-11-16T16:40:00Z', type: 'state', barcode: '2000000311869', state: { f: 'pocket', d: [], n: [], o: '' } }]);
rs = postAs(vladaKey, [{ id: 'hk6', ts: '2026-11-16T16:41:00Z', type: 'state', barcode: '2000000311869', state: { f: 'normal', d: [], n: [], o: '' } }]);
assert.ok(lg.rows[lg.rows.length - 1][2].length > 0, 'для книги из Лист1 указано название');
// повторная отправка — не задваивается
rs = post([{ id: 'st1', ts: '2026-11-13T10:00:00Z', type: 'state', barcode: '2000000777001', state: { f: 'pocket' } }]);
assert.strictEqual(rs.results[0].result, 'уже получено');
assert.strictEqual(stSh.rows[1][1], 'обычный');

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


// ---------- 2.5: книгу поставили раньше, чем описали ----------
const ean = p12 => { let s = 0; for (let i = 0; i < 12; i++) s += +p12[i] * (i % 2 ? 3 : 1); return p12 + ((10 - s % 10) % 10); };
const jrows = () => sheets['Журнал размещения'].rows;
const jres = id => { const x = jrows().find(r => String(r[0]) === id); return x && x[12]; };
const errN = () => sheets['Ошибки'].rows.length;
const catalog = () => JSON.parse(vm.runInContext('doGet', ctx)({ parameter: { key: olgaKey, action: 'catalog' } }).text);
const P1 = ean('200000050001'), P2 = ean('200000050002'), P3 = ean('200000050003'), P4 = ean('200000050004'), P5 = ean('200000050005'), P6 = ean('200000050006');
let e0 = errN();
// 1) неописанная книга с нашей наклейкой -> «ждёт описания», не ошибка
rs = postAs(vladaKey, [{ id: 'w1', ts: '2026-11-17T09:00:00Z', type: 'place', cell: 'С1-П2', barcode: P1, pkg: { name: 'Развертка - 5 см.' } }]);
assert.strictEqual(rs.results[0].result, 'ждёт описания');
assert.strictEqual(errN(), e0, 'в «Ошибки» не попала');
// чужой код (не 200…) и наша наклейка с неверной контрольной цифрой — по-прежнему ошибка
rs = post([{ id: 'w1x', ts: '2026-11-17T09:00:01Z', type: 'place', cell: 'С1-П2', barcode: '9785041104634' },
           { id: 'w1y', ts: '2026-11-17T09:00:02Z', type: 'place', cell: 'С1-П2', barcode: P1.slice(0, 12) + ((+P1[12] + 1) % 10) }]);
assert.ok(rs.results.every(x => x.result.includes('нет в')), JSON.stringify(rs.results));
e0 = errN();
let pcat = catalog();
assert.ok(pcat.ok, pcat.error);
assert.deepStrictEqual([pcat.books[P1].c, pcat.books[P1].pend, pcat.books[P1].n], ['С1-П2', 1, 1], 'телефон знает, где стоит неописанная книга');
// 2) книгу описали (парсер дописал строку) -> место вписывается само при следующем обращении
const r1 = addBook(201, 'Описали потом', P1);
pcat = catalog();
let b = books.rows[r1];
assert.strictEqual(b[hm['Место хранения']], 'С1-П2');
assert.strictEqual(b[hm['Артикул']], 'С1-П2_' + P1);
assert.strictEqual(b[hm['Упаковка']], 'Развертка - 5 см.');
assert.deepStrictEqual([b[hm['Длина']], b[hm['Ширина']], b[hm['Высота']]], [22, 15, 5]);
assert.strictEqual(b[hm['Размещено']], '17.11.2026 12:00:00', 'время — когда пикнули, а не когда описали');
assert.strictEqual(b[hm['Размещено кем']], 'Влада');
assert.strictEqual(jres('w1'), 'ok', 'в журнале пик стал «ok»');
assert.ok(!pcat.books[P1].pend && pcat.books[P1].c === 'С1-П2', 'в справочнике — обычная книга');
// и его можно отменить как обычный пик
assert.strictEqual(res1(post([{ id: 'w1u', ts: '2026-11-17T10:00:00Z', type: 'undo', undoOf: 'w1' }])), 'отменено');
assert.strictEqual(books.rows[r1][hm['Место хранения']], ''); assert.strictEqual(books.rows[r1][hm['Упаковка']], '');
// 3) переставили на другую полку до описания -> действует последний пик
post([{ id: 'w2', ts: '2026-11-17T09:10:00Z', type: 'place', cell: 'С1-П2', barcode: P2, pkg: { name: '201 - 2 см.' } }]);
post([{ id: 'w2m', ts: '2026-11-17T09:20:00Z', type: 'move', cell: 'С4-П3', barcode: P2, pkg: { name: '201 - 2 см.' } }]);
assert.strictEqual(catalog().books[P2].c, 'С4-П3');
const r2 = addBook(202, 'Переставили', P2);
catalog();
assert.strictEqual(books.rows[r2][hm['Место хранения']], 'С4-П3');
assert.strictEqual(books.rows[r2][hm['Артикул']], 'С4-П3_' + P2);
assert.ok(jres('w2').startsWith('заменено'), jres('w2'));
// 4) отменили до описания -> ничего не впишется
post([{ id: 'w3', ts: '2026-11-17T09:30:00Z', type: 'place', cell: 'С1-П2', barcode: P3, pkg: { name: '201 - 2 см.' } }]);
assert.strictEqual(res1(post([{ id: 'w3u', ts: '2026-11-17T09:31:00Z', type: 'undo', undoOf: 'w3' }])), 'отменено');
assert.strictEqual(jres('w3'), 'отменено до описания');
assert.ok(!catalog().books[P3], 'отменённая неописанная книга не числится на полке');
const r3 = addBook(203, 'Отменили', P3); catalog();
assert.strictEqual(books.rows[r3][hm['Место хранения']], '', 'после описания место не появилось');
// 5) исправили упаковку до описания -> впишется исправленная; отмена пика возвращает строку как была
post([{ id: 'w4', ts: '2026-11-17T09:40:00Z', type: 'place', cell: 'С1-П2', barcode: P4, pkg: { name: '201 - 2 см.' } }]);
post([{ id: 'w4f', ts: '2026-11-17T09:40:30Z', type: 'place', cell: 'С1-П2', barcode: P4, pkg: { name: 'Развертка - 7 см.' }, fixOf: 'w4' }]);
const r4 = addBook(204, 'Исправили', P4); catalog();
assert.strictEqual(books.rows[r4][hm['Упаковка']], 'Развертка - 7 см.');
assert.strictEqual(res1(post([{ id: 'w4u', ts: '2026-11-17T10:00:00Z', type: 'undo', undoOf: 'w4' }])), 'отменено');
assert.strictEqual(books.rows[r4][hm['Место хранения']], ''); assert.strictEqual(books.rows[r4][hm['Упаковка']], '');
// 6) не описали за 3 дня -> одна строка в «Ошибки», но ждём дальше
e0 = errN();
post([{ id: 'w5', ts: '2026-11-10T09:00:00Z', type: 'place', cell: 'С2-П1', barcode: P5, pkg: { name: '201 - 2 см.' } }]);
catalog(); catalog();
assert.strictEqual(errN(), e0 + 1, 'одна строка в «Ошибки»');
assert.ok(sheets['Ошибки'].rows[errN() - 1][5].includes('больше 3 дней'));
const r5 = addBook(205, 'Поздно описали', P5); catalog();
assert.strictEqual(books.rows[r5][hm['Место хранения']], 'С2-П1', 'описали позже — место всё равно вписалось');
// 7) книгу описали и успели поставить в другое место обычным пиком -> отложенный пик не перетирает
post([{ id: 'w6', ts: '2026-11-17T09:50:00Z', type: 'place', cell: 'С1-П2', barcode: P6, pkg: { name: '201 - 2 см.' } }]);
const r6 = addBook(206, 'Уже стоит', P6); books.rows[r6][hm['Место хранения']] = 'С9-П9';
e0 = errN(); catalog();
assert.strictEqual(books.rows[r6][hm['Место хранения']], 'С9-П9');
assert.ok(jres('w6').includes('уже размещена'), jres('w6'));
assert.strictEqual(errN(), e0 + 1);
console.log('Все проверки пройдены:', 'Core + события + безопасная отмена + перемещение + справочник + заказы WB + состояние + размещение до описания');
