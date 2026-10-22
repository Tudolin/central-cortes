# Imagem do HUB (dashboard, agenda, publicação, Telegram). O worker roda fora do Docker, na máquina com GPU.
FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production ROLE=hub PORT=8095 TZ=America/Sao_Paulo
COPY package.json package-lock.json ./
# onnxruntime (detecção de rosto) só é usado pelo worker: fora da imagem economiza ~200 MB.
RUN npm ci --omit=dev --omit=optional && npm cache clean --force
COPY app ./app
COPY web ./web
EXPOSE 8095
USER node
CMD ["node", "app/main.ts"]
