FROM node:20-alpine

WORKDIR /app

COPY package.json package-lock.json* ./
RUN npm ci

COPY . .

CMD ["sh", "-c", "npm run build && cp -r dist/* /output/"]
