# Una sola imagen para los dos procesos: el servidor web y el worker de crons.
# Cuál corre lo decide el comando de arranque (ver render.yaml y docs/despliegue.md).
FROM node:20-slim

# Prisma necesita openssl en la imagen slim.
RUN apt-get update -y && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app

COPY package.json package-lock.json ./
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN npm ci && npm ci --prefix frontend

COPY . .
RUN npx prisma generate && npm run build

ENV NODE_ENV=production
EXPOSE 3000

# Por defecto, el servidor web. El worker usa: npm run start:worker
CMD ["npm", "start"]
