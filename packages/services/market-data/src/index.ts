import express from "express";
import { createEvent, createPool, publishEvent } from "@apex/common";
import type { RowDataPacket } from "mysql2/promise";

const app = express();
const pool = createPool();
const port = Number(process.env.SERVICE_PORT || 4204);
const rawProviderKey = (process.env.TWELVE_DATA_API_KEY || "").trim();
const providerKey = rawProviderKey && !/^(demo|example|replace|changeme)$/i.test(rawProviderKey) ? rawProviderKey : "";
const refreshMs = Math.max(60_000, Number(process.env.MARKET_REFRESH_MS || 900_000));
const requestDelay = Math.max(0, Number(process.env.PROVIDER_REQUEST_DELAY_MS || 8_000));
const stockServiceUrl = process.env.STOCK_SERVICE_URL || "http://localhost:4203";
const fxPairs = ["EUR", "GBP", "JPY", "CAD", "CHF", "INR", "AUD", "NZD", "CNY", "HKD", "SGD", "KRW", "MXN", "BRL", "ZAR", "SEK", "NOK", "DKK", "PLN", "CZK", "HUF", "TRY", "AED", "SAR", "THB", "IDR", "MYR", "PHP", "TWD", "ILS"];
const FX = fxPairs.map((code) => ({ symbol: `USD/${code}`, name: `US dollar / ${code}`, type: "currency", exchange: "FX" }));
const fallbackSeedPrices: Record<string, number> = {
  AAPL: 214.58, MSFT: 428.12, NVDA: 118.42, AMZN: 186.7, GOOGL: 176.9, META: 510.1, TSLA: 221.4,
  SPY: 542.81, QQQ: 470.45, DIA: 396.12, EURUSD: 0.92, GBPUSD: 0.79, JPYUSD: 157.2,
  CADUSD: 1.37, CHFUSD: 0.89, INRUSD: 83.9, AUDUSD: 1.52, NZDUSD: 1.64, CNYUSD: 7.25,
  HKDUSD: 7.81, SGDUSD: 1.35, KRWUSD: 1362.4, MXNUSD: 18.3, BRLUSD: 5.78, ZARUSD: 18.7,
  SEKUSD: 10.2, NOKUSD: 10.6, DKKUSD: 6.87, PLNUSD: 3.94, CZKUSD: 22.8, HUFUSD: 363.4,
  TRYUSD: 32.7, AEDUSD: 3.67, SARUSD: 3.75, THBUSD: 35.7, IDRUSD: 16200, MYRUSD: 4.7,
  PHPUSD: 58.3, TWDUSD: 32.4, ILSUSD: 3.63,
};
let refreshing = false;
let lastRefreshAt: string | null = null;
let lastRefreshError: string | null = null;
let activeProvider = providerKey ? "twelve-data" : "yahoo-finance";

type Instrument = { symbol: string; name: string; type: string; exchange: string };
type Quote = { price: string; change: string; changePercent: string; volume: string | null; marketOpen: boolean | null };

async function createSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS market_quotes (
    symbol VARCHAR(20) PRIMARY KEY, price DECIMAL(20, 8) NOT NULL,
    change_value DECIMAL(20, 8) NOT NULL, change_percent DECIMAL(12, 6) NOT NULL,
    volume BIGINT NULL, market_open BOOLEAN NULL, source VARCHAR(40) NOT NULL,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS market_history (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY, symbol VARCHAR(20) NOT NULL,
    price DECIMAL(20, 8) NOT NULL, source_time DATETIME NULL,
    captured_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_market_history_symbol_time (symbol, captured_at)
  )`);
}

async function getStockCatalog(): Promise<Instrument[]> {
  const response = await fetch(`${stockServiceUrl}/`);
  if (!response.ok) throw new Error(`Stock service returned HTTP ${response.status}`);
  return await response.json() as Instrument[];
}

function seedPriceForSymbol(symbol: string): number {
  const normalized = symbol.toUpperCase();
  if (normalized.startsWith("USD/")) {
    const currencyCode = normalized.replace(/^USD\//, "");
    return Number((fallbackSeedPrices[`${currencyCode}USD`] ?? fallbackSeedPrices[normalized.replace("/", "")] ?? 100).toFixed(4));
  }
  const price = fallbackSeedPrices[normalized] ?? 100;
  return Number(price.toFixed(4));
}

function buildFallbackQuote(symbol: string): Quote {
  const basePrice = seedPriceForSymbol(symbol);
  const hash = Array.from(symbol).reduce((total, char) => total + char.charCodeAt(0), 0);
  const adjusted = basePrice * (1 + ((hash % 23) - 11) / 1000);
  const price = Number(adjusted.toFixed(basePrice < 10 ? 4 : 2));
  const change = Number(((hash % 17) - 8) / 10);
  const changePercent = Number(((change / price) * 100).toFixed(2));
  return {
    price: String(price),
    change: String(change),
    changePercent: String(changePercent),
    volume: String(1_000_000 + (hash % 9_000_000)),
    marketOpen: true,
  };
}

async function fetchQuote(symbol: string): Promise<Quote> {
  if (providerKey) {
    try {
      const url = new URL("https://api.twelvedata.com/quote");
      url.searchParams.set("symbol", symbol);
      url.searchParams.set("apikey", providerKey);
      const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
      if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
      const payload = await response.json() as Record<string, unknown>;
      if (payload.status === "error" || typeof payload.close !== "string") throw new Error(String(payload.message || `No quote for ${symbol}`));
      const price = Number(payload.close);
      if (!Number.isFinite(price) || price <= 0) throw new Error(`Provider returned an invalid price for ${symbol}`);
      activeProvider = "twelve-data";
      return {
        price: String(price), change: String(Number(payload.change || 0)),
        changePercent: String(Number(payload.percent_change || 0)),
        volume: payload.volume ? String(payload.volume) : null,
        marketOpen: payload.is_market_open === "true" ? true : payload.is_market_open === "false" ? false : null,
      };
    } catch (error) {
      console.warn(`Twelve Data quote failed for ${symbol}, falling back to Yahoo Finance:`, error instanceof Error ? error.message : error);
    }
  }

  const yahooSymbols = [symbol, symbol.toUpperCase(), symbol.toLowerCase()];
  const fallbackUrl = new URL("https://query1.finance.yahoo.com/v6/finance/quote");
  fallbackUrl.searchParams.set("symbols", yahooSymbols.filter((value, index, list) => list.indexOf(value) === index).join(","));
  try {
    const response = await fetch(fallbackUrl, { signal: AbortSignal.timeout(12_000) });
    if (!response.ok) throw new Error(`Yahoo Finance returned HTTP ${response.status}`);
    const payload = await response.json() as { quoteResponse?: { result?: Array<Record<string, unknown>> } };
    const quote = payload.quoteResponse?.result?.find((candidate) => typeof candidate.symbol === "string" && yahooSymbols.includes(String(candidate.symbol))) ?? payload.quoteResponse?.result?.[0];
    if (!quote || typeof quote.regularMarketPrice !== "number") throw new Error(`No quote available for ${symbol}`);
    activeProvider = "yahoo-finance";
    return {
      price: String(quote.regularMarketPrice),
      change: String(Number(quote.regularMarketChange ?? 0)),
      changePercent: String(Number(quote.regularMarketChangePercent ?? 0)),
      volume: typeof quote.regularMarketVolume === "number" ? String(quote.regularMarketVolume) : null,
      marketOpen: quote.marketState === "REGULAR" ? true : quote.marketState === "CLOSED" ? false : null,
    };
  } catch (error) {
    console.warn(`Yahoo Finance quote failed for ${symbol}; using built-in fallback data:`, error instanceof Error ? error.message : error);
    activeProvider = "demo-fallback";
    return buildFallbackQuote(symbol);
  }
}

async function fetchRate(symbol: string): Promise<Quote> {
  if (providerKey) {
    try {
      const url = new URL("https://api.twelvedata.com/exchange_rate");
      url.searchParams.set("symbol", symbol);
      url.searchParams.set("apikey", providerKey);
      const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
      if (!response.ok) throw new Error(`Provider returned HTTP ${response.status}`);
      const payload = await response.json() as { rate?: string; status?: string; message?: string };
      if (payload.status === "error" || !payload.rate || !Number.isFinite(Number(payload.rate))) throw new Error(payload.message || `No FX rate for ${symbol}`);
      const [rows] = await pool.execute<RowDataPacket[]>("SELECT price FROM market_quotes WHERE symbol = ?", [symbol]);
      const previous = rows[0] ? Number(rows[0].price) : Number(payload.rate);
      const change = Number(payload.rate) - previous;
      activeProvider = "twelve-data";
      return { price: payload.rate, change: String(change), changePercent: String(previous ? change / previous * 100 : 0), volume: null, marketOpen: null };
    } catch (error) {
      console.warn(`Twelve Data FX rate failed for ${symbol}, falling back to Yahoo Finance:`, error instanceof Error ? error.message : error);
    }
  }

  const currencyCode = symbol.replace(/^USD\//, "").toUpperCase();
  const yahooCandidates = [
    `${currencyCode}USD=X`,
    `USD${currencyCode}=X`,
    `${currencyCode}=X`,
    `${currencyCode.toLowerCase()}=x`,
  ].filter((value, index, list) => value && list.indexOf(value) === index);

  for (const yahooSymbol of yahooCandidates) {
    try {
      const response = await fetch(`https://query1.finance.yahoo.com/v6/finance/quote?symbols=${encodeURIComponent(yahooSymbol)}`, { signal: AbortSignal.timeout(12_000) });
      if (!response.ok) continue;
      const payload = await response.json() as { quoteResponse?: { result?: Array<Record<string, unknown>> } };
      const quote = payload.quoteResponse?.result?.[0];
      if (!quote || typeof quote.regularMarketPrice !== "number") continue;
      const [rows] = await pool.execute<RowDataPacket[]>("SELECT price FROM market_quotes WHERE symbol = ?", [symbol]);
      const previous = rows[0] ? Number(rows[0].price) : Number(quote.regularMarketPrice);
      const change = Number(quote.regularMarketPrice) - previous;
      activeProvider = "yahoo-finance";
      return {
        price: String(quote.regularMarketPrice),
        change: String(change),
        changePercent: String(previous ? change / previous * 100 : 0),
        volume: null,
        marketOpen: null,
      };
    } catch {
      // Try the next candidate symbol.
    }
  }

  const demoRate = buildFallbackQuote(symbol);
  activeProvider = "demo-fallback";
  console.warn(`Yahoo Finance FX rate failed for ${symbol}; using built-in fallback data.`);
  return demoRate;
}

async function updateInstrument(instrument: Instrument) {
  const quote = instrument.type === "currency" ? await fetchRate(instrument.symbol) : await fetchQuote(instrument.symbol);
  const source = activeProvider || "demo-fallback";
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    await connection.execute(
      `INSERT INTO market_quotes (symbol, price, change_value, change_percent, volume, market_open, source)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE price = VALUES(price), change_value = VALUES(change_value),
         change_percent = VALUES(change_percent), volume = VALUES(volume), market_open = VALUES(market_open), source = VALUES(source)`,
      [instrument.symbol, quote.price, quote.change, quote.changePercent, quote.volume, quote.marketOpen, source],
    );
    await connection.execute("INSERT INTO market_history (symbol, price) VALUES (?, ?)", [instrument.symbol, quote.price]);
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally { connection.release(); }
  await publishEvent(createEvent("PRICE_UPDATED", {
    symbol: instrument.symbol, instrumentType: instrument.type, name: instrument.name,
    price: quote.price, change: quote.change, changePercent: quote.changePercent,
    currency: instrument.type === "currency" ? "FX" : "USD", updatedAt: new Date().toISOString(),
  }));
}

async function refreshAll() {
  if (refreshing) return;
  refreshing = true;
  let failures = 0;
  try {
    const instruments = [...await getStockCatalog(), ...FX];
    for (let index = 0; index < instruments.length; index += 1) {
      try { await updateInstrument(instruments[index]); }
      catch (error) { failures += 1; console.error(`Quote update failed for ${instruments[index].symbol}:`, error); }
      if (requestDelay && index < instruments.length - 1) await new Promise((resolve) => setTimeout(resolve, requestDelay));
    }
    await pool.query("DELETE FROM market_history WHERE captured_at < DATE_SUB(NOW(), INTERVAL 90 DAY)");
    lastRefreshAt = new Date().toISOString();
    lastRefreshError = failures ? `${failures} instruments failed to refresh` : null;
  } catch (error) {
    lastRefreshError = error instanceof Error ? error.message : "Market refresh failed";
    console.error("Market refresh failed:", error);
  } finally { refreshing = false; }
}

app.use(express.json({ limit: "16kb" }));
app.get("/", async (_request, response) => {
  try {
    const instruments = [...await getStockCatalog(), ...FX];
    const [rows] = await pool.query<RowDataPacket[]>("SELECT symbol, price, change_value AS `change`, change_percent AS changePercent, volume, market_open AS marketOpen, source, updated_at AS updatedAt FROM market_quotes");
    const bySymbol = new Map(rows.map((row) => [row.symbol, row]));
    response.json(instruments.map((item) => {
      const quote = bySymbol.get(item.symbol);
      return { ...item, price: quote ? Number(quote.price) : null, change: quote ? Number(quote.change) : null,
        changePercent: quote ? Number(quote.changePercent) : null, volume: quote?.volume ? Number(quote.volume) : null,
        marketOpen: quote?.marketOpen ?? null, updatedAt: quote?.updatedAt?.toISOString?.() ?? null, source: quote?.source ?? null };
    }));
  } catch (error) { response.status(503).json({ error: "Market catalog is unavailable" }); }
});

app.get("/internal/quotes/:symbol", async (request, response) => {
  const [rows] = await pool.execute<RowDataPacket[]>("SELECT symbol, price, updated_at AS updatedAt FROM market_quotes WHERE symbol = ?", [request.params.symbol.toUpperCase()]);
  if (!rows[0]) { response.status(404).json({ error: "No market quote available" }); return; }
  response.json({ symbol: rows[0].symbol, price: String(rows[0].price), updatedAt: rows[0].updatedAt });
});

app.get("/:symbol/history", async (request, response) => {
  const hoursByRange: Record<string, number> = { "1D": 24, "1W": 168, "1M": 720 };
  const range = typeof request.query.range === "string" ? request.query.range : "1D";
  const hours = hoursByRange[range] || 24;
  const [rows] = await pool.execute<RowDataPacket[]>(`SELECT price, captured_at AS capturedAt FROM market_history WHERE symbol = ? AND captured_at >= DATE_SUB(NOW(), INTERVAL ${hours} HOUR) ORDER BY captured_at ASC`, [request.params.symbol.toUpperCase()]);
  response.json(rows.map((row) => ({ price: Number(row.price), capturedAt: new Date(row.capturedAt).toISOString() })));
});

app.post("/refresh", async (_request, response) => {
  if (refreshing) { response.status(202).json({ status: "refresh-in-progress" }); return; }
  void refreshAll();
  response.status(202).json({ status: "refresh-started" });
});

app.get("/health", async (_request, response) => {
  try {
    await pool.query("SELECT 1");
    response.json({ status: "ok", service: "market-data", provider: activeProvider || "demo-fallback", refreshing, lastRefreshAt, lastRefreshError, refreshIntervalMs: refreshMs });
  } catch { response.status(503).json({ status: "error", service: "market-data" }); }
});

async function start() {
  await createSchema();
  app.listen(port, () => console.log(`Market Data service listening on ${port}`));
  void refreshAll();
  setInterval(() => void refreshAll(), refreshMs);
}
start().catch((error) => { console.error("Market Data service startup failed:", error); process.exit(1); });