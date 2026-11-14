const MAX_UPLOAD_BYTES = 50 * 1024 * 1024;
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
  const extensions = /\.(mp4|m4v|mov|webm|mkv|avi|flv|3gp|mp3|m4a|wav|ogg|m3u8|mpd|m4s|ts|pdf|zip|rar)(?:$|[?#])/i;
  const add = (value, requireMediaExtension = false) => {
    if (!value) return;
    const candidate = String(value)
      .replace(/&amp;/gi, "&")
      .replace(/\\u0026/gi, "&")
      .replace(/\\u003d/gi, "=")
      .replace(/\\\//g, "/")
      .trim()
      .replace(/^["']|["']$/g, "");
    if (!candidate || /^(data:|blob:|javascript:)/i.test(candidate)) return;
    try {
      const absolute = new URL(candidate, baseUrl);
      if (
        (absolute.protocol === "http:" || absolute.protocol === "https:") &&
        !isBlockedHost(absolute.hostname) &&
        (!requireMediaExtension || extensions.test(absolute.href)) &&
        !seen.has(absolute.href)
      ) {
        seen.add(absolute.href);
        found.push(absolute.href);
      }
    } catch {
      // Ignore malformed page references.
    }
  };

  const tags = html.matchAll(/<(video|audio|source|meta|a)\b[^>]*>/gi);
  for (const match of tags) {
    const tagName = match[1].toLowerCase();
    const tag = match[0];
    const attrs = {};
    for (const item of tag.matchAll(/([^\s=<>/]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
      attrs[item[1].toLowerCase()] = item[2] ?? item[3] ?? item[4] ?? "";
    }

    if (["video", "audio", "source"].includes(tagName)) {
      add(attrs.src);
      add(attrs["data-src"]);
      add(attrs["data-url"]);
      add(attrs["data-original"]);
    } else if (tagName === "meta") {
      const key = (attrs.property || attrs.name || "").toLowerCase();
      if (/^(og:video|og:audio|twitter:player:stream)/.test(key)) add(attrs.content);
    } else if (tagName === "a") {
      add(attrs.href, true);
    }
  }

  // Some public pages expose media URLs inside JSON or script tags instead of media elements.
  const normalized = html
    .replace(/\\u0026/gi, "&")
    .replace(/\\u003d/gi, "=")
    .replace(/\\\//g, "/")
    .replace(/&amp;/gi, "&");
  const rawUrlPattern = /(?:https?:)?\/\/[^"'<>\\\s]+?\.(?:mp4|m4v|mov|webm|mkv|avi|flv|3gp|mp3|m4a|wav|ogg|m3u8|mpd|m4s|ts)(?:[?#][^"'<>\\\s]*)?/gi;
  for (const match of normalized.matchAll(rawUrlPattern)) add(match[0], true);

  const propertyPattern = /(?:["']?(?:file|src|videoUrl|contentUrl|downloadUrl)["']?)\s*[:=]\s*["']([^"']+)["']/gi;
  for (const match of normalized.matchAll(propertyPattern)) add(match[1], true);

  return found.slice(0, 20);
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
          "accept": "text/html,application/xhtml+xml,video/*,audio/*,application/vnd.apple.mpegurl,application/dash+xml,application/octet-stream,*/*;q=0.8",
          "accept-language": "pt-BR,pt;q=0.9,en;q=0.8"
        },
        signal: AbortSignal.timeout(15000)
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (!location || hop === 5) {
          await response.body?.cancel().catch(() => {});
          return json({ ok: false, error: "O site redirecionou muitas vezes ou bloqueou a consulta." }, 502);
        }
        await response.body?.cancel().catch(() => {});
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
    const status = response?.status || 502;
    if (status === 429) {
      const retryAfter = response.headers.get("retry-after");
      const waitText = retryAfter ? " Tente novamente após " + retryAfter + " (valor informado pelo site)." : " Aguarde um pouco antes de tentar novamente.";
      return json({ ok: false, code: "source_rate_limited", retryAfter, error: "O site de origem limitou as consultas (HTTP 429)." + waitText }, 429);
    }
    if (status === 401 || status === 403) {
      return json({ ok: false, error: "O site de origem exige acesso autorizado ou bloqueou a consulta (HTTP " + status + "). O LinkBox não contorna login ou proteção." }, 502);
    }
    return json({ ok: false, error: "O site respondeu com erro HTTP " + status + "." }, status === 404 ? 404 : 502);
  }

  const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  const isMedia = /^(video\/|audio\/|image\/|application\/(octet-stream|pdf|zip|x-rar|vnd\.|msword|x-mpegurl|dash\+xml))/.test(contentType);
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

function parseExpiry(value) {
  const input = String(value || "24h").trim().toLowerCase();
  const match = /^(\d{1,4})(minutos|minuto|mins|min|m|horas|hora|hr|h)$/.exec(input.replace(/\s+/g, ""));
  if (!match) return null;
  const amount = Number(match[1]);
  const unit = match[2] === "h" || match[2] === "hr" || match[2].startsWith("hora") ? "h" : "m";
  const minutes = amount * (unit === "h" ? 60 : 1);
  if (!Number.isSafeInteger(minutes) || minutes < 1 || minutes > 24 * 60) return null;
  return minutes * 60 * 1000;
}

async function uploadFile(request, env) {
  if (!env.FILES) {
    return json({
      ok: false,
      code: "storage_not_configured",
      error: "O armazenamento R2 ainda não foi conectado ao Worker."
    }, 503);
  }
  const temporaryMode = Boolean(env.NODE_EPHEMERAL_STORAGE);
  if (!temporaryMode && !env.UPLOAD_KEY) {
    return json({
      ok: false,
      code: "upload_key_missing",
      error: "O responsável pelo projeto precisa configurar o segredo UPLOAD_KEY antes de liberar envios."
    }, 503);
  }
  if (!temporaryMode && request.headers.get("x-upload-key") !== env.UPLOAD_KEY) {
    return json({ ok: false, error: "Chave de envio incorreta." }, 403);
  }

  const size = Number(request.headers.get("x-file-size") || request.headers.get("content-length") || 0);
  if (!request.body) return json({ ok: false, error: "Nenhum arquivo foi enviado." }, 400);
  if (!Number.isSafeInteger(size) || size < 1) {
    return json({ ok: false, error: "Não foi possível confirmar o tamanho do arquivo." }, 411);
  }
  if (size > MAX_UPLOAD_BYTES) {
    return json({ ok: false, error: "O limite por arquivo é de 50 MB." }, 413);
  }

  const uploadUrl = new URL(request.url);
  const expiryMs = parseExpiry(uploadUrl.searchParams.get("expires"));
  if (!expiryMs) {
    return json({ ok: false, error: "Validade inválida. Use de 1 minuto até 24 horas (exemplos: 10m, 10 minutos, 2h ou 24h)." }, 400);
  }
  const expiresAt = Date.now() + expiryMs;
  const filename = cleanFilename(uploadUrl.searchParams.get("filename"));
  const contentType = (request.headers.get("content-type") || "application/octet-stream").slice(0, 150);
  const id = makeId();

  let stored;
  try {
    stored = await env.FILES.put("files/" + id, request.body, {
      httpMetadata: { contentType },
      customMetadata: { originalName: filename, expiresAt: String(expiresAt) }
    });
  } catch (error) {
    if (error?.code === "STORAGE_FULL") {
      return json({ ok: false, error: "O espaço temporário do LinkBox está cheio. Tente novamente depois que arquivos antigos expirarem." }, 507);
    }
    if (error?.code === "FILE_TOO_LARGE") {
      return json({ ok: false, error: "O limite por arquivo é de 50 MB." }, 413);
    }
    return json({ ok: false, error: "Não foi possível salvar o arquivo no armazenamento. Tente novamente." }, 502);
  }

  const base = new URL(request.url).origin;
  return json({
    ok: true,
    id,
    filename,
    size: Number(stored?.size || size),
    expiresAt: new Date(expiresAt).toISOString(),
    expiresInSeconds: Math.floor(expiryMs / 1000),
    shortUrl: base + "/d/" + id
  }, 201);
}

function downloadPage(id) {
  if (!/^[A-Za-z0-9_-]{16}$/.test(id)) return new Response("Link inválido.", { status: 404 });
  const html = "<!doctype html>\n<html lang=\"pt-BR\"><head>\n<meta charset=\"utf-8\"><meta name=\"viewport\" content=\"width=device-width,initial-scale=1\">\n<meta name=\"theme-color\" content=\"#080d20\"><title>Download temporário • LinkBox</title>\n<style>\n:root{color-scheme:dark;--bg:#080d20;--line:#2c3b65;--text:#f5f7ff;--muted:#a8b4d4;--green:#5ce0ae;--red:#ff8fa7}\n*{box-sizing:border-box}body{margin:0;min-height:100vh;display:grid;place-items:center;padding:22px;background:radial-gradient(ellipse at 12% 0%,#20275c 0,transparent 44%),radial-gradient(ellipse at 95% 22%,#3c1d65 0,transparent 38%),var(--bg);font-family:Inter,system-ui,-apple-system,Segoe UI,Roboto,sans-serif;color:var(--text)}\n.shell{width:min(560px,100%)}.brand{display:flex;align-items:center;justify-content:center;gap:11px;margin-bottom:23px}.logo{width:43px;height:43px;border-radius:14px;display:grid;place-items:center;background:linear-gradient(135deg,#4d8dff,#9867ff,#db69dc);box-shadow:0 8px 25px #7259ff55;font-size:22px}.brand b{font-size:22px}.brand small{display:block;color:var(--muted);font-size:10px;letter-spacing:1.7px;margin-top:3px}\n.card{border:1px solid var(--line);border-radius:25px;padding:clamp(22px,6vw,34px);background:linear-gradient(155deg,#151f40f5,#0e1731f7);box-shadow:0 24px 80px #0006;text-align:center}.icon{width:76px;height:76px;margin:0 auto 18px;border-radius:24px;display:grid;place-items:center;background:linear-gradient(145deg,#223c70,#3b286e);font-size:34px;box-shadow:inset 0 1px #ffffff22,0 12px 30px #0003}.eyebrow{color:#54d7f5;text-transform:uppercase;font-size:10px;font-weight:800;letter-spacing:2px}.card h1{font-size:clamp(23px,5vw,30px);margin:9px 0 8px;overflow-wrap:anywhere}.desc{color:var(--muted);font-size:13px;line-height:1.6;margin:0}\n.meta{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin:22px 0}.meta div{padding:13px 10px;border:1px solid #2a395f;border-radius:13px;background:#091329}.meta small{display:block;color:var(--muted);font-size:10px;margin-bottom:5px}.meta strong{font-size:13px;overflow-wrap:anywhere}\n.timer{border:1px solid #285a58;background:#0b292c;border-radius:15px;padding:14px;margin:18px 0}.timer small{display:block;color:#a9dcd4;font-size:11px}.time{font-variant-numeric:tabular-nums;font-size:28px;font-weight:850;color:var(--green);margin-top:4px}.timer.expired{border-color:#6b3548;background:#321522}.timer.expired .time{color:var(--red)}.preview{display:none;margin:18px 0;padding:12px;border:1px solid #2c3b65;border-radius:16px;background:#091329;text-align:left}.preview.show{display:block}.preview-label{display:block;color:#54d7f5;font-size:10px;font-weight:800;letter-spacing:1.5px;margin:0 0 10px}.preview img,.preview video{display:block;width:100%;max-height:420px;object-fit:contain;border-radius:11px;background:#050914}.preview-tile{min-height:150px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:8px;border:1px solid #30436e;border-radius:13px;background:linear-gradient(145deg,#17294d,#241b49);text-align:center;padding:20px}.preview-tile .tile-icon{font-size:42px}.preview-tile strong{font-size:15px}.preview-tile small{color:var(--muted);font-size:12px}\n.btn{display:flex;justify-content:center;align-items:center;gap:9px;width:100%;padding:15px 18px;border-radius:14px;background:linear-gradient(100deg,#397df4,#8061f5 65%,#b55ce0);color:#fff;text-decoration:none;font-weight:800;font-size:15px;box-shadow:0 10px 25px #655ee044}.btn.disabled{opacity:.38;pointer-events:none;filter:grayscale(.5)}.copy{margin-top:11px;width:100%;padding:12px;border-radius:12px;border:1px solid #43598c;background:#172448;color:#dce8ff;font-weight:700;cursor:pointer}.status{min-height:20px;margin:14px 0 0;color:var(--muted);font-size:12px;line-height:1.5}.status.good{color:var(--green)}.status.bad{color:var(--red)}.foot{margin-top:17px;text-align:center;color:#7785aa;font-size:10px;line-height:1.5}.spinner{width:17px;height:17px;border:2px solid #ffffff38;border-top-color:#fff;border-radius:50%;display:inline-block;animation:spin .8s linear infinite;vertical-align:middle}@keyframes spin{to{transform:rotate(360deg)}}@media(max-width:390px){.meta{grid-template-columns:1fr}.card{border-radius:20px}}\n</style></head>\n<body><main class=\"shell\">\n<header class=\"brand\"><div class=\"logo\">↗</div><div><b>LinkBox</b><small>DOWNLOAD TEMPORÁRIO</small></div></header>\n<section class=\"card\">\n<div class=\"icon\" id=\"fileIcon\">📦</div><div class=\"eyebrow\">Compartilhamento protegido por tempo</div>\n<h1 id=\"fileName\">Preparando seu download…</h1><p class=\"desc\" id=\"description\">O LinkBox está consultando a validade e os dados do arquivo.</p>\n<div class=\"meta\"><div><small>TAMANHO</small><strong id=\"fileSize\">—</strong></div><div><small>TIPO</small><strong id=\"fileType\">Arquivo</strong></div></div>\n<div class=\"preview\" id=\"filePreview\"><span class=\"preview-label\">PRÉVIA DO ARQUIVO</span><div id=\"previewContent\"></div></div>\n<div class=\"timer\" id=\"timerBox\"><small>ESTE LINK EXPIRA EM</small><div class=\"time\" id=\"countdown\">--:--</div></div>\n<a class=\"btn disabled\" id=\"downloadBtn\" href=\"#\" aria-disabled=\"true\">⬇ Baixar arquivo</a>\n<button class=\"copy\" id=\"copyBtn\" type=\"button\" disabled>Copiar link temporário</button>\n<p class=\"status\" id=\"status\" aria-live=\"polite\"><span class=\"spinner\"></span> Verificando arquivo no servidor…</p>\n</section><p class=\"foot\">Quando o prazo termina, o servidor bloqueia novas transferências.<br>LinkBox • Compartilhe com simplicidade</p>\n</main>\n<script>\nconst id=location.pathname.slice(3),$=name=>document.getElementById(name);\nconst sizeText=value=>{if(!value)return \"—\";const units=[\"B\",\"KB\",\"MB\",\"GB\"];let n=value,i=0;while(n>=1024&&i<units.length-1){n/=1024;i++}return n.toFixed(i?1:0)+\" \"+units[i]};\nconst timeText=ms=>{const total=Math.max(0,Math.ceil(ms/1000)),h=Math.floor(total/3600),m=Math.floor((total%3600)/60),s=total%60;return (h?String(h).padStart(2,\"0\")+\":\":\"\")+String(m).padStart(2,\"0\")+\":\"+String(s).padStart(2,\"0\")};\nlet expiresAt=0,timer=0;\nfunction expireUi(){$(\"timerBox\").classList.add(\"expired\");$(\"countdown\").textContent=\"EXPIRADO\";$(\"downloadBtn\").classList.add(\"disabled\");$(\"downloadBtn\").setAttribute(\"aria-disabled\",\"true\");$(\"downloadBtn\").removeAttribute(\"href\");$(\"copyBtn\").disabled=true;$(\"status\").className=\"status bad\";$(\"status\").textContent=\"Este link expirou. O servidor bloqueou o download.\";clearInterval(timer)}\nfunction tick(){const remaining=expiresAt-Date.now();if(remaining<=0){expireUi();return}$(\"countdown\").textContent=timeText(remaining)}\nasync function loadFile(){try{const response=await fetch(\"/api/file/\"+encodeURIComponent(id),{cache:\"no-store\"}),data=await response.json();if(!response.ok||!data.ok){if(response.status===410||data.expired){$(\"fileName\").textContent=\"Link expirado\";$(\"description\").textContent=\"O prazo de compartilhamento terminou.\";expireUi()}else{$(\"fileName\").textContent=\"Arquivo indisponível\";$(\"description\").textContent=data.error||\"Este link não existe ou o arquivo não está mais disponível.\";$(\"status\").className=\"status bad\";$(\"status\").textContent=data.error||\"Arquivo não encontrado.\";$(\"timerBox\").classList.add(\"expired\");$(\"countdown\").textContent=\"INDISPONÍVEL\"}return}\n$(\"fileName\").textContent=data.filename;$(\"fileSize\").textContent=sizeText(data.size);$(\"fileType\").textContent=data.contentType||\"Arquivo\";const ext=(data.filename.split(\".\").pop()||\"\").toLowerCase();const imageExt=[\"jpg\",\"jpeg\",\"png\",\"gif\",\"webp\",\"avif\",\"bmp\"];const videoExt=[\"mp4\",\"m4v\",\"webm\",\"ogv\"];const langs={py:[\"🐍\",\"Python\"],js:[\"🟨\",\"JavaScript\"],ts:[\"🔷\",\"TypeScript\"],html:[\"🌐\",\"HTML\"],css:[\"🎨\",\"CSS\"],json:[\"🧩\",\"JSON\"],java:[\"☕\",\"Java\"],kt:[\"🟣\",\"Kotlin\"],cpp:[\"🔹\",\"C++\"],php:[\"🐘\",\"PHP\"],go:[\"🐹\",\"Go\"],rs:[\"🦀\",\"Rust\"],sh:[\"⌨️\",\"Shell\"],sql:[\"🗄️\",\"SQL\"]};const icon=videoExt.includes(ext)?\"🎬\":imageExt.includes(ext)?\"🖼️\":langs[ext]?.[0]||\"📦\";$(\"fileIcon\").textContent=icon;const preview=$(\"filePreview\"),content=$(\"previewContent\");content.replaceChildren();if(imageExt.includes(ext)){const img=document.createElement(\"img\");img.src=\"/preview/\"+encodeURIComponent(id);img.alt=\"Prévia de \"+data.filename;content.append(img)}else if(videoExt.includes(ext)){const video=document.createElement(\"video\");video.src=\"/preview/\"+encodeURIComponent(id);video.controls=true;video.preload=\"metadata\";video.playsInline=true;content.append(video)}else{const tile=document.createElement(\"div\");tile.className=\"preview-tile\";const glyph=document.createElement(\"span\");glyph.className=\"tile-icon\";glyph.textContent=icon;const title=document.createElement(\"strong\");title.textContent=langs[ext]?.[1]|| (ext===\"pdf\"?\"Documento PDF\":ext.toUpperCase()||\"Arquivo\");const note=document.createElement(\"small\");note.textContent=langs[ext]?\"Arquivo de código • conteúdo não executado nem exibido.\":\"Prévia não disponível para este formato.\";tile.append(glyph,title,note);content.append(tile)}preview.classList.add(\"show\");expiresAt=new Date(data.expiresAt).getTime();if(!Number.isFinite(expiresAt)||expiresAt<=Date.now()){expireUi();return}\n$(\"downloadBtn\").href=\"/download/\"+encodeURIComponent(id);$(\"downloadBtn\").classList.remove(\"disabled\");$(\"downloadBtn\").setAttribute(\"aria-disabled\",\"false\");$(\"copyBtn\").disabled=false;$(\"copyBtn\").addEventListener(\"click\",async()=>{try{await navigator.clipboard.writeText(location.href);$(\"copyBtn\").textContent=\"Link copiado!\"}catch{$(\"copyBtn\").textContent=location.href}});\n$(\"status\").className=\"status good\";$(\"status\").textContent=\"Arquivo disponível. A validade é controlada pelo servidor.\";tick();timer=setInterval(tick,1000)\n}catch{$(\"fileName\").textContent=\"Falha na conexão\";$(\"description\").textContent=\"Não foi possível consultar o arquivo no servidor.\";$(\"status\").className=\"status bad\";$(\"status\").textContent=\"Verifique sua conexão e abra o link novamente.\";$(\"timerBox\").classList.add(\"expired\");$(\"countdown\").textContent=\"ERRO\"}}\nloadFile();\n</script></body></html>";
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store, max-age=0", "x-content-type-options": "nosniff", "referrer-policy": "strict-origin-when-cross-origin" } });
}

async function getFileInfo(id, env) {
  if (!/^[A-Za-z0-9_-]{16}$/.test(id)) return json({ ok: false, error: "Link inválido." }, 404);
  if (!env.FILES) return json({ ok: false, error: "O armazenamento não está configurado." }, 503);
  let object;
  try { object = await env.FILES.get("files/" + id); } catch { return json({ ok: false, error: "Não foi possível consultar o arquivo." }, 502); }
  if (!object) return json({ ok: false, error: "Arquivo não encontrado ou link expirado.", expired: true }, 404);
  const expiresAt = Number(object.customMetadata?.expiresAt || 0);
  if (expiresAt && Date.now() >= expiresAt) {
    if (typeof env.FILES.delete === "function") await env.FILES.delete("files/" + id).catch(() => {});
    try { await object.body?.cancel?.(); } catch {}
    return json({ ok: false, error: "Este link expirou e o download foi bloqueado.", expired: true }, 410);
  }
  const result = { ok: true, filename: cleanFilename(object.customMetadata?.originalName || "arquivo"), size: Number(object.size || 0), contentType: String(object.httpMetadata?.contentType || "application/octet-stream"), expiresAt: new Date(expiresAt || (Date.now() + 24 * 60 * 60 * 1000)).toISOString() };
  try { await object.body?.cancel?.(); } catch {}
  return json(result);
}

async function downloadFile(id, env, inline = false) {
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
  const expiresAt = Number(object.customMetadata?.expiresAt || 0);
  if (expiresAt && Date.now() >= expiresAt) {
    if (typeof env.FILES.delete === "function") {
      await env.FILES.delete("files/" + id).catch(() => {});
    }
    return new Response("Este link expirou e o download foi bloqueado.", {
      status: 410,
      headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" }
    });
  }

  const filename = cleanFilename(object.customMetadata?.originalName || "arquivo");
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  const contentType = String(object.httpMetadata?.contentType || "application/octet-stream").split(";")[0].toLowerCase();
  if (inline && !new Set(["image/jpeg","image/png","image/gif","image/webp","image/avif","image/bmp","video/mp4","video/webm","video/ogg"]).has(contentType)) {
    try { await object.body?.cancel?.(); } catch {}
    return new Response("Prévia não disponível para este tipo de arquivo.", { status: 415, headers: { "cache-control": "no-store", "content-type": "text/plain; charset=utf-8" } });
  }
  headers.set("content-type", contentType);
  if (inline) { headers.set("content-disposition", "inline"); } else { headers.set("content-disposition", "attachment; } filename*=UTF-8''" + encodeURIComponent(filename));
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
        uploadEnabled: Boolean(env.FILES && (env.UPLOAD_KEY || env.NODE_EPHEMERAL_STORAGE)),
        storageMode: env.NODE_EPHEMERAL_STORAGE ? "temporario" : "r2",
        maxRetentionHours: 24,
        minRetentionMinutes: 1,
        maxUploadMB: 50
      });
    }

    if (path === "/api/extract" && request.method === "POST") {
      return extractLinks(request);
    }

    if (path === "/api/upload" && request.method === "POST") {
      return uploadFile(request, env);
    }

    if (path.startsWith("/api/file/") && request.method === "GET") {
      return getFileInfo(path.slice("/api/file/".length), env);
    }

    if (path.startsWith("/preview/") && request.method === "GET") {
      return downloadFile(path.slice("/preview/".length), env, true);
    }

    if (path.startsWith("/download/") && request.method === "GET") {
      return downloadFile(path.slice("/download/".length), env);
    }

    if (path.startsWith("/d/") && request.method === "GET") {
      return downloadPage(path.slice(3));
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