import { createServer } from "node:http";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, writeFile, stat, unlink, rename, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import worker from "./src/index.js";

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.resolve(ROOT, "public");
const PORT = Number(process.env.PORT || 3000);
const STORAGE_DIR = process.env.LINKBOX_STORAGE_DIR || path.join("/tmp", "linkbox-uploads");
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_STORAGE_BYTES = 250 * 1024 * 1024;
const RETENTION_MS = 24 * 60 * 60 * 1000;

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

await mkdir(STORAGE_DIR, { recursive: true });
let storedBytes = 0;

async function removeExpiredFiles() {
  const now = Date.now();
  let total = 0;
  for (const name of await readdir(STORAGE_DIR).catch(() => [])) {
    if (!name.endsWith(".json")) continue;
    const metaPath = path.join(STORAGE_DIR, name);
    const dataPath = path.join(STORAGE_DIR, name.slice(0, -5) + ".bin");
    try {
      const meta = JSON.parse(await readFile(metaPath, "utf8"));
      const info = await stat(dataPath);
      if (!meta.createdAt || now - meta.createdAt > RETENTION_MS) {
        await unlink(dataPath).catch(() => {});
        await unlink(metaPath).catch(() => {});
      } else {
        total += info.size;
      }
    } catch {
      await unlink(metaPath).catch(() => {});
      await unlink(dataPath).catch(() => {});
    }
  }
  storedBytes = total;
}

await removeExpiredFiles();

function validIdFromKey(key) {
  const match = /^files\/([A-Za-z0-9_-]{16})$/.exec(String(key));
  if (!match) throw new Error("Invalid storage key");
  return match[1];
}

const localFiles = {
  async put(key, body, options = {}) {
    const id = validIdFromKey(key);
    const dataPath = path.join(STORAGE_DIR, id + ".bin");
    const metaPath = path.join(STORAGE_DIR, id + ".json");
    const tempPath = path.join(STORAGE_DIR, id + ".part");
    let size = 0;

    const counter = new Transform({
      transform(chunk, encoding, callback) {
        size += chunk.length;
        if (size > MAX_UPLOAD_BYTES) {
          const error = new Error("File exceeds allowed size");
          error.code = "FILE_TOO_LARGE";
          callback(error);
          return;
        }
        if (storedBytes + size > MAX_STORAGE_BYTES) {
          const error = new Error("Temporary storage is full");
          error.code = "STORAGE_FULL";
          callback(error);
          return;
        }
        callback(null, chunk);
      }
    });

    try {
      await pipeline(Readable.fromWeb(body), counter, createWriteStream(tempPath, { flags: "wx" }));
      if (size < 1) throw new Error("Empty file");
      const meta = {
        createdAt: Date.now(),
        size,
        httpMetadata: options.httpMetadata || {},
        customMetadata: options.customMetadata || {}
      };
      await rename(tempPath, dataPath);
      await writeFile(metaPath, JSON.stringify(meta), { flag: "wx" });
      storedBytes += size;
      return { size };
    } catch (error) {
      await unlink(tempPath).catch(() => {});
      await unlink(dataPath).catch(() => {});
      await unlink(metaPath).catch(() => {});
      throw error;
    }
  },

  async get(key) {
    const id = validIdFromKey(key);
    const dataPath = path.join(STORAGE_DIR, id + ".bin");
    const metaPath = path.join(STORAGE_DIR, id + ".json");
    let meta;
    try {
      meta = JSON.parse(await readFile(metaPath, "utf8"));
      if (!meta.createdAt || Date.now() - meta.createdAt > RETENTION_MS) {
        storedBytes = Math.max(0, storedBytes - Number(meta.size || 0));
        await unlink(dataPath).catch(() => {});
        await unlink(metaPath).catch(() => {});
        return null;
      }
      await stat(dataPath);
    } catch {
      return null;
    }

    return {
      body: Readable.toWeb(createReadStream(dataPath)),
      httpMetadata: meta.httpMetadata || {},
      customMetadata: meta.customMetadata || {},
      writeHttpMetadata(headers) {
        if (this.httpMetadata.contentType) headers.set("content-type", this.httpMetadata.contentType);
      }
    };
  }
};

// Render uses temporary instance storage. Files are private to their random IDs and expire after 24 hours.
const env = {
  NODE_EPHEMERAL_STORAGE: true,
  FILES: localFiles,
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

const uploadRequests = new Map();
function uploadAllowed(ip) {
  const now = Date.now();
  const recent = (uploadRequests.get(ip) || []).filter((time) => now - time < 60 * 60 * 1000);
  if (recent.length >= 5) {
    uploadRequests.set(ip, recent);
    return false;
  }
  recent.push(now);
  uploadRequests.set(ip, recent);
  return true;
}

const server = createServer(async (incoming, outgoing) => {
  try {
    const method = incoming.method || "GET";
    const host = incoming.headers.host || "localhost";
    const requestUrl = new URL(incoming.url || "/", "http://" + host).toString();

    if (method === "POST" && new URL(requestUrl).pathname === "/api/upload") {
      const forwarded = String(incoming.headers["x-forwarded-for"] || "").split(",")[0].trim();
      const ip = forwarded || incoming.socket.remoteAddress || "unknown";
      if (!uploadAllowed(ip)) {
        outgoing.writeHead(429, {
          "content-type": "application/json; charset=utf-8",
          "retry-after": "3600",
          "cache-control": "no-store"
        });
        outgoing.end(JSON.stringify({
          ok: false,
          error: "Limite de segurança: este endereço já enviou 5 arquivos na última hora. Tente novamente mais tarde."
        }));
        return;
      }
    }

    const init = { method, headers: incoming.headers };
    if (method !== "GET" && method !== "HEAD") {
      init.body = Readable.toWeb(incoming);
      init.duplex = "half";
    }

    const request = new Request(requestUrl, init);
    const response = await worker.fetch(request, env);

    outgoing.statusCode = response.status;
    if (response.statusText) outgoing.statusMessage = response.statusText;
    for (const [name, value] of response.headers) outgoing.setHeader(name, value);

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

setInterval(() => { removeExpiredFiles().catch((error) => console.error("Limpeza de arquivos expirados falhou:", error)); }, 5 * 60 * 1000).unref();

server.listen(PORT, "0.0.0.0", () => {
  console.log("LinkBox ativo na porta " + PORT);
  console.log("Armazenamento temporário ativo: 50 MB por arquivo, 250 MB totais, expiração em 24 horas.");
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});
