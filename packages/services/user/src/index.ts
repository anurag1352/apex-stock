import express from "express";
import { consumeEvents, createPool, requireUserId } from "@apex/common";

const app = express();
const pool = createPool();
const port = Number(process.env.SERVICE_PORT || 4202);
app.use(express.json({ limit: "16kb" }));

async function createSchema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS user_profiles (
    user_id CHAR(36) PRIMARY KEY, email VARCHAR(320) NOT NULL,
    display_name VARCHAR(80) NOT NULL DEFAULT '', created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
  )`);
}

void consumeEvents("apex-user-v1", async (event) => {
  if (event.type !== "USER_REGISTERED") return;
  const data = event.data as { userId: string; email: string; displayName?: string };
  await pool.execute(
    `INSERT INTO user_profiles (user_id, email, display_name) VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE email = VALUES(email), display_name = VALUES(display_name)`,
    [data.userId, data.email, data.displayName || ""],
  );
}).catch((error) => console.error("User event consumer failed:", error));

app.get("/me", async (request, response) => {
  const userId = requireUserId(request.header("x-user-id"));
  const email = request.header("x-user-email") || "";
  await pool.execute("INSERT IGNORE INTO user_profiles (user_id, email) VALUES (?, ?)", [userId, email]);
  const [rows] = await pool.execute("SELECT user_id AS id, email, display_name AS displayName, created_at AS createdAt FROM user_profiles WHERE user_id = ?", [userId]);
  response.json((rows as Array<Record<string, unknown>>)[0]);
});

app.put("/me", async (request, response) => {
  const userId = requireUserId(request.header("x-user-id"));
  const displayName = typeof request.body?.displayName === "string" ? request.body.displayName.trim() : "";
  if (displayName.length < 1 || displayName.length > 80) {
    response.status(400).json({ error: "Display name must be between 1 and 80 characters" });
    return;
  }
  await pool.execute("UPDATE user_profiles SET display_name = ? WHERE user_id = ?", [displayName, userId]);
  response.json({ id: userId, displayName });
});

app.get("/health", async (_request, response) => {
  try { await pool.query("SELECT 1"); response.json({ status: "ok", service: "user" }); }
  catch { response.status(503).json({ status: "error" }); }
});

async function start() { await createSchema(); app.listen(port, () => console.log(`User service listening on ${port}`)); }
start().catch((error) => { console.error("User service startup failed:", error); process.exit(1); });