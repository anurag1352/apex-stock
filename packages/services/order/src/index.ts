import { randomUUID } from "node:crypto";
import Decimal from "decimal.js";
import express from "express";
import { consumeEvents, createEvent, createPool, publishEvent, requireUserId } from "@apex/common";
import type { RowDataPacket } from "mysql2/promise";

const app = express();
const pool = createPool();
const port = Number(process.env.SERVICE_PORT || 4206);
const marketDataUrl = process.env.MARKET_DATA_URL || "http://localhost:4204";
const portfolioUrl = process.env.PORTFOLIO_SERVICE_URL || "http://localhost:4205";
app.use(express.json({ limit: "16kb" }));

type TradeOrder = {
  id: string; user_id: string; symbol: string; side: "BUY" | "SELL";
  quantity: string; status: string; average_price: string | null; reason: string | null;
};

function parseOutboxEventPayload(payload: unknown) {
  if (typeof payload === "string") return JSON.parse(payload);
  if (payload !== null && typeof payload === "object") return payload;
  throw new Error("Outbox payload is missing or invalid");
}

async function createSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS trade_orders (
    id CHAR(36) PRIMARY KEY, user_id CHAR(36) NOT NULL, idempotency_key VARCHAR(120) NOT NULL,
    symbol VARCHAR(20) NOT NULL, side VARCHAR(4) NOT NULL, quantity DECIMAL(22, 8) NOT NULL,
    status VARCHAR(16) NOT NULL, average_price DECIMAL(22, 8) NULL, reason VARCHAR(240) NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_order_user_idempotency (user_id, idempotency_key),
    INDEX idx_orders_user_time (user_id, created_at)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS order_outbox (
    event_id CHAR(36) PRIMARY KEY, event_type VARCHAR(40) NOT NULL, payload JSON NOT NULL,
    published_at DATETIME NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_order_outbox_pending (published_at, created_at)
  )`);
}

async function writeTransition(order: TradeOrder, expectedStatus: string, status: string, eventType: "ORDER_ACCEPTED" | "ORDER_REJECTED" | "ORDER_EXECUTED" | "ORDER_FILLED" | "ORDER_CANCELLED", extra: Record<string, string> = {}) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [result] = await connection.execute("UPDATE trade_orders SET status = ?, average_price = COALESCE(?, average_price), reason = ? WHERE id = ? AND status = ?", [status, extra.price || null, extra.reason || null, order.id, expectedStatus]);
    if ((result as { affectedRows: number }).affectedRows === 0) { await connection.rollback(); return false; }
    const event = createEvent(eventType, {
      orderId: order.id, userId: order.user_id, symbol: order.symbol, side: order.side,
      quantity: order.quantity, ...extra,
    }, order.id);
    await connection.execute("INSERT INTO order_outbox (event_id, event_type, payload) VALUES (?, ?, ?)", [event.id, event.type, JSON.stringify(event)]);
    await connection.commit();
    return true;
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

async function processCreatedOrder(event: { data: Record<string, string> }) {
  const orderId = event.data.orderId;
  const [rows] = await pool.execute<RowDataPacket[]>("SELECT * FROM trade_orders WHERE id = ?", [orderId]);
  const order = rows[0] as (RowDataPacket & TradeOrder) | undefined;
  if (!order || order.status !== "CREATED") return;
  const [claim] = await pool.execute("UPDATE trade_orders SET status = 'VALIDATING' WHERE id = ? AND status = 'CREATED'", [orderId]);
  if ((claim as { affectedRows: number }).affectedRows === 0) return;
  let reserved = false;
  try {
    const quoteResponse = await fetch(`${marketDataUrl}/internal/quotes/${encodeURIComponent(order.symbol)}`, { signal: AbortSignal.timeout(5_000) });
    if (!quoteResponse.ok) throw new Error("No current market quote is available for this symbol");
    const quote = await quoteResponse.json() as { price?: string };
    const price = new Decimal(String(quote.price));
    if (!price.isFinite() || price.lte(0)) throw new Error("The market provider returned an invalid price");
    const reservationResponse = await fetch(`${portfolioUrl}/internal/reservations`, {
      method: "POST", signal: AbortSignal.timeout(5_000),
      headers: { "content-type": "application/json", "x-user-id": order.user_id },
      body: JSON.stringify({ orderId: order.id, symbol: order.symbol, side: order.side, quantity: order.quantity, price: price.toString() }),
    });
    if (!reservationResponse.ok) {
      const reservationError = await reservationResponse.json().catch(() => ({})) as { error?: string };
      throw new Error(reservationError.error || "Portfolio could not reserve this order");
    }
    reserved = true;
    if (!await writeTransition(order, "VALIDATING", "ACCEPTED", "ORDER_ACCEPTED", { price: price.toString() })) return;
    if (!await writeTransition(order, "ACCEPTED", "EXECUTING", "ORDER_EXECUTED", { price: price.toString(), executionMode: "PAPER" })) return;
    const total = price.times(order.quantity).toString();
    await writeTransition(order, "EXECUTING", "FILLED", "ORDER_FILLED", { price: price.toString(), total, executionMode: "PAPER" });
  } catch (error) {
    const reason = error instanceof Error ? error.message.slice(0, 240) : "Order processing failed";
    if (reserved) {
      const release = createEvent("ORDER_REJECTED", { orderId: order.id, userId: order.user_id, symbol: order.symbol, side: order.side, quantity: order.quantity, reason }, order.id);
      const connection = await pool.getConnection();
      try {
        await connection.beginTransaction();
        await connection.execute("UPDATE trade_orders SET status = 'REJECTED', reason = ? WHERE id = ? AND status IN ('VALIDATING', 'ACCEPTED', 'EXECUTING')", [reason, order.id]);
        await connection.execute("INSERT IGNORE INTO order_outbox (event_id, event_type, payload) VALUES (?, ?, ?)", [release.id, release.type, JSON.stringify(release)]);
        await connection.commit();
      } catch (dbError) { await connection.rollback(); throw dbError; }
      finally { connection.release(); }
    } else {
      await writeTransition(order, "VALIDATING", "REJECTED", "ORDER_REJECTED", { reason });
    }
  }
}

async function publishPendingOutbox() {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.query<RowDataPacket[]>("SELECT event_id, payload FROM order_outbox WHERE published_at IS NULL ORDER BY created_at LIMIT 20 FOR UPDATE SKIP LOCKED");
    for (const row of rows) {
      await publishEvent(parseOutboxEventPayload(row.payload));
      await connection.execute("UPDATE order_outbox SET published_at = NOW() WHERE event_id = ?", [row.event_id]);
    }
    await connection.commit();
  } catch (error) { await connection.rollback(); console.error("Order outbox publish failed:", error); }
  finally { connection.release(); }
}

app.post("/", async (request, response) => {
  const userId = requireUserId(request.header("x-user-id"));
  const symbol = typeof request.body?.symbol === "string" ? request.body.symbol.trim().toUpperCase() : "";
  const side = typeof request.body?.side === "string" ? request.body.side.toUpperCase() : "";
  const idempotencyKey = request.header("idempotency-key") || "";
  let quantity: Decimal;
  try { quantity = new Decimal(String(request.body?.quantity)); }
  catch { response.status(400).json({ error: "quantity must be a decimal number" }); return; }
  if (!/^[A-Z]{1,8}$/.test(symbol) || !["BUY", "SELL"].includes(side) || !quantity.isFinite() || quantity.lte(0) || quantity.decimalPlaces() > 8 || quantity.gt(100_000) || idempotencyKey.length < 8 || idempotencyKey.length > 120) {
    response.status(400).json({ error: "Provide a stock symbol, BUY or SELL side, quantity up to 8 decimals, and an Idempotency-Key header of 8–120 characters" }); return;
  }
  const [existingRows] = await pool.execute<RowDataPacket[]>("SELECT * FROM trade_orders WHERE user_id = ? AND idempotency_key = ?", [userId, idempotencyKey]);
  const existing = existingRows[0] as (RowDataPacket & TradeOrder) | undefined;
  if (existing) {
    if (existing.symbol !== symbol || existing.side !== side || !new Decimal(existing.quantity).eq(quantity)) { response.status(409).json({ error: "Idempotency key was already used for a different order" }); return; }
    response.status(200).json(existing);
    return;
  }
  const orderId = randomUUID();
  const event = createEvent("ORDER_CREATED", { orderId, userId, symbol, side, quantity: quantity.toString() }, orderId);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute("INSERT INTO trade_orders (id, user_id, idempotency_key, symbol, side, quantity, status) VALUES (?, ?, ?, ?, ?, ?, 'CREATED')", [orderId, userId, idempotencyKey, symbol, side, quantity.toString()]);
    await connection.execute("INSERT INTO order_outbox (event_id, event_type, payload) VALUES (?, ?, ?)", [event.id, event.type, JSON.stringify(event)]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    if ((error as { code?: string }).code === "ER_DUP_ENTRY") { response.status(409).json({ error: "An order with this idempotency key already exists" }); return; }
    console.error("Order creation failed:", error);
    response.status(503).json({ error: "Order could not be created" });
    return;
  } finally { connection.release(); }
  response.status(202).json({ id: orderId, symbol, side, quantity: quantity.toString(), status: "CREATED", executionMode: "PAPER" });
});

app.get("/", async (request, response) => {
  const userId = requireUserId(request.header("x-user-id"));
  const [rows] = await pool.execute<RowDataPacket[]>("SELECT id, symbol, side, quantity, status, average_price AS averagePrice, reason, created_at AS createdAt, updated_at AS updatedAt FROM trade_orders WHERE user_id = ? ORDER BY created_at DESC LIMIT 100", [userId]);
  response.json(rows);
});

app.get("/health", async (_request, response) => {
  try { await pool.query("SELECT 1"); response.json({ status: "ok", service: "order", executionMode: "paper" }); }
  catch { response.status(503).json({ status: "error" }); }
});

app.get("/:orderId", async (request, response) => {
  const userId = requireUserId(request.header("x-user-id"));
  const [rows] = await pool.execute<RowDataPacket[]>("SELECT id, symbol, side, quantity, status, average_price AS averagePrice, reason, created_at AS createdAt, updated_at AS updatedAt FROM trade_orders WHERE id = ? AND user_id = ?", [request.params.orderId, userId]);
  if (!rows[0]) { response.status(404).json({ error: "Order not found" }); return; }
  response.json(rows[0]);
});

app.post("/:orderId/cancel", async (request, response) => {
  const userId = requireUserId(request.header("x-user-id"));
  const [rows] = await pool.execute<RowDataPacket[]>("SELECT * FROM trade_orders WHERE id = ? AND user_id = ?", [request.params.orderId, userId]);
  const order = rows[0] as (RowDataPacket & TradeOrder) | undefined;
  if (!order) { response.status(404).json({ error: "Order not found" }); return; }
  if (order.status !== "CREATED") { response.status(409).json({ error: `Only CREATED orders can be cancelled; current status is ${order.status}` }); return; }
  const cancelled = await writeTransition(order, "CREATED", "CANCELLED", "ORDER_CANCELLED", { reason: "Cancelled by user" });
  response.status(cancelled ? 202 : 409).json({ id: order.id, status: cancelled ? "CANCELLED" : "PROCESSING" });
});

async function start() {
  await createSchema();
  void consumeEvents("apex-order-processor-v1", async (event) => {
    if (event.type === "ORDER_CREATED") await processCreatedOrder(event as { data: Record<string, string> });
  }).catch((error) => console.error("Order event consumer failed:", error));
  setInterval(() => void publishPendingOutbox(), 500);
  app.listen(port, () => console.log(`Order service listening on ${port} (paper execution)`));
}
start().catch((error) => { console.error("Order service startup failed:", error); process.exit(1); });