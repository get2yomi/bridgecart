const PAGE = __HTML__;
const STYLES = __CSS__;
const APP = __APP__;

const textResponse = (body, contentType, status = 200) => new Response(body, {
  status,
  headers: {
    "content-type": `${contentType}; charset=utf-8`,
    "cache-control": "no-cache"
  }
});

function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
  });
}

function isUnsafeHost(hostname) {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host === "::1" || host.endsWith(".local")) return true;
  if (/^(0|10|127|169\.254|192\.168)\./.test(host)) return true;
  const match = host.match(/^172\.(\d{1,3})\./);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  return false;
}

function safeUrl(value) {
  let url;
  try { url = new URL(value); } catch { throw new Error("Enter a complete product URL."); }
  if (!["http:", "https:"].includes(url.protocol) || isUnsafeHost(url.hostname)) {
    throw new Error("This URL cannot be checked.");
  }
  return url;
}

async function fetchProductPage(initialUrl) {
  let current = safeUrl(initialUrl);
  for (let redirects = 0; redirects < 5; redirects += 1) {
    const response = await fetch(current.toString(), {
      redirect: "manual",
      headers: {
        "accept": "text/html,application/xhtml+xml",
        "accept-language": "en-US,en;q=0.9",
        "user-agent": "Mozilla/5.0 (compatible; NaijaBridgeProductLookup/1.0)"
      }
    });
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("The retailer returned an incomplete redirect.");
      current = safeUrl(new URL(location, current).toString());
      continue;
    }
    if (!response.ok) {
      if ([401, 403, 429].includes(response.status)) throw new Error("This retailer blocked automatic price lookup. Enter the price manually.");
      throw new Error(`The retailer returned status ${response.status}.`);
    }
    const type = response.headers.get("content-type") || "";
    if (!type.includes("text/html") && !type.includes("application/xhtml")) throw new Error("This link is not a product webpage.");
    const length = Number(response.headers.get("content-length") || 0);
    if (length > 4_000_000) throw new Error("This product page is too large to analyze safely.");
    const html = (await response.text()).slice(0, 4_000_000);
    return { html, finalUrl: current.toString() };
  }
  throw new Error("The product link redirected too many times.");
}

async function fetchMicrolink(productUrl) {
  const endpoint = new URL("https://api.microlink.io/");
  endpoint.searchParams.set("url", safeUrl(productUrl).toString());
  endpoint.searchParams.set("meta", "true");
  const response = await fetch(endpoint.toString(), {
    headers: { "accept": "application/json" }
  });
  if (!response.ok) throw new Error("Microlink could not retrieve this page.");
  const payload = await response.json();
  if (payload?.status !== "success" || !payload?.data) {
    throw new Error(payload?.message || "Microlink could not retrieve this page.");
  }
  const data = payload.data;
  const rawImage = typeof data.image === "object" ? data.image?.url : data.image;
  return {
    title: typeof data.title === "string" ? data.title.slice(0, 180) : null,
    image: typeof rawImage === "string" ? rawImage : null,
    price: numericPrice(data.price?.value, data.price),
    currency: data.price?.currency || "USD",
    finalUrl: data.url || productUrl,
    source: "Microlink"
  };
}

function decodeText(value = "") {
  return value.replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").trim();
}

function metaContent(html, key) {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const patterns = [
    new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${escaped}["'][^>]+content=["']([^"']+)["'][^>]*>`, "i"),
    new RegExp(`<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name|itemprop)=["']${escaped}["'][^>]*>`, "i")
  ];
  for (const pattern of patterns) {
    const match = html.match(pattern);
    if (match) return decodeText(match[1]);
  }
  return null;
}

function walkForProduct(value) {
  if (!value || typeof value !== "object") return null;
  if (Array.isArray(value)) {
    for (const entry of value) { const found = walkForProduct(entry); if (found) return found; }
    return null;
  }
  const types = Array.isArray(value["@type"]) ? value["@type"] : [value["@type"]];
  if (types.some(type => String(type).toLowerCase() === "product")) return value;
  for (const key of ["@graph", "mainEntity", "itemListElement"] ) {
    const found = walkForProduct(value[key]);
    if (found) return found;
  }
  return null;
}

function firstOffer(offers) {
  if (Array.isArray(offers)) return offers[0] || {};
  return offers && typeof offers === "object" ? offers : {};
}

function numericPrice(...values) {
  for (const value of values) {
    const number = Number(String(value ?? "").replace(/[^0-9.]/g, ""));
    if (Number.isFinite(number) && number > 0) return number;
  }
  return null;
}

function shippingFromOffer(offer) {
  const details = Array.isArray(offer.shippingDetails) ? offer.shippingDetails : offer.shippingDetails ? [offer.shippingDetails] : [];
  for (const detail of details) {
    const rate = detail?.shippingRate;
    const value = typeof rate === "object" ? rate.value ?? rate.minValue : rate;
    if (value === 0 || value === "0" || value === "0.00") return { freeShipping: true, shippingCost: 0 };
    const number = numericPrice(value);
    if (number !== null) return { freeShipping: false, shippingCost: number };
  }
  return { freeShipping: null, shippingCost: null };
}

function productImage(product, html, finalUrl) {
  const raw = Array.isArray(product?.image) ? product.image[0] : product?.image;
  const value = typeof raw === "object" ? raw?.url || raw?.contentUrl : raw;
  const candidate = value || metaContent(html, "og:image") || metaContent(html, "twitter:image");
  if (!candidate) return null;
  try {
    const url = new URL(candidate, finalUrl);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch { return null; }
}

function extractProduct(html, finalUrl) {
  let product = null;
  const scripts = html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi);
  for (const match of scripts) {
    try {
      const parsed = JSON.parse(match[1].trim());
      product = walkForProduct(parsed);
      if (product) break;
    } catch { /* Ignore malformed retailer markup. */ }
  }

  const offer = firstOffer(product?.offers);
  const price = numericPrice(
    offer.price,
    offer.lowPrice,
    offer.priceSpecification?.price,
    product?.offers?.lowPrice,
    metaContent(html, "product:price:amount"),
    metaContent(html, "og:price:amount"),
    metaContent(html, "price")
  );
  const currency = offer.priceCurrency || product?.offers?.priceCurrency || metaContent(html, "product:price:currency") || "USD";
  const title = decodeText(product?.name || metaContent(html, "og:title") || metaContent(html, "twitter:title") || "");
  const shipping = shippingFromOffer(offer);

  const image = productImage(product, html, finalUrl);
  return { title: title.slice(0, 180) || null, price, currency, image, ...shipping, finalUrl };
}

export default {
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method !== "GET") return jsonResponse({ error: "Method not allowed" }, 405);
    if (url.pathname === "/") return textResponse(PAGE, "text/html");
    if (url.pathname === "/styles.css") return textResponse(STYLES, "text/css");
    if (url.pathname === "/app.js") return textResponse(APP, "application/javascript");
    if (url.pathname === "/api/product") {
      const productUrl = url.searchParams.get("url");
      if (!productUrl) return jsonResponse({ error: "A product URL is required." }, 400);
      try {
        let microlink = null;
        let direct = null;
        let microlinkError = null;
        try { microlink = await fetchMicrolink(productUrl); } catch (error) { microlinkError = error; }
        try {
          const page = await fetchProductPage(microlink?.finalUrl || productUrl);
          direct = extractProduct(page.html, page.finalUrl);
        } catch { /* Retailers may block direct extraction even when Microlink metadata works. */ }

        if (!microlink && !direct) throw microlinkError || new Error("Unable to analyze this product.");
        return jsonResponse({
          title: direct?.title || microlink?.title || null,
          image: direct?.image || microlink?.image || null,
          price: direct?.price || microlink?.price || null,
          currency: direct?.currency || microlink?.currency || "USD",
          freeShipping: direct?.freeShipping ?? null,
          shippingCost: direct?.shippingCost ?? null,
          finalUrl: direct?.finalUrl || microlink?.finalUrl || productUrl,
          source: microlink ? "Microlink + retailer data" : "retailer data"
        });
      } catch (error) {
        return jsonResponse({ error: error instanceof Error ? error.message : "Unable to analyze this product." }, 422);
      }
    }
    return textResponse("Not found", "text/plain", 404);
  }
};
