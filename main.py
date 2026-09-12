"""MSMEFlow WhatsApp ingestion API powered by OpenAI."""
import os
import json
from collections import deque
from typing import Deque

from fastapi import FastAPI
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

# Initialize OpenAI client with your key
client = OpenAI(api_key="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")

staged_orders: Deque[dict] = deque()

class WhatsAppMessage(BaseModel):
    sender: str
    raw_text: str

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
- "statusTag": "Pending Payment"
"""

@app.post("/api/ingest/whatsapp")
def ingest_whatsapp(message: WhatsAppMessage):
    sender_id = message.sender.split("@")[0]

    try:
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
        parsed["id"] = f"ORD-{sender_id[-4:]}"
        parsed["sender"] = message.sender
        parsed["raw"] = message.raw_text

    except Exception as e:
        print(f"OpenAI parsing failed: {e}")
        # Fallback if API credit is low or key is invalid
        parsed = {
            "id": f"ORD-{sender_id[-4:]}",
            "sender": message.sender,
            "customer": sender_id,
            "product": "1x Brownie Box",
            "quantity": 1,
            "addon": "Standard",
            "total": 15.0,
            "delivery": "Standard Delivery",
            "statusTag": "Pending Payment",
            "raw": message.raw_text
        }

    staged_orders.append(parsed)
    print("AI Structured Order:", parsed)
    return {"ok": True, "staged": parsed}

@app.get("/api/poll/latest")
def poll_latest():
    if staged_orders:
        return {"has_new": True, "data": staged_orders.popleft()}
    return {"has_new": False}

if __name__ == "__main__":
    uvicorn.run(app, host="127.0.0.1", port=8000)