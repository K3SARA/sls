# Stage 1: Build the React Frontend
FROM node:20-alpine AS builder
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY apps/web/package.json apps/web/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm ci
COPY . .
# Empty VITE_API_BASE forces relative endpoints in production
ENV VITE_API_BASE=""
RUN npm run build -w apps/web

# Stage 2: Create production container
FROM node:20-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY apps/server/package.json apps/server/package.json
COPY packages/shared/package.json packages/shared/package.json
RUN npm install --omit=dev --workspace=packages/shared --workspace=apps/server --include-workspace-root
COPY --from=builder /app/apps/server /app/apps/server
COPY --from=builder /app/packages/shared /app/packages/shared
COPY --from=builder /app/apps/web/dist /app/apps/web/dist

ENV NODE_ENV=production
WORKDIR /app/apps/server
CMD ["npm", "run", "start"]
