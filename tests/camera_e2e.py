import json, threading, http.server, functools
from playwright.sync_api import sync_playwright
import os; ROOT=os.path.join(os.path.dirname(os.path.abspath(__file__)),'..','docs')
h=functools.partial(http.server.SimpleHTTPRequestHandler, directory=ROOT); h.log_message=lambda *a: None
srv=http.server.ThreadingHTTPServer(('127.0.0.1',8793),h); threading.Thread(target=srv.serve_forever,daemon=True).start()
API='https://script.google.com/macros/s/AKfycbzsrMDosDNc4HsdZyGS-WUeu7bUxzGh0HCho9dZJAC8_p163mjrFFPM3WCPH35hqQ_b/exec'
PK=[{"name":"Развертка - 5 см.","L":22,"W":15,"H":5},{"name":"Ручная","manual":True}]
BOOKS={"2000000311838":{"t":"Великие женщины","a":"","s":{},"n":1,"q":1,"c":"","d":[22,15,5]}}
def handle(route, req):
    body={"ok":True,"user":"Ольга"} if req.method=='GET' and 'ping' in req.url else ({"ok":True,"version":"v","packages":PK,"books":BOOKS} if req.method=='GET' else {"ok":True,"results":[{"id":e["id"],"result":"ok"} for e in json.loads(req.post_data)["events"]]})
    route.fulfill(status=200,content_type='application/json',body=json.dumps(body))
INIT = """
window.__codes = ['991019002','2000000311838'];
window.BarcodeDetector = class { static async getSupportedFormats(){ return ['ean_13','code_128','ean_8']; }
  async detect(){ await new Promise(r=>setTimeout(r,300)); return [{rawValue: window.__codes.shift()}]; } };
navigator.mediaDevices.getUserMedia = async () => { const c=document.createElement('canvas'); c.width=320;c.height=240; const x=c.getContext('2d'); setInterval(()=>{x.fillStyle='#'+Math.floor(Math.random()*16777215).toString(16).padStart(6,'0'); x.fillRect(0,0,320,240)},100); return c.captureStream(10); };
"""
ok=True
with sync_playwright() as p:
    br=p.chromium.launch(); pg=br.new_page(viewport={"width":390,"height":844}); errs=[]; pg.on('pageerror',lambda e: errs.append(str(e)))
    pg.add_init_script(INIT); pg.route(API+'*',handle)
    pg.goto('http://127.0.0.1:8793/index.html'); pg.fill('#keyInput','k'); pg.click('#keySave'); pg.wait_for_timeout(500)
    pg.click('#camBtn'); pg.wait_for_timeout(1200)
    a = pg.inner_text('#cellName'); hidden = pg.locator('#camSheet').get_attribute('class')
    print('камера -> ячейка:', a, '| окно камеры закрылось:', 'hidden' in hidden); ok &= a=='С19-П2' and 'hidden' in hidden
    pg.click('#camBtn'); pg.wait_for_timeout(1200)
    t = pg.inner_text('#status'); print('камера -> книга:', t.replace('\n',' | ')); ok &= 'НОВОЕ МЕСТО' in t
    print('ошибки JS:', errs); ok &= not errs
    br.close()
srv.shutdown(); print('ИТОГ:', 'OK' if ok else 'FAIL')
