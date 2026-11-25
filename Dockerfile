FROM node:22-bookworm-slim AS dependencies
WORKDIR /app
ENV PUPPETEER_SKIP_DOWNLOAD=true
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force
FROM dependencies AS control
RUN apt-get update && apt-get install -y --no-install-recommends python3 ca-certificates && rm -rf /var/lib/apt/lists/*
COPY control/ ./control/
COPY public/pwa/ ./public/pwa/
COPY public/notification-icons/ ./public/notification-icons/
COPY public/notification-worker.js ./public/notification-worker.js
CMD ["node","control/server.js"]
FROM node:22-bookworm-slim AS speech
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates cmake g++ make && rm -rf /var/lib/apt/lists/*
RUN git clone --depth=1 --branch v1.7.6 https://github.com/ggml-org/whisper.cpp.git /speech \
    && test "$(git -C /speech rev-parse HEAD)" = a8d002cfd879315632a579e73f0148d06959de36 \
    && cmake -S /speech -B /build -DBUILD_SHARED_LIBS=OFF -DGGML_NATIVE=OFF -DGGML_OPENMP=OFF -DCMAKE_BUILD_TYPE=Release \
    && cmake --build /build --target whisper-cli -j2
FROM dependencies AS worker
COPY --from=speech /build/bin/whisper-cli /usr/local/bin/whisper-cli
RUN apt-get update && apt-get install -y --no-install-recommends chromium ffmpeg tesseract-ocr-por tesseract-ocr-eng poppler-utils ca-certificates tini fonts-liberation procps && rm -rf /var/lib/apt/lists/*
# Same multilingual Whisper Base weights as the desktop, shared by the read-only image.
RUN install -d -m 0755 /opt/whatsia /opt/whatsia/models
ADD --checksum=sha256:60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe --chmod=0444 https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin /opt/whatsia/models/ggml-base.bin
ENV WHISPER_MODEL=/opt/whatsia/models/ggml-base.bin
COPY *.js local-routines.json ./
COPY public ./public
RUN ln -s /persist/data data && ln -s /persist/context context && ln -s /persist/home/web-cache .wwebjs_cache
ENV WHATSIA_TENANT=1 WHATSAPP_CHROMIUM_PATH=/usr/bin/chromium HOME=/persist/home
USER node
ENTRYPOINT ["/usr/bin/tini","--"]
CMD ["sh","-ec","mkdir -p /persist/home/web-cache && exec node server.js"]
