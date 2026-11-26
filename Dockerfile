FROM node:24-bookworm-slim
ENV NODE_ENV=production HOST=0.0.0.0 PORT=3010 BECHAT_DB=/app/data/bechat.sqlite
WORKDIR /app
COPY --chown=node:node package.json ./
COPY --chown=node:node server ./server
COPY --chown=node:node dist ./dist
RUN install -d -m 0700 -o node -g node /app/data
USER node
EXPOSE 3010
CMD ["node","server/main.mjs"]
