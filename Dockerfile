# Build stage
FROM node:20-alpine AS build
WORKDIR /app
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml* ./
COPY verifier/custom-cbe-verifier ./verifier/custom-cbe-verifier
COPY ["verifier/telebirr verify", "./verifier/telebirr verify"]
RUN corepack enable && corepack prepare pnpm@9.12.3 --activate
RUN pnpm install --frozen-lockfile
COPY tsconfig.json ./
COPY src ./src
RUN pnpm run build

# Runtime stage
FROM node:20-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml* ./
COPY verifier/custom-cbe-verifier ./verifier/custom-cbe-verifier
COPY ["verifier/telebirr verify", "./verifier/telebirr verify"]
RUN corepack enable && corepack prepare pnpm@9.12.3 --activate
RUN pnpm install --frozen-lockfile --prod
COPY --from=build /app/dist ./dist
COPY public ./public
COPY .env.example ./
EXPOSE 3000
CMD ["node", "dist/index.js"]
