import express from "express";
import { createPool, requireUserId } from "@apex/common";

const app = express();
const pool = createPool();
const port = Number(process.env.SERVICE_PORT || 4207);
app.use(express.json({ limit: "16kb" }));

async function createSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS watchlist_items (
    user_id CHAR(36) NOT NULL, symbol VARCHAR(20) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, symbol), INDEX idx_watchlist_user_time (user_id, created_at)
  )`);
}

app.get("/", async (request, response) => {
  const userId = requireUserId(request.header("x-user-id"));
  const [rows] = await pool.execute("SELECT symbol, created_at AS addedAt FROM watchlist_items WHERE user_id = ? ORDER BY created_at DESC", [userId]);
  response.json(rows);
});

app.post("/", async (request, response) => {
  const userId = requireUserId(request.header("x-user-id"));
  const symbol = typeof request.body?.symbol === "string" ? request.body.symbol.trim().toUpperCase() : "";
  if (!/^[A-Z]{1,8}(?:\/[A-Z]{3})?$/.test(symbol)) { response.status(400).json({ error: "Invalid instrument symbol" }); return; }
  await pool.execute("INSERT IGNORE INTO watchlist_items (user_id, symbol) VALUES (?, ?)", [userId, symbol]);
  response.status(201).json({ symbol });
});

app.delete("/:symbol", async (request, response) => {
  const userId = requireUserId(request.header("x-user-id"));
  await pool.execute("DELETE FROM watchlist_items WHERE user_id = ? AND symbol = ?", [userId, request.params.symbol.toUpperCase()]);
  response.status(204).end();
});

app.get("/health", async (_request, response) => {
  try { await pool.query("SELECT 1"); response.json({ status: "ok", service: "watchlist" }); }
  catch { response.status(503).json({ status: "error" }); }
});

async function start() { await createSchema(); app.listen(port, () => console.log(`Watchlist service listening on ${port}`)); }
start().catch((error) => { console.error("Watchlist service startup failed:", error); process.exit(1); });