# Сквозная проверка приложения в настоящем Chromium с поддельной таблицей.
# Запуск: python3 tests/app_e2e.py
import json, threading, http.server, functools, os, sys
from playwright.sync_api import sync_playwright

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'docs')
PORT = 8791
API = 'https://script.google.com/macros/s/AKfycbzsrMDosDNc4HsdZyGS-WUeu7bUxzGh0HCho9dZJAC8_p163mjrFFPM3WCPH35hqQ_b/exec'

handler = functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT)
handler.log_message = lambda *a: None
srv = http.server.ThreadingHTTPServer(('127.0.0.1', PORT), handler)
threading.Thread(target=srv.serve_forever, daemon=True).start()

PK = [{"name": "201 - 2 см.", "L": 25, "W": 17, "H": 2}, {"name": "Развертка - 5 см.", "L": 22, "W": 15, "H": 5},
      {"name": "Ручная", "manual": True}]
BOOKS = {
  "2000000311869": {"t": "Книга с габаритами", "a": "Автор А", "s": {}, "n": 1, "q": 1, "c": "", "d": [25, 17, 2]},
  "2000000311852": {"t": "Книга без габаритов", "a": "", "s": {}, "n": 1, "q": 1, "c": ""},
  "2000000311845": {"t": "Третья книга", "a": "", "s": {}, "n": 1, "q": 2, "c": ""},
  "2000000311838": {"t": "Книга для проверки без сети", "a": "", "s": {}, "n": 1, "q": 1, "c": "", "d": [22, 15, 5]},
  "9785480000566": {"t": "Уже на другой полке", "a": "", "s": {}, "n": 1, "q": 1, "c": "С5-П1", "d": [22, 15, 3]},
  "9785991035781": {"t": "Старая из 1С", "a": "Б", "s": {"1c": "С17-П4", "arch": "С17-П4"}, "f": 1, "ar": "С17-П4_9785991035781"},
}
posted = []
NET = {"down": False}

def handle(route, request):
    if NET["down"]:
        return route.abort('internetdisconnected')
    if request.method == 'GET':
        q = request.url.split('?', 1)[1]
        if 'key=good' not in q:
            return route.fulfill(status=200, content_type='application/json', body=json.dumps({"ok": False, "error": "Неизвестный ключ устройства"}))
        if 'action=ping' in q:
            return route.fulfill(status=200, content_type='application/json', body=json.dumps({"ok": True, "user": "Ольга"}))
        # как настоящая таблица: принятые пики уже записаны в «Место хранения»
        books = json.loads(json.dumps(BOOKS))
        for e in posted:
            if e.get('type') in ('place', 'move') and e.get('barcode') in books and books[e['barcode']].get('n'):
                books[e['barcode']]['c'] = e['cell']
        return route.fulfill(status=200, content_type='application/json',
                             body=json.dumps({"ok": True, "version": "2026-11-04T09:00:00Z", "packages": PK, "books": books}))
    body = json.loads(request.post_data)
    posted.extend(body['events'])
    res = [{"id": e["id"], "result": "ok" if e.get("type") != "undo" else "отменено"} for e in body['events']]
    return route.fulfill(status=200, content_type='application/json', body=json.dumps({"ok": True, "results": res}))

fails = []
def check(cond, msg):
    print(('OK   ' if cond else 'FAIL ') + msg)
    if not cond: fails.append(msg)

with sync_playwright() as p:
    b = p.chromium.launch()
    ctx = b.new_context(viewport={"width": 390, "height": 844})
    page = ctx.new_page()
    errors = []
    page.on('pageerror', lambda e: errors.append(str(e)))
    page.route(API + '*', handle)
    page.goto(f'http://127.0.0.1:{PORT}/index.html')

    def scan(code):
        page.evaluate("document.getElementById('scan').focus()")
        page.keyboard.type(code); page.keyboard.press('Enter'); page.wait_for_timeout(250)
    st = lambda: page.inner_text('#status')

    page.fill('#keyInput', 'bad'); page.click('#keySave'); page.wait_for_timeout(300)
    check('Не получилось' in page.inner_text('#keyMsg'), 'неверный ключ отклонён')
    page.fill('#keyInput', 'good'); page.click('#keySave'); page.wait_for_timeout(600)
    check(page.is_visible('#mainView') and page.inner_text('#who') == 'Ольга', 'вход по ключу')

    scan('2000000311869')
    check('СНАЧАЛА ЯЧЕЙКА' in st(), 'книга без ячейки не принимается')
    scan('991019002')
    check(page.inner_text('#cellName') == 'С19-П2', 'ячейка С19-П2')

    scan('2000000311869')
    check('НОВОЕ МЕСТО' in st() and 'Книга с габаритами' in st(), 'книга с габаритами из таблицы')
    check(page.locator('#pkgGrid button.from-table').inner_text() == '201·2', 'упаковка «из таблицы» подсвечена')

    scan('2000000311852')
    check('Книга без габаритов' in st() and 'Выберите упаковку' in st(), 'книга без габаритов просит упаковку')
    scan('2000000311845')
    check('ВЫБЕРИТЕ УПАКОВКУ' in st(), 'следующий пик заблокирован без упаковки')
    page.locator('#pkgGrid button', has_text='Разв·5').click(); page.wait_for_timeout(150)
    scan('2000000311845')
    check('ЭКЗЕМПЛЯР 1 ИЗ 2' in st(), 'несколько экземпляров: 1 из 2')
    scan('2000000311845')   # двойной пик < 1.5 с игнорируется
    check('ЭКЗЕМПЛЯР 1 ИЗ 2' in st(), 'двойной пик проигнорирован')
    page.wait_for_timeout(1600)
    scan('2000000311845')
    check('ЭКЗЕМПЛЯР 2 ИЗ 2' in st(), 'второй экземпляр')

    scan('9785480000566')
    check('УЖЕ РАЗМЕЩЕНА' in st() and 'С5-П1' in st() and page.is_visible('#moveActions'), 'книга с другой полки — красный экран')
    page.click('#moveNo'); page.wait_for_timeout(100)

    scan('9785991035781')
    check('НЕ НОВАЯ КНИГА' in st() and 'С17-П4' in st(), 'книга из 1С не размещается, показано место')
    scan('2,00E+12')
    check('НЕКОРРЕКТНЫЙ КОД' in st(), '«2,00E+12» отклонён')
    scan('2000000999990')
    check('НЕИЗВЕСТНЫЙ' in st() and page.is_visible('#unknownActions'), 'неизвестный штрихкод')

    page.click('#undoBtn'); page.wait_for_timeout(200)
    check('ОТМЕНЕНО' in st(), 'отмена последнего')

    # без сети
    ctx.set_offline(True); NET["down"] = True
    page.evaluate("window.dispatchEvent(new Event('offline'))")
    scan('991021004')
    scan('2000000311838')
    page.wait_for_timeout(1600)
    scan('991021004')    # закрыть пик повторным пиком ячейки
    page.wait_for_timeout(5500)
    check('Нет сети' in page.inner_text('#sync'), 'без сети: показано «Нет сети»')
    n_before = len(posted)
    check(not any(e.get('barcode') == '2000000311838' for e in posted), 'без сети пик не ушёл, ждёт в очереди')
    page.reload(); page.wait_for_timeout(800)
    check('ждут отправки: 1' in page.inner_text('#sync') or 'Нет сети' in page.inner_text('#sync'), 'очередь пережила перезапуск приложения: ' + page.inner_text('#sync'))
    ctx.set_offline(False); NET["down"] = False
    page.evaluate("window.dispatchEvent(new Event('online'))")
    page.wait_for_timeout(6000)
    check('всё отправлено' in page.inner_text('#sync'), 'после сети всё отправлено')

    # что ушло в таблицу
    by = {}
    for e in posted: by.setdefault(e['barcode'] if e.get('barcode') else 'undo', []).append(e)
    e1 = by.get('2000000311869', [])
    check(len(e1) >= 1 and e1[0]['cell'] == 'С19-П2' and e1[0]['pkg'] is None, 'книга 1: ячейка С19-П2, габариты из таблицы не перезаписаны')
    e2 = by.get('2000000311852', [])
    check(len(e2) == 1 and e2[0]['pkg']['name'] == 'Развертка - 5 см.', 'книга 2: выбрана Развертка·5')
    e3 = by.get('2000000311845', [])
    check(len(e3) + (1 if by.get('undo') else 0) >= 2, 'экземпляры книги 3 отправлены (последний отменён)')
    check('9785480000566' not in by and '9785991035781' not in by, 'чужая и старая книги в таблицу не ушли')
    check(any(e['cell'] == 'С21-П4' for e in by.get('2000000311838', [])), 'пик без сети дошёл после появления сети')

    # «Где книга?»
    page.click('#modeFind'); page.wait_for_timeout(150)
    scan('9785991035781')
    check('ВЕРНУТЬ НА' in st() and 'С17-П4' in st(), '«Где книга?»: место из 1С')
    scan('2000000311838')
    check('С21-П4' in st(), '«Где книга?»: новое место после размещения')

    # автозакрытие последней книги и «Полка готова»
    page.click('#modePlace'); page.wait_for_timeout(150)
    check(not page.is_visible('#doneBtn') or page.inner_text('#cellName') != '—', 'кнопка «Полка готова» только при выбранной ячейке')
    scan('991019002')
    check(page.is_visible('#doneBtn'), 'кнопка «Полка готова» видна')
    page.screenshot(path='/tmp/razm_done.png')
    n0 = len(posted)
    scan('2000000311869')
    page.wait_for_timeout(6000)
    check(len(posted) == n0, 'последняя книга без пиков не отправлена сразу')
    page.evaluate("window.RAZM_AUTO_CLOSE_MS = 300"); page.wait_for_timeout(400)
    page.evaluate("autoClose()"); page.wait_for_timeout(1500)
    check('ПОСЛЕДНЯЯ КНИГА ЗАПИСАНА' in st(), 'автозакрытие: ' + st().replace('\n', ' | '))
    check(len(posted) == n0 + 1 and posted[-1]['barcode'] == '2000000311869', 'автозакрытая книга ушла в таблицу')
    page.evaluate("window.RAZM_AUTO_CLOSE_MS = 0")
    page.wait_for_timeout(1600)
    scan('2000000311852')
    page.click('#doneBtn'); page.wait_for_timeout(1500)
    check('ПОЛКА ГОТОВА' in st() and 'С19-П2' in st() and '2 книги' in st() and 'Всё отправлено' in st(), '«Полка готова»: ' + st().replace('\n', ' | '))
    check(posted[-1]['barcode'] == '2000000311852', '«Полка готова» отправила последнюю книгу')
    check(page.inner_text('#cellName') == '—' and not page.is_visible('#doneBtn'), 'после «Полка готова» ячейка сброшена')
    scan('2000000311845')
    check('СНАЧАЛА ЯЧЕЙКА' in st(), 'после «Полка готова» книга без новой ячейки не принимается')

    page.screenshot(path='/tmp/razm_e2e.png')
    check(not errors, 'нет ошибок JavaScript ' + (str(errors) if errors else ''))
    b.close()
srv.shutdown()
print('\nИТОГ:', 'всё прошло' if not fails else f'{len(fails)} провал(ов)')
sys.exit(1 if fails else 0)
