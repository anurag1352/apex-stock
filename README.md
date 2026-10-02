# Apex Stock Market Monorepo

Apex is a full-stack stock market dashboard monorepo built with TypeScript, React, Node.js services, MySQL, Kafka, and Docker. It simulates a market data terminal with equities, indices, FX pairs, watchlists, paper trading, notifications, and real-time updates.

This project is designed to run locally as a full development stack and also supports a containerized deployment with Docker Compose.

## What this project does

The app provides:

- A responsive market dashboard in React + Vite
- A microservice-based backend in TypeScript
- Real-time event streaming for market updates and analytics
- A paper trading workflow with orders and portfolio tracking
- Auth + user profile + watchlist persistence
- Market data storage and historical charting
- A gateway layer that exposes the public API to the frontend

## Tech stack

### Frontend
- React 18 + Vite
- TypeScript
- Recharts for charts
- Lucide icons
- CSS-based dashboard UI

### Backend
- Node.js + TypeScript
- Express.js
- REST API gateway
- Microservices pattern with separate service packages
- JWT-based auth
- WebSocket realtime support

### Data and messaging
- MySQL 8
- Kafka for domain event streaming
- Shared common library for DB, auth, Kafka helpers

### Dev and deployment
- npm workspaces
- Docker Compose
- Docker image packaging for each service

## Project structure

```text
apex-stock/
├── .env
├── .env.example
├── docker-compose.yml
├── package.json
├── mysql/
│   └── init/
├── packages/
│   ├── api/
│   ├── common/
│   ├── services/
│   └── web/
└── node_modules/
```

### Core folders

- `packages/web` — dashboard UI and market display
- `packages/api` — API gateway and reverse proxy to internal services
- `packages/common` — shared DB, auth, Kafka, and config utilities
- `packages/services/*` — service-specific microservices
  - `auth` — authentication and JWT handling
  - `user` — user profile storage
  - `stock` — stock catalog and instrument definitions
  - `market-data` — market quote refresh and fallback logic
  - `portfolio` — paper portfolio/account state
  - `order` — paper order execution and fills
  - `watchlist` — user watchlists
  - `notification` — event notifications
  - `analytics` — event aggregation
  - `realtime` — WebSocket / streaming service

## How everything works together

The system is organized as a small event-driven microservice architecture:

1. The browser loads the React dashboard from `packages/web`.
2. The frontend calls the gateway at `http://localhost:4100/api/...`.
3. The API gateway (`packages/api`) forwards requests to the correct internal service.
4. The `market-data` service fetches market prices, stores them in MySQL, and publishes `PRICE_UPDATED` events to Kafka.
5. The `realtime` service listens to Kafka and pushes updates to connected browser clients over WebSocket.
6. Other services like `order`, `portfolio`, `notification`, and `analytics` consume the same event stream.
7. MySQL stores persistent quote snapshots, user records, portfolios, and order history.

This means the UI is not directly connected to external market providers. Instead, internal services orchestrate the data flow and keep the app modular.

## Required installation

Before running the app locally, install the following:

- Node.js 20+ or 22+ (LTS recommended)
- npm 10+
- Docker Desktop or Docker Engine + Docker Compose
- Git

Optional but helpful:

- A real market data API key (for example Twelve Data) if you want live external pricing instead of a fallback/demo dataset

## Environment setup

1. Copy the example file:

```bash
cp .env.example .env
```

2. Update the values in `.env` as needed.

Important variables include:

- `MYSQL_ROOT_PASSWORD`
- `DB_SERVICE_PASSWORD`
- `JWT_ACCESS_SECRET`
- `JWT_REFRESH_SECRET`
- `TWELVE_DATA_API_KEY` (optional; empty means the app uses fallback logic rather than failing completely)
- `MARKET_REFRESH_MS`
- `PROVIDER_REQUEST_DELAY_MS`
- `PAPER_INITIAL_CASH`

The app is designed to run even without a valid external provider key, using resilient fallback data when provider requests fail or are rate-limited.

## Local development run

From the project root:

```bash
npm install
npm run dev
```

This starts the full stack concurrently:

- gateway
- auth service
- user service
- stock service
- market-data service
- portfolio service
- order service
- watchlist service
- notification service
- analytics service
- realtime service
- web app

Then open:

```text
http://localhost:5173
```

The frontend acts as the main dashboard UI. The backend is exposed through the gateway on port `4100` and the browser dev server proxies requests to it.

## Database and Kafka startup

If you want to start the infrastructure separately before the app:

```bash
docker compose up -d database kafka
```

This starts:

- MySQL on `localhost:3306`
- Kafka on `localhost:29092`

The app services are configured to connect to those dependencies automatically via `.env` and Docker service names.

## Full Docker Compose run

To run the full stack in containers:

```bash
docker compose up --build
```

Then open:

```text
http://localhost:8080
```

This runs the web app and all backend services in Docker.

## How the market data flow works

### Stocks and indices
The `stock` service defines the catalog of tracked instruments:

- equities like AAPL, MSFT, NVDA, AMZN, etc.
- index proxies like SPY, QQQ, DIA
- FX pairs like USD/EUR, USD/GBP, USD/JPY, etc.

### Market refresh process
The `market-data` service does the following:

1. Fetches the instrument list from the stock service
2. Tries to load current quote data from the configured provider
3. Falls back to alternate quote sources when the provider is unavailable or rate-limited
4. Stores updated values in MySQL
5. Saves price history for charting
6. Publishes `PRICE_UPDATED` events to Kafka

### Realtime updates
The `realtime` service listens for Kafka events and pushes them through WebSockets to the browser. This keeps the UI refreshed without forcing a full page reload.

### Orders and portfolio
The `order` service creates paper trades and emits order events. The `portfolio` service consumes those events and updates cash, holdings, and positions. This gives the app a simple but realistic trading simulation flow.

## API overview

The gateway exposes the app’s public routes.

### Gateway endpoints
- `GET /api/health` — gateway health
- `GET /api/markets` — returns all tracked market instruments
- `GET /api/markets/:symbol/history?range=1D|1W|1M` — gets chart history
- `POST /api/markets/refresh` — triggers a refresh
- `GET /api/markets/health` — market-data service health

### Auth and user endpoints
- `/api/auth/*`
- `/api/users/*`
- `/api/watchlist/*`

### Trading endpoints
- `/api/orders`
- `/api/portfolio`
- `/api/notifications`
- `/api/analytics`

## Notes about live market data

The project supports a real provider setup but does not require one to run successfully.

- If `TWELVE_DATA_API_KEY` is set and valid, the app will prefer that provider.
- If the key is absent or invalid, the app uses resilient fallback behavior instead of crashing.
- This helps local development remain usable even when third-party providers are rate-limited, blocked, or return partial data.

## Common commands

Install dependencies:

```bash
npm install
```

Run the full local app:

```bash
npm run dev
```

Build the project:

```bash
npm run build
```

Start only infrastructure:

```bash
docker compose up -d database kafka
```

Run the full container stack:

```bash
docker compose up --build
```

## Troubleshooting

### Port already in use
Check whether another process is listening on:

- 4100 (gateway)
- 4201-4210 (microservices)
- 5173 (web app)
- 3306 (MySQL)
- 29092 (Kafka)

### MySQL connection problems
Make sure your `.env` matches the database credentials and that the database container is running.

### Market data empty or not updating
Check:

- `TWELVE_DATA_API_KEY` is valid if you want an external live feed
- the `market-data` service is running
- the gateway is serving requests correctly
- the app has completed a refresh cycle

### Browser shows stale UI
Hard refresh the page or restart the Vite dev server.

## Summary

Apex is a practical TypeScript monorepo market terminal that demonstrates how a full-stack app can connect:

- frontend UI
- API gateway
- microservices
- MySQL persistence
- Kafka event flow
- WebSocket realtime delivery
- paper trading and analytics

It is designed to be easy to run locally, extendable, and realistic enough to understand how a market data system is assembled from multiple moving parts.

This project is for local development and simulation, not for live trading or financial advice.