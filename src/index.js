const MAX_UPLOAD_BYTES = 95 * 1024 * 1024;
const JSON_HEADERS = {
  "content-type": "application/json; charset=utf-8",
  "cache-control": "no-store"
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: JSON_HEADERS });
}

function isBlockedHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal") ||
    host === "::1" ||
    host.startsWith("fc") ||
    host.startsWith("fd") ||
    host.startsWith("fe80:")
  ) return true;

  const parts = host.split(".");
  if (parts.length === 4 && parts.every((part) => /^\d+$/.test(part))) {
    const [a, b] = parts.map(Number);
    if (
      a === 0 || a === 10 || a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127)
    ) return true;
  }
  return false;
}

function safeHttpUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Digite um endereço válido.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Só aceitamos links HTTP ou HTTPS.");
  }
  if (url.username || url.password || isBlockedHost(url.hostname)) {
    throw new Error("Esse endereço não pode ser consultado.");
  }
  return url;
}

async function readTextLimited(response, limit) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let output = "";
  let total = 0;

  while (true) {
    const item = await reader.read();
    if (item.done) break;
    total += item.value.byteLength;
    if (total > limit) {
      output += decoder.decode(item.value.slice(0, Math.max(0, limit - (total - item.value.byteLength))), { stream: true });
      await reader.cancel();
      break;
    }
    output += decoder.decode(item.value, { stream: true });
  }
  output += decoder.decode();
  return output;
}

function findMediaCandidates(html, baseUrl) {
  const found = [];
  const seen = new Set();
  const tags = html.matchAll(/<(video|audio|source|meta|a)\b[^>]*>/gi);

  for (const match of tags) {
    const tagName = match[1].toLowerCase();
    const tag = match[0];
    const attrs = {};
    for (const item of tag.matchAll(/([^\s=<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attrs[item[1].toLowerCase()] = item[2] ?? item[3] ?? item[4] ?? "";
    }

    const candidates = [];
    if (["video", "audio", "source"].includes(tagName)) {
      candidates.push(attrs.src, attrs["data-src"]);
    } else if (tagName === "meta") {
      const key = (attrs.property || attrs.name || "").toLowerCase();
      if (/^(og:video|og:audio|twitter:player:stream)/.test(key)) {
        candidates.push(attrs.content);
      }
    } else if (tagName === "a") {
      const href = attrs.href || "";
      if (/\.(mp4|m4v|mov|webm|mp3|m4a|wav|ogg|pdf|zip)(?:$|[?#])/i.test(href)) {
        candidates.push(href);
      }
    }

    for (const candidate of candidates) {
      if (!candidate || candidate.startsWith("data:") || candidate.startsWith("javascript:")) continue;
      try {
        const absolute = new URL(candidate, baseUrl);
        if (
          (absolute.protocol === "http:" || absolute.protocol === "https:") &&
          !isBlockedHost(absolute.hostname) &&
          !seen.has(absolute.href)
        ) {
          seen.add(absolute.href);
          found.push(absolute.href);
        }
      } catch {
        // Ignore malformed page references.
      }
    }
  }
  return found.slice(0, 10);
}

async function extractLinks(request) {
  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Envie um JSON válido com o campo url." }, 400);
  }

  let current;
  try {
    current = safeHttpUrl(String(body.url || "").trim());
  } catch (error) {
    return json({ ok: false, error: error.message }, 400);
  }

  let response;
  try {
    for (let hop = 0; hop <= 5; hop++) {
      response = await fetch(current.href, {
        method: "GET",
        redirect: "manual",
        headers: {
          "user-agent": "LinkBox/1.0 (+link extractor)",
          "accept": "text/html,application/xhtml+xml,video/*,audio/*,application/octet-stream,*/*;q=0.8"
        }
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || hop === 5) {
          return json({ ok: false, error: "O site redirecionou muitas vezes ou bloqueou a consulta." }, 502);
        }
        try {
          current = safeHttpUrl(new URL(location, current).href);
        } catch (error) {
          return json({ ok: false, error: error.message }, 400);
        }
        continue;
      }
      break;
    }
  } catch {
    return json({ ok: false, error: "Não foi possível consultar esse site. Ele pode bloquear acessos automáticos." }, 502);
  }

  if (!response || !response.ok) {
    return json({ ok: false, error: "O site respondeu com erro HTTP " + (response?.status || "desconhecido") + "." }, 502);
  }

  const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const isMedia = /^(video\/|audio\/|image\/|application\/(octet-stream|pdf|zip|x-rar|vnd\.|msword))/.test(contentType);
  if (isMedia) {
    return json({
      ok: true,
      finalUrl: current.href,
      contentType,
      directUrl: current.href,
      candidates: [current.href],
      message: "O próprio endereço já aponta para um arquivo."
    });
  }

  if (!/(text\/html|application\/xhtml\+xml)/.test(contentType)) {
    return json({
      ok: true,
      finalUrl: current.href,
      contentType: contentType || "desconhecido",
      candidates: [],
      message: "A página respondeu, mas não revelou um arquivo direto reconhecível."
    });
  }

  let html = "";
  try {
    html = await readTextLimited(response, 1024 * 1024);
  } catch {
    return json({ ok: false, error: "Não foi possível ler o conteúdo dessa página." }, 502);
  }

  const candidates = findMediaCandidates(html, current.href);
  return json({
    ok: true,
    finalUrl: current.href,
    contentType,
    candidates,
    message: candidates.length
      ? "Encontramos possíveis endereços de mídia na página."
      : "Nenhum arquivo direto foi encontrado. Alguns sites escondem a mídia, exigem login ou carregam o conteúdo por JavaScript."
  });
}

function cleanFilename(value) {
  let name = String(value || "arquivo").split(/[\\/]/).pop();
  name = name.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  name = name.replace(/[^\p{L}\p{N}._ -]/gu, "_").slice(0, 120);
  return name || "arquivo";
}

function makeId() {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

async function uploadFile(request, env) {
  if (!env.FILES) {
    return json({
      ok: false,
      code: "storage_not_configured",
      error: "O armazenamento R2 ainda não foi conectado ao Worker."
    }, 503);
  }
  if (!env.UPLOAD_KEY) {
    return json({
      ok: false,
      code: "upload_key_missing",
      error: "O responsável pelo projeto precisa configurar o segredo UPLOAD_KEY antes de liberar envios."
    }, 503);
  }
  if (request.headers.get("x-upload-key") !== env.UPLOAD_KEY) {
    return json({ ok: false, error: "Chave de envio incorreta." }, 403);
  }

  const size = Number(request.headers.get("content-length") || 0);
  if (!request.body) return json({ ok: false, error: "Nenhum arquivo foi enviado." }, 400);
  if (size > MAX_UPLOAD_BYTES) {
    return json({ ok: false, error: "O limite por arquivo é de 95 MB." }, 413);
  }

  const filename = cleanFilename(new URL(request.url).searchParams.get("filename"));
  const contentType = (request.headers.get("content-type") || "application/octet-stream").slice(0, 150);
  const id = makeId();

  try {
    await env.FILES.put("files/" + id, request.body, {
      httpMetadata: { contentType },
      customMetadata: { originalName: filename }
    });
  } catch {
    return json({ ok: false, error: "O R2 não conseguiu salvar o arquivo. Confira o bucket e os limites da conta." }, 502);
  }

  const base = new URL(request.url).origin;
  return json({
    ok: true,
    id,
    filename,
    size,
    shortUrl: base + "/d/" + id
  }, 201);
}

async function downloadFile(id, env) {
  if (!/^[A-Za-z0-9_-]{16}$/.test(id)) {
    return new Response("Link inválido.", { status: 404 });
  }
  if (!env.FILES) return new Response("O armazenamento ainda não está configurado.", { status: 503 });

  let object;
  try {
    object = await env.FILES.get("files/" + id);
  } catch {
    return new Response("Não foi possível consultar o arquivo.", { status: 502 });
  }
  if (!object) return new Response("Arquivo não encontrado ou link expirado.", { status: 404 });

  const filename = cleanFilename(object.customMetadata?.originalName || "arquivo");
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("content-type", object.httpMetadata?.contentType || "application/octet-stream");
  headers.set("content-disposition", "attachment; filename*=UTF-8''" + encodeURIComponent(filename));
  headers.set("cache-control", "private, no-store");
  headers.set("x-content-type-options", "nosniff");
  return new Response(object.body, { headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/health" && request.method === "GET") {
      return json({
        ok: true,
        storageConfigured: Boolean(env.FILES),
        uploadEnabled: Boolean(env.FILES && env.UPLOAD_KEY),
        maxUploadMB: 95
      });
    }

    if (path === "/api/extract" && request.method === "POST") {
      return extractLinks(request);
    }

    if (path === "/api/upload" && request.method === "POST") {
      return uploadFile(request, env);
    }

    if (path.startsWith("/d/") && request.method === "GET") {
      return downloadFile(path.slice(3), env);
    }

    if (path.startsWith("/api/")) {
      return json({ ok: false, error: "Rota não encontrada." }, 404);
    }

    const assetResponse = await env.ASSETS.fetch(request);
    const headers = new Headers(assetResponse.headers);
    headers.set("x-content-type-options", "nosniff");
    headers.set("referrer-policy", "strict-origin-when-cross-origin");
    headers.set("x-frame-options", "DENY");
    return new Response(assetResponse.body, {
      status: assetResponse.status,
      statusText: assetResponse.statusText,
      headers
    });
  }
};