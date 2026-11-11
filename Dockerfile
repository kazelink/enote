FROM node:20-alpine AS deps

WORKDIR /app

COPY package*.json ./
RUN apk add --no-cache --virtual .build-deps python3 make g++ && \
    npm install --omit=dev && \
    apk del .build-deps

FROM node:20-alpine

WORKDIR /app

RUN apk add --no-cache su-exec && \
    addgroup -S enote && \
    adduser -S enote -G enote && \
    mkdir -p /app/data

ENV NODE_ENV=production

COPY --from=deps --chown=enote:enote /app/node_modules ./node_modules
COPY --chown=enote:enote package.json ./package.json
COPY --chown=enote:enote apps/server ./server
COPY --chown=enote:enote apps/client ./client
RUN find client -type f \( -name '*.js' -o -name '*.mjs' -o -name '*.css' -o -name '*.svg' -o -name '*.html' \) \
    -exec sh -c 'gzip -9 -c "$1" > "$1.gz"' _ {} \;
COPY --chmod=755 entrypoint.sh ./entrypoint.sh

VOLUME ["/app/data"]
EXPOSE 3000

ENTRYPOINT ["/app/entrypoint.sh"]
