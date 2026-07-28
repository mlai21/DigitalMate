FROM node:22-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:22-alpine AS builder
WORKDIR /app
# console:build applies vendor patches via `git apply`
RUN apk add --no-cache git
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# 内存不足以打包 Console 的部署环境可传 PREBUILT_CONSOLE=1，
# 改用构建上下文里已有的 public/_admin-console 产物。
ARG PREBUILT_CONSOLE=0
# 堆上限必须小于构建机物理内存：Node 在额度用尽前不会认真回收，
# 声明得比内存还大会让整机在 GC 之前先陷入颠簸。
# 从源码打包 Console 需要 4096，只应在内存 ≥8GB 的构建机上传入。
ARG NODE_HEAP_MB=2048
RUN if [ "$PREBUILT_CONSOLE" = "1" ]; then \
      test -f public/_admin-console/index.html \
        || { echo "PREBUILT_CONSOLE=1 requires public/_admin-console/index.html"; exit 1; }; \
      NODE_OPTIONS=--max-old-space-size=${NODE_HEAP_MB} npm run build:next; \
    else \
      NODE_OPTIONS=--max-old-space-size=${NODE_HEAP_MB} npm run build; \
    fi

FROM node:22-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
RUN apk add --no-cache docker-cli openssl tzdata
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/package-lock.json ./package-lock.json
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/.next ./.next
COPY --from=builder /app/public ./public
COPY --from=builder /app/vendor/qwenpaw-console/LICENSE ./third-party/qwenpaw-console/LICENSE
COPY --from=builder /app/vendor/qwenpaw-console/UPSTREAM.md ./third-party/qwenpaw-console/UPSTREAM.md
COPY --from=builder /app/src ./src
COPY --from=builder /app/node_modules ./node_modules
EXPOSE 3000
CMD ["npm", "run", "start"]
