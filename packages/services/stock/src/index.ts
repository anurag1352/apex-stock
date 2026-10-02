import express from "express";
import { createPool } from "@apex/common";

const app = express();
const pool = createPool();
const port = Number(process.env.SERVICE_PORT || 4203);
const initialStocks = [
  ["AAPL", "Apple Inc.", "stock", "NASDAQ"], ["MSFT", "Microsoft Corporation", "stock", "NASDAQ"],
  ["NVDA", "NVIDIA Corporation", "stock", "NASDAQ"], ["AMZN", "Amazon.com, Inc.", "stock", "NASDAQ"],
  ["GOOGL", "Alphabet Inc.", "stock", "NASDAQ"], ["META", "Meta Platforms, Inc.", "stock", "NASDAQ"],
  ["TSLA", "Tesla, Inc.", "stock", "NASDAQ"], ["SPY", "S&P 500 proxy · SPDR ETF", "index", "NYSE Arca"],
  ["QQQ", "Nasdaq-100 proxy · Invesco ETF", "index", "NASDAQ"], ["DIA", "Dow Jones proxy · SPDR ETF", "index", "NYSE Arca"],
];

async function createSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS stocks (
    symbol VARCHAR(20) PRIMARY KEY, name VARCHAR(120) NOT NULL,
    asset_type VARCHAR(20) NOT NULL, exchange_name VARCHAR(60) NOT NULL,
    active BOOLEAN NOT NULL DEFAULT TRUE, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  for (const stock of initialStocks) {
    await pool.execute("INSERT IGNORE INTO stocks (symbol, name, asset_type, exchange_name) VALUES (?, ?, ?, ?)", stock);
  }
}

app.get("/", async (request, response) => {
  const type = typeof request.query.type === "string" ? request.query.type : null;
  if (type && !["stock", "index"].includes(type)) { response.status(400).json({ error: "type must be stock or index" }); return; }
  const [rows] = await pool.query(`SELECT symbol, name, asset_type AS type, exchange_name AS exchange FROM stocks WHERE active = TRUE ${type ? "AND asset_type = ?" : ""} ORDER BY symbol`, type ? [type] : []);
  response.json(rows);
});

app.get("/health", async (_request, response) => {
  try { await pool.query("SELECT 1"); response.json({ status: "ok", service: "stock" }); }
  catch { response.status(503).json({ status: "error" }); }
});

app.get("/:symbol", async (request, response) => {
  const [rows] = await pool.execute("SELECT symbol, name, asset_type AS type, exchange_name AS exchange FROM stocks WHERE symbol = ? AND active = TRUE", [request.params.symbol.toUpperCase()]);
  const stock = (rows as Array<Record<string, unknown>>)[0];
  if (!stock) { response.status(404).json({ error: "Instrument not found" }); return; }
  response.json(stock);
});

async function start() { await createSchema(); app.listen(port, () => console.log(`Stock service listening on ${port}`)); }
start().catch((error) => { console.error("Stock service startup failed:", error); process.exit(1); });