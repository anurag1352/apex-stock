import express from "express";
import { consumeEvents, createPool, requireUserId } from "@apex/common";

const app = express();
const pool = createPool();
const port = Number(process.env.SERVICE_PORT || 4209);

async function createSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS analytics_events (
    event_id CHAR(36) PRIMARY KEY, event_type VARCHAR(40) NOT NULL,
    occurred_at DATETIME NOT NULL, received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS analytics_counters (
    event_type VARCHAR(40) PRIMARY KEY, total BIGINT UNSIGNED NOT NULL DEFAULT 0,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
}

app.get("/", async (request, response) => {
  requireUserId(request.header("x-user-id"));
  const [counts] = await pool.query("SELECT event_type AS eventType, total, updated_at AS updatedAt FROM analytics_counters ORDER BY event_type");
  const [recent] = await pool.query("SELECT event_id AS eventId, event_type AS eventType, occurred_at AS occurredAt FROM analytics_events ORDER BY received_at DESC LIMIT 25");
  response.json({ counts, recent });
});

app.get("/health", async (_request, response) => {
  try { await pool.query("SELECT 1"); response.json({ status: "ok", service: "analytics" }); }
  catch { response.status(503).json({ status: "error" }); }
});

async function start() {
  await createSchema();
  void consumeEvents("apex-analytics-v1", async (event) => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [result] = await connection.execute("INSERT IGNORE INTO analytics_events (event_id, event_type, occurred_at) VALUES (?, ?, ?)", [event.id, event.type, new Date(event.occurredAt)]);
      if ((result as { affectedRows: number }).affectedRows) {
        await connection.execute("INSERT INTO analytics_counters (event_type, total) VALUES (?, 1) ON DUPLICATE KEY UPDATE total = total + 1", [event.type]);
      }
      await connection.commit();
    } catch (error) { await connection.rollback(); throw error; }
    finally { connection.release(); }
  }).catch((error) => console.error("Analytics event consumer failed:", error));
  app.listen(port, () => console.log(`Analytics service listening on ${port}`));
}
start().catch((error) => { console.error("Analytics service startup failed:", error); process.exit(1); });