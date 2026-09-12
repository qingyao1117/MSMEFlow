const fs = require("fs");
const http = require("http");
const path = require("path");

// Port 8000 is used by the optional Python demo API. Keep the Telegram bridge
// separate so both local services can run during a demo.
const PORT = 8001;
const CHANNELS = ["whatsapp", "telegram", "tiktok", "shopee", "lazada", "website"];
const orders = [];

function loadEnv() {
  const envPath = path.join(__dirname, ".env");
  if (!fs.existsSync(envPath)) return;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.+)\s*$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2];
  }
}

loadEnv();

let telegramOffset = 0;

async function pollTelegram() {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return;
  try {
    const response = await fetch("https://api.telegram.org/bot" + token + "/getUpdates?offset=" + telegramOffset + "&timeout=10");
    const payload = await response.json();
    if (!payload.ok) return console.warn("Telegram polling failed");
    for (const update of payload.result) {
      telegramOffset = update.update_id + 1;
      const message = update.message;
      if (!message?.text) continue;
      const sender = message.from?.username || [message.from?.first_name, message.from?.last_name].filter(Boolean).join(" ") || "Telegram customer";
      const order = await analyseOrder({ sender, raw_text: message.text }, "telegram");
      orders.unshift(order);
      console.log("Telegram order received from " + sender);
    }
  } catch (error) {
    console.warn("Telegram polling unavailable:", error.message);
  }
}

const samples = {
  whatsapp: ["Aisha", "Hi, I need 2 ayam wraps with cheese for pickup."],
  telegram: ["Hana", "Order 3 brownie boxes, delivery tomorrow."],
  tiktok: ["TikTok Shop buyer", "Checkout: 4 chicken wraps, extra cheese."],
  shopee: ["Shopee customer", "Order #SHP-1042: 2 Brownie Box"],
  lazada: ["Lazada customer", "Order #LZD-880: 5 Ayam Wrap"],
  website: ["Website guest", "1 brownie box, self pickup"],
};

function json(response, status, payload) {
  response.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  response.end(JSON.stringify(payload));
}

function fallbackOrder({ sender, raw_text }, channel) {
  const quantity = Number(raw_text.match(/\b(\d+)\b/)?.[1] || 1);
  const isBrownie = /brownie/i.test(raw_text);
  const hasCheese = /cheese/i.test(raw_text);
  const price = isBrownie ? 15 : 11;
  return {
    id: `ORD-${channel.slice(0, 3).toUpperCase()}-${Date.now()}`,
    channel,
    sender,
    customer: sender,
    product: isBrownie ? "Brownie Box" : "Ayam Wrap",
    quantity,
    addon: hasCheese ? "Extra cheese" : "None",
    total: quantity * price + (hasCheese ? quantity * 5 : 0),
    delivery: /pickup|ambil/i.test(raw_text) ? "Self-pickup" : "Unspecified",
    status_tag: "Pending Payment",
    raw_text,
    created_at: new Date().toISOString(),
  };
}

async function analyseOrder(input, channel) {
  const fallback = fallbackOrder(input, channel);
  if (!process.env.OPENAI_API_KEY) return fallback;

  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: "gpt-4o-mini",
        temperature: 0.1,
        response_format: { type: "json_object" },
        messages: [{
          role: "system",
          content: "Extract an F&B order. Return JSON only with customer, product, quantity, addon, total, delivery, and status_tag. Use Malaysian Ringgit."
        }, {
          role: "user",
          content: `Channel: ${channel}\nSender: ${input.sender}\nMessage: ${input.raw_text}`
        }],
      }),
    });
    if (!response.ok) throw new Error(`OpenAI returned ${response.status}`);
    const result = await response.json();
    const extracted = JSON.parse(result.choices[0].message.content);
    return { ...fallback, ...extracted, id: fallback.id, channel, sender: input.sender, raw_text: input.raw_text };
  } catch (error) {
    console.warn("AI analysis unavailable; using fallback:", error.message);
    return fallback;
  }
}

function readBody(request) {
  return new Promise((resolve, reject) => {
    let data = "";
    request.on("data", chunk => { data += chunk; });
    request.on("end", () => {
      try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error("Request body must be valid JSON.")); }
    });
    request.on("error", reject);
  });
}

http.createServer(async (request, response) => {
  const url = new URL(request.url, `http://${request.headers.host}`);
  if (request.method === "OPTIONS") return json(response, 204, {});
  if (request.method === "GET" && url.pathname === "/") {
    response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    return fs.createReadStream(path.join(__dirname, "index.html")).pipe(response);
  }
  if (request.method === "GET" && url.pathname === "/api/orders") return json(response, 200, { orders });
  if (request.method === "GET" && url.pathname === "/api/channels") return json(response, 200, { channels: CHANNELS });

  const demoMatch = url.pathname.match(/^\/api\/demo\/([a-z]+)$/);
  if (request.method === "POST" && demoMatch) {
    const channel = demoMatch[1];
    if (!CHANNELS.includes(channel)) return json(response, 404, { error: "Unsupported channel" });
    const [sender, raw_text] = samples[channel];
    const order = await analyseOrder({ sender, raw_text }, channel);
    orders.unshift(order);
    return json(response, 200, { ok: true, order });
  }

  const ingestMatch = url.pathname.match(/^\/api\/ingest\/([a-z]+)$/);
  if (request.method === "POST" && ingestMatch) {
    const channel = ingestMatch[1];
    if (!CHANNELS.includes(channel)) return json(response, 404, { error: "Unsupported channel" });
    try {
      const input = await readBody(request);
      if (!input.sender || !input.raw_text) return json(response, 400, { error: "sender and raw_text are required" });
      const order = await analyseOrder(input, channel);
      orders.unshift(order);
      return json(response, 200, { ok: true, order });
    } catch (error) {
      return json(response, 400, { error: error.message });
    }
  }

  const refundMatch = url.pathname.match(/^\/api\/orders\/([^/]+)\/refund$/);
  if (request.method === "POST" && refundMatch) {
    const order = orders.find(item => item.id === refundMatch[1]);
    if (!order) return json(response, 404, { error: "Order not found" });
    order.status_tag = "Refunded";
    order.refunded_at = new Date().toISOString();
    return json(response, 200, { ok: true, order });
  }

  return json(response, 404, { error: "Not found" });
}).listen(PORT, "127.0.0.1", () => {
  pollTelegram();
  setInterval(pollTelegram, 12000);
  console.log(`MSMEFlow API is running at http://127.0.0.1:${PORT}`);
});




