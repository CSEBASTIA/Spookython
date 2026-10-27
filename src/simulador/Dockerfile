# La imagen solo copia el bundle que genera `npm run build` en la PC (esbuild).
# Así construirla para ARM64 desde Windows no necesita emular ningún RUN.
FROM node:22-alpine
ENV NODE_ENV=production
WORKDIR /app
COPY dist/ ./
USER node
EXPOSE 8080
CMD ["node", "index.cjs"]
