# DEPLOY.md
# Деплой Video Bridge — nginx (apt) + certbot + Docker

---

## 1. Подготовка сервера

```bash
sudo apt update && sudo apt upgrade -y

# Docker (если ещё нет)
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER

# Node.js 20 (для сборки фронтенда)
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs

# Certbot
sudo apt install -y certbot python3-certbot-nginx

# Перелогиньтесь, чтобы группа docker подхватилась
exit
```

---

## 2. Файрвол (ufw)

```bash
sudo ufw allow OpenSSH
sudo ufw allow 80/tcp
sudo ufw allow 443/tcp
sudo ufw allow 3478/tcp
sudo ufw allow 3478/udp
sudo ufw allow 49152:49252/udp   # Медиа-порты coturn
sudo ufw enable
```

---

## 3. Проект на сервер

```bash
# Вариант A — архив
scp video-bridge.tar.gz user@SERVER_IP:~
ssh user@SERVER_IP
tar -xzf video-bridge.tar.gz
cd video-bridge

# Вариант B — git
git clone <repo-url> video-bridge && cd video-bridge
```

---

## 4. Настройка .env

```bash
cp .env.example .env
nano .env
```

```
SERVER_IP=<реальный публичный IP>
SERVER_DOMAIN=video.qwertttyyy.ru
TURN_USERNAME=myuser
TURN_PASSWORD=<надёжный_пароль>
FRONTEND_ORIGIN=https://video.qwertttyyy.ru
```

---

## 5. Сборка фронтенда

```bash
cd frontend
npm install
npm run build        # → dist/
sudo mkdir -p /var/www/video-bridge
sudo cp -r dist/* /var/www/video-bridge/
cd ..
```

---

## 6. Настройка nginx

```bash
# Копируем конфиг
sudo cp nginx/video.qwertttyyy.ru /etc/nginx/sites-available/video.qwertttyyy.ru

# Активируем
sudo ln -sf /etc/nginx/sites-available/video.qwertttyyy.ru /etc/nginx/sites-enabled/

# Проверяем синтаксис
sudo nginx -t

# Пока HTTPS-блок сломается (нет сертификата) — временно закомментируйте его:
sudo nano /etc/nginx/sites-available/video.qwertttyyy.ru
# Закомментируйте весь блок server { listen 443 ... }

# Перезапускаем с HTTP-only
sudo systemctl reload nginx
```

---

## 7. Получение TLS-сертификата

```bash
# Создаём директорию для challenge
sudo mkdir -p /var/www/certbot

# Получаем сертификат
sudo certbot certonly --webroot -w /var/www/certbot -d video.qwertttyyy.ru
```

После успешного получения:

```bash
# Раскомментируйте HTTPS-блок в конфиге
sudo nano /etc/nginx/sites-available/video.qwertttyyy.ru

# Раскомментируйте редирект HTTP → HTTPS (строка return 301)

# Проверяем и перезагружаем
sudo nginx -t && sudo systemctl reload nginx
```

Автообновление сертификата:

```bash
# certbot ставит cron/timer автоматически, проверяем:
sudo systemctl list-timers | grep certbot
```

---

## 8. Запуск Docker-сервисов

```bash
cd ~/video-bridge
docker compose up --build -d

# Проверка
docker compose ps
docker compose logs -f backend
docker compose logs -f coturn
```

---

## 9. Проверка coturn

```bash
# Из пакета coturn-utils
sudo apt install -y coturn-utils
turnutils_uclient -T -u myuser -w '<пароль>' -p 3478 <SERVER_IP>
```

Или онлайн: https://webrtc.github.io/samples/src/content/peerconnection/trickle-ice/
→ добавьте `turn:<SERVER_IP>:3478`, логин/пароль → Gather candidates → ищите `relay`.

---

## 10. Тестирование

1. Откройте `https://video.qwertttyyy.ru`
2. **Создать сессию** → скопируйте ключ
3. Второе устройство → вставьте ключ → **Подключиться**
4. Разрешите камеру/микрофон

---

## 11. Типичные проблемы

### nginx отдаёт 502 Bad Gateway

```bash
# Бэкенд запущен?
docker compose ps backend
curl -s http://127.0.0.1:8000/api/ice-config
```

### WebSocket не подключается (ошибка в консоли браузера)

Проверьте блок `/ws/` в nginx — нужен `proxy_http_version 1.1` и заголовки Upgrade/Connection.

### ICE connection failed

```bash
ss -tulnp | grep 3478                  # coturn слушает?
docker compose logs coturn | head -30  # ошибки?
```

Частые причины: неправильный `SERVER_IP` в `.env`, закрыты UDP-порты 49152–49252.

### Нет видео (getUserMedia)

- Страница **обязана** быть на HTTPS (проверьте замок в адресной строке)
- В Chrome: `chrome://webrtc-internals` для диагностики
- Проверьте разрешения камеры в настройках браузера

### CORS

`FRONTEND_ORIGIN` в `.env` должен совпадать с URL сайта: `https://video.qwertttyyy.ru` (без `/` в конце).

---

## 12. Обновление фронтенда

```bash
cd ~/video-bridge/frontend
npm run build
sudo rm -rf /var/www/video-bridge/*
sudo cp -r dist/* /var/www/video-bridge/
```

## 13. Перезапуск бэкенда

```bash
cd ~/video-bridge
docker compose up --build -d backend
```
