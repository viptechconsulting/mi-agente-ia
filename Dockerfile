FROM node:22-alpine
WORKDIR /app
RUN apk add --no-cache python3 make g++
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /app/data
EXPOSE 3100
CMD ["node", "server.js"]
