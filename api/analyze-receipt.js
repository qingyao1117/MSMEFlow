const MAX_IMAGE_BYTES = 3 * 1024 * 1024;

function send(res, status, body) {
  res.status(status).json(body);
}

function parseJson(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  return JSON.parse(fenced ? fenced[1] : text);
}

export default async function handler(req, res) {
  if (req.method !== "POST") return send(res, 405, { error: "Method not allowed" });
  if (!process.env.OPENAI_API_KEY) return send(res, 503, { error: "Receipt AI is not configured yet." });

  const { imageDataUrl, fileName = "receipt" } = req.body || {};
  if (typeof imageDataUrl !== "string" || !/^data:image\/(jpeg|jpg|png|webp);base64,/i.test(imageDataUrl)) {
    return send(res, 400, { error: "Upload a JPG, PNG, or WEBP receipt." });
  }
  if (Buffer.byteLength(imageDataUrl, "utf8") > MAX_IMAGE_BYTES * 1.4) {
    return send(res, 413, { error: "Use a receipt image smaller than 3 MB." });
  }

  const instruction = `Read this Malaysian business receipt. Return JSON only, no markdown, using this exact shape:
{"merchant":"string or Unknown","receipt_date":"YYYY-MM-DD or Unknown","category":"supplies|inventory|utilities|transport|other","total":number,"currency":"MYR","summary":"short description","confidence":"high|medium|low"}.
Use 0 for an unreadable total. File name: ${fileName}`;

  try {
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: JSON.stringify({
        model: "gpt-4.1-mini",
        input: [{ role: "user", content: [
          { type: "input_text", text: instruction },
          { type: "input_image", image_url: imageDataUrl, detail: "high" }
        ] }]
      })
    });
    if (!response.ok) throw new Error(`AI request failed (${response.status})`);
    const result = await response.json();
    const receipt = parseJson(result.output_text || "");
    return send(res, 200, { receipt });
  } catch (error) {
    console.error("Receipt analysis failed", error.message);
    return send(res, 502, { error: "Could not read this receipt. Try a clearer photo." });
  }
}

