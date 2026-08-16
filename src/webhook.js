import { createServer } from "node:http";

async function readJson(request, maxBytes) {
  const chunks = [];
  let length = 0;

  for await (const chunk of request) {
    length += chunk.length;
    if (length > maxBytes) {
      const error = new Error("Request body is too large");
      error.statusCode = 413;
      throw error;
    }
    chunks.push(chunk);
  }

  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    const error = new Error("Request body must be valid JSON");
    error.statusCode = 400;
    throw error;
  }
}

function sendJson(response, statusCode, body) {
  const content = JSON.stringify(body);
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(content),
  });
  response.end(content);
}

export function createWebhookServer(options) {
  const {
    ingestor,
    queue,
    webhookPath = "/telegram/webhook",
    secretToken = "",
    maxBodyBytes = 1_000_000,
  } = options;

  if (!ingestor || !queue) {
    throw new TypeError("createWebhookServer requires ingestor and queue");
  }

  return createServer(async (request, response) => {
    const url = new URL(request.url, "http://localhost");

    if (request.method === "GET" && url.pathname === "/health") {
      return sendJson(response, 200, { ok: true });
    }

    if (request.method !== "POST" || url.pathname !== webhookPath) {
      return sendJson(response, 404, { ok: false, error: "not_found" });
    }

    if (
      secretToken &&
      request.headers["x-telegram-bot-api-secret-token"] !== secretToken
    ) {
      return sendJson(response, 401, { ok: false, error: "unauthorized" });
    }

    try {
      const update = await readJson(request, maxBodyBytes);
      const result = ingestor.ingest(update);

      // Processing happens outside the request. The response follows only the
      // durable raw_log + queue insert, not downstream work.
      sendJson(response, 200, { ok: true, ...result });
      setImmediate(() => queue.wake());
    } catch (error) {
      const statusCode = error.statusCode ?? 500;
      sendJson(response, statusCode, {
        ok: false,
        error: statusCode === 500 ? "internal_error" : error.message,
      });
    }
  });
}
