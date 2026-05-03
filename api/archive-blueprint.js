// api/archive-blueprint.js
// Vercel Serverless Function — ingen package.json behövs
// Sparar planritningar i Vercel Blob via REST API (fetch inbyggt i Node 18+)
//
// Miljövariabel som krävs (sätts automatiskt när du aktiverar Blob i Vercel):
//   BLOB_READ_WRITE_TOKEN

const BLUEPRINT_KEYWORDS = ["planritning","planlosning","planlösning","plan_","_plan","floor","ritning","skiss","blueprint","alternativ"];
const PHOTO_KEYWORDS     = ["fasad","badrum","kök","kok","sovrum","vardagsrum","hall","balkong","portrait","staff","agent"];

const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8",
  "Accept-Language": "sv-SE,sv;q=0.9,en-US;q=0.8",
};

// ── Hjälpfunktioner ───────────────────────────────────────────────

function toId(str = "") {
  return str.toLowerCase()
    .replace(/å/g,"a").replace(/ä/g,"a").replace(/ö/g,"o")
    .replace(/[^a-z0-9]+/g,"-").replace(/^-|-$/g,"") || "okand";
}

function blueprintScore(url = "", label = "") {
  const text = (url + " " + label).toLowerCase();
  let score = 0;
  for (const kw of BLUEPRINT_KEYWORDS) if (text.includes(kw)) score += 10;
  for (const kw of PHOTO_KEYWORDS)     if (text.includes(kw)) score -= 5;
  if (/planritning/i.test(label)) score += 15;
  return score;
}

function extractImages(html, baseUrl) {
  const images = [];
  const seen   = new Set();
  const attrRe = /(?:src|data-src|data-lazy-src)=["']([^"']+\.(?:jpg|jpeg|png|webp)[^"']*)["']/gi;
  const altRe  = /alt=["']([^"']*)["']/i;
  let m;
  while ((m = attrRe.exec(html)) !== null) {
    let url = m[1];
    if (url.startsWith("//")) url = "https:" + url;
    if (url.startsWith("/"))  url = new URL(url, baseUrl).href;
    if (!url.startsWith("http") || seen.has(url)) continue;
    seen.add(url);
    const nearby = html.slice(Math.max(0, m.index - 100), m.index + 200);
    const altM   = altRe.exec(nearby);
    images.push({ url, label: altM ? altM[1] : "" });
  }
  const jsonRe = /"(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/gi;
  while ((m = jsonRe.exec(html)) !== null) {
    const url = m[1];
    if (!seen.has(url)) { seen.add(url); images.push({ url, label: "" }); }
  }
  return images;
}

function extractMeta(html) {
  const meta = { address: null, sqm: null, rooms: null, floor: null };
  const h1 = html.match(/<h1[^>]*>([^<]{5,80})<\/h1>/i);
  if (h1) meta.address = h1[1].trim();
  if (!meta.address) {
    const title = html.match(/<title>([^<|–\-]{5,60})/i);
    if (title) meta.address = title[1].trim();
  }
  const t = html.replace(/<[^>]+>/g, " ");
  const sqmM   = t.match(/(\d{2,3})\s*(?:m²|m2|kvm)/i);   if (sqmM)   meta.sqm   = parseInt(sqmM[1]);
  const rumM   = t.match(/(\d{1,2})\s*rum/i);               if (rumM)   meta.rooms = parseInt(rumM[1]);
  const floorM = t.match(/(\d{1,2})\s*tr(?:\b|[\s,])/i) || t.match(/(?:våning|plan)\s*(\d)/i);
  if (floorM) meta.floor = parseInt(floorM[1]);
  return meta;
}

// Spara fil i Vercel Blob via REST API — ingen npm-paket behövs
async function putBlob(pathname, body, contentType, token) {
  const res = await fetch(`https://blob.vercel-storage.com/${pathname}`, {
    method: "PUT",
    headers: {
      "Authorization":  `Bearer ${token}`,
      "Content-Type":   contentType,
      "x-content-type": contentType,
    },
    body,
  });
  if (!res.ok) {
    const txt = await res.text();
    throw new Error(`Blob PUT misslyckades (${res.status}): ${txt}`);
  }
  const data = await res.json();
  return data.url;
}

// ── Huvud-handler ─────────────────────────────────────────────────

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST")   return res.status(405).json({ error: "Använd POST" });

  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return res.status(500).json({ error: "BLOB_READ_WRITE_TOKEN saknas" });

  const { url: brokerUrl } = req.body || {};
  if (!brokerUrl?.startsWith("http")) {
    return res.status(400).json({ error: "Ange en giltig URL" });
  }

  // Steg 1: Hämta sidan
  let html;
  try {
    const pageRes = await fetch(brokerUrl, { headers: BROWSER_HEADERS, redirect: "follow" });
    if (!pageRes.ok) throw new Error(`HTTP ${pageRes.status}`);
    html = await pageRes.text();
  } catch (e) {
    return res.status(502).json({ error: `Kunde inte hämta sidan: ${e.message}` });
  }

  // Steg 2: Identifiera planritningar
  const allImages  = extractImages(html, brokerUrl);
  const blueprints = allImages
    .map(img => ({ ...img, score: blueprintScore(img.url, img.label) }))
    .filter(img => img.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((img, i) => ({
      ...img,
      type:     i === 0 ? "original_plan" : "alternative_plan",
      filename: i === 0 ? "original_plan.jpg" : `alternative_plan_${i}.jpg`,
    }));

  if (blueprints.length === 0) {
    return res.status(404).json({ error: "Ingen planritning identifierad", images_scanned: allImages.length });
  }

  // Steg 3: Bygg sökväg
  const meta        = extractMeta(html);
  const objectId    = toId(meta.address);
  const sizeSlug    = meta.sqm   ? `${meta.sqm}kvm`       : "okand-storlek";
  const roomSlug    = meta.rooms ? `_${meta.rooms}rum`    : "";
  const floorSlug   = meta.floor ? `vaning_${meta.floor}` : "vaning_okand";
  const storagePath = `blueprints/${objectId}/${sizeSlug}${roomSlug}/${floorSlug}`;

  // Steg 4: Ladda ner och spara i Vercel Blob
  const savedImages = [];
  const warnings    = [];

  for (const bp of blueprints) {
    try {
      const imgRes = await fetch(bp.url, {
        headers: { "User-Agent": BROWSER_HEADERS["User-Agent"], "Referer": new URL(bp.url).origin + "/" },
      });
      if (!imgRes.ok) throw new Error(`HTTP ${imgRes.status}`);
      const buf         = await imgRes.arrayBuffer();
      const contentType = imgRes.headers.get("Content-Type") || "image/jpeg";
      const publicUrl   = await putBlob(`${storagePath}/${bp.filename}`, buf, contentType, token);
      savedImages.push({ ...bp, downloaded: true, public_url: publicUrl, bytes: buf.byteLength });
    } catch (e) {
      warnings.push(`${bp.filename}: ${e.message}`);
      savedImages.push({ ...bp, downloaded: false, error: e.message });
    }
  }

  // Steg 5: Spara metadata.json
  const metadataObj = {
    object_id:    objectId,
    address:      meta.address,
    floor:        meta.floor,
    size_sqm:     meta.sqm,
    rooms:        meta.rooms,
    broker_url:   brokerUrl,
    storage_path: storagePath,
    timestamp:    new Date().toISOString().split("T")[0],
    images:       savedImages,
    warnings,
  };

  try {
    await putBlob(`${storagePath}/metadata.json`, JSON.stringify(metadataObj, null, 2), "application/json", token);
  } catch (_) {}

  return res.status(200).json({
    success:               true,
    object_id:             objectId,
    storage_path:          storagePath,
    blueprints_found:      blueprints.length,
    blueprints_downloaded: savedImages.filter(i => i.downloaded).length,
    metadata:              metadataObj,
  });
}
