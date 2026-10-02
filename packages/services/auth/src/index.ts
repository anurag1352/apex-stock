import { randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import express from "express";
import type { RowDataPacket } from "mysql2/promise";
import { createEvent, createPool, publishEvent, signAccessToken, signRefreshToken, verifyRefreshToken } from "@apex/common";

const app = express();
const pool = createPool();
const port = Number(process.env.SERVICE_PORT || 4201);
const refreshCookie = "apex_refresh";
app.use(express.json({ limit: "16kb" }));

function getCookie(request: express.Request, name: string): string | undefined {
  return request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith(`${name}=`))?.slice(name.length + 1);
}

function setRefreshCookie(response: express.Response, token: string) {
  response.cookie(refreshCookie, token, {
    httpOnly: true,
    secure: process.env.COOKIE_SECURE === "true",
    sameSite: "lax",
    path: "/api/auth",
    maxAge: 7 * 24 * 60 * 60 * 1000,
  });
}

function parseOutboxEventPayload(payload: unknown) {
  if (typeof payload === "string") return JSON.parse(payload);
  if (payload !== null && typeof payload === "object") return payload;
  throw new Error("Outbox payload is missing or invalid");
}

async function createSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS auth_accounts (
    id CHAR(36) PRIMARY KEY, email VARCHAR(320) NOT NULL UNIQUE,
    password_hash VARCHAR(100) NOT NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS refresh_sessions (
    token_id CHAR(36) PRIMARY KEY, user_id CHAR(36) NOT NULL,
    expires_at DATETIME NOT NULL, revoked_at DATETIME NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_refresh_user (user_id)
  )`);
  await pool.query(`CREATE TABLE IF NOT EXISTS auth_outbox (
    event_id CHAR(36) PRIMARY KEY, payload JSON NOT NULL,
    published_at DATETIME NULL, created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    INDEX idx_auth_outbox_pending (published_at, created_at)
  )`);
}

app.post("/register", async (request, response) => {
  const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
  const password = typeof request.body?.password === "string" ? request.body.password : "";
  const displayName = typeof request.body?.displayName === "string" ? request.body.displayName.trim().slice(0, 80) : "";
  if (!/^\S+@\S+\.\S+$/.test(email) || password.length < 10 || password.length > 128) {
    response.status(400).json({ error: "Enter a valid email and a password between 10 and 128 characters" });
    return;
  }
  const userId = randomUUID();
  const refreshId = randomUUID();
  const refreshToken = signRefreshToken(userId, refreshId);
  const event = createEvent("USER_REGISTERED", { userId, email, displayName });
  const connection = await pool.getConnection();
  try {
    const hash = await bcrypt.hash(password, 12);
    await connection.beginTransaction();
    await connection.execute("INSERT INTO auth_accounts (id, email, password_hash) VALUES (?, ?, ?)", [userId, email, hash]);
    await connection.execute("INSERT INTO refresh_sessions (token_id, user_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY))", [refreshId, userId]);
    await connection.execute("INSERT INTO auth_outbox (event_id, payload) VALUES (?, ?)", [event.id, JSON.stringify(event)]);
    await connection.commit();
    setRefreshCookie(response, refreshToken);
    response.status(201).json({ accessToken: signAccessToken(userId, email), user: { id: userId, email, displayName } });
  } catch (error) {
    await connection.rollback();
    if ((error as { code?: string }).code === "ER_DUP_ENTRY") {
      response.status(409).json({ error: "An account with this email already exists" });
      return;
    }
    console.error("Registration failed:", error);
    response.status(503).json({ error: "Account registration is temporarily unavailable" });
  } finally { connection.release(); }
});

app.post("/login", async (request, response) => {
  const email = typeof request.body?.email === "string" ? request.body.email.trim().toLowerCase() : "";
  const password = typeof request.body?.password === "string" ? request.body.password : "";
  const [rows] = await pool.execute<Array<{ id: string; email: string; password_hash: string } & import("mysql2").RowDataPacket>>(
    "SELECT id, email, password_hash FROM auth_accounts WHERE email = ? LIMIT 1", [email],
  );
  const account = rows[0];
  if (!account || !(await bcrypt.compare(password, account.password_hash))) {
    response.status(401).json({ error: "Email or password is incorrect" });
    return;
  }
  const refreshId = randomUUID();
  await pool.execute("INSERT INTO refresh_sessions (token_id, user_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY))", [refreshId, account.id]);
  setRefreshCookie(response, signRefreshToken(account.id, refreshId));
  response.json({ accessToken: signAccessToken(account.id, account.email), user: { id: account.id, email: account.email } });
});

app.post("/refresh", async (request, response) => {
  const connection = await pool.getConnection();
  try {
    const token = getCookie(request, refreshCookie);
    if (!token) throw new Error("Refresh session is missing");
    const payload = verifyRefreshToken(decodeURIComponent(token));
    const userId = payload.sub!;
    const oldTokenId = payload.jti!;
    await connection.beginTransaction();
    const [rows] = await connection.execute<RowDataPacket[]>(
      "SELECT a.email, s.revoked_at FROM auth_accounts a JOIN refresh_sessions s ON s.user_id = a.id WHERE a.id = ? AND s.token_id = ? AND s.expires_at > NOW() FOR UPDATE",
      [userId, oldTokenId],
    );
    const session = rows[0] as (RowDataPacket & { email: string; revoked_at: Date | null }) | undefined;
    if (!session || session.revoked_at) throw new Error("Refresh session is invalid");
    await connection.execute("UPDATE refresh_sessions SET revoked_at = NOW() WHERE token_id = ? AND revoked_at IS NULL", [oldTokenId]);
    const refreshId = randomUUID();
    await connection.execute("INSERT INTO refresh_sessions (token_id, user_id, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 7 DAY))", [refreshId, userId]);
    await connection.commit();
    setRefreshCookie(response, signRefreshToken(userId, refreshId));
    response.json({ accessToken: signAccessToken(userId, session.email) });
  } catch {
    await connection.rollback();
    response.clearCookie(refreshCookie, { path: "/api/auth" });
    response.status(401).json({ error: "Refresh session has expired; sign in again" });
  } finally { connection.release(); }
});

app.post("/logout", async (request, response) => {
  const token = getCookie(request, refreshCookie);
  if (token) {
    try {
      const payload = verifyRefreshToken(decodeURIComponent(token));
      await pool.execute("UPDATE refresh_sessions SET revoked_at = NOW() WHERE token_id = ?", [payload.jti!]);
    } catch { /* Expired or invalid cookie is already logged out. */ }
  }
  response.clearCookie(refreshCookie, { path: "/api/auth" });
  response.status(204).end();
});

app.get("/health", async (_request, response) => {
  try { await pool.query("SELECT 1"); response.json({ status: "ok", service: "auth" }); }
  catch { response.status(503).json({ status: "error" }); }
});

async function start() {
  await createSchema();
  setInterval(async () => {
    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();
      const [events] = await connection.query<RowDataPacket[]>("SELECT event_id, payload FROM auth_outbox WHERE published_at IS NULL ORDER BY created_at LIMIT 20 FOR UPDATE SKIP LOCKED");
      for (const item of events) {
        await publishEvent(parseOutboxEventPayload(item.payload));
        await connection.execute("UPDATE auth_outbox SET published_at = NOW() WHERE event_id = ?", [item.event_id]);
      }
      await connection.commit();
    } catch (error) { await connection.rollback(); console.error("Auth event outbox publish failed:", error); }
    finally { connection.release(); }
  }, 500);
  app.listen(port, () => console.log(`Auth service listening on ${port}`));
}
start().catch((error) => { console.error("Auth service startup failed:", error); process.exit(1); });