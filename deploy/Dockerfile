FROM node:22.23.4-bookworm-slim
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts --no-audit --fund=false
COPY bot.js test.js ./
COPY src ./src
RUN npm run check && npm test && npm prune --omit=dev --ignore-scripts --no-audit --fund=false
COPY deploy/runtime.cjs /opt/peer/runtime.cjs
ENV NODE_ENV=production
USER 10001:10001
CMD ["node", "/opt/peer/runtime.cjs", "bot.js"]
