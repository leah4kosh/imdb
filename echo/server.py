"""Echo - a styled chat app powered by Claude, with saved chats and image creation.

Run:  python server.py   (then open http://localhost:8000)
Without API keys it runs in demo mode so the whole interface can be tried out.
"""

import asyncio
import base64
import html
import json
import os
import queue
import random
import re
import sqlite3
import threading
import time
import uuid
from pathlib import Path

import anthropic
import httpx2
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

ROOT = Path(__file__).resolve().parent
STATIC_DIR = ROOT / "static"
DATA_DIR = ROOT / "data"
MEDIA_DIR = DATA_DIR / "media"
DB_PATH = DATA_DIR / "echo.db"


def load_env_file(path: Path) -> None:
    """Minimal .env loader so no extra dependency is needed."""
    if not path.exists():
        return
    for line in path.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        value = value.strip().strip('"').strip("'")
        if value:
            os.environ.setdefault(key.strip(), value)


load_env_file(ROOT / ".env")

MODEL = os.environ.get("ECHO_MODEL", "claude-opus-5-5")
EFFORT = os.environ.get("ECHO_EFFORT", "medium")
IMAGE_MODEL = os.environ.get("ECHO_IMAGE_MODEL", "gpt-image-1")
HAS_CLAUDE = bool(os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN"))
HAS_IMAGES = bool(os.environ.get("OPENAI_API_KEY"))

MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024
ALLOWED_MEDIA_TYPES = {"image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif"}

SYSTEM_PROMPT = """You are a warm, helpful and witty assistant inside a chat app.
- Reply in the language the user writes in (often Hebrew). Use Markdown when it helps: lists, headings, code blocks.
- Do not introduce yourself by name and do not call yourself "Echo"; just help.
- When the user asks for a picture, drawing, illustration, logo or any image, call the create_image tool exactly once.
  Write the tool's prompt in rich, vivid English (subject, style, colors, lighting, mood), faithful to what the user asked.
  After the image is created, add one short, friendly sentence in the user's language - do not describe the image at length.
- If the user did not ask for an image, never call create_image."""

IMAGE_TOOL = {
    "name": "create_image",
    "description": (
        "Create one image from a text description and show it to the user. "
        "Use only when the user asks for an image, drawing, picture, illustration or similar."
    ),
    "strict": True,
    "input_schema": {
        "type": "object",
        "properties": {
            "prompt": {
                "type": "string",
                "description": "Detailed English description of the image to create.",
            },
            "caption": {
                "type": "string",
                "description": "A very short caption in the user's language.",
            },
        },
        "required": ["prompt", "caption"],
        "additionalProperties": False,
    },
}

# --------------------------------------------------------------------------- storage

db_lock = threading.Lock()


def db() -> sqlite3.Connection:
    conn = sqlite3.connect(DB_PATH, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    return conn


def init_db() -> None:
    DATA_DIR.mkdir(exist_ok=True)
    MEDIA_DIR.mkdir(exist_ok=True)
    with db() as conn:
        conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS chats (
                id TEXT PRIMARY KEY,
                title TEXT NOT NULL,
                pinned INTEGER NOT NULL DEFAULT 0,
                created REAL NOT NULL,
                updated REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS messages (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
                role TEXT NOT NULL,
                text TEXT NOT NULL DEFAULT '',
                attachments TEXT NOT NULL DEFAULT '[]',
                images TEXT NOT NULL DEFAULT '[]',
                created REAL NOT NULL
            );
            CREATE INDEX IF NOT EXISTS idx_messages_chat ON messages(chat_id, id);
            """
        )


def chat_row(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "title": row["title"],
        "pinned": bool(row["pinned"]),
        "created": row["created"],
        "updated": row["updated"],
    }


def message_row(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "role": row["role"],
        "text": row["text"],
        "attachments": json.loads(row["attachments"]),
        "images": json.loads(row["images"]),
        "created": row["created"],
    }


def get_chat_or_404(conn: sqlite3.Connection, chat_id: str) -> sqlite3.Row:
    row = conn.execute("SELECT * FROM chats WHERE id = ?", (chat_id,)).fetchone()
    if row is None:
        raise HTTPException(404, "chat not found")
    return row


def insert_message(chat_id: str, role: str, text: str, attachments=None, images=None) -> dict:
    now = time.time()
    with db_lock, db() as conn:
        cur = conn.execute(
            "INSERT INTO messages (chat_id, role, text, attachments, images, created) VALUES (?, ?, ?, ?, ?, ?)",
            (chat_id, role, text, json.dumps(attachments or []), json.dumps(images or []), now),
        )
        conn.execute("UPDATE chats SET updated = ? WHERE id = ?", (now, chat_id))
        row = conn.execute("SELECT * FROM messages WHERE id = ?", (cur.lastrowid,)).fetchone()
    return message_row(row)


def save_media(data: bytes, ext: str) -> str:
    name = f"{uuid.uuid4().hex}.{ext}"
    (MEDIA_DIR / name).write_bytes(data)
    return f"/media/{name}"


def media_path(url: str) -> Path | None:
    if not url.startswith("/media/"):
        return None
    path = (MEDIA_DIR / url.removeprefix("/media/")).resolve()
    return path if path.is_relative_to(MEDIA_DIR) and path.exists() else None


# --------------------------------------------------------------------------- images


def generate_image(prompt: str) -> str:
    """Create one image and return its URL. Uses the OpenAI images API when a key is set."""
    if not HAS_IMAGES:
        return demo_image(prompt)
    response = httpx2.post(
        "https://api.openai.com/v1/images/generations",
        headers={"Authorization": f"Bearer {os.environ['OPENAI_API_KEY']}"},
        json={"model": IMAGE_MODEL, "prompt": prompt, "size": "1024x1024", "n": 1},
        timeout=180,
    )
    response.raise_for_status()
    item = response.json()["data"][0]
    if item.get("b64_json"):
        return save_media(base64.b64decode(item["b64_json"]), "png")
    downloaded = httpx2.get(item["url"], timeout=60)
    downloaded.raise_for_status()
    return save_media(downloaded.content, "png")


DEMO_EMOJI = [
    (("cat", "חתול", "kitten"), "🐱"),
    (("dog", "כלב", "puppy"), "🐶"),
    (("astronaut", "אסטרונאוט", "space", "חלל", "rocket"), "🚀"),
    (("flower", "פרח", "garden"), "🌸"),
    (("sea", "ים", "ocean", "water", "מים"), "🌊"),
    (("unicorn", "חד קרן", "חד-קרן"), "🦄"),
    (("pizza", "פיצה"), "🍕"),
    (("heart", "לב", "love"), "💖"),
]


def demo_image(prompt: str) -> str:
    """A pretty placeholder so image creation can be tried without an image API key."""
    lowered = prompt.lower()
    emojis = [emoji for words, emoji in DEMO_EMOJI if any(w in lowered for w in words)] or ["✨"]
    palettes = [("#ffd1dc", "#f7a1c4", "#c97b9a"), ("#b9e8ff", "#5cc8f0", "#2a86c4"), ("#d4f0d0", "#9fd8a8", "#4f9b6c")]
    a, b, c = random.choice(palettes)
    label = html.escape(prompt[:70] + ("…" if len(prompt) > 70 else ""))
    big = " ".join(emojis[:3])
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="{a}"/><stop offset="1" stop-color="{b}"/></linearGradient>
    <radialGradient id="r" cx="0.5" cy="0.45" r="0.5"><stop offset="0" stop-color="#fff" stop-opacity="0.7"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></radialGradient>
  </defs>
  <rect width="1024" height="1024" fill="url(#g)"/>
  <circle cx="512" cy="470" r="380" fill="url(#r)"/>
  <circle cx="512" cy="470" r="250" fill="none" stroke="#fff" stroke-opacity="0.5" stroke-width="6"/>
  <circle cx="512" cy="470" r="330" fill="none" stroke="#fff" stroke-opacity="0.3" stroke-width="4"/>
  <circle cx="512" cy="470" r="410" fill="none" stroke="#fff" stroke-opacity="0.15" stroke-width="3"/>
  <text x="512" y="540" font-size="190" text-anchor="middle">{big}</text>
  <text x="512" y="880" font-size="34" text-anchor="middle" fill="{c}" font-family="sans-serif">{label}</text>
  <text x="512" y="940" font-size="26" text-anchor="middle" fill="{c}" fill-opacity="0.75" font-family="sans-serif">demo image · add OPENAI_API_KEY for real images</text>
</svg>"""
    return save_media(svg.encode("utf-8"), "svg")


# --------------------------------------------------------------------------- Claude


def build_history(messages: list[dict]) -> list[dict]:
    """Turn saved messages into Messages API turns (text + attached images)."""
    history = []
    for msg in messages:
        if msg["role"] == "user":
            content = []
            for att in msg["attachments"]:
                path = media_path(att["url"])
                if path is None:
                    continue
                content.append(
                    {
                        "type": "image",
                        "source": {
                            "type": "base64",
                            "media_type": att["media_type"],
                            "data": base64.standard_b64encode(path.read_bytes()).decode("ascii"),
                        },
                    }
                )
            content.append({"type": "text", "text": msg["text"] or "(image)"})
            history.append({"role": "user", "content": content})
        else:
            text = msg["text"]
            for img in msg["images"]:
                text += f"\n\n[An image was created and shown to the user: {img['prompt']}]"
            history.append({"role": "assistant", "content": text.strip() or "(no reply)"})
    return history


def echo_content(content) -> list:
    """Content to send back in the tool loop, following the fallback echo rules."""
    blocks = [b.model_dump(exclude_none=True) if hasattr(b, "model_dump") else b for b in content]
    last_fallback = max((i for i, b in enumerate(blocks) if b.get("type") == "fallback"), default=-1)
    if last_fallback < 0:
        return blocks
    dropped = {"thinking", "redacted_thinking", "tool_use"}
    return [b for i, b in enumerate(blocks) if i > last_fallback or b.get("type") not in dropped]


def claude_reply(history: list[dict], emit):
    """Stream Claude's answer, running the image tool when Claude asks for it."""
    client = anthropic.Anthropic()
    messages = list(history)
    for _ in range(3):  # one image per reply; a few rounds is plenty
        with client.beta.messages.stream(
            model=MODEL,
            max_tokens=16000,
            system=SYSTEM_PROMPT,
            messages=messages,
            tools=[IMAGE_TOOL],
            tool_choice={"type": "auto", "disable_parallel_tool_use": True},
            output_config={"effort": EFFORT},
            betas=["server-side-fallback-2026-07-01"],
            fallbacks="default",
        ) as stream:
            for event in stream:
                if event.type == "content_block_delta" and event.delta.type == "text_delta":
                    emit("delta", text=event.delta.text)
            response = stream.get_final_message()

        if response.stop_reason == "refusal":
            emit("delta", text="\n\nמצטער, את הבקשה הזאת אני לא יכול לעשות. אפשר לנסות לנסח אחרת? 🙏")
            return
        tool_uses = [b for b in response.content if b.type == "tool_use"]
        if not tool_uses or response.stop_reason == "max_tokens":
            return

        results = []
        for block in tool_uses:
            args = block.input if isinstance(block.input, dict) else {}
            prompt = args.get("prompt")
            if block.name != "create_image" or not isinstance(prompt, str) or not prompt.strip():
                results.append({"type": "tool_result", "tool_use_id": block.id, "is_error": True, "content": "invalid input"})
                continue
            emit("image_pending", prompt=prompt)
            try:
                url = generate_image(prompt)
            except Exception as exc:  # image service errors are reported back to Claude
                emit("image_failed")
                results.append(
                    {"type": "tool_result", "tool_use_id": block.id, "is_error": True, "content": f"Image service error: {exc}"}
                )
                continue
            emit("image", url=url, prompt=prompt, caption=args.get("caption", ""))
            results.append({"type": "tool_result", "tool_use_id": block.id, "content": "The image was created and is now shown to the user."})
        messages.append({"role": "assistant", "content": echo_content(response.content)})
        messages.append({"role": "user", "content": results})


# --------------------------------------------------------------------------- demo mode

IMAGE_WORDS = re.compile(r"(צייר|תיצור\S* (לי )?תמונ|צור (לי )?תמונ|תמונה של|איור של|\bdraw|\bpaint|picture of|image of)", re.I)

DEMO_REPLIES = [
    "היי! 👋 אני כרגע ב**מצב דמו**, כך שהתשובות שלי מוכנות מראש.\n\n"
    "כדי לקבל תשובות אמיתיות, צריך להוסיף מפתח `ANTHROPIC_API_KEY` לקובץ `.env`.\n\n"
    "בינתיים אפשר לנסות:\n- לבקש ממני **לצייר משהו** 🎨\n- לפתוח שיחה חדשה ולחזור לשיחות קודמות\n- להחליף ערכת צבעים למעלה ✨",
    "שאלה מעולה! 🌟 במצב דמו אני רק מדגים איך הכל נראה.\n\n"
    "## מה אפשר לעשות כאן\n1. לכתוב הודעות ולראות אותן נשמרות\n2. לצרף תמונה עם 📎\n3. לבקש ציור\n\n"
    "```python\nprint('שלום עולם!')\n```",
    "אני אוהב את הכיוון! 💡 ברגע שיחובר מפתח API, אוכל לענות על הכל באמת: שיעורי בית, רעיונות, קוד, סיפורים ועוד.",
]


def demo_reply(user_text: str, emit) -> None:
    if IMAGE_WORDS.search(user_text or ""):
        prompt = user_text.strip()
        for word in "רגע, אני מצייר את זה בשבילך… 🎨".split(" "):
            emit("delta", text=word + " ")
            time.sleep(0.05)
        emit("image_pending", prompt=prompt)
        time.sleep(1.6)
        emit("image", url=generate_image(prompt) if HAS_IMAGES else demo_image(prompt), prompt=prompt, caption="")
        for word in "\n\nהנה! ✨ (זו תמונת דמו, עם מפתח של שירות תמונות זה יהיה ציור אמיתי)".split(" "):
            emit("delta", text=word + " ")
            time.sleep(0.04)
        return
    for word in re.split(r"(\s+)", random.choice(DEMO_REPLIES)):
        emit("delta", text=word)
        time.sleep(0.025)


# --------------------------------------------------------------------------- API

app = FastAPI(title="Echo")
init_db()


class NewChat(BaseModel):
    title: str | None = None


class ChatUpdate(BaseModel):
    title: str | None = None
    pinned: bool | None = None


class Attachment(BaseModel):
    data: str  # base64, no data: prefix
    media_type: str


class NewMessage(BaseModel):
    text: str = ""
    attachments: list[Attachment] = []


@app.get("/api/status")
def status():
    return {"claude": HAS_CLAUDE, "images": HAS_IMAGES, "model": MODEL if HAS_CLAUDE else "demo"}


@app.get("/api/chats")
def list_chats():
    with db() as conn:
        rows = conn.execute("SELECT * FROM chats ORDER BY pinned DESC, updated DESC").fetchall()
    return [chat_row(r) for r in rows]


@app.post("/api/chats")
def create_chat(body: NewChat):
    now = time.time()
    chat_id = uuid.uuid4().hex[:12]
    with db_lock, db() as conn:
        conn.execute(
            "INSERT INTO chats (id, title, pinned, created, updated) VALUES (?, ?, 0, ?, ?)",
            (chat_id, (body.title or "שיחה חדשה")[:80], now, now),
        )
        row = conn.execute("SELECT * FROM chats WHERE id = ?", (chat_id,)).fetchone()
    return chat_row(row)


@app.get("/api/chats/{chat_id}")
def get_chat(chat_id: str):
    with db() as conn:
        chat = get_chat_or_404(conn, chat_id)
        rows = conn.execute("SELECT * FROM messages WHERE chat_id = ? ORDER BY id", (chat_id,)).fetchall()
    return {**chat_row(chat), "messages": [message_row(r) for r in rows]}


@app.patch("/api/chats/{chat_id}")
def update_chat(chat_id: str, body: ChatUpdate):
    with db_lock, db() as conn:
        get_chat_or_404(conn, chat_id)
        if body.title is not None and body.title.strip():
            conn.execute("UPDATE chats SET title = ? WHERE id = ?", (body.title.strip()[:80], chat_id))
        if body.pinned is not None:
            conn.execute("UPDATE chats SET pinned = ? WHERE id = ?", (int(body.pinned), chat_id))
        row = conn.execute("SELECT * FROM chats WHERE id = ?", (chat_id,)).fetchone()
    return chat_row(row)


@app.delete("/api/chats/{chat_id}")
def delete_chat(chat_id: str):
    with db_lock, db() as conn:
        get_chat_or_404(conn, chat_id)
        conn.execute("DELETE FROM messages WHERE chat_id = ?", (chat_id,))
        conn.execute("DELETE FROM chats WHERE id = ?", (chat_id,))
    return {"ok": True}


def sse(event_type: str, **data) -> str:
    return f"data: {json.dumps({'type': event_type, **data}, ensure_ascii=False)}\n\n"


class Stopped(Exception):
    """Raised inside a reply's worker when the user pressed stop."""


class Reply:
    """One assistant reply, generated in a worker thread and saved when it ends (or is stopped)."""

    def __init__(self, chat_id: str, history: list[dict]):
        self.chat_id = chat_id
        self.history = history
        self.events: queue.Queue[str] = queue.Queue()
        self.text_parts: list[str] = []
        self.images: list[dict] = []
        self.stopped = threading.Event()
        self.finished = threading.Event()
        self.message: dict | None = None
        self.error: str | None = None

    def emit(self, kind: str, **data) -> None:
        if self.stopped.is_set():
            raise Stopped
        if kind == "delta":
            self.text_parts.append(data["text"])
        elif kind == "image":
            # "at" marks where in the text the image appeared, so it renders in place.
            data["at"] = len("".join(self.text_parts))
            self.images.append({"url": data["url"], "prompt": data["prompt"], "caption": data.get("caption", ""), "at": data["at"]})
        self.events.put(sse(kind, **data))

    def run(self) -> None:
        try:
            if HAS_CLAUDE:
                claude_reply(build_history(self.history), self.emit)
            else:
                demo_reply(self.history[-1]["text"] if self.history else "", self.emit)
        except Stopped:
            pass
        except anthropic.AuthenticationError:
            self.error = "מפתח ה-API של Claude לא תקין. כדאי לבדוק את הקובץ .env"
        except anthropic.RateLimitError:
            self.error = "יותר מדי בקשות כרגע. נסו שוב בעוד רגע ⏳"
        except anthropic.APIConnectionError:
            self.error = "אין חיבור לשרת. בדקו את האינטרנט ונסו שוב."
        except anthropic.APIStatusError as exc:
            self.error = f"שגיאה מהשרת ({exc.status_code}). נסו שוב."
        except Exception as exc:  # keep the stream alive and tell the user
            self.error = f"משהו השתבש: {exc}"
        finally:
            try:
                self.message = self.save()
            finally:
                with replies_lock:
                    if active_replies.get(self.chat_id) is self:
                        del active_replies[self.chat_id]
                self.finished.set()

    def save(self) -> dict | None:
        raw = "".join(self.text_parts)
        text = raw.strip()
        if not text and not self.images:
            return None
        lead = len(raw) - len(raw.lstrip())
        for img in self.images:
            img["at"] = max(0, min(len(text), img["at"] - lead))
        return insert_message(self.chat_id, "assistant", text, images=self.images)


replies_lock = threading.Lock()
active_replies: dict[str, Reply] = {}


def stop_active_reply(chat_id: str) -> None:
    """Stop a reply still running for this chat and wait until its partial text is saved."""
    with replies_lock:
        reply = active_replies.get(chat_id)
    if reply is not None:
        reply.stopped.set()
        reply.finished.wait(30)


def stream_reply(chat_id: str, first_events: list[str]) -> StreamingResponse:
    """Start the assistant's reply and stream it to the browser as server-sent events."""
    with db() as conn:
        rows = conn.execute("SELECT * FROM messages WHERE chat_id = ? ORDER BY id", (chat_id,)).fetchall()
    reply = Reply(chat_id, [message_row(r) for r in rows])
    with replies_lock:
        active_replies[chat_id] = reply
    threading.Thread(target=reply.run, daemon=True).start()

    async def generator():
        try:
            for event in first_events:
                yield event
            while True:
                finished = reply.finished.is_set()
                while not reply.events.empty():
                    yield reply.events.get_nowait()
                if finished:
                    break
                await asyncio.sleep(0.03)
            if reply.error:
                yield sse("error", message=reply.error)
            yield sse("done", message=reply.message)
        finally:
            reply.stopped.set()  # the browser went away (stop button): end the worker early

    return StreamingResponse(generator(), media_type="text/event-stream", headers={"Cache-Control": "no-cache"})


@app.post("/api/chats/{chat_id}/messages")
def send_message(chat_id: str, body: NewMessage):
    if not body.text.strip() and not body.attachments:
        raise HTTPException(400, "empty message")
    stop_active_reply(chat_id)
    with db() as conn:
        chat = get_chat_or_404(conn, chat_id)
        is_first = conn.execute("SELECT COUNT(*) FROM messages WHERE chat_id = ?", (chat_id,)).fetchone()[0] == 0

    attachments = []
    for att in body.attachments[:4]:
        ext = ALLOWED_MEDIA_TYPES.get(att.media_type)
        if ext is None:
            raise HTTPException(400, "unsupported image type")
        raw = base64.b64decode(att.data, validate=True)
        if len(raw) > MAX_ATTACHMENT_BYTES:
            raise HTTPException(413, "image too large")
        attachments.append({"url": save_media(raw, ext), "media_type": att.media_type})

    user_message = insert_message(chat_id, "user", body.text.strip(), attachments=attachments)
    first_events = [sse("user_saved", message=user_message)]

    if is_first and chat["title"] == "שיחה חדשה":
        title = re.sub(r"\s+", " ", body.text).strip() or "תמונה"
        title = title[:40] + ("…" if len(title) > 40 else "")
        update_chat(chat_id, ChatUpdate(title=title))
        first_events.append(sse("title", title=title))

    return stream_reply(chat_id, first_events)


@app.post("/api/chats/{chat_id}/regenerate")
def regenerate(chat_id: str):
    stop_active_reply(chat_id)
    with db_lock, db() as conn:
        get_chat_or_404(conn, chat_id)
        last = conn.execute("SELECT * FROM messages WHERE chat_id = ? ORDER BY id DESC LIMIT 1", (chat_id,)).fetchone()
        if last is None:
            raise HTTPException(400, "nothing to regenerate")
        if last["role"] == "assistant":
            conn.execute("DELETE FROM messages WHERE id = ?", (last["id"],))
    return stream_reply(chat_id, [])


app.mount("/media", StaticFiles(directory=MEDIA_DIR), name="media")
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


@app.get("/")
def index():
    return FileResponse(STATIC_DIR / "index.html")


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("ECHO_PORT", "8000"))
    mode = "Claude" if HAS_CLAUDE else "demo mode"
    print(f"✨ Echo is running ({mode}) → http://localhost:{port}")
    uvicorn.run(app, host="0.0.0.0", port=port)
