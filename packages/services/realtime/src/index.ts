import express from "express";
import { createServer } from "node:http";
import { WebSocket, WebSocketServer } from "ws";
import { consumeEvents } from "@apex/common";

const app = express();
const port = Number(process.env.SERVICE_PORT || 4210);
const server = createServer(app);
const sockets = new Set<WebSocket>();
const socketServer = new WebSocketServer({ noServer: true });

socketServer.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
  socket.on("error", () => sockets.delete(socket));
  socket.send(JSON.stringify({ type: "CONNECTION_READY", version: 1, occurredAt: new Date().toISOString() }));
});

server.on("upgrade", (request, socket, head) => {
  if (new URL(request.url || "/", "http://localhost").pathname !== "/stream") { socket.destroy(); return; }
  socketServer.handleUpgrade(request, socket, head, (webSocket) => socketServer.emit("connection", webSocket, request));
});

app.get("/health", (_request, response) => response.json({ status: "ok", service: "realtime", clients: sockets.size }));

void consumeEvents("apex-realtime-v1", async (event) => {
  if (event.type !== "PRICE_UPDATED") return;
  const message = JSON.stringify(event);
  for (const socket of sockets) if (socket.readyState === WebSocket.OPEN) socket.send(message);
}).catch((error) => console.error("Realtime event consumer failed:", error));

server.listen(port, () => console.log(`Realtime service listening on ${port}`));