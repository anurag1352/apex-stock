FROM node:22-alpine
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages packages
RUN npm install --workspace @apex/common --workspace @apex/gateway --include-workspace-root
RUN npm run build -w @apex/common && npm run build -w @apex/gateway
EXPOSE 4000
CMD ["npm", "run", "start", "-w", "@apex/gateway"]