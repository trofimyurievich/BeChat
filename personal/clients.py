import asyncio
import base64
import io
import os
import re
from worker import Runtime, emit, message, qr
from attachments import MAX_DOMAINS, MAX_SIZE, read_document

def payload(name, data):
    if not data or len(data) > 8 * 1024 * 1024:
        return None
    return {"name": str(name or "Файл")[:160], "bytes": base64.b64encode(data).decode()}

class Telegram(Runtime):
    async def start(self):
        from telethon import TelegramClient, events
        from telethon.errors import SessionPasswordNeededError
        from telethon.tl.types import User
        c = self.client = TelegramClient(str(self.dir / "telegram"), int(os.environ["TG_API_ID"]),
              os.environ["TG_API_HASH"], device_model="BeChat", system_version="Server", app_version="1.1.0",
              catch_up=True)
        await c.connect()
        if not await c.is_user_authorized():
            while True:
                ticket = await c.qr_login()
                qr(ticket.url)
                try:
                    await ticket.wait()
                    break
                except asyncio.TimeoutError:
                    continue
                except SessionPasswordNeededError:
                    await c.sign_in(password=await self.password())
                    break
        me = await c.get_me()
        if not me or me.bot:
            raise ValueError("personal account required")
        self.ready(me.id, me.username or me.first_name)
        async def process(m, peer, historical):
            if not isinstance(peer, User) or peer.bot or peer.is_self or peer.id == 777000:
                return
            file = None
            if m.file and 0 < (m.file.size or 0) <= 8 * 1024 * 1024:
                file = payload(m.file.name or ("Вложение" + (m.file.ext or "")), await m.download_media(file=bytes))
            message(peer.id, m.id, " ".join(x for x in [peer.first_name,peer.last_name] if x),
                    m.raw_text or ("[Вложение]" if m.media else ""), m.out, m.date, historical, file)
        @c.on(events.NewMessage)
        async def receive(event):
            if event.is_private:
                await process(event.message, await event.get_chat(), False)
        if self.recent:
            async for dialog in c.iter_dialogs(limit=30):
                if isinstance(dialog.entity, User) and not dialog.entity.bot and not dialog.entity.is_self:
                    recent = [m async for m in c.iter_messages(dialog.entity,limit=25)]
                    for m in reversed(recent):
                        await process(m, dialog.entity, True)
            emit("history_complete")
        await c.run_until_disconnected()

    async def resolve(self, peer):
        from telethon.tl.types import User
        entity = await self.client.get_entity(int(peer) if str(peer).isdigit() else str(peer))
        if not isinstance(entity, User) or entity.bot or entity.is_self or entity.id == 777000:
            raise ValueError("personal recipient required")
        return str(entity.id)

    async def send(self, peer, text, file):
        peer = int(peer)
        if file:
            data = io.BytesIO(base64.b64decode(file["bytes"],validate=True))
            data.name = file["name"]
            reply = await self.client.send_file(peer,data,caption=text,force_document=True,parse_mode=None)
        else:
            reply = await self.client.send_message(peer,text,parse_mode=None,link_preview=False)
        return str(reply.id)

    async def logout(self):
        if self.client and self.client.is_connected():
            await self.client.log_out()

class WhatsApp(Runtime):
    async def start(self):
        from neonize.aioze.client import NewAClient
        from neonize.aioze.events import ConnectedEv, MessageEv, LoggedOutEv, HistorySyncEv
        c = self.client = NewAClient(str(self.dir/"whatsapp.db"))
        @c.qr
        async def show(client, code):
            qr(code)
        @c.event(ConnectedEv)
        async def connected(client, event):
            info = await client.get_me()
            self.ready(info.JID.User, info.PushName or info.JID.User)
        @c.event(LoggedOutEv)
        async def logged_out(client, event):
            emit("revoked")
        @c.event(MessageEv)
        async def receive(client, item):
            source = item.Info.MessageSource
            if item.IsViewOnce or item.IsViewOnceV2 or item.IsViewOnceV2Extension or source.IsGroup or source.Chat.Server not in ("s.whatsapp.net","lid"):
                return
            chat = source.Chat
            if chat.Server == "lid":
                try:
                    pn = await client.get_pn_from_lid(chat)
                    if pn.User:
                        chat = pn
                except Exception:
                    pass
            peer = chat.User + ("@lid" if chat.Server == "lid" else "")
            msg = item.Message
            text = msg.conversation or msg.extendedTextMessage.text
            attachment = None
            for field in ("documentMessage","imageMessage","videoMessage","audioMessage"):
                if not msg.HasField(field):
                    continue
                m = getattr(msg, field)
                text = getattr(m,"caption","") or text
                if 0 < m.fileLength <= 8*1024*1024:
                    raw = await client.download_any(msg)
                    attachment = payload(getattr(m,"fileName","") or "Вложение", raw)
                text = text or "[Вложение]"
                break
            message(peer,item.Info.ID,item.Info.Pushname if not source.IsFromMe else peer,
                    text,source.IsFromMe,item.Info.Timestamp,False,attachment)
        @c.event(HistorySyncEv)
        async def history(client, event):
            if not self.recent:
                return
            for conv in list(event.Data.conversations)[:30]:
                peer, _, server = conv.ID.partition("@")
                if server not in ("s.whatsapp.net","lid"):
                    continue
                if server == "lid":
                    peer += "@lid"
                for entry in sorted(list(conv.messages)[:25],key=lambda x:x.message.messageTimestamp):
                    item = entry.message
                    text = item.message.conversation or item.message.extendedTextMessage.text
                    message(peer,item.key.ID,getattr(conv,"name","") or peer,text,item.key.fromMe,item.messageTimestamp,True)
            if event.Data.progress == 100:
                emit("history_complete")
        await c.connect()
        await c.idle()

    async def resolve(self, peer):
        if not re.fullmatch(r"[1-9]\d{6,14}", str(peer)):
            raise ValueError("international phone number required")
        return str(peer)

    async def send(self, peer, text, file):
        from neonize.utils.jid import build_jid
        user, _, domain = str(peer).partition("@")
        target = build_jid(user,domain or "s.whatsapp.net")
        if file:
            res = await self.client.send_document(target,base64.b64decode(file["bytes"],validate=True),
                         caption=text,filename=file["name"])
        else:
            res = await self.client.send_message(target,text,link_preview=False)
        return res.ID

    async def logout(self):
        if self.client and self.active:
            await self.client.logout()

class Max(Runtime):
    async def start(self):
        from pymax import WebClient
        class Display:
            async def show_qr(_, url):
                qr(url)
        c = self.client = WebClient(work_dir=str(self.dir),session_name="max.db",qr_provider=Display())
        async def process(m, chat, historical):
            if not chat or not chat.is_dialog or m.id is None:
                return
            file = None
            for item in m.attaches or []:
                file_id = getattr(item, "file_id", None)
                if file_id is not None and (getattr(item,"size",0) or 0) <= MAX_SIZE:
                    try:
                        info = await c.get_file_by_id(chat.id, m.id, file_id)
                        file = await read_document(getattr(info,"url",None),item.name,MAX_DOMAINS)
                    except (ValueError, RuntimeError, TimeoutError):
                        pass
                    break
            message(chat.id,m.id,chat.title or str(chat.id),m.text or ("[Вложение MAX]" if m.attaches else ""),
                    m.sender == c.me.contact.id,m.time,historical,file)
        @c.on_start()
        async def started(client):
            me = client.me.contact
            self.ready(me.id, str(me.id))
            if self.recent:
                for chat in [v for v in client.chats if v.is_dialog][:30]:
                    for m in reversed(await client.fetch_history(chat.id,backward=25)):
                        await process(m,chat,True)
                emit("history_complete")
        @c.on_message()
        async def receive(event, client):
            if event.chat_id is not None and client.me:
                await process(event,await client.get_chat(event.chat_id),False)
        await c.start()

    async def resolve(self, peer):
        chat = await self.client.get_chat(int(peer))
        if not chat or not chat.is_dialog:
            raise ValueError("personal dialog required")
        return str(chat.id)

    async def send(self, peer, text, file):
        if file:
            from pymax import File
            value = File(raw=base64.b64decode(file["bytes"],validate=True),name=file["name"])
            msg = await self.client.send_message(int(peer),text or None,attachments=[value])
        else:
            msg = await self.client.send_message(int(peer),text)
        return str(msg.id)

    async def logout(self):
        if self.client and self.active:
            await self.client.logout()
