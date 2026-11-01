FROM node:22-alpine
WORKDIR /app
COPY package.json ./
COPY server ./server
COPY scripts ./scripts
COPY public ./public
ENV NODE_ENV=production PORT=3000 DB_FILE=/data/lockcash.db
# Mount a persistent volume at /data or you will lose all records on redeploy.
VOLUME /data
EXPOSE 3000
USER node
CMD ["node", "--no-warnings", "server/server.js"]
