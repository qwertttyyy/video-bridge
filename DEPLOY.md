# Деплой Video Bridge На VPS

Инструкция актуальна для VPS, где системный nginx уже настроен отдельно и отдает frontend из `/var/www/video-bridge`, а backend и coturn запускаются через Docker Compose.

В репозитории не нужен nginx-конфиг и не нужен отдельный nginx-контейнер. На проде тесты запускать не нужно. Проверки ниже - только короткие smoke-команды: `docker compose ps` и `curl`.

## 1. Подготовка сервера

```bash
sudo apt update && sudo apt upgrade -y

# Docker
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# nginx/certbot должны быть настроены на VPS отдельно, если их еще нет
sudo apt install -y nginx certbot python3-certbot-nginx

# Перелогиньтесь, чтобы группа docker подхватилась
exit
```

Node.js на VPS для продовой сборки не нужен: frontend собирается только Docker-образом `frontend-build`.

## 2. Файрвол

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 49152:49252/udp
sudo ufw enable
```

Backend наружу не открывается: Docker Compose публикует его только на `127.0.0.1:${BACKEND_HOST_PORT}`.

## 3. Проект

```bash
cd /opt/projects
git clone <repo-url> video-bridge
cd /opt/projects/video-bridge
```

Если проект уже есть на VPS:

```bash
cd /opt/projects/video-bridge
git pull
```

## 4. `.env`

```bash
cp .env.example .env
nano .env
```

Пример для `video.qwertttyyy.ru`:

```env
SERVER_IP=157.22.230.215
SERVER_DOMAIN=video.qwertttyyy.ru
TURN_SECRET=replace_with_openssl_rand_hex_32
TURN_REALM=video.qwertttyyy.ru
FRONTEND_ORIGIN=https://video.qwertttyyy.ru
BACKEND_HOST_PORT=8000
MAX_SESSIONS=10
SESSIONS_RATE_LIMIT=10/minute
TURN_CRED_TTL=3600
```

`TURN_SECRET` генерируется так:

```bash
openssl rand -hex 32
```

`BACKEND_HOST_PORT` - порт backend на localhost VPS. Если меняете его с `8000` на другой, замените этот же порт в nginx-конфиге `proxy_pass`.

## 5. Frontend Только Через Docker

```bash
cd /opt/projects/video-bridge
sudo mkdir -p /var/www/video-bridge
sudo rm -rf /var/www/video-bridge/*
docker compose --profile build build frontend-build
docker compose --profile build run --rm frontend-build
```

После этого nginx будет отдавать файлы из `/var/www/video-bridge`.

## 6. Backend И Coturn

```bash
cd /opt/projects/video-bridge
docker compose up -d --build backend coturn
docker compose ps
```

Короткая проверка backend:

```bash
curl -s http://127.0.0.1:8000/api/ice-config
```

Если `BACKEND_HOST_PORT` не `8000`, используйте свой порт:

```bash
curl -s http://127.0.0.1:${BACKEND_HOST_PORT}/api/ice-config
```

## 7. nginx На VPS

Отдельный nginx-контейнер не используется. nginx-конфиг не хранится в репозитории.

Проверьте на VPS в уже существующем nginx-конфиге:

- frontend root указывает на `/var/www/video-bridge`;
- `/api/` проксируется на `http://127.0.0.1:8000`;
- `/ws/` проксируется на `http://127.0.0.1:8000`;
- для `/ws/` включены HTTP/1.1 и заголовки `Upgrade`/`Connection`.

Если в `.env` меняете `BACKEND_HOST_PORT`, тот же порт должен быть указан в существующем nginx `proxy_pass`.

## 8. Обновление Frontend

Только Docker-сборка:

```bash
cd /opt/projects/video-bridge
git pull
sudo rm -rf /var/www/video-bridge/*
docker compose --profile build build frontend-build
docker compose --profile build run --rm frontend-build
```

Для простой замены статических файлов nginx перезапускать не нужно. Перезагружайте nginx только если меняли его конфиг.

## 9. Обновление Backend/Coturn

```bash
cd /opt/projects/video-bridge
git pull
docker compose up -d --build backend coturn
docker compose ps
curl -s http://127.0.0.1:8000/api/ice-config
```

Если меняли только frontend, backend/coturn перезапускать не обязательно.

## 10. Smoke-Проверка После Деплоя

```bash
docker compose ps
docker compose logs --tail=80 backend
docker compose logs --tail=80 coturn
curl -s http://127.0.0.1:8000/api/ice-config
```

В браузере:

1. Откройте `https://video.qwertttyyy.ru`.
2. Создайте сессию.
3. Подключитесь со второй вкладки или второго устройства.
4. Проверьте камеру, микрофон, reconnect после перезагрузки вкладки.
5. Проверьте демонстрацию экрана. Звук демонстрации будет отправляться только если браузер реально вернул audio track из `getDisplayMedia`.

## 11. Диагностика

### nginx отдает 502

```bash
docker compose ps backend
curl -s http://127.0.0.1:8000/api/ice-config
sudo tail -80 /var/log/nginx/error.log
```

Проверьте, что порт в `BACKEND_HOST_PORT` совпадает с портом в nginx `proxy_pass`.

### WebSocket не подключается

Проверьте блок `/ws/` в nginx: нужны HTTP/1.1, `Upgrade`, `Connection`, увеличенный `proxy_read_timeout`.

### ICE connection failed

```bash
ss -tulnp | grep 3478
docker compose logs --tail=120 coturn
```

Частые причины:

- неверный `SERVER_IP`;
- закрыты `3478/tcp`, `3478/udp` или `49152:49252/udp`;
- `TURN_SECRET` в `.env` не совпадает с `--static-auth-secret` coturn из compose.

### Нет камеры/микрофона

- сайт должен открываться по HTTPS;
- проверьте разрешения браузера;
- смотрите `chrome://webrtc-internals`.

### Нет звука демонстрации экрана

Код приложения отправляет звук демонстрации, если браузер возвращает audio track. На Linux это зависит от браузера, Wayland/X11, PipeWire/PulseAudio и выбранного типа захвата; для некоторых вариантов screen/window capture системный звук браузер может не отдавать.
