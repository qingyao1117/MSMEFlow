"""MSMEFlow WhatsApp ingestion API powered by OpenAI."""
import os
import json
from datetime import datetime, timezone
from typing import Literal

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
from openai import OpenAI
import uvicorn

load_dotenv()

app = FastAPI(title="MSMEFlow AI API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

client = OpenAI(api_key=os.environ.get("OPENAI_API_KEY"))

orders: list[dict] = []
SUPPORTED_CHANNELS = {"whatsapp", "telegram", "tiktok", "shopee", "lazada", "website"}

class WhatsAppMessage(BaseModel):
    sender: str
    raw_text: str


class InboundOrder(BaseModel):
    sender: str
    raw_text: str
    external_id: str | None = None

SYSTEM_PROMPT = """
You are an intelligent order extraction and business analysis AI for MSMEFlow (a micro-bakery / F&B store).
Extract the customer's intent from messy WhatsApp/SMS/Manglish/Malay messages.

You must respond ONLY with a JSON object containing:
- "customer": string (sender name if mentioned like 'saya Ahmad' or 'for Sarah', otherwise short sender number)
- "product": string (e.g. "2x Brownie Box", "1x Chicken Wrap")
- "quantity": integer (total primary items)
- "addon": string (e.g. "Extra Cheese (+RM5)", "None", or specific special requests)
- "total": float (assume Brownie Box = RM 15, Wrap = RM 11, Cheese add-on = RM 5 unless specified)
- "delivery": string (e.g. "Tomorrow Evening", "Self-Pickup", "Unspecified")
- "status_tag": "Pending Payment"
"""

def extract_order(message: InboundOrder, channel: str) -> dict:
    sender_id = message.sender.split("@")[0]

    try:
        if not os.environ.get("OPENAI_API_KEY"):
            raise RuntimeError("OPENAI_API_KEY is not configured")
        completion = client.chat.completions.create(
            model="gpt-4o-mini",
            response_format={"type": "json_object"},
            messages=[
                {"role": "system", "content": SYSTEM_PROMPT},
                {"role": "user", "content": f"Sender: {sender_id}\nRaw Message: {message.raw_text}"}
            ],
            temperature=0.1
        )
        parsed = json.loads(completion.choices[0].message.content)
        parsed["id"] = message.external_id or f"ORD-{channel[:3].upper()}-{int(datetime.now().timestamp())}"
        parsed["sender"] = message.sender
        parsed["channel"] = channel
        parsed["raw_text"] = message.raw_text
        parsed["status_tag"] = parsed.pop("statusTag", parsed.get("status_tag", "Pending Payment"))

    except Exception as e:
        print(f"OpenAI parsing failed: {e}")
        # Fallback if API credit is low or key is invalid
        parsed = {
            "id": message.external_id or f"ORD-{channel[:3].upper()}-{int(datetime.now().timestamp())}",
            "sender": message.sender,
            "channel": channel,
            "customer": sender_id,
            "product": "1x Brownie Box",
            "quantity": 1,
            "addon": "Standard",
            "total": 15.0,
            "delivery": "Standard Delivery",
            "status_tag": "Pending Payment",
            "raw_text": message.raw_text
        }

    parsed["created_at"] = datetime.now(timezone.utc).isoformat()
    orders.insert(0, parsed)
    print("AI Structured Order:", parsed)
    return parsed


@app.post("/api/ingest/{channel}")
def ingest_channel(channel: str, message: InboundOrder):
    channel = channel.lower()
    if channel not in SUPPORTED_CHANNELS:
        raise HTTPException(status_code=404, detail="Unsupported channel")
    return {"ok": True, "order": extract_order(message, channel)}


@app.post("/api/ingest/whatsapp")
def ingest_whatsapp(message: WhatsAppMessage):
    return {"ok": True, "order": extract_order(InboundOrder(**message.model_dump()), "whatsapp")}


@app.get("/api/orders")
def list_orders():
    return {"orders": orders}


@app.get("/api/channels")
def list_channels():
    return {"channels": sorted(SUPPORTED_CHANNELS)}


@app.post("/api/demo/{channel}")
def create_demo_order(channel: Literal["whatsapp", "telegram", "tiktok", "shopee", "lazada", "website"]):
    samples = {
        "whatsapp": ("Aisha", "Hi, I need 2 ayam wraps with cheese for pickup."),
        "telegram": ("Hana", "Order 3 brownie boxes, delivery tomorrow."),
        "tiktok": ("TikTok Shop buyer", "Checkout: 4 chicken wraps, extra cheese."),
        "shopee": ("Shopee customer", "Order #SHP-1042: 2 Brownie Box"),
        "lazada": ("Lazada customer", "Order #LZD-880: 5 Ayam Wrap"),
        "website": ("Website guest", "1 brownie box, self pickup"),
    }
    sender, raw_text = samples[channel]
    order = extract_order(InboundOrder(sender=sender, raw_text=raw_text), channel)
    return {"ok": True, "order": order}

@app.get("/api/poll/latest")
def poll_latest():
    if orders:
        return {"has_new": True, "data": orders[0]}
    return {"has_new": False}

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)

