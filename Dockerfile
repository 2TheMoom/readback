# Readback server: the guard API, the owner's queue and the web app, in one Node process.
# Everything is built from this repository: the engine from source, and the wallet executors downloaded and
# checked against web/wallets.lock.json (the build fails if any of them changed upstream).

FROM rust:1.97.1-slim-bookworm AS engine
WORKDIR /src/engine
COPY engine/ .
RUN rustup target add wasm32-wasip1 && cargo build --locked --release --target wasm32-wasip1

FROM node:24.15.0-bookworm-slim AS web
WORKDIR /src/web
COPY web/package.json web/package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY web/ .
RUN npm run bundle && node --no-warnings=ExperimentalWarning scripts/pin-wallets.ts

FROM node:24.15.0-bookworm-slim
WORKDIR /app
COPY service/package.json service/package-lock.json service/
RUN cd service && npm ci --omit=dev --no-audit --no-fund
COPY service/src service/src
COPY agent/src agent/src
COPY docs/test-vectors docs/test-vectors
COPY docs/outlayer/attested-vectors*.json docs/outlayer/
COPY --from=engine /src/engine/target/wasm32-wasip1/release/readback-check.wasm engine/target/wasm32-wasip1/release/readback-check.wasm
COPY --from=web /src/web/public web/public
ENV NODE_ENV=production HOST=0.0.0.0 READBACK_TRUST_PROXY=1 READBACK_DATA_DIR=/data
EXPOSE 8787
CMD ["node", "--no-warnings=ExperimentalWarning", "service/src/server.ts"]
