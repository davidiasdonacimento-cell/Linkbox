import { createServer } from "node:http";
import { Readable } from "node:stream";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import worker from "./src/index.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(ROOT, "public");
const PORT = Number(process.env.PORT || 3000);

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon"
};

const env = {
  ASSETS: {
    async fetch(request) {
      let relativePath;
      try {
        const pathname = new URL(request.url).pathname;
        relativePath = pathname === "/" ? "index.html" : decodeURIComponent(pathname.slice(1));
      } catch {
        return new Response("Endereço inválido.", { status: 400 });
      }

      const filePath = path.resolve(PUBLIC_DIR, relativePath);
      if (filePath !== PUBLIC_DIR && !filePath.startsWith(PUBLIC_DIR + path.sep)) {
        return new Response("Arquivo não encontrado.", { status: 404 });
      }

      try {
        const content = await readFile(filePath);
        const contentType = MIME_TYPES[path.extname(filePath).toLowerCase()] || "application/octet-stream";
        return new Response(content, {
          status: 200,
          headers: {
            "content-type": contentType,
            "cache-control": "no-cache"
          }
        });
      } catch {
        return new Response("Arquivo não encontrado.", { status: 404 });
      }
    }
  }
};

const server = createServer(async (incoming, outgoing) => {
  try {
    const host = incoming.headers.host || "localhost";
    const requestUrl = new URL(incoming.url || "/", `http://${host}`).toString();
    const method = incoming.method || "GET";
    const init = {
      method,
      headers: incoming.headers
    };

    if (method !== "GET" && method !== "HEAD") {
      init.body = Readable.toWeb(incoming);
      init.duplex = "half";
    }

    const request = new Request(requestUrl, init);
    const response = await worker.fetch(request, env);

    outgoing.statusCode = response.status;
    if (response.statusText) outgoing.statusMessage = response.statusText;
    for (const [name, value] of response.headers) {
      outgoing.setHeader(name, value);
    }

    if (method === "HEAD" || !response.body) {
      outgoing.end();
      return;
    }

    Readable.fromWeb(response.body)
      .on("error", (error) => outgoing.destroy(error))
      .pipe(outgoing);
  } catch (error) {
    console.error("Falha ao processar requisição:", error);
    if (!outgoing.headersSent) {
      outgoing.writeHead(500, { "content-type": "application/json; charset=utf-8" });
      outgoing.end(JSON.stringify({ ok: false, error: "Erro interno do servidor." }));
    } else {
      outgoing.destroy(error);
    }
  }
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`LinkBox ativo na porta ${PORT}`);
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
