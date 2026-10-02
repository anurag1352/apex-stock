FROM node:22-alpine
WORKDIR /app
ARG SERVICE_PACKAGE
ENV SERVICE_PACKAGE=${SERVICE_PACKAGE}
COPY package.json package-lock.json ./
COPY packages packages
RUN npm install --workspace @apex/common --workspace ${SERVICE_PACKAGE} --include-workspace-root
RUN npm run build -w @apex/common && npm run build -w ${SERVICE_PACKAGE}
CMD ["sh", "-c", "npm run start -w $SERVICE_PACKAGE"]