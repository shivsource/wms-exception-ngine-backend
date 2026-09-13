# syntax=docker/dockerfile:1

FROM node:20-alpine AS base
WORKDIR /app
COPY package*.json ./

# ---- Development: hot reload via ts-node-dev, full devDependencies ----
FROM base AS development
ENV NODE_ENV=development
RUN npm install
COPY . .
EXPOSE 6000
CMD ["npm", "run", "dev"]

# ---- Build: compile TypeScript to dist/ ----
FROM base AS build
RUN npm install
COPY . .
RUN npm run build

# ---- Production: only prod deps + compiled output ----
FROM node:20-alpine AS production
ENV NODE_ENV=production
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY --from=build /app/dist ./dist
EXPOSE 6000
CMD ["node", "dist/server.js"]
