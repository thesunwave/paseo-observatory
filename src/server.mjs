import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";

import { ObservatoryCollector } from "./collector/collector.mjs";

const host = process.env.HOST ?? "127.0.0.1";
const port = Number.parseInt(process.env.PORT ?? "4173", 10);
const paseoHost = process.env.PASEO_HOST ?? "127.0.0.1:6767";
const refreshMs = Math.max(1000, Number.parseInt(process.env.REFRESH_MS ?? "2500", 10));
const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const collector = new ObservatoryCollector({ paseoHost });

const contentTypes = new Map([
  [".html", "text/html; charset=utf-8"],
  [".css", "text/css; charset=utf-8"],
  [".js", "text/javascript; charset=utf-8"],
  [".json", "application/json; charset=utf-8"],
  [".svg", "image/svg+xml"],
]);

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(`${JSON.stringify(payload)}\n`);
}

async function serveStatic(request, response, pathname) {
  const requested = pathname === "/" ? "/index.html" : pathname;
  const safePath = normalize(requested).replace(/^(\.\.(\/|\\|$))+/, "");
  const filePath = join(publicDir, safePath);
  if (!filePath.startsWith(publicDir)) {
    response.writeHead(403).end("Forbidden");
    return;
  }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) throw new Error("not a file");
  } catch {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("Not found\n");
    return;
  }

  response.writeHead(200, {
    "content-type": contentTypes.get(extname(filePath)) ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(filePath).pipe(response);
}

function sseWrite(response, event, payload) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function streamTelemetry(request, response, url) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  response.write("retry: 2000\n\n");

  const requestedRunId = url.searchParams.get("runId");
  let closed = false;
  let timer = null;
  let collecting = false;

  const tick = async () => {
    if (closed || collecting) return;
    collecting = true;
    try {
      const snapshot = await collector.collect(requestedRunId);
      sseWrite(response, "snapshot", snapshot);
    } catch (error) {
      sseWrite(response, "collector_error", {
        observedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : String(error),
      });
    } finally {
      collecting = false;
      if (!closed) timer = setTimeout(tick, refreshMs);
    }
  };

  request.on("close", () => {
    closed = true;
    if (timer) clearTimeout(timer);
  });
  await tick();
}

const server = createServer(async (request, response) => {
  const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);

  if (url.pathname === "/api/health") {
    sendJson(response, 200, {
      ok: true,
      service: "paseo-observatory",
      paseoHost,
      refreshMs,
    });
    return;
  }

  if (url.pathname === "/api/snapshot") {
    try {
      const snapshot = await collector.collect(url.searchParams.get("runId"));
      sendJson(response, 200, snapshot);
    } catch (error) {
      sendJson(response, 503, {
        status: "collector_error",
        observedAt: new Date().toISOString(),
        message: error instanceof Error ? error.message : String(error),
      });
    }
    return;
  }

  if (url.pathname === "/api/events") {
    await streamTelemetry(request, response, url);
    return;
  }

  await serveStatic(request, response, url.pathname);
});

server.listen(port, host, () => {
  console.log(`Paseo Observatory: http://${host}:${port}`);
  console.log(`Paseo control plane: ${paseoHost}`);
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    collector.close();
    server.close(() => process.exit(0));
  });
}
