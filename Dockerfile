# Build stage
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY verifier/custom-cbe-verifier ./verifier/custom-cbe-verifier
COPY ["verifier/telebirr verify", "./verifier/telebirr verify"]
RUN npm ci --only=production=false || npm i
COPY tsconfig.json ./
COPY src ./src
RUN npm run build

# Runtime stage
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json* ./
COPY verifier/custom-cbe-verifier ./verifier/custom-cbe-verifier
COPY ["verifier/telebirr verify", "./verifier/telebirr verify"]
RUN npm ci --only=production || npm i --omit=dev
COPY --from=build /app/dist ./dist
COPY .env.example ./
EXPOSE 3000
CMD ["node", "dist/index.js"]
