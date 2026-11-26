FROM python:3.12-slim-bookworm AS voice_model
ADD --checksum=sha256:961d5ff98a17f4aa6de69864d0aa71fa5bac682301d2b5d17a3f24c5c99a46d4 https://alphacephei.com/vosk/models/vosk-model-small-ru-0.22.zip /tmp/model.zip
RUN python -m zipfile -e /tmp/model.zip /models

FROM node:24-bookworm-slim AS node_runtime
FROM python:3.12-slim-bookworm
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3010 BECHAT_DB=/app/data/bechat.sqlite BECHAT_PYTHON=/usr/local/bin/python3 PYTHONDONTWRITEBYTECODE=1
WORKDIR /app
COPY --from=node_runtime /usr/local/bin/node /usr/local/bin/node
RUN apt-get update && apt-get install -y --no-install-recommends libstdc++6 libmagic1 ffmpeg && rm -rf /var/lib/apt/lists/* && useradd --uid 1000 --create-home --shell /usr/sbin/nologin bechat
COPY personal/requirements.txt /tmp/bechat-requirements.txt
RUN pip install --no-cache-dir --disable-pip-version-check -r /tmp/bechat-requirements.txt && python -c "import telethon, pymax, qrcode; from neonize.aioze.client import NewAClient" && node --version
COPY --from=voice_model /models/vosk-model-small-ru-0.22 /opt/bechat-speech/ru
COPY --chown=bechat:bechat package.json ./
COPY --chown=bechat:bechat server ./server
COPY --chown=bechat:bechat personal ./personal
COPY --chown=bechat:bechat dist ./dist
RUN install -d -m 0700 -o bechat -g bechat /app/data
USER bechat
EXPOSE 3010
CMD ["node","server/start.mjs"]
