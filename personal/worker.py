"""One local messenger client per BeChat account. Only the parent process uses this pipe."""
import asyncio
import base64
import io
import json
import logging
import os
from pathlib import Path
import sys
from datetime import datetime, timezone

# Some native libraries write pairing codes to stdout. Keep the protocol separate.
out = os.fdopen(os.dup(sys.stdout.fileno()), "w", encoding="utf-8", buffering=1)
with open(os.devnull, "w") as quiet:
    os.dup2(quiet.fileno(), 1)
logging.disable(logging.CRITICAL)
os.umask(0o077)

def emit(kind, **payload):
    out.write(json.dumps({"type": kind, **payload}, ensure_ascii=True) + "\n")

def qr(value):
    import qrcode
    image = qrcode.make(value.decode() if isinstance(value, bytes) else str(value))
    data = io.BytesIO()
    image.save(data, format="PNG")
    emit("prompt", mode="qr", image=base64.b64encode(data.getvalue()).decode())

def message(peer, remote, name, text, outgoing, when, history=False, attachment=None):
    if peer is None or remote is None or not (text or attachment):
        return
    if isinstance(when, (int, float)):
        when = datetime.fromtimestamp(when / (1000 if when > 10**11 else 1), timezone.utc)
    at = when.astimezone(timezone.utc).isoformat() if isinstance(when, datetime) else None
    emit("message", peer=str(peer), remote=str(remote), name=str(name or peer)[:200],
         text=str(text or "")[:16000], outgoing=bool(outgoing), at=at, history=history, file=attachment)

class Runtime:
    def __init__(self, directory, recent):
        self.dir = Path(directory)
        self.dir.mkdir(mode=0o700, parents=True, exist_ok=True)
        self.recent = recent
        self.answer = asyncio.Queue(maxsize=1)
        self.active = False
        self.client = None

    def ready(self, identity, label):
        if not identity:
            raise ValueError("missing account identity")
        self.active = True
        emit("ready", identity=str(identity), label=str(label or identity)[:160])

    async def password(self):
        emit("prompt", mode="password")
        return await asyncio.wait_for(self.answer.get(), 150)

    async def resolve(self, peer):
        return str(peer)

async def run():
    from clients import Telegram, WhatsApp, Max
    from vk_account import VK
    kind, directory, recent = sys.argv[1:4]
    worker = {"Telegram": Telegram, "WhatsApp": WhatsApp, "MAX": Max, "ВКонтакте": VK}[kind](directory, recent == "1")
    async def read_commands():
        while True:
            line = await asyncio.to_thread(sys.stdin.buffer.readline)
            if not line:
                return
            try:
                data = json.loads(line)
                op = data.get("op")
                if op == "answer":
                    if not worker.answer.full():
                        worker.answer.put_nowait(data["answer"])
                    result = True
                elif op == "resolve" and worker.active:
                    result = await worker.resolve(data["peer"])
                elif op == "send" and worker.active:
                    result = await worker.send(data["peer"], data["text"], data.get("file"))
                elif op == "logout":
                    try:
                        await asyncio.wait_for(worker.logout(), 6)
                    finally:
                        emit("result", request=data.get("request"), value=True)
                    return
                else:
                    raise ValueError("inactive")
                emit("result", request=data.get("request"), value=result)
            except Exception as exc:
                emit("result", request=data.get("request"), error=type(exc).__name__)
    connection = asyncio.create_task(worker.start())
    controls = asyncio.create_task(read_commands())
    done, pending = await asyncio.wait([connection, controls], return_when=asyncio.FIRST_COMPLETED)
    for task in pending:
        task.cancel()
    for task in done:
        if not task.cancelled() and task.exception():
            emit("error", reason=type(task.exception()).__name__)
    # stdin may be blocked in a thread after a network disconnect. All sessions are durable.
    out.flush()
    os._exit(0)

if __name__ == "__main__":
    # Provider modules import these functions from the running program.
    sys.modules["worker"] = sys.modules[__name__]
    asyncio.run(run())
