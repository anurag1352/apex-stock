import express from "express";
import { consumeEvents, createPool, requireUserId } from "@apex/common";

const app = express();
const pool = createPool();
const port = Number(process.env.SERVICE_PORT || 4208);

async function createSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS notifications (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, event_id CHAR(36) NOT NULL UNIQUE,
    user_id CHAR(36) NOT NULL, event_type VARCHAR(40) NOT NULL, message VARCHAR(240) NOT NULL,
    read_at DATETIME NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_notifications_user_time (user_id, created_at)
  )`);
}

function notificationText(type: string, data: Record<string, string>) {
  if (type === "ORDER_FILLED") return `${data.side} ${data.quantity} ${data.symbol} filled at ${data.price} (paper)`;
  if (type === "ORDER_REJECTED") return `${data.symbol} order rejected: ${data.reason || "validation failed"}`;
  if (type === "ORDER_CANCELLED") return `${data.symbol} order cancelled`;
  if (type === "ORDER_ACCEPTED") return `${data.side} ${data.quantity} ${data.symbol} accepted for paper execution`;
  return null;
}

app.get("/", async (request, response) => {
  const userId = requireUserId(request.header("x-user-id"));
  const [rows] = await pool.execute("SELECT id, event_type AS type, message, read_at AS readAt, created_at AS createdAt FROM notifications WHERE user_id = ? ORDER BY created_at DESC LIMIT 100", [userId]);
  response.json(rows);
});

app.post("/:id/read", async (request, response) => {
  const userId = requireUserId(request.header("x-user-id"));
  const [result] = await pool.execute("UPDATE notifications SET read_at = COALESCE(read_at, NOW()) WHERE id = ? AND user_id = ?", [request.params.id, userId]);
  if ((result as { affectedRows: number }).affectedRows === 0) { response.status(404).json({ error: "Notification not found" }); return; }
  response.status(204).end();
});

app.get("/health", async (_request, response) => {
  try { await pool.query("SELECT 1"); response.json({ status: "ok", service: "notification" }); }
  catch { response.status(503).json({ status: "error" }); }
});

async function start() {
  await createSchema();
  void consumeEvents("apex-notification-v1", async (event) => {
    const data = event.data as Record<string, string>;
    const message = notificationText(event.type, data);
    if (!message || !data.userId) return;
    await pool.execute("INSERT IGNORE INTO notifications (event_id, user_id, event_type, message) VALUES (?, ?, ?, ?)", [event.id, data.userId, event.type, message]);
  }).catch((error) => console.error("Notification event consumer failed:", error));
  app.listen(port, () => console.log(`Notification service listening on ${port}`));
}
start().catch((error) => { console.error("Notification service startup failed:", error); process.exit(1); });