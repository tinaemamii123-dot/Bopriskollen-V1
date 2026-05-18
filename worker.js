var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// worker.js
var CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type"
};
var worker_default = {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS });
    }
    const { pathname } = new URL(request.url);
    try {
      if (pathname === "/fetch-listing" && request.method === "POST") {
        return await handleFetchListing(request);
      }
      if (pathname === "/analyze" && request.method === "POST") {
        return await handleAnalyze(request, env);
      }
      if (pathname === "/image-proxy") {
        return await handleImageProxy(request);
      }
      // ── NY ROUTE ──────────────────────────────────────────────
      if (pathname === "/archive-blueprint" && request.method === "POST") {
        return await handleArchiveBlueprint(request, env);
      }
      // ─────────────────────────────────────────────────────────
    } catch (e) {
      return json({ success: false, error: e.message }, 500);
    }
    return new Response("Bopriskollen Worker \u2013 OK", { headers: CORS });
  }
};
async function handleFetchListing(request) {
  const { url } = await request.json();
  if (!url || !url.startsWith("http")) {
    return json({ success: false, error: "Ogiltig URL" }, 400);
  }
  let html = "";
  try {
    html = await fetchPage(url);
  } catch (_) {
  }
  if (url.includes("booli.se")) return json(await parseBooli(url, html));
  if (url.includes("hemnet.se")) return json(await parseHemnet(url, html || await fetchPage(url)));
  return json(await parseBroker(url, html || await fetchPage(url)));
}
__name(handleFetchListing, "handleFetchListing");
async function parseBooli(url, html) {
  const result = { success: true, source: "Booli", images: [], metadata: {}, brokerUrl: null };
  const listingId = url.match(/\/(\d{5,})/)?.[1];
  if (listingId) {
    try {
      const gqlResult = await fetchBooliGraphQL(listingId);
      if (gqlResult) {
        result.metadata = gqlResult.metadata;
        result.images = gqlResult.images;
        result.brokerUrl = gqlResult.brokerUrl;
        result.source = "Booli (API)";
      }
    } catch (_) {
    }
  }
  if (result.images.length === 0 && html) {
    const nextData = extractNextData(html);
    if (nextData) {
      const listing = dig(nextData, "props.pageProps.listing") || dig(nextData, "props.pageProps.data.listing");
      if (listing) {
        result.metadata = extractBooliMeta(listing);
        const imgs = listing.images || listing.media?.images || dig(listing, "media.imageList") || [];
        result.images = toImageList(imgs);
      }
    }
    if (result.images.length === 0) {
      const apollo = extractApolloState(html);
      if (apollo) {
        result.images = Object.entries(apollo).filter(([k]) => k.startsWith("Image:") || k.startsWith("ListingImage:")).map(([, v]) => ({ url: v.url || v.src, label: v.primaryLabel || v.alt || "" })).filter((i) => i.url);
        const lKey = Object.keys(apollo).find((k) => k.match(/^(ForSale|Sold)?Listing:/));
        if (lKey) result.metadata = { ...result.metadata, ...extractBooliMeta(apollo[lKey]) };
      }
    }
    const brokerHref = html.match(/href="(https?:\/\/(?!(?:www\.)?booli)[^"]+)"[^>]*>[^<]*[Ll]äs\s*mer\s*hos\s*m[äa]klaren/i)?.[1];
    if (brokerHref) result.brokerUrl = brokerHref;
  }
  if (result.brokerUrl && result.images.length === 0) {
    try {
      const brokerHtml = await fetchPage(result.brokerUrl, { Referer: "https://www.booli.se/" });
      const brokerResult = await parseBroker(result.brokerUrl, brokerHtml);
      if (brokerResult.images.length > 0) {
        result.images = brokerResult.images;
        result.source = "M\xE4klare (via Booli)";
      }
    } catch (_) {
    }
  }
  return result;
}
__name(parseBooli, "parseBooli");
async function fetchBooliGraphQL(listingId) {
  try {
    const homeHtml = await fetchPage("https://www.booli.se/", {
      "Sec-Fetch-Mode": "navigate",
      "Sec-Fetch-Site": "none"
    });
    const buildId = homeHtml.match(/"buildId"\s*:\s*"([^"]+)"/)?.[1];
    if (buildId) {
      const dataUrl = `https://www.booli.se/_next/data/${buildId}/annons/${listingId}.json`;
      const dataRes = await fetch(dataUrl, {
        headers: {
          ...BROWSER_HEADERS,
          "Sec-Fetch-Mode": "same-origin",
          "Sec-Fetch-Site": "same-origin",
          "Sec-Fetch-Dest": "empty",
          "Referer": `https://www.booli.se/annons/${listingId}`
        }
      });
      if (dataRes.ok) {
        const json2 = await dataRes.json();
        const l = dig(json2, "pageProps.listing") || dig(json2, "pageProps.data.listing");
        if (l) {
          return {
            metadata: extractBooliMeta(l),
            images: toImageList(l.images || l.media?.images || []),
            brokerUrl: l.brokerObject?.url || l.brokerUrl || null
          };
        }
      }
    }
  } catch (_) {
  }
  const apiUrls = [
    `https://www.booli.se/api/listings/${listingId}`,
    `https://api.booli.se/listings/${listingId}`
  ];
  for (const apiUrl of apiUrls) {
    try {
      const res = await fetch(apiUrl, {
        headers: { ...BROWSER_HEADERS, "Accept": "application/json" }
      });
      if (!res.ok) continue;
      const json2 = await res.json();
      const l = json2.listing || json2;
      if (l?.streetAddress || l?.images?.length) {
        return {
          metadata: extractBooliMeta(l),
          images: toImageList(l.images || []),
          brokerUrl: l.brokerObject?.url || null
        };
      }
    } catch (_) {
      continue;
    }
  }
  return null;
}
__name(fetchBooliGraphQL, "fetchBooliGraphQL");
function extractBooliMeta(l) {
  if (!l) return {};
  return {
    address: l.streetAddress || l.address || l.location?.address,
    area: l.location?.namedAreas?.[0] || l.areaName,
    sqm: l.livingArea || l.sqm,
    rooms: l.rooms,
    floor: l.floor,
    buildYear: l.constructionYear || l.buildYear,
    askingPrice: l.listPrice || l.askingPrice,
    monthlyFee: l.rent || l.monthlyFee,
    brf: l.housingCooperative?.name || l.brfName,
    hasBalcony: l.balcony ?? l.hasBalcony,
    hasElevator: l.elevator ?? l.hasElevator
  };
}
__name(extractBooliMeta, "extractBooliMeta");
async function parseHemnet(url, html) {
  const result = { success: true, source: "Hemnet", images: [], metadata: {} };
  const nextData = extractNextData(html);
  if (nextData) {
    const listing = dig(nextData, "props.pageProps.listing") || dig(nextData, "props.pageProps.propertyDetails") || dig(nextData, "props.pageProps.data.property");
    if (listing) {
      result.metadata = {
        address: listing.streetAddress || listing.street_address,
        area: listing.location?.area?.name || listing.municipality_name || listing.area,
        sqm: listing.livingArea || listing.living_area,
        rooms: listing.numberOfRooms || listing.number_of_rooms,
        floor: listing.floor,
        buildYear: listing.constructionYear || listing.construction_year,
        askingPrice: listing.askingPrice || listing.asking_price,
        monthlyFee: listing.monthlyFee || listing.monthly_fee,
        brf: listing.associationName || listing.association?.name,
        hasBalcony: listing.patioAndBalcony || listing.balcony,
        hasElevator: listing.elevator
      };
      const imgs = listing.images || listing.media?.images || [];
      result.images = toImageList(imgs);
    }
  }
  if (result.images.length === 0) {
    result.images = extractOgImages(html);
  }
  if (!result.metadata.address) {
    const ld = extractJsonLd(html);
    if (ld) result.metadata.address = ld.name || ld.address?.streetAddress;
  }
  return result;
}
__name(parseHemnet, "parseHemnet");
async function parseBroker(url, html) {
  const result = { success: true, source: detectBroker(url), images: [], metadata: {} };
  const listingOrigin = (() => {
    try {
      return new URL(url).origin;
    } catch {
      return "";
    }
  })();
  const nextData = extractNextData(html);
  if (nextData) {
    const urls = collectImageUrls(nextData);
    result.images = urls.map((u) => ({ url: u, label: "" }));
    const meta = extractBrokerMeta(nextData);
    if (meta.sqm) result.metadata.sqm = meta.sqm;
    if (meta.rooms) result.metadata.rooms = meta.rooms;
    if (meta.floor) result.metadata.floor = meta.floor;
    if (meta.monthlyFee) result.metadata.monthlyFee = meta.monthlyFee;
    if (meta.askingPrice) result.metadata.askingPrice = meta.askingPrice;
    if (meta.brf) result.metadata.brf = meta.brf;
    if (meta.buildYear) result.metadata.buildYear = meta.buildYear;
    if (meta.address) result.metadata.address = meta.address;
  }
  const ogImgs = extractOgImages(html);
  if (ogImgs.length > 0) {
    const existing = new Set(result.images.map((i) => i.url));
    for (const img of ogImgs) if (!existing.has(img.url)) result.images.push(img);
  }
  {
    const cdnPattern = IMAGE_CDN_HOSTS.map((h) => h.replace(/\./g, "\\.")).join("|");
    const cdnRe = new RegExp(`https?://(?:${cdnPattern})/[^"'\\s>]+`, "gi");
    const attrRe = /(?:src|data-src|data-lazy-src|data-original)="(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)(?:\?[^"]*)?)"/gi;
    const srcsetRe = /(?:srcset|data-srcset)="([^"]+)"/gi;
    const jsonImgRe = /"(https?:\/\/[^"]+\.(?:jpg|jpeg|png|webp)(?:\?[^"]*)?)"/gi;
    const attrMatches = [...html.matchAll(attrRe)].map((m) => m[1]);
    const cdnMatches = [...html.matchAll(cdnRe)].map((m) => m[0].replace(/['">\s].*$/, ""));
    const jsonMatches = [...html.matchAll(jsonImgRe)].map((m) => m[1]);
    const srcsetMatches = [];
    for (const m of html.matchAll(srcsetRe)) {
      const candidates2 = m[1].split(",").map((s) => s.trim().split(/\s+/)[0]).filter(Boolean);
      if (candidates2.length) srcsetMatches.push(candidates2[candidates2.length - 1]);
    }
    const allUrls = [.../* @__PURE__ */ new Set([...cdnMatches, ...attrMatches, ...srcsetMatches, ...jsonMatches])].filter((u) => u && u.startsWith("http") && !isMarketingImage(u, listingOrigin));
    const external = allUrls.filter((u) => {
      try {
        return new URL(u).origin !== listingOrigin;
      } catch {
        return false;
      }
    });
    const sameOrigin = allUrls.filter((u) => {
      try {
        return new URL(u).origin === listingOrigin;
      } catch {
        return false;
      }
    });
    const preferred = external.length > 0 ? external : sameOrigin;
    const deduped = deduplicateSizedImages(preferred);
    const candidates = deduped.map((u) => ({ url: u, label: "" }));
    if (candidates.length > result.images.length) {
      result.images = candidates;
    }
  }
  if (/snart\s+till\s+salu|coming[\s-]soon|kommande\s+objekt/i.test(html)) {
    result.metadata.comingSoon = true;
  }
  if (!result.metadata.description) {
    const descKeys = ["description", "body", "text", "brokerText", "objectDescription", "longDescription", "about", "content"];
    const findDesc = /* @__PURE__ */ __name((obj, depth = 0) => {
      if (!obj || typeof obj !== "object" || depth > 6) return "";
      for (const k of descKeys) {
        if (typeof obj[k] === "string" && obj[k].length > 80) return obj[k];
      }
      for (const v of Object.values(obj)) {
        if (v && typeof v === "object" && !Array.isArray(v)) {
          const found = findDesc(v, depth + 1);
          if (found) return found;
        }
      }
      return "";
    }, "findDesc");
    if (nextData) result.metadata.description = findDesc(nextData);
  }
  if (!result.metadata.description) {
    const ogDesc = html.match(/<meta[^>]+(?:property="og:description"|name="description")[^>]+content="([^"]+)"/i)?.[1] || html.match(/<meta[^>]+content="([^"]+)"[^>]+(?:property="og:description"|name="description")/i)?.[1];
    if (ogDesc && ogDesc.length > 80) result.metadata.description = ogDesc;
  }
  if (result.metadata.description) {
    result.metadata.description = result.metadata.description.replace(/\s+/g, " ").trim().slice(0, 2e3);
  }
  if (!result.metadata.address) {
    const ld = extractJsonLd(html);
    if (ld) result.metadata.address = ld.name || ld.address?.streetAddress;
  }
  if (!result.metadata.address) {
    const ogTitle = html.match(/<meta[^>]+property="og:title"[^>]+content="([^"]+)"/i)?.[1];
    if (ogTitle) result.metadata.address = ogTitle;
  }
  if (result.metadata.address) {
    result.metadata.address = decodeHtml(result.metadata.address).replace(/\s*[|\-–]\s*[^|]{4,80}$/, "").trim();
  }
  const metaDesc = html.match(/<meta[^>]+(?:name="description"|property="og:description")[^>]+content="([^"]+)"/i)?.[1] || "";
  const scanText = metaDesc + " " + html;
  if (!result.metadata.sqm) {
    const m = scanText.match(/(\d{2,3})\s*(?:m²|m2|kvm)/i);
    if (m) {
      const n = parseInt(m[1]);
      if (n > 10 && n < 500) result.metadata.sqm = n;
    }
  }
  if (!result.metadata.rooms) {
    const m = scanText.match(/(\d{1,2})\s*rum/i);
    if (m) {
      const n = parseInt(m[1]);
      if (n > 0 && n < 20) result.metadata.rooms = n;
    }
  }
  if (!result.metadata.floor) {
    const m = scanText.match(/(?:vån(?:ing)?|etage)[^\d]{0,5}(\d{1,2})/i) || scanText.match(/(\d{1,2})\s*tr(?:appor?)?(?:\b|[\s,])/i);
    if (m) result.metadata.floor = parseInt(m[1]);
  }
  if (!result.metadata.askingPrice) {
    const pm = scanText.match(/(?:utgångspris|utropspris|pris)[^0-9]*(\d[\d\s\u00a0]{4,})/i) || scanText.match(/(\d[\d\s\u00a0]{4,})\s*kr[^/m].*?(?:utgångspris|utropspris)/i);
    if (pm) {
      const price = parseInt(pm[1].replace(/[\s\u00a0]/g, ""));
      if (price > 1e5 && price < 1e8) result.metadata.askingPrice = price;
    }
  }
  if (!result.metadata.monthlyFee) {
    const fm = scanText.match(/(?:avgift|månadsavgift|brfavgift|driftskostnad)[^\d]{0,10}(\d[\d\s\u00a0]{2,6})/i);
    if (fm) {
      const fee = parseInt(fm[1].replace(/[\s\u00a0]/g, ""));
      if (fee > 500 && fee < 3e4) result.metadata.monthlyFee = fee;
    }
  }
  if (!result.metadata.brf) {
    const bm = scanText.match(/(?:förening|brf|bostadsrättsförening)[:\s]+([A-ZÅÄÖ][^<\n,]{3,50})/i);
    if (bm) result.metadata.brf = bm[1].trim();
  }
  return result;
}
__name(parseBroker, "parseBroker");
function extractBrokerMeta(obj, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 8) return {};
  const aliases = {
    sqm: ["livingArea", "area", "squareMeters", "boyta", "living_area", "sqm", "size"],
    rooms: ["rooms", "numberOfRooms", "antal_rum", "numRooms", "number_of_rooms"],
    floor: ["floor", "etage", "vaning", "floorNumber"],
    monthlyFee: ["fee", "monthlyFee", "avgift", "brfFee", "monthlyCost", "monthly_fee", "objectFee"],
    askingPrice: ["listPrice", "startingPrice", "askingPrice", "price", "utgangspris", "requestedPrice"],
    brf: ["association", "brf", "housingAssociation", "brfName", "associationName"],
    buildYear: ["constructionYear", "buildYear", "yearBuilt", "bygg\xE5r"],
    address: ["streetAddress", "address", "gatuadress", "street"]
  };
  const found = {};
  for (const [field, keys] of Object.entries(aliases)) {
    for (const k of keys) {
      const v = obj[k];
      if (v !== void 0 && v !== null) {
        if (field === "address" && typeof v === "string" && v.length > 3) {
          found[field] = v;
          break;
        }
        if (field === "brf" && typeof v === "string" && v.length > 2) {
          found[field] = v;
          break;
        }
        if (typeof v === "number" && v > 0) {
          found[field] = v;
          break;
        }
        if (typeof v === "string" && /^\d+(\.\d+)?$/.test(v.trim())) {
          found[field] = parseFloat(v);
          break;
        }
      }
    }
  }
  if (found.sqm || found.rooms) return found;
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const sub = extractBrokerMeta(v, depth + 1);
      if (sub.sqm || sub.rooms) return sub;
    }
  }
  return found;
}
__name(extractBrokerMeta, "extractBrokerMeta");
function isMarketingImage(url, listingOrigin = "") {
  if (!url) return true;
  if (/\.svg(\?|$)/i.test(url) || /\.gif(\?|$)/i.test(url)) return true;
  if (/gravatar\.com|\/avatar\//i.test(url)) return true;
  if (/\/wp-content\/(?:themes|plugins|uploads\/woocommerce|cache)\//i.test(url)) return true;
  if (/\/(?:pixel|tracker|beacon|track)\//i.test(url)) return true;
  let isSameOrigin = false;
  if (listingOrigin) {
    try {
      isSameOrigin = new URL(url).origin === listingOrigin;
    } catch {
    }
  }
  if (isSameOrigin) {
    if (/\/(?:logo|favicon|icon|sprite)[^/]*\.(?:png|jpg|webp)/i.test(url)) return true;
    if (/\/wp-content\/uploads\/.*(?:portrait|staff|team|mäklare|maklare|broker|agent|medarbetare|personal)[^/]*\.(?:jpg|jpeg|png|webp)/i.test(url)) return true;
    if (/\/wp-content\/themes\//i.test(url)) return true;
  }
  return false;
}
__name(isMarketingImage, "isMarketingImage");
var SIZE_RANK = {
  "_4k": 3,
  "_hd": 2,
  "_original": 4,
  "_large": 2,
  "_thumb": -1,
  "_small": 0,
  "original": 4,
  "medium": 3,
  "large": 2,
  "small": 1,
  "thumbnail": -1
};
function deduplicateSizedImages(urls) {
  const toKey = /* @__PURE__ */ __name((u) => u.replace(/\.\._(?:4k|hd|thumb|original|large|small|medium)$/i, "").replace(/[?&](?:w|width|size|format|quality)=[^&]*/gi, "").replace(/-\d+x\d+(?=\.\w+$)/, "").replace(/\/(?:Small|Medium|Large|Thumbnail|Original)\//gi, "/SIZE/"), "toKey");
  const best = /* @__PURE__ */ new Map();
  for (const u of urls) {
    const key = toKey(u);
    let rank = 1;
    const suf = u.match(/\.\._(\w+)$/i)?.[1]?.toLowerCase();
    if (suf !== void 0) {
      rank = SIZE_RANK["_" + suf] ?? 1;
    } else {
      const seg = u.match(/\/(?:Small|Medium|Large|Thumbnail|Original)\//i)?.[0]?.replace(/\//g, "").toLowerCase();
      if (seg) rank = SIZE_RANK[seg] ?? 1;
    }
    if (rank < 0) continue;
    if (!best.has(key) || rank > best.get(key).rank) {
      best.set(key, { url: u, rank });
    }
  }
  return [...best.values()].map((v) => v.url);
}
__name(deduplicateSizedImages, "deduplicateSizedImages");
function decodeHtml(str) {
  if (!str || !str.includes("&")) return str;
  return str.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10))).replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}
__name(decodeHtml, "decodeHtml");
async function handleImageProxy(request) {
  const imageUrl = new URL(request.url).searchParams.get("url");
  if (!imageUrl || !imageUrl.startsWith("http")) {
    return new Response("Missing url", { status: 400, headers: CORS });
  }
  const res = await fetch(imageUrl, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; Bopriskollen/1.0)",
      "Referer": new URL(imageUrl).origin
    }
  });
  if (!res.ok) return new Response("Image fetch failed", { status: res.status, headers: CORS });
  const contentType = res.headers.get("Content-Type") || "image/jpeg";
  const body = await res.arrayBuffer();
  return new Response(body, {
    status: 200,
    headers: { ...CORS, "Content-Type": contentType, "Cache-Control": "public, max-age=3600" }
  });
}
__name(handleImageProxy, "handleImageProxy");

// ═══════════════════════════════════════════════════════════════════
// NY FUNKTION: handleArchiveBlueprint
// Identifierar planritningar, laddar ner dem och sparar i Supabase.
// Kräver miljövariabler: SUPABASE_URL, SUPABASE_SERVICE_KEY
// ═══════════════════════════════════════════════════════════════════
async function handleArchiveBlueprint(request, env) {
  const SUPABASE_URL = env.SUPABASE_URL;
  const SUPABASE_KEY = env.SUPABASE_SERVICE_KEY;
  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return json({ success: false, error: "SUPABASE_URL eller SUPABASE_SERVICE_KEY saknas i Worker-miljön" }, 500);
  }

  const body = await request.json();
  const brokerUrl = body.url;
  if (!brokerUrl || !brokerUrl.startsWith("http")) {
    return json({ success: false, error: 'Ange en giltig URL i fältet "url"' }, 400);
  }

  // Steg 1: Hämta och parsa sidan — återanvänder befintliga funktioner
  let listing;
  try {
    const html = await fetchPage(brokerUrl);
    if (brokerUrl.includes("booli.se"))       listing = await parseBooli(brokerUrl, html);
    else if (brokerUrl.includes("hemnet.se")) listing = await parseHemnet(brokerUrl, html);
    else                                       listing = await parseBroker(brokerUrl, html);
  } catch (e) {
    return json({ success: false, error: `Kunde inte hämta sidan: ${e.message}` }, 502);
  }

  const { images = [], metadata = {} } = listing;

  // Steg 2: Poängsätt och identifiera planritningar
  const BLUEPRINT_KEYWORDS = ["planritning", "planlosning", "planlösning", "plan_", "_plan", "floor", "ritning", "skiss", "blueprint", "alternativ"];
  const PHOTO_KEYWORDS     = ["fasad", "badrum", "kök", "kok", "sovrum", "vardagsrum", "hall", "balkong", "portrait", "staff", "agent"];

  function blueprintScore(url = "", label = "") {
    const text = (url + " " + label).toLowerCase();
    let score = 0;
    for (const kw of BLUEPRINT_KEYWORDS) if (text.includes(kw)) score += 10;
    for (const kw of PHOTO_KEYWORDS)     if (text.includes(kw)) score -= 5;
    if (/planritning/i.test(label)) score += 15;
    return score;
  }

  const blueprints = images
    .map((img) => ({ ...img, score: blueprintScore(img.url, img.label) }))
    .filter((img) => img.score >= 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, 4)
    .map((img, i) => ({
      ...img,
      type:               i === 0 ? "original_plan" : "alternative_plan",
      alternative_number: i === 0 ? null : i,
      filename:           i === 0 ? "original_plan.jpg" : `alternative_plan_${i}.jpg`,
    }));

  if (blueprints.length === 0) {
    return json({ success: false, error: "Ingen planritning identifierad bland annonsens bilder", images_scanned: images.length }, 404);
  }

  // Steg 3: Bygg filstruktur
  function toId(str = "") {
    return str.toLowerCase()
      .replace(/å/g, "a").replace(/ä/g, "a").replace(/ö/g, "o")
      .replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "okand";
  }

  const address    = metadata.address || null;
  const sqm        = metadata.sqm     || null;
  const rooms      = metadata.rooms   || null;
  const floor      = metadata.floor   || null;
  const objectId   = toId(address);
  const storagePath = `blueprints/${objectId}/${sqm ? sqm + "kvm" : "okand-storlek"}${rooms ? "_" + rooms + "rum" : ""}/${floor ? "vaning_" + floor : "vaning_okand"}`;

  // Steg 4: Ladda ner och spara i Supabase Storage
  const savedImages = [];
  const warnings    = [];

  for (const bp of blueprints) {
    try {
      const imgRes = await fetch(bp.url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; Bopriskollen/1.0)",
          "Referer":    new URL(bp.url).origin + "/",
        },
      });
      if (!imgRes.ok) {
        warnings.push(`${bp.filename}: HTTP ${imgRes.status}`);
        savedImages.push({ ...bp, downloaded: false, error: `HTTP ${imgRes.status}` });
        continue;
      }
      const buf         = await imgRes.arrayBuffer();
      const contentType = imgRes.headers.get("Content-Type") || "image/jpeg";

      const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/${storagePath}/${bp.filename}`, {
        method:  "POST",
        headers: { "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": contentType, "x-upsert": "true" },
        body:    buf,
      });

      if (!uploadRes.ok) {
        const err = await uploadRes.text();
        warnings.push(`${bp.filename}: Storage-fel – ${err}`);
        savedImages.push({ ...bp, downloaded: false, error: err });
        continue;
      }

      savedImages.push({
        ...bp,
        downloaded:  true,
        public_url:  `${SUPABASE_URL}/storage/v1/object/public/${storagePath}/${bp.filename}`,
        bytes:       buf.byteLength,
      });
    } catch (e) {
      warnings.push(`${bp.filename}: ${e.message}`);
      savedImages.push({ ...bp, downloaded: false, error: e.message });
    }
  }

  // Steg 5: Bygg och spara metadata
  const metadataObj = {
    object_id:    objectId,
    address,
    floor,
    size_sqm:     sqm,
    rooms,
    broker_name:  detectBroker(brokerUrl),
    source_url:   body.source_url || brokerUrl,
    broker_url:   brokerUrl,
    storage_path: storagePath,
    timestamp:    new Date().toISOString().split("T")[0],
    images:       savedImages,
    warnings,
  };

  // Spara metadata.json i Storage
  await fetch(`${SUPABASE_URL}/storage/v1/object/${storagePath}/metadata.json`, {
    method:  "POST",
    headers: { "Authorization": `Bearer ${SUPABASE_KEY}`, "Content-Type": "application/json", "x-upsert": "true" },
    body:    JSON.stringify(metadataObj, null, 2),
  }).catch(() => {});

  // Spara rad i Postgres-tabellen `blueprints`
  await fetch(`${SUPABASE_URL}/rest/v1/blueprints`, {
    method:  "POST",
    headers: {
      "Authorization": `Bearer ${SUPABASE_KEY}`,
      "apikey":        SUPABASE_KEY,
      "Content-Type":  "application/json",
      "Prefer":        "resolution=merge-duplicates",
    },
    body: JSON.stringify({
      object_id:    objectId,
      address,
      floor,
      size_sqm:     sqm,
      rooms,
      broker_name:  detectBroker(brokerUrl),
      source_url:   body.source_url || brokerUrl,
      broker_url:   brokerUrl,
      storage_path: storagePath,
      image_count:  savedImages.length,
      timestamp:    metadataObj.timestamp,
      metadata:     metadataObj,
    }),
  }).catch(() => {});

  return json({
    success:               true,
    object_id:             objectId,
    storage_path:          storagePath,
    blueprints_found:      blueprints.length,
    blueprints_downloaded: savedImages.filter((i) => i.downloaded).length,
    metadata:              metadataObj,
  });
}
__name(handleArchiveBlueprint, "handleArchiveBlueprint");
// ═══════════════════════════════════════════════════════════════════

async function handleAnalyze(request, env) {
  const apiKey = env.ANTHROPIC_API_KEY;
  if (!apiKey) return json({ error: "ANTHROPIC_API_KEY saknas i Worker-milj\xF6n" }, 500);
  const body = await request.json();
  const diag = { requested: 0, loaded: 0, skipped_http: 0, skipped_size: 0, skipped_dims: 0, skipped_format: 0, skipped_other: 0, total_bytes: 0 };
  if (Array.isArray(body.messages)) {
    for (const msg of body.messages) {
      if (!Array.isArray(msg.content)) continue;
      const resolved = await Promise.all(
        msg.content.map(async (block) => {
          if (block.type !== "image" || block.source?.type !== "url") {
            return block;
          }
          diag.requested++;
          try {
            const imgUrl = block.source.url;
            const imgRes = await fetch(imgUrl, {
              headers: {
                "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
                "Referer": new URL(imgUrl).origin + "/",
                "Accept": "image/avif,image/webp,image/apng,image/*,*/*;q=0.8"
              }
            });
            if (!imgRes.ok) {
              diag.skipped_http++;
              return null;
            }
            const buf = await imgRes.arrayBuffer();
            if (buf.byteLength < 1024) {
              diag.skipped_size++;
              return null;
            }
            if (buf.byteLength > 1.5 * 1024 * 1024) {
              diag.skipped_size++;
              return null;
            }
            if (!isValidImageBuffer(buf)) {
              diag.skipped_format++;
              return null;
            }
            const dims = getImageDimensions(buf);
            if (dims && (dims.width > 2e3 || dims.height > 2e3)) {
              diag.skipped_dims++;
              return null;
            }
            const mime = normalizeMime(imgRes.headers.get("Content-Type"));
            if (!mime) {
              diag.skipped_format++;
              return null;
            }
            const b64 = arrayBufferToBase64(buf);
            diag.loaded++;
            diag.total_bytes += buf.byteLength;
            return { ...block, source: { type: "base64", media_type: mime, data: b64 } };
          } catch (e) {
            diag.skipped_other++;
            return null;
          }
        })
      );
      msg.content = resolved.filter(Boolean);
    }
  }
  console.log(`[analyze] images: ${diag.loaded}/${diag.requested} loaded, ${diag.total_bytes} bytes total. Skipped: http=${diag.skipped_http} size=${diag.skipped_size} dims=${diag.skipped_dims} fmt=${diag.skipped_format} other=${diag.skipped_other}`);
  const hasImages = body.messages?.some(
    (m) => Array.isArray(m.content) && m.content.some((b) => b.type === "image")
  );
  if (!hasImages) {
    return json({ error: `Inga bilder kunde laddas. Beg\xE4rde ${diag.requested} bilder \u2014 filtrerade bort: ${diag.skipped_http} HTTP-fel, ${diag.skipped_size} f\xF6r stor/liten, ${diag.skipped_dims} >2000px, ${diag.skipped_format} ej bildfil.`, diag }, 422);
  }
  const ANTHROPIC_LIMIT = 9 * 1024 * 1024;
  if (diag.total_bytes > ANTHROPIC_LIMIT) {
    return json({ error: `Bilderna \xE4r f\xF6r stora f\xF6r ett enskilt anrop (${(diag.total_bytes / 1024 / 1024).toFixed(1)} MB, gr\xE4ns ~9 MB). Prova en annons med f\xE4rre eller mindre bilder.`, diag }, 422);
  }
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify(body)
  });
  let respData;
  try {
    respData = await res.json();
  } catch (e) {
    return json({ error: `Anthropic svarade med ogiltig JSON: ${e.message}` }, 502);
  }
  if (Array.isArray(respData.content)) {
    const toolBlock = respData.content.find((b) => b.type === "tool_use" && b.input);
    if (toolBlock) {
      return json({ success: true, result: toolBlock.input, stop_reason: respData.stop_reason, diag });
    }
    const textBlock = respData.content.find((b) => b.type === "text" && b.text);
    if (textBlock) {
      return json({ success: false, text: textBlock.text, stop_reason: respData.stop_reason, error: respData.error });
    }
  }
  return json({ success: false, error: respData.error?.message || respData.error || "Ok\xE4nt fel fr\xE5n Anthropic", stop_reason: respData.stop_reason }, res.status);
}
__name(handleAnalyze, "handleAnalyze");
function isValidImageBuffer(buf) {
  if (buf.byteLength < 12) return false;
  const b = new Uint8Array(buf, 0, 12);
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return true;
  if (b[0] === 137 && b[1] === 80 && b[2] === 78 && b[3] === 71) return true;
  if (b[0] === 82 && b[1] === 73 && b[2] === 70 && b[3] === 70 && b[8] === 87 && b[9] === 69 && b[10] === 66 && b[11] === 80) return true;
  if (b[0] === 71 && b[1] === 73 && b[2] === 70) return true;
  return false;
}
__name(isValidImageBuffer, "isValidImageBuffer");
function normalizeMime(ct) {
  const raw = (ct || "image/jpeg").split(";")[0].trim().toLowerCase();
  const map = {
    "image/jpeg": "image/jpeg",
    "image/jpg": "image/jpeg",
    "image/pjpeg": "image/jpeg",
    "image/png": "image/png",
    "image/gif": "image/gif",
    "image/webp": "image/webp"
  };
  if (map[raw]) return map[raw];
  if (raw === "application/octet-stream" || raw === "binary/octet-stream" || !raw.startsWith("image/")) {
    return "image/jpeg";
  }
  return null;
}
__name(normalizeMime, "normalizeMime");
function arrayBufferToBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 8192;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}
__name(arrayBufferToBase64, "arrayBufferToBase64");
var BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8",
  "Accept-Language": "sv-SE,sv;q=0.9,en-US;q=0.8,en;q=0.7",
  "Accept-Encoding": "gzip, deflate, br",
  "Sec-Fetch-Dest": "document",
  "Sec-Fetch-Mode": "navigate",
  "Sec-Fetch-Site": "none",
  "Sec-Fetch-User": "?1",
  "Upgrade-Insecure-Requests": "1"
};
async function fetchPage(url, extraHeaders = {}) {
  const res = await fetch(url, {
    headers: { ...BROWSER_HEADERS, ...extraHeaders },
    redirect: "follow"
  });
  if (!res.ok) throw new Error(`Kunde inte h\xE4mta sidan (HTTP ${res.status})`);
  return res.text();
}
__name(fetchPage, "fetchPage");
function extractNextData(html) {
  const m = html.match(/<script\s+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}
__name(extractNextData, "extractNextData");
function extractApolloState(html) {
  const patterns = [
    /window\.__APOLLO_STATE__\s*=\s*(\{[\s\S]+?\});\s*(?:window|<\/script>)/,
    /"ROOT_QUERY"[\s\S]{0,20}\{[\s\S]*?"__typename"/
  ];
  for (const pat of patterns) {
    const m = html.match(pat);
    if (m) {
      try {
        return JSON.parse(m[1]);
      } catch {
      }
    }
  }
  const nd = extractNextData(html);
  if (nd) {
    const str = JSON.stringify(nd);
    const km = str.match(/"Image:\d+"/);
    if (km) {
      return flattenForApollo(nd);
    }
  }
  return null;
}
__name(extractApolloState, "extractApolloState");
function flattenForApollo(obj, out = {}) {
  if (!obj || typeof obj !== "object") return out;
  for (const [k, v] of Object.entries(obj)) {
    if (k.match(/^(Image|Listing|ForSaleListing):\d/)) out[k] = v;
    else if (typeof v === "object") flattenForApollo(v, out);
  }
  return out;
}
__name(flattenForApollo, "flattenForApollo");
function extractOgImages(html) {
  return [...html.matchAll(/<meta[^>]+(?:property="og:image"|name="twitter:image")[^>]+content="([^"]+)"/gi)].map((m) => ({ url: m[1], label: "" }));
}
__name(extractOgImages, "extractOgImages");
function extractJsonLd(html) {
  const m = html.match(/<script[^>]+type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/i);
  if (!m) return null;
  try {
    return JSON.parse(m[1]);
  } catch {
    return null;
  }
}
__name(extractJsonLd, "extractJsonLd");
function toImageList(arr) {
  if (!Array.isArray(arr)) return [];
  return arr.map((img) => ({
    url: img.url || img.src || img.imageUrl || (typeof img === "string" ? img : null),
    label: img.primaryLabel || img.caption || img.alt || img.room || ""
  })).filter((i) => i.url && i.url.startsWith("http"));
}
__name(toImageList, "toImageList");
var IMAGE_CDN_HOSTS = [
  "i.sfcdn.se",
  "cdn.sfcdn.se",
  "bilder.erikolsson.se",
  "cdn.erikolsson.se",
  "media.notar.se",
  "bilder.notar.se",
  "cdn.notar.se",
  "images.bjurfors.se",
  "media.bjurfors.se",
  "cdn.fastighetsbyran.se",
  "images.fastighetsbyran.se",
  "images.hemnet.se",
  "cdn.hemnet.se",
  "images.booli.se",
  "bcdn.se",
  "cdn.era.se",
  "images.era.se",
  "media.lansfast.se",
  "images.lansfast.se",
  "images.maklarhuset.se",
  "cdn.maklarhuset.se",
  "media.skandiamaklarna.se",
  "media.husmanhagberg.se",
  "images.husmanhagberg.se",
  "driftservice.blob.core.windows.net",
  "mspublicblob.blob.core.windows.net",
  "mediabank.se",
  "cdn.mediabank.se",
  "fastighetsbilder.se",
  "cdn.fastighetsbilder.se",
  "tradition.maklarobjekt.se",
  "maklarobjekt.se"
];
function collectImageUrls(obj, urls = /* @__PURE__ */ new Set()) {
  if (!obj || typeof obj !== "object") return urls;
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === "string" && v.startsWith("http")) {
      const hasExt = /\.(?:jpg|jpeg|png|webp|avif)(?:[?#]|$)/i.test(v);
      let fromCdn = false;
      try {
        fromCdn = IMAGE_CDN_HOSTS.some((h) => new URL(v).hostname === h);
      } catch {
      }
      if ((hasExt || fromCdn) && !isMarketingImage(v)) {
        urls.add(v);
      }
    }
    if (v && typeof v === "object") collectImageUrls(v, urls);
  }
  return [...urls];
}
__name(collectImageUrls, "collectImageUrls");
function dig(obj, path) {
  return path.split(".").reduce((o, k) => o?.[k], obj);
}
__name(dig, "dig");
function detectBroker(url) {
  const map = {
    erikolsson: "Erik Olsson",
    husmanhagberg: "Husman Hagberg",
    bjurfors: "Bjurfors",
    fastighetsbyran: "Fastighetsbyr\xE5n",
    maklarringen: "M\xE4klarringen",
    notar: "Notar",
    edwardpartners: "Edward & Partners",
    lansfast: "L\xE4nsf\xF6rs\xE4kringar",
    skandiamaklarna: "Skandia M\xE4klarna",
    historiskahem: "Historiska Hem",
    svenskfast: "Svensk Fastighetsf\xF6rmedling",
    karlamakleri: "Karla M\xE4kleri",
    cbreresidential: "CBRE",
    vasastan: "Vasastan M\xE4kleri",
    bergetsro: "Bergets Ro Fastighetsf\xF6rmedling",
    tradition: "Tradition Fastighetsmäklare",
    franzondurietz: "Franzon Du Rietz"
  };
  for (const [key, name] of Object.entries(map)) {
    if (url.includes(key)) return name;
  }
  return "M\xE4klare";
}
__name(detectBroker, "detectBroker");
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...CORS, "Content-Type": "application/json" }
  });
}
__name(json, "json");
function getImageDimensions(buf) {
  const view = new DataView(buf);
  if (view.byteLength < 24) return null;
  if (view.getUint8(0) === 255 && view.getUint8(1) === 216) {
    let off = 2;
    while (off < view.byteLength - 9) {
      if (view.getUint8(off) !== 255) break;
      const marker = view.getUint8(off + 1);
      if (marker === 255) { off++; continue; }
      if (marker === 217 || marker === 218) break;
      if (off + 3 >= view.byteLength) break;
      const segLen = view.getUint16(off + 2);
      if (marker >= 192 && marker <= 207 && marker !== 196 && marker !== 200 && marker !== 204) {
        if (off + 8 < view.byteLength) {
          return { height: view.getUint16(off + 5), width: view.getUint16(off + 7) };
        }
      }
      off += 2 + segLen;
    }
    return null;
  }
  if (view.getUint32(0) === 2303741511 && view.getUint32(4) === 218765834) {
    return { width: view.getUint32(16), height: view.getUint32(20) };
  }
  if (view.getUint32(0) === 1380533830 && view.getUint32(8) === 1464156752 && view.byteLength >= 30) {
    const vp8 = view.getUint32(12);
    if (vp8 === 1448097824) {
      return { width: (view.getUint16(26, true) & 16383) + 1, height: (view.getUint16(28, true) & 16383) + 1 };
    }
    if (vp8 === 1448097868 && view.byteLength >= 25) {
      const bits = view.getUint32(21, true);
      return { width: (bits & 16383) + 1, height: (bits >> 14 & 16383) + 1 };
    }
  }
  return null;
}
__name(getImageDimensions, "getImageDimensions");
export {
  worker_default as default
};
//# sourceMappingURL=worker.js.map
