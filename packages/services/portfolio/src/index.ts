import Decimal from "decimal.js";
import express from "express";
import { consumeEvents, createPool, requireUserId } from "@apex/common";
import type { RowDataPacket } from "mysql2/promise";

const app = express();
const pool = createPool();
const port = Number(process.env.SERVICE_PORT || 4205);
const initialCash = new Decimal(process.env.PAPER_INITIAL_CASH || "100000");
app.use(express.json({ limit: "16kb" }));

async function createSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS portfolio_accounts (
    user_id CHAR(36) PRIMARY KEY, cash DECIMAL(22, 8) NOT NULL,
    account_mode VARCHAR(12) NOT NULL DEFAULT 'PAPER',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS portfolio_holdings (
    user_id CHAR(36) NOT NULL, symbol VARCHAR(20) NOT NULL,
    quantity DECIMAL(22, 8) NOT NULL, average_price DECIMAL(22, 8) NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, symbol)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS portfolio_reservations (
    order_id CHAR(36) PRIMARY KEY, user_id CHAR(36) NOT NULL, symbol VARCHAR(20) NOT NULL,
    side VARCHAR(4) NOT NULL, quantity DECIMAL(22, 8) NOT NULL, amount DECIMAL(22, 8) NOT NULL,
    status VARCHAR(12) NOT NULL DEFAULT 'RESERVED', created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_reservation_user_status (user_id, status)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS portfolio_transactions (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, order_id CHAR(36) NOT NULL UNIQUE,
    user_id CHAR(36) NOT NULL, symbol VARCHAR(20) NOT NULL, side VARCHAR(4) NOT NULL,
    quantity DECIMAL(22, 8) NOT NULL, price DECIMAL(22, 8) NOT NULL,
    total DECIMAL(22, 8) NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_transactions_user_time (user_id, created_at)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS portfolio_market_prices (
    symbol VARCHAR(20) PRIMARY KEY, price DECIMAL(22, 8) NOT NULL,
    source_updated_at DATETIME NOT NULL, received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS portfolio_processed_events (
    event_id CHAR(36) PRIMARY KEY, event_type VARCHAR(40) NOT NULL,
    processed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
}

async function ensureAccount(userId: string) {
  await pool.execute("INSERT IGNORE INTO portfolio_accounts (user_id, cash, account_mode) VALUES (?, ?, 'PAPER')", [userId, initialCash.toString()]);
}

app.get("/", async (request, response) => {
  const userId = requireUserId(request.header("x-user-id"));
  await ensureAccount(userId);
  const [accounts] = await pool.execute<RowDataPacket[]>("SELECT cash, account_mode AS mode FROM portfolio_accounts WHERE user_id = ?", [userId]);
  const [holdings] = await pool.execute<RowDataPacket[]>(
    `SELECT h.symbol, h.quantity, h.average_price AS averagePrice, p.price AS currentPrice,
      h.quantity * p.price AS marketValue, h.quantity * (p.price - h.average_price) AS unrealizedPnl
     FROM portfolio_holdings h LEFT JOIN portfolio_market_prices p ON p.symbol = h.symbol
     WHERE h.user_id = ? AND h.quantity > 0 ORDER BY h.symbol`, [userId],
  );
  const [pending] = await pool.execute<RowDataPacket[]>("SELECT COALESCE(SUM(amount), 0) AS amount FROM portfolio_reservations WHERE user_id = ? AND side = 'BUY' AND status = 'RESERVED'", [userId]);
  const cash = new Decimal(String(accounts[0].cash));
  const reserved = new Decimal(String(pending[0].amount || 0));
  const totalMarketValue = holdings.reduce((total, item) => total.plus(item.marketValue == null ? 0 : String(item.marketValue)), new Decimal(0));
  const totalPnl = holdings.reduce((total, item) => total.plus(item.unrealizedPnl == null ? 0 : String(item.unrealizedPnl)), new Decimal(0));
  response.json({
    mode: accounts[0].mode,
    cash: cash.toString(),
    availableCash: cash.minus(reserved).toString(),
    marketValue: totalMarketValue.toString(),
    totalValue: cash.plus(totalMarketValue).toString(),
    unrealizedPnl: totalPnl.toString(),
    holdings: holdings.map((item) => ({
      symbol: item.symbol, quantity: String(item.quantity), averagePrice: String(item.averagePrice),
      currentPrice: item.currentPrice == null ? null : String(item.currentPrice),
      marketValue: item.marketValue == null ? null : String(item.marketValue),
      unrealizedPnl: item.unrealizedPnl == null ? null : String(item.unrealizedPnl),
    })),
  });
});

app.get("/transactions", async (request, response) => {
  const userId = requireUserId(request.header("x-user-id"));
  const [rows] = await pool.execute<RowDataPacket[]>("SELECT order_id AS orderId, symbol, side, quantity, price, total, created_at AS createdAt FROM portfolio_transactions WHERE user_id = ? ORDER BY created_at DESC LIMIT 100", [userId]);
  response.json(rows);
});

app.post("/internal/reservations", async (request, response) => {
  const userId = requireUserId(request.header("x-user-id"));
  const { orderId, symbol, side } = request.body || {};
  let quantity: Decimal;
  let price: Decimal;
  try { quantity = new Decimal(String(request.body?.quantity)); price = new Decimal(String(request.body?.price)); }
  catch { response.status(400).json({ error: "Quantity and price must be valid decimal numbers" }); return; }
  if (typeof orderId !== "string" || typeof symbol !== "string" || !["BUY", "SELL"].includes(side) || !quantity.isFinite() || quantity.lte(0) || !price.isFinite() || price.lte(0)) {
    response.status(400).json({ error: "Invalid reservation request" }); return;
  }
  await ensureAccount(userId);
  const amount = quantity.times(price);
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    if (side === "BUY") {
      const [accounts] = await connection.execute<RowDataPacket[]>("SELECT cash FROM portfolio_accounts WHERE user_id = ? FOR UPDATE", [userId]);
      const [reservedRows] = await connection.execute<RowDataPacket[]>("SELECT COALESCE(SUM(amount), 0) AS amount FROM portfolio_reservations WHERE user_id = ? AND side = 'BUY' AND status = 'RESERVED'", [userId]);
      const available = new Decimal(String(accounts[0].cash)).minus(String(reservedRows[0].amount || 0));
      if (available.lt(amount)) { await connection.rollback(); response.status(409).json({ error: "Insufficient available paper-trading cash" }); return; }
    } else {
      const [holdings] = await connection.execute<RowDataPacket[]>("SELECT quantity FROM portfolio_holdings WHERE user_id = ? AND symbol = ? FOR UPDATE", [userId, symbol]);
      const [reservedRows] = await connection.execute<RowDataPacket[]>("SELECT COALESCE(SUM(quantity), 0) AS quantity FROM portfolio_reservations WHERE user_id = ? AND symbol = ? AND side = 'SELL' AND status = 'RESERVED'", [userId, symbol]);
      const available = new Decimal(String(holdings[0]?.quantity || 0)).minus(String(reservedRows[0].quantity || 0));
      if (available.lt(quantity)) { await connection.rollback(); response.status(409).json({ error: "Insufficient available shares" }); return; }
    }
    await connection.execute("INSERT INTO portfolio_reservations (order_id, user_id, symbol, side, quantity, amount) VALUES (?, ?, ?, ?, ?, ?)", [orderId, userId, symbol, side, quantity.toString(), amount.toString()]);
    await connection.commit();
    response.status(201).json({ orderId, reserved: amount.toString() });
  } catch (error) {
    await connection.rollback();
    if ((error as { code?: string }).code === "ER_DUP_ENTRY") { response.status(200).json({ orderId, status: "already-reserved" }); return; }
    console.error("Portfolio reservation failed:", error);
    response.status(503).json({ error: "Portfolio reservation failed" });
  } finally { connection.release(); }
});

async function consumePortfolioEvent(eventId: string, type: string, data: Record<string, string>) {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [insertResult] = await connection.execute("INSERT IGNORE INTO portfolio_processed_events (event_id, event_type) VALUES (?, ?)", [eventId, type]);
    if ((insertResult as { affectedRows: number }).affectedRows === 0) { await connection.commit(); return; }
    if (type === "PRICE_UPDATED") {
      await connection.execute(
        `INSERT INTO portfolio_market_prices (symbol, price, source_updated_at) VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE price = IF(VALUES(source_updated_at) >= source_updated_at, VALUES(price), price),
           source_updated_at = GREATEST(source_updated_at, VALUES(source_updated_at)), received_at = CURRENT_TIMESTAMP`,
        [data.symbol, data.price, new Date(data.updatedAt || Date.now())],
      );
    } else if (type === "ORDER_FILLED") {
      const [reservations] = await connection.execute<RowDataPacket[]>("SELECT * FROM portfolio_reservations WHERE order_id = ? AND status = 'RESERVED' FOR UPDATE", [data.orderId]);
      const reservation = reservations[0];
      if (reservation) {
        const quantity = new Decimal(data.quantity);
        const price = new Decimal(data.price);
        const total = quantity.times(price);
        if (data.side === "BUY") {
          await connection.execute("UPDATE portfolio_accounts SET cash = cash - ? WHERE user_id = ?", [total.toString(), data.userId]);
          const [existingRows] = await connection.execute<RowDataPacket[]>("SELECT quantity, average_price FROM portfolio_holdings WHERE user_id = ? AND symbol = ? FOR UPDATE", [data.userId, data.symbol]);
          if (existingRows[0]) {
            const oldQty = new Decimal(String(existingRows[0].quantity));
            const nextQty = oldQty.plus(quantity);
            const average = oldQty.times(String(existingRows[0].average_price)).plus(total).dividedBy(nextQty);
            await connection.execute("UPDATE portfolio_holdings SET quantity = ?, average_price = ? WHERE user_id = ? AND symbol = ?", [nextQty.toString(), average.toString(), data.userId, data.symbol]);
          } else {
            await connection.execute("INSERT INTO portfolio_holdings (user_id, symbol, quantity, average_price) VALUES (?, ?, ?, ?)", [data.userId, data.symbol, quantity.toString(), price.toString()]);
          }
        } else {
          await connection.execute("UPDATE portfolio_accounts SET cash = cash + ? WHERE user_id = ?", [total.toString(), data.userId]);
          await connection.execute("UPDATE portfolio_holdings SET quantity = quantity - ? WHERE user_id = ? AND symbol = ?", [quantity.toString(), data.userId, data.symbol]);
        }
        await connection.execute("UPDATE portfolio_reservations SET status = 'SETTLED' WHERE order_id = ?", [data.orderId]);
        await connection.execute("INSERT INTO portfolio_transactions (order_id, user_id, symbol, side, quantity, price, total) VALUES (?, ?, ?, ?, ?, ?, ?)", [data.orderId, data.userId, data.symbol, data.side, quantity.toString(), price.toString(), total.toString()]);
      }
    } else if (type === "ORDER_REJECTED" || type === "ORDER_CANCELLED") {
      await connection.execute("UPDATE portfolio_reservations SET status = 'RELEASED' WHERE order_id = ? AND status = 'RESERVED'", [data.orderId]);
    }
    await connection.commit();
  } catch (error) { await connection.rollback(); throw error; }
  finally { connection.release(); }
}

app.get("/health", async (_request, response) => {
  try { await pool.query("SELECT 1"); response.json({ status: "ok", service: "portfolio", mode: "paper" }); }
  catch { response.status(503).json({ status: "error" }); }
});

async function start() {
  await createSchema();
  void consumeEvents("apex-portfolio-v1", async (event) => {
    if (["PRICE_UPDATED", "ORDER_FILLED", "ORDER_REJECTED", "ORDER_CANCELLED"].includes(event.type)) {
      await consumePortfolioEvent(event.id, event.type, event.data as Record<string, string>);
    }
  }).catch((error) => console.error("Portfolio event consumer failed:", error));
  app.listen(port, () => console.log(`Portfolio service listening on ${port}`));
}
start().catch((error) => { console.error("Portfolio service startup failed:", error); process.exit(1); });