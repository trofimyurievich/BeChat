import asyncio
import base64
import io
import os
import re
import time
import subprocess
import tempfile
from pathlib import Path
from worker import Runtime, emit, message, qr
from attachments import MAX_DOMAINS, MAX_SIZE, read_document

def animation_file(data, sticker=False):
    # Input comes from an uploaded GIF. Restrict ffmpeg to this local file.
    if data[:6] not in (b"GIF87a",b"GIF89a") or len(data)<10:
        raise ValueError("invalid GIF")
    width, height = int.from_bytes(data[6:8],"little"), int.from_bytes(data[8:10],"little")
    if not (0 < width*height <= 4000000):
        raise ValueError("invalid GIF size")
    with tempfile.TemporaryDirectory() as folder:
        source = Path(folder)/"source.gif"
        target = Path(folder)/("sticker.webm" if sticker else "animation.mp4")
        source.write_bytes(data)
        options = ["-vf","fps=24,scale=512:512:force_original_aspect_ratio=decrease,pad=512:512:(ow-iw)/2:(oh-ih)/2:color=black@0","-c:v","libvpx-vp9","-b:v","240k","-deadline","realtime","-pix_fmt","yuva420p"] if sticker else [
            "-vf","fps=20,scale=w='min(640,iw)':h=-2:force_divisible_by=2","-c:v","libx264","-preset","veryfast","-pix_fmt","yuv420p","-movflags","+faststart"]
        subprocess.run(["ffmpeg","-nostdin","-v","error","-protocol_whitelist","file","-f","gif","-ignore_loop","1","-i",str(source),
                        "-an","-t","3" if sticker else "60","-threads","2",*options,str(target)],
                       check=True,timeout=35,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL)
        return target.read_bytes()

def payload(name, data):
    if not data or len(data) > 8 * 1024 * 1024:
        return None
    return {"name": str(name or "Файл")[:160], "bytes": base64.b64encode(data).decode()}

async def image_bytes(url, domains):
    result = await read_document(url, "avatar", domains)
    return base64.b64decode(result["bytes"]) if result else None

class Telegram(Runtime):
    async def contact(self, peer):
        identity=(peer.username or "",peer.phone or "")
        if not hasattr(self,"telegram_identities"):
            self.telegram_identities={}
        if self.telegram_identities.get(peer.id)==identity:
            return
        picture = None
        if peer.photo:
            try:
                picture = await self.client.download_profile_photo(peer, file=bytes, download_big=False)
            except Exception:
                pass
        self.profile(peer.id, " ".join(v for v in (peer.first_name,peer.last_name) if v), peer.phone, picture, username=peer.username or "")
        self.telegram_identities[peer.id]=identity
        self.profiles.add(peer.id)

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
                try:
                    file = payload(m.file.name or ("Вложение" + (m.file.ext or "")), await m.download_media(file=bytes))
                except Exception:
                    pass
            message(peer.id, m.id, " ".join(x for x in [peer.first_name,peer.last_name] if x),
                    m.raw_text or ("[Вложение]" if m.media else ""), m.out, m.date, historical, file)
        @c.on(events.MessageRead(inbox=False))
        async def read_outbox(event):
            if event.chat_id and event.chat_id > 0:
                emit("receipt", peer=str(event.chat_id), basis="id", position=event.max_id)
        @c.on(events.NewMessage)
        async def receive(event):
            if event.is_private:
                peer=await event.get_chat()
                if isinstance(peer,User) and not peer.bot and not peer.is_self:
                    await self.contact(peer)
                await process(event.message,peer,False)
        async def collect():
            async for dialog in c.iter_dialogs(limit=None):
                peer = dialog.entity
                if not isinstance(peer, User) or peer.bot or peer.is_self or peer.id == 777000:
                    continue
                await self.contact(peer)
                if dialog.dialog.read_outbox_max_id:
                    emit("receipt", peer=str(peer.id), basis="id", position=dialog.dialog.read_outbox_max_id)
                last = self.cursor(peer.id)
                async for m in c.iter_messages(peer, limit=None, min_id=last, reverse=True):
                    await process(m, peer, True)
                    self.advance(peer.id, m.id)
        task = asyncio.create_task(self.history_task(collect))
        try:
            await c.run_until_disconnected()
        finally:
            task.cancel()

    async def resolve(self, peer):
        from telethon.tl.types import User
        entity = await self.client.get_entity(int(peer) if str(peer).isdigit() else str(peer))
        if not isinstance(entity, User) or entity.bot or entity.is_self or entity.id == 777000:
            raise ValueError("personal recipient required")
        await self.contact(entity)
        return str(entity.id)

    async def send(self, peer, text, file):
        peer = int(peer)
        if file:
            data = io.BytesIO(base64.b64decode(file["bytes"],validate=True))
            data.name = file["name"]
            kind = file.get("kind")
            options = {"force_document":True}
            if kind == "audio":
                options = {"voice_note":True}
            elif kind in ("photo","video","music"):
                options = {"force_document": False, "supports_streaming": kind == "video"}
            elif kind in ("gif","sticker"):
                from telethon.tl.types import DocumentAttributeAnimated, DocumentAttributeSticker, InputStickerSetEmpty
                sticker = kind == "sticker"
                converted = await asyncio.to_thread(animation_file,data.getvalue(),sticker)
                data = io.BytesIO(converted)
                data.name = "sticker.webm" if sticker else "animation.mp4"
                options = {"attributes":[DocumentAttributeSticker(alt="✨",stickerset=InputStickerSetEmpty()) if sticker else DocumentAttributeAnimated()]}
            reply = await self.client.send_file(peer,data,caption=text,parse_mode=None,**options)
        else:
            reply = await self.client.send_message(peer,text,parse_mode=None,link_preview=False)
        return str(reply.id)

    async def logout(self):
        if self.client and self.client.is_connected():
            await self.client.log_out()

class WhatsApp(Runtime):
    async def contact(self, jid, name):
        peer = jid.User + ("@lid" if jid.Server == "lid" else "")
        if peer in self.profiles:
            return
        self.profiles.add(peer)
        picture = None
        try:
            photo = await self.client.get_profile_picture(jid)
            picture = await image_bytes(photo.URL, ("whatsapp.net","whatsapp.com","fbcdn.net"))
        except Exception:
            pass
        self.profile(peer, name, jid.User if jid.Server == "s.whatsapp.net" else None, picture)

    async def start(self):
        from neonize.aioze.client import NewAClient
        from neonize.aioze.events import ConnectedEv, MessageEv, LoggedOutEv, HistorySyncEv, ReceiptEv
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
            await self.connected.wait()
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
                    try:
                        attachment = payload(getattr(m,"fileName","") or "Вложение", await client.download_any(msg))
                    except Exception:
                        pass
                text = text or "[Вложение]"
                break
            message(peer,item.Info.ID,item.Info.Pushname if not source.IsFromMe else peer,
                    text,source.IsFromMe,item.Info.Timestamp,False,attachment)
            await self.contact(chat, item.Info.Pushname if not source.IsFromMe else None)
        @c.event(ReceiptEv)
        async def receive_receipt(client, event):
            src = event.MessageSource
            status = {event.DELIVERED:"delivered",event.READ:"read",event.PLAYED:"read"}.get(event.Type)
            if not status or src.IsFromMe or src.IsGroup or src.Chat.Server not in ("lid","s.whatsapp.net"):
                return
            chat = src.Chat
            if chat.Server == "lid":
                try:
                    pn = await client.get_pn_from_lid(chat)
                    if pn.User:
                        chat = pn
                except Exception:
                    pass
            peer = chat.User + ("@lid" if chat.Server == "lid" else "")
            for remote in event.MessageIDs:
                emit("receipt", peer=peer, remote=remote, status=status)
        @c.event(HistorySyncEv)
        async def history(client, event):
            from neonize.utils.jid import build_jid
            await self.connected.wait()
            for conv in event.Data.conversations:
                peer, _, server = conv.ID.partition("@")
                if server not in ("s.whatsapp.net","lid"):
                    continue
                jid = build_jid(peer, server)
                if server == "lid":
                    try:
                        pn = await client.get_pn_from_lid(jid)
                        if pn.User:
                            jid = pn
                    except Exception:
                        pass
                peer = jid.User + ("@lid" if jid.Server == "lid" else "")
                await self.contact(jid, getattr(conv,"name","") or None)
                for entry in conv.messages:
                    item = entry.message
                    text = item.message.conversation or item.message.extendedTextMessage.text
                    if not text:
                        for field in ("documentMessage", "imageMessage", "videoMessage", "audioMessage", "stickerMessage", "locationMessage", "contactMessage"):
                            if item.message.HasField(field):
                                media = getattr(item.message, field)
                                text = getattr(media, "caption", "") or getattr(media, "fileName", "") or "[Вложение WhatsApp]"
                                break
                    if item.key.fromMe and item.status in (3,4,5):
                        emit("receipt", peer=peer, remote=item.key.ID, status="delivered" if item.status == 3 else "read")
                    message(peer,item.key.ID,getattr(conv,"name","") or peer,text,item.key.fromMe,item.messageTimestamp,True)
            if event.Data.progress == 100:
                emit("history_complete")
        await c.connect()
        await c.idle()

    async def resolve(self, peer):
        peer = str(peer).lstrip("+")
        if not re.fullmatch(r"[1-9]\d{6,14}", peer):
            raise ValueError("international phone number required")
        return str(peer)

    async def send(self, peer, text, file):
        from neonize.utils.jid import build_jid
        user, _, domain = str(peer).partition("@")
        target = build_jid(user,domain or "s.whatsapp.net")
        if file:
            data = base64.b64decode(file["bytes"],validate=True)
            kind = file.get("kind")
            if kind == "audio":
                res = await self.client.send_audio(target,data,ptt=True)
            elif kind == "photo":
                res = await self.client.send_image(target,data,caption=text)
            elif kind == "video":
                res = await self.client.send_video(target,data,caption=text)
            elif kind == "music" and not text:
                res = await self.client.send_audio(target,data,ptt=False)
            elif kind == "sticker":
                res = await self.client.send_sticker(target,data,animated_gif=True,packname="Google Noto Emoji")
            elif kind == "gif":
                res = await self.client.send_video(target,await asyncio.to_thread(animation_file,data),caption=text,gifplayback=True)
            else:
                res = await self.client.send_document(target,data,caption=text,filename=file["name"])
        else:
            res = await self.client.send_message(target,text,link_preview=False)
        return res.ID

    async def logout(self):
        if self.client and self.active:
            await self.client.logout()

class Max(Runtime):
    @staticmethod
    def media_info(item):
        kind = str(getattr(item.type, "value", item.type)).upper()
        defaults = {"PHOTO":("Фотография.jpg","image/jpeg"), "VIDEO":("Видео.mp4","video/mp4"),
                    "AUDIO":("Голосовое сообщение.ogg","audio/ogg"), "STICKER":("Стикер.webp","image/webp")}
        if kind == "FILE":
            return {"name":item.name,"size":item.size,"kind":"file"}
        if kind in defaults:
            name,mime = defaults[kind]
            return {"name":name,"mime":mime,"kind":kind.lower()}
        return None

    async def media_url(self, peer, message_id, slot):
        chat_id, remote = int(peer), int(message_id)
        msg = await self.client.get_message(chat_id,remote)
        if not msg or not 0 <= slot < len(msg.attaches or []):
            raise ValueError("missing attachment")
        item = msg.attaches[slot]
        if getattr(item,"file_id",None) is not None:
            return (await self.client.get_file_by_id(chat_id,remote,item.file_id)).url
        if getattr(item,"video_id",None) is not None:
            return (await self.client.get_video_by_id(chat_id,remote,item.video_id)).url
        return getattr(item,"base_url",None) or getattr(item,"url",None)

    async def contact(self, user):
        me = self.client.me.contact.id
        peer = self.client.get_chat_id(user.id, me)
        if peer not in self.profiles:
            first = next(iter(user.names), None)
            name = first and (first.name or " ".join(x for x in (first.first_name, first.last_name) if x))
            url = user.base_url or user.base_raw_url
            picture = await image_bytes(url, MAX_DOMAINS) if url else None
            self.profile(peer, name, user.phone, picture)
            self.profiles.add(peer)
        return peer

    async def start(self):
        from pymax import Client, ExtraConfig, QrAuthFlow, WebClient
        runtime = self
        class Prompts:
            async def show_qr(_, url):
                qr(url)
            async def get_password(_, hint=None):
                return await runtime.password()
            async def get_code(_, phone):
                emit("prompt", mode="code")
                return await asyncio.wait_for(runtime.answer.get(), 150)

        from pymax.auth.sms import SmsAuthFlow
        from pymax.auth.models import AuthResult
        from pymax.exceptions import ApiError
        from pairing import code_problem, PairingFailure
        class PhoneLogin(SmsAuthFlow):
            async def authenticate(self, app):
                ticket = await app.api.auth.request_code(app.config.phone)
                reason = None
                for attempt in range(3):
                    emit("prompt", mode="code", digits=ticket.code_length, reason=reason)
                    code = await asyncio.wait_for(runtime.answer.get(), 180)
                    try:
                        result = await app.api.auth.send_code(ticket.token,code)
                    except ApiError as error:
                        reason = code_problem(error)
                        if reason == "CodeRejected" and attempt < 2:
                            continue
                        raise PairingFailure(reason) from None
                    if result.login_token:
                        emit("prompt",mode="confirming")
                        return AuthResult(token=result.login_token)
                    if result.password_challenge:
                        challenge=result.password_challenge
                        token=await self._authenticate_with_password(app,challenge.track_id,challenge.hint)
                        emit("prompt",mode="confirming")
                        return AuthResult(token=token)
                    raise PairingFailure("NoProfile" if result.register_token else "ConfirmationIncomplete")

        class QRLogin(QrAuthFlow):
            async def _poll_qr(self, app, ticket):
                confirmed = await super()._poll_qr(app, ticket)
                if confirmed:
                    emit("prompt", mode="confirming")
                else:
                    raise TimeoutError("QR expired")
                return confirmed

        prompts = Prompts()
        options = dict(work_dir=str(self.dir), extra_config=ExtraConfig(reconnect=False))
        if os.environ.get("BECHAT_MAX_METHOD") == "phone":
            c = Client(os.environ.get("BECHAT_MAX_PHONE", ""), session_name="max-phone.db",
                       auth_flow=PhoneLogin(prompts,prompts), **options)
        else:
            c = WebClient(session_name="max.db", auth_flow=QRLogin(prompts, prompts), **options)
        self.client = c
        async def process(m, chat, historical):
            if not chat or not chat.is_dialog or m.id is None:
                return
            media = []
            extra = []
            for slot,item in enumerate(m.attaches or []):
                descriptor = self.media_info(item)
                if descriptor:
                    media.append({**descriptor,"slot":slot})
                else:
                    label = getattr(item,"title",None) or getattr(item,"name",None) or getattr(item,"url",None)
                    if label:
                        extra.append(str(label))
            text = "\n".join(x for x in [m.text,*extra] if x)
            message(chat.id,m.id,chat.title or "Собеседник MAX",text or ("[Событие MAX]" if m.attaches and not media else ""),
                    m.sender == c.me.contact.id,m.time,historical,media=media)
        @c.on_start()
        async def started(client):
            me = client.me.contact
            self.ready(me.id, str(me.id))
            async def collect():
                seen = set()
                async def dialog(chat):
                    if not chat.is_dialog or chat.id in seen:
                        return
                    seen.add(chat.id)
                    other = client.get_chat_id(chat.id, me.id)
                    user = await client.get_user(other) if other != me.id else None
                    if user:
                        await self.contact(user)
                    mark = chat.participants.get(other, 0) if other != me.id else 0
                    if 10**12 < mark <= int(time.time()*1000)+60000:
                        emit("receipt", peer=str(chat.id), basis="time", position=mark)
                    prior = self.cursor("media2:"+str(chat.id))
                    newest = prior
                    before = None
                    while True:
                        page = await client.fetch_history(chat.id, backward=80, from_time=before)
                        if not page:
                            break
                        oldest = min(m.time for m in page)
                        for msg in page:
                            if msg.time >= prior:
                                await process(msg, chat, True)
                                newest = max(newest, msg.time)
                        if oldest <= prior or (before is not None and oldest >= before):
                            break
                        before = oldest - 1
                        await asyncio.sleep(.08)
                    self.advance("media2:"+str(chat.id), newest)
                for chat in list(client.chats or []):
                    await dialog(chat)
                marker = int(time.time() * 1000)
                while marker > 0:
                    page = await client.fetch_chats(marker=marker)
                    if not page:
                        break
                    for chat in page:
                        await dialog(chat)
                    oldest = min((x.last_event_time or x.created for x in page), default=0)
                    if oldest <= 0 or oldest >= marker:
                        break
                    marker = oldest - 1
            self.backfill = asyncio.create_task(self.history_task(collect))
        @c.on_message_read()
        async def read_outbox(event, client):
            if not client.me or event.set_as_unread or not event.mark:
                return
            me = client.me.contact.id
            if event.user_id != me and event.user_id == client.get_chat_id(event.chat_id, me):
                emit("receipt", peer=str(event.chat_id), basis="time", position=event.mark)
        @c.on_message()
        async def receive(event, client):
            if event.chat_id is not None and client.me:
                chat = await client.get_chat(event.chat_id)
                if chat and chat.is_dialog:
                    await process(event,chat,False)
                    peer = client.get_chat_id(chat.id,client.me.contact.id)
                    if peer != client.me.contact.id and chat.id not in self.profiles:
                        user = await client.get_user(peer)
                        if user:
                            await self.contact(user)
        await c.start()

    async def identify_max(self, phone):
        if not re.fullmatch(r"\+[1-9]\d{6,14}", phone):
            return None
        user = await self.client.search_by_phone(phone)
        me = self.client.me.contact.id
        return str(self.client.get_chat_id(user.id, me)) if user and user.id != me else None

    async def resolve(self, peer):
        if str(peer).startswith("+"):
            user = await self.client.search_by_phone(str(peer))
            if not user or user.id == self.client.me.contact.id:
                raise ValueError("unavailable recipient")
            return str(await self.contact(user))
        chat = await self.client.get_chat(int(peer))
        if not chat or not chat.is_dialog:
            raise ValueError("personal dialog required")
        return str(chat.id)

    async def send(self, peer, text, file):
        if file:
            from pymax import File, Video, Voice
            data = base64.b64decode(file["bytes"],validate=True)
            if file.get("kind") == "audio":
                value = Voice(raw=data,name="voice.ogg",duration=max(1,int(file["duration"])))
            elif file.get("kind") == "photo":
                from pymax import Photo
                value = Photo(raw=data,name=file["name"])
            elif file.get("kind") == "video":
                value = Video(raw=data,name=file["name"])
            elif file.get("kind") in ("gif","sticker"):
                value = Video(raw=await asyncio.to_thread(animation_file,data),name="animation.mp4")
            else:
                value = File(raw=data,name=file["name"])
            msg = await self.client.send_message(int(peer),text or None,attachments=[value])
        else:
            msg = await self.client.send_message(int(peer),text)
        return str(msg.id)

    async def logout(self):
        if self.client and self.active:
            await self.client.logout()
