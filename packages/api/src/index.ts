import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { createProxyMiddleware } from "http-proxy-middleware";
import { createServer } from "node:http";
import { signRealtimeTicket, verifyAccessToken, verifyRealtimeTicket } from "@apex/common";
import { WebSocket, WebSocketServer } from "ws";

dotenv.config({ path: process.env.ENV_FILE || ".env" });
const app = express();
const server = createServer(app);
const port = Number(process.env.GATEWAY_PORT || 4100);
const allowedOrigins = (process.env.FRONTEND_ORIGINS || "http://localhost:5173,http://localhost:8080").split(",");
const realtimeWsUrl = process.env.REALTIME_WS_URL || "ws://localhost:4210";
const usedRealtimeTickets = new Set<string>();

app.use(cors({ origin: allowedOrigins, credentials: true }));
app.get("/api/health", (_request, response) => response.json({ status: "ok", service: "api-gateway" }));

app.use("/api", (request, response, next) => {
  const path = request.path;
  if (path.startsWith("/portfolio/internal/") || path.startsWith("/markets/internal/")) {
    response.status(404).json({ error: "Route not found" });
    return;
  }
  if (path.startsWith("/auth/") || path === "/auth" || path.startsWith("/markets") || path.startsWith("/stocks")) { next(); return; }
  const header = request.header("authorization");
  const token = header?.startsWith("Bearer ") ? header.slice(7) : "";
  try {
    const identity = verifyAccessToken(token);
    request.headers["x-user-id"] = identity.sub!;
    request.headers["x-user-email"] = typeof identity.email === "string" ? identity.email : "";
    next();
  } catch {
    response.status(401).json({ error: "A valid access token is required" });
  }
});

app.post("/api/realtime-ticket", (request, response) => {
  try {
    const token = request.header("authorization")?.slice(7) || "";
    const identity = verifyAccessToken(token);
    response.status(201).json({ ticket: signRealtimeTicket(identity.sub!) });
  } catch {
    response.status(401).json({ error: "A valid access token is required" });
  }
});

const serviceRoutes: Array<[string, string]> = [
  ["/api/auth", process.env.AUTH_SERVICE_URL || "http://localhost:4201"],
  ["/api/users", process.env.USER_SERVICE_URL || "http://localhost:4202"],
  ["/api/stocks", process.env.STOCK_SERVICE_URL || "http://localhost:4203"],
  ["/api/markets", process.env.MARKET_DATA_SERVICE_URL || "http://localhost:4204"],
  ["/api/portfolio", process.env.PORTFOLIO_SERVICE_URL || "http://localhost:4205"],
  ["/api/orders", process.env.ORDER_SERVICE_URL || "http://localhost:4206"],
  ["/api/watchlist", process.env.WATCHLIST_SERVICE_URL || "http://localhost:4207"],
  ["/api/notifications", process.env.NOTIFICATION_SERVICE_URL || "http://localhost:4208"],
  ["/api/analytics", process.env.ANALYTICS_SERVICE_URL || "http://localhost:4209"],
];

for (const [path, target] of serviceRoutes) {
  app.use(path, createProxyMiddleware({ target, changeOrigin: true, proxyTimeout: 15_000, timeout: 15_000 }));
}

const webSockets = new WebSocketServer({ noServer: true });
server.on("upgrade", (request, socket, head) => {
  const url = new URL(request.url || "/", "http://localhost");
  if (url.pathname !== "/ws") { socket.destroy(); return; }
  try {
    const ticket = verifyRealtimeTicket(url.searchParams.get("ticket") || "");
    if (usedRealtimeTickets.has(ticket.jti!)) throw new Error("Realtime ticket has already been used");
    usedRealtimeTickets.add(ticket.jti!);
    setTimeout(() => usedRealtimeTickets.delete(ticket.jti!), 35_000);
    webSockets.handleUpgrade(request, socket, head, (client) => {
      const upstream = new WebSocket(`${realtimeWsUrl}/stream`);
      upstream.on("message", (message) => { if (client.readyState === WebSocket.OPEN) client.send(message.toString()); });
      client.on("message", (message) => { if (upstream.readyState === WebSocket.OPEN) upstream.send(message.toString()); });
      client.on("close", () => { if (upstream.readyState === WebSocket.OPEN) upstream.close(); });
      upstream.on("close", () => { if (client.readyState === WebSocket.OPEN) client.close(); });
      upstream.on("error", () => { if (client.readyState === WebSocket.OPEN) client.close(1011, "Realtime service unavailable"); });
      webSockets.emit("connection", client, request);
    });
  } catch { socket.destroy(); }
});

server.listen(port, () => console.log(`API Gateway listening on ${port}`));