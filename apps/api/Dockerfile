FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
# postinstall(prisma generate)는 prisma/ 복사 전이므로 스크립트 생략 — build 단계에서 generate
RUN npm ci --ignore-scripts 2>/dev/null || npm install --ignore-scripts

FROM node:20-alpine AS build
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npx prisma generate
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
# PDF 렌더·bbox·텍스트 힌트: PyMuPDF(fitz) Python 스크립트 사용
RUN apk add --no-cache python3 py3-pip \
  && pip3 install --no-cache-dir pymupdf --break-system-packages \
  && ln -sf /usr/bin/python3 /usr/bin/python
ENV NODE_ENV=production
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/dist ./dist
COPY --from=build /app/prisma ./prisma
COPY --from=build /app/scripts ./scripts
COPY package.json ./
RUN chmod +x scripts/start-production.sh
EXPOSE 4000
CMD ["./scripts/start-production.sh"]
