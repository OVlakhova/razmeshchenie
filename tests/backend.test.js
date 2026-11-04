// Проверка скрипта таблицы вне Google: Core + обработка событий на поддельной таблице.
// Запуск: node tests/backend.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

// ---------- поддельные SpreadsheetApp / сервисы ----------
class Sheet {
  constructor(name, rows) { this.name = name; this.rows = rows.map(r => r.slice()); }
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
ctx.SpreadsheetApp = { getActive: () => makeSS(sheets) };
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

// справочник
const cat = JSON.parse(vm.runInContext('doGet', ctx)({ parameter: { key: olgaKey, action: 'catalog' } }).text);
assert.strictEqual(cat.table, 'ТЕСТ OzonBooks', 'справочник говорит, какая это таблица');
assert.ok(cat.ok);
assert.strictEqual(cat.books['2000000311869'].c, 'С21-П4');
assert.strictEqual(cat.packages.length, 17);

console.log('Все проверки пройдены:', 'Core + события + отмена + перемещение + справочник');
