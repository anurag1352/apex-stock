import dotenv from "dotenv";
import jwt, { JwtPayload } from "jsonwebtoken";
import { Kafka, Producer, EachMessagePayload } from "kafkajs";
import mysql, { Pool } from "mysql2/promise";

dotenv.config({ path: process.env.ENV_FILE });

export type DomainEventType =
  | "USER_REGISTERED"
  | "PRICE_UPDATED"
  | "ORDER_CREATED"
  | "ORDER_ACCEPTED"
  | "ORDER_REJECTED"
  | "ORDER_EXECUTED"
  | "ORDER_FILLED"
  | "ORDER_CANCELLED"
  | "PORTFOLIO_UPDATED";

export type DomainEvent<T = Record<string, unknown>> = {
  id: string;
  type: DomainEventType;
  version: 1;
  occurredAt: string;
  correlationId: string;
  data: T;
};

const kafka = new Kafka({
  clientId: process.env.KAFKA_CLIENT_ID || process.env.SERVICE_NAME || "apex-service",
  brokers: (process.env.KAFKA_BROKERS || "localhost:9092").split(","),
  retry: { initialRetryTime: 500, retries: 8 },
});

let producer: Producer | undefined;

export function createPool(): Pool {
  const database = process.env.DB_NAME;
  if (!database) throw new Error("DB_NAME must be configured for this service");
  return mysql.createPool({
    host: process.env.MYSQL_HOST || "localhost",
    port: Number(process.env.MYSQL_PORT || 3306),
    database,
    user: process.env.DB_USER || "apex_services",
    password: process.env.DB_PASSWORD || "apex-service-dev-password",
    waitForConnections: true,
    connectionLimit: 8,
    decimalNumbers: false,
  });
}

export async function publishEvent(event: DomainEvent): Promise<void> {
  if (!producer) {
    producer = kafka.producer({ idempotent: true, maxInFlightRequests: 1 });
    await producer.connect();
  }
  await producer.send({
    topic: process.env.KAFKA_TOPIC || "apex.domain.events.v1",
    acks: -1,
    messages: [{ key: event.type, value: JSON.stringify(event) }],
  });
}

export async function consumeEvents(
  groupId: string,
  handler: (event: DomainEvent, message: EachMessagePayload) => Promise<void>,
): Promise<void> {
  const consumer = kafka.consumer({ groupId });
  await consumer.connect();
  await consumer.subscribe({ topic: process.env.KAFKA_TOPIC || "apex.domain.events.v1", fromBeginning: false });
  await consumer.run({
    eachMessage: async (message) => {
      if (!message.message.value) return;
      const event = JSON.parse(message.message.value.toString()) as DomainEvent;
      await handler(event, message);
    },
  });
}

export function createEvent<T>(type: DomainEventType, data: T, correlationId: string = crypto.randomUUID()): DomainEvent<T> {
  return { id: crypto.randomUUID(), type, version: 1, occurredAt: new Date().toISOString(), correlationId, data };
}

export function signAccessToken(userId: string, email: string): string {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) throw new Error("JWT_ACCESS_SECRET must be configured");
  return jwt.sign({ sub: userId, email, token_use: "access" }, secret, { expiresIn: "15m", issuer: "apex-auth" });
}

export function signRefreshToken(userId: string, tokenId: string): string {
  const secret = process.env.JWT_REFRESH_SECRET;
  if (!secret) throw new Error("JWT_REFRESH_SECRET must be configured");
  return jwt.sign({ sub: userId, jti: tokenId, token_use: "refresh" }, secret, { expiresIn: "7d", issuer: "apex-auth" });
}

export function verifyRefreshToken(token: string): JwtPayload {
  const secret = process.env.JWT_REFRESH_SECRET;
  if (!secret) throw new Error("JWT_REFRESH_SECRET must be configured");
  const payload = jwt.verify(token, secret, { issuer: "apex-auth" });
  if (typeof payload === "string" || payload.token_use !== "refresh" || typeof payload.sub !== "string" || typeof payload.jti !== "string") {
    throw new Error("Invalid refresh token");
  }
  return payload;
}

export function verifyAccessToken(token: string): JwtPayload {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) throw new Error("JWT_ACCESS_SECRET must be configured");
  const payload = jwt.verify(token, secret, { issuer: "apex-auth" });
  if (typeof payload === "string" || payload.token_use !== "access" || typeof payload.sub !== "string") {
    throw new Error("Invalid access token");
  }
  return payload;
}

export function signRealtimeTicket(userId: string): string {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) throw new Error("JWT_ACCESS_SECRET must be configured");
  return jwt.sign({ token_use: "realtime" }, secret, { subject: userId, expiresIn: "30s", issuer: "apex-auth", jwtid: crypto.randomUUID() });
}

export function verifyRealtimeTicket(token: string): JwtPayload {
  const secret = process.env.JWT_ACCESS_SECRET;
  if (!secret) throw new Error("JWT_ACCESS_SECRET must be configured");
  const payload = jwt.verify(token, secret, { issuer: "apex-auth" });
  if (typeof payload === "string" || payload.token_use !== "realtime" || typeof payload.sub !== "string" || typeof payload.jti !== "string") {
    throw new Error("Invalid realtime ticket");
  }
  return payload;
}

export function requireUserId(value: string | undefined): string {
  if (!value) throw new Error("Authenticated user context is required");
  return value;
}