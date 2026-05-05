FROM node:20-alpine AS base
WORKDIR /app
ENV NODE_ENV=production

COPY package.json package-lock.json* ./
RUN npm install --omit=dev

COPY server.js ./
COPY index.html ./
COPY orcamento.html ./
COPY admin ./admin
COPY public ./public

EXPOSE 3000
USER node
CMD ["node", "server.js"]
