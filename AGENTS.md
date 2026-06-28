# AGENTS.md

## Обзор проекта

Video Bridge - приватное приложение для видеозвонков 1:1.

В рантайме проект состоит из трех частей:

- `frontend/` - одностраничное приложение на React + Vite с интерфейсом звонка и WebRTC-клиентом.
- `backend/` - FastAPI-сервер сигналинга для создания сессий, выдачи ICE-конфигурации и пересылки WebSocket-сообщений.
- `coturn` - STUN/TURN-сервер, запускаемый через `docker-compose.yml` для прохождения NAT.

Бэкенд не передает медиа. Аудио и видео идут напрямую между браузерами через WebRTC; сервер только координирует комнаты и пересылает signaling-сообщения.

## Структура репозитория

- `backend/main.py` - FastAPI-приложение, REST-эндпоинты, WebSocket-сигналинг, CORS, лимиты, keepalive.
- `backend/session_manager.py` - in-memory реестр сессий, ограничение комнаты двумя клиентами, TTL-очистка, расчет polite-роли.
- `backend/schemas.py` - Pydantic-валидация входящих WebSocket-сообщений.
- `backend/turn_credentials.py` - генерация эфемерных TURN-учетных данных.
- `backend/rate_limit.py` - token bucket для ограничения частоты WebSocket-сообщений.
- `backend/dependencies.py` - заглушка FastAPI-зависимости для `SessionManager`.
- `frontend/src/App.jsx` - основной интерфейс, лобби, управление медиа, экран звонка.
- `frontend/src/useSignaling.js` - WebSocket-клиент с реконнектом, backoff и ping/pong.
- `frontend/src/useWebRTC.js` - оркестрация WebRTC, Perfect Negotiation, media-state, ICE-восстановление, статистика.
- `frontend/src/config.js` - клиентские константы таймингов, битрейта, качества и реконнекта.
- `frontend/src/lib/` - узкие помощники для WebRTC и работы с медиа.
- `frontend/public/` - PWA-манифест, service worker, иконки.
- `docker-compose.yml` - backend, coturn и опциональная сборка frontend.
- `.env.example` - пример обязательных переменных окружения.
- `DEPLOY.md` - инструкция деплоя с nginx, certbot, Docker и coturn.

## Конфигурация

Перед запуском backend или Docker Compose создайте `.env` из `.env.example`:

```bash
cp .env.example .env
```

Обязательные переменные:

- `SERVER_IP` - публичный IP сервера, который используется в STUN/TURN URL.
- `SERVER_DOMAIN` - публичное доменное имя.
- `TURN_SECRET` - общий секрет для эфемерных TURN-кредов. Сгенерировать можно командой `openssl rand -hex 32`.
- `TURN_REALM` - TURN realm; обычно совпадает с `SERVER_DOMAIN`.
- `FRONTEND_ORIGIN` - точный origin фронтенда для CORS на backend, без завершающего слэша.

Операционные переменные:

- `BACKEND_HOST_PORT` - внешний порт backend-контейнера на `127.0.0.1`; nginx должен проксировать `/api/` и `/ws/` на этот порт.
- `MAX_SESSIONS` - максимальное число активных сессий в памяти backend.
- `SESSIONS_RATE_LIMIT` - slowapi-лимит для `POST /api/sessions`, например `10/minute`.
- `TURN_CRED_TTL` - TTL сгенерированных TURN-кредов в секундах.

Не коммитьте реальные секреты из `.env`.

## Локальная разработка

Backend:

```bash
cd backend
python -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload --host 0.0.0.0 --port 8000
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

В разработке `frontend/vite.config.js` проксирует `/api` и `/ws` на backend `127.0.0.1:8000`, поэтому локально можно запускать backend и Vite отдельно.

Docker:

```bash
docker compose up --build
```

Compose привязывает backend к `127.0.0.1:${BACKEND_HOST_PORT:-8000}` и запускает coturn в host networking mode. На проде frontend собирается только Docker-профилем `frontend-build`, который пишет статические файлы в `/var/www/video-bridge`:

```bash
docker compose --profile build build frontend-build
docker compose --profile build run --rm frontend-build
```

## Контракт API

REST:

- `GET /api/ice-config` возвращает `iceServers` и `ttl` для `RTCPeerConnection`.
- `POST /api/sessions` создает сессию и возвращает `{ "sessionKey": "..." }` либо `{ "error": "limit", "message": "..." }`.

WebSocket:

- Путь: `/ws/{session_key}/{client_id}`.
- `session_key` и `client_id` должны соответствовать `^[A-Za-z0-9_-]{4,64}$`.
- В одной сессии может быть не больше двух разных клиентов.
- Реконнект с тем же `client_id` разрешен.
- После регистрации сервер отправляет `{ "type": "role", "polite": boolean | null }`.
- Сервер отправляет `{ "type": "ping" }`; клиент должен ответить `{ "type": "pong" }`.

Сообщения клиент-сервер, валидируемые в `backend/schemas.py`:

- `{ "type": "offer", "sdp": {...} }`
- `{ "type": "answer", "sdp": {...} }`
- `{ "type": "ice-candidate", "candidate": {...} }`
- `{ "type": "media-state", "camera": true, "mic": true }`
- `{ "type": "hangup" }`
- `{ "type": "pong" }`

Большинство валидных неслужебных сообщений пересылается собеседнику без изменений.

События сервер-клиент:

- `peer_joined`
- `peer_left`
- `peer_disconnected`
- `ping`
- `role`

При добавлении или изменении типа WebSocket-сообщения обновляйте и `backend/schemas.py`, и обработчики в `frontend/src/useWebRTC.js` или `frontend/src/useSignaling.js`.

## Заметки по WebRTC

Клиент использует паттерн Perfect Negotiation:

- `SessionManager.is_polite()` назначает стабильную polite-роль сравнением client ID.
- `frontend/src/useWebRTC.js` хранит состояние negotiation в refs, например `politeRef`, `makingOfferRef` и `ignoreOfferRef`.
- При glare-сценариях impolite-пир инициирует offer.

Восстановление соединения разделено между несколькими механизмами:

- WebSocket-реконнект и backoff в `frontend/src/useSignaling.js`.
- ICE restart и пересоздание PeerConnection в `frontend/src/useWebRTC.js`.
- DataChannel heartbeat в `frontend/src/useWebRTC.js`.
- Серверный WebSocket ping/pong в `backend/main.py`.

Демонстрация экрана находится в `frontend/src/lib/screenShare.js`. Если браузер возвращает audio track из `getDisplayMedia({ audio: true })`, приложение отправляет микс "микрофон + звук демонстрации" через audio sender. Если браузер/ОС не возвращает audio track для screen/window capture, приложение не может отправить системный звук; это часто зависит от платформы и типа захвата, особенно на Linux.

Будьте осторожны с таймингами в `frontend/src/config.js`: изменение одного timeout может повлиять сразу на несколько путей восстановления.

## Безопасность и лимиты

- CORS ограничен значением `FRONTEND_ORIGIN`.
- TURN-креды эфемерные и генерируются из `TURN_SECRET`.
- Создание сессий ограничено через slowapi.
- Входящие WebSocket-сообщения валидируются Pydantic discriminated unions.
- Частота WebSocket-сообщений ограничена token bucket.
- Состояние сессий хранится только в памяти; рестарт backend сбрасывает активные сессии.
- Сервис рассчитан на звонки 1:1, а не на групповые конференции.

## Деплой

Полный процесс с nginx/certbot/Docker описан в `DEPLOY.md`.

Важные требования для деплоя:

- HTTPS обязателен для `getUserMedia` в браузерах.
- nginx должен проксировать `/api/` и `/ws/` на backend-порт из `BACKEND_HOST_PORT`.
- Для WebSocket-проксирования нужны HTTP/1.1 и заголовки `Upgrade`/`Connection`.
- Файрвол должен пропускать TCP/UDP `3478` и UDP relay-порты `49152:49252` для coturn.
- `FRONTEND_ORIGIN` должен точно совпадать с публичным URL фронтенда.

## Проверки

Полезные команды валидации:

```bash
python3 -m compileall backend
./venv/bin/python -m pytest backend/tests -q
cd frontend && npm run test
cd frontend && npm run build
cd frontend && npm run test:e2e
docker compose config
```

`npm run test:e2e` запускает Playwright-сценарии с локальным backend и Vite dev server. Сценарии используют Chromium с fake camera/microphone и коротко проверяют reconnect, hangup, media toggles, отказ третьему клиенту и screen-share audio replacement.

Проверки в рантайме:

```bash
curl -s http://127.0.0.1:8000/api/ice-config
docker compose ps
docker compose logs -f backend
docker compose logs -f coturn
```

Проверки в браузере:

- Откройте две вкладки или два устройства с одним ключом сессии.
- Проверьте разрешения камеры и микрофона.
- Проверьте прямые или relayed ICE candidates в `chrome://webrtc-internals`.
- Для звука демонстрации экрана проверьте, что выбранный браузером тип захвата реально возвращает audio track; на Linux системный звук может быть недоступен для некоторых типов захвата.
- Если NAT traversal не работает, отдельно проверьте TURN через Trickle ICE или `turnutils_uclient`.

## Правила для агентов

- Сохраняйте async-безопасность backend; изменения состояния в `SessionManager` должны оставаться под его lock.
- Не обходите Pydantic-валидацию входящих WebSocket-сообщений.
- Сохраняйте same-origin пути frontend API, если одновременно не обновляете деплой/proxy-конфигурацию.
- Держите WebRTC side effects внутри hooks и refs; не переносите временное состояние PeerConnection в React state без необходимости для UI.
- Останавливайте media tracks при замене или закрытии stream.
- Не делайте широкие UI-переписывания при изменениях сигналинга или WebRTC-логики.
- Не коммитьте сгенерированный `frontend/dist/`, локальные virtualenv, `.env` или IDE-файлы.
- Предпочитайте маленькие точечные изменения и обновляйте этот файл, когда меняются команды, runtime-допущения или API-контракты.
