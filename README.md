# Размещение книг по ячейкам

Телефон + Bluetooth-сканер: пик ячейки → пик книг → упаковка. Данные — в Google-таблицу OzonBooks
(сначала тестовая копия). Режим «Где книга?» — поиск места по таблице, архиву и выгрузке 1С.

- `docs/` — приложение для телефона (PWA), публикуется на GitHub Pages (папка `/docs`)
- `apps-script/Code.gs` — скрипт таблицы (бэкенд), установка: `apps-script/УСТАНОВКА.md`
- `tests/backend.test.js` — проверки скрипта вне Google: `node tests/backend.test.js`
- `tests/app_e2e.py` — сквозная проверка приложения в Chromium: `python3 tests/app_e2e.py`
- `tests/camera_e2e.py` — проверка пика камерой (с подменённой камерой): `python3 tests/camera_e2e.py`
