FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json* ./
COPY packages packages
RUN npm install --workspace @apex/web --include-workspace-root
RUN npm run build -w @apex/web

FROM nginx:1.27-alpine
COPY packages/web/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/packages/web/dist /usr/share/nginx/html
EXPOSE 80