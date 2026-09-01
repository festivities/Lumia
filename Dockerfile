FROM node:22-alpine
RUN apk add --no-cache ffmpeg libwebp-tools
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY src src
COPY tools tools
CMD ["node", "src/index.js"]
