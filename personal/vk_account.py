"""VK ID with PKCE and direct official VK Messages API for an approved BeChat app."""
import asyncio
import base64
import hashlib
import json
import os
import secrets
import time
from urllib.parse import urlencode
from aiohttp import ClientSession, ClientTimeout
from cryptography.fernet import Fernet
from worker import Runtime, emit, message
from attachments import MAX_SIZE, VK_DOMAINS, allowed, read_document

class VK(Runtime):
    async def start(self):
        self.http = ClientSession(timeout=ClientTimeout(total=25))
        self.app = os.environ["VK_APP_ID"]
        self.callback = os.environ["PUBLIC_ORIGIN"] + "/personal/vk/callback"
        self.box = Fernet(os.environ["BECHAT_SESSION_CIPHER"].encode())
        self.path = self.dir/"vk.session"
        if self.path.exists():
            self.creds = json.loads(self.box.decrypt(self.path.read_bytes()))
        else:
            verifier = secrets.token_urlsafe(48)
            state = secrets.token_urlsafe(32)
            challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
            params = {"response_type":"code","client_id":self.app,"redirect_uri":self.callback,
                      "state":state,"code_challenge":challenge,"code_challenge_method":"S256","scope":"messages"}
            emit("prompt",mode="oauth",url="https://id.vk.com/authorize?"+urlencode(params),state=state)
            response = await asyncio.wait_for(self.answer.get(), 300)
            if not isinstance(response,dict) or not secrets.compare_digest(response.get("state",""),state):
                raise ValueError("invalid oauth state")
            self.creds = {"device_id":response["device_id"]}
            await self.exchange(grant_type="authorization_code",code=response["code"],code_verifier=verifier,
                                redirect_uri=self.callback,device_id=response["device_id"],state=state)
        me = (await self.api("users.get"))[0]
        # VK ID alone does not grant personal messages. Verify the actual Messages API first.
        await self.api("messages.getConversations",count=1)
        self.ready(me["id"],(me.get("first_name","")+" "+me.get("last_name","")).strip())
        async def save_message(key, name, m, historical):
            doc = next((a["doc"] for a in m.get("attachments",[]) if a.get("type")=="doc" and a.get("doc")), None)
            file = await read_document(doc.get("url"),doc.get("title"),VK_DOMAINS) if doc and (doc.get("size") or 0) <= MAX_SIZE else None
            message(key,m["id"],name,m.get("text") or ("[Вложение ВКонтакте]" if m.get("attachments") else ""), m.get("out"),m["date"],historical,file)

        async def collect():
            offset = 0
            while True:
                res = await self.api("messages.getConversations", count=200, offset=offset, extended=1, fields="photo_100,contacts")
                profiles = {p["id"]:p for p in res.get("profiles",[])}
                for entry in res["items"]:
                    peer = entry["conversation"]["peer"]
                    if peer["type"] != "user":
                        continue
                    key = peer["id"]
                    mark = entry["conversation"].get("out_read")
                    if mark:
                        emit("receipt", peer=str(key), basis="id", position=mark)
                    profile = profiles.get(key,{})
                    name = " ".join(x for x in (profile.get("first_name"),profile.get("last_name")) if x)
                    if key not in self.profiles:
                        photo = await read_document(profile.get("photo_100"), "avatar", VK_DOMAINS)
                        self.profile(key,name,profile.get("mobile_phone"),base64.b64decode(photo["bytes"]) if photo else None)
                        self.profiles.add(key)
                    latest = entry["last_message"]["id"]
                    prior = self.cursor(key)
                    if prior >= latest:
                        continue
                    start = latest
                    while start > prior:
                        items = (await self.api("messages.getHistory",peer_id=key,count=200,start_message_id=start))["items"]
                        for m in items:
                            if m["id"] > prior:
                                await save_message(key,name or str(key),m,True)
                        if len(items)<200 or min(m["id"] for m in items) <= prior:
                            break
                        oldest = min(m["id"] for m in items)
                        if oldest >= start:
                            raise RuntimeError("VK pagination")
                        start = oldest
                    self.advance(key,latest)
                offset += len(res["items"])
                if not res["items"] or offset >= res.get("count",offset):
                    return

        # Establish a live cursor before starting the historical scan.
        conn = await self.api("messages.getLongPollServer",lp_version=3)
        self.backfill = asyncio.create_task(self.history_task(collect))
        while True:
            url = str(conn["server"])
            if not url.startswith("https://"):
                url = "https://" + url
            if not allowed(url, VK_DOMAINS + ("vkuser.ru","vkuser.com")):
                raise ValueError("VK long poll endpoint")
            try:
                async with self.http.get(url, params={"act":"a_check","key":conn["key"],"ts":conn["ts"],"wait":20,"mode":2,"version":3},allow_redirects=False) as r:
                    result = await r.json(content_type=None)
            except asyncio.TimeoutError:
                continue
            if result.get("failed"):
                if result.get("ts"):
                    conn["ts"] = result["ts"]
                else:
                    conn = await self.api("messages.getLongPollServer",lp_version=3)
                if self.backfill.done():
                    self.backfill = asyncio.create_task(self.history_task(collect))
                continue
            for event in result.get("updates",[]):
                if len(event) >= 3 and event[0] == 7 and 0 < event[1] < 2000000000:
                    emit("receipt", peer=str(event[1]), basis="id", position=event[2])
                    continue
                if event[0] != 4 or not 0 < event[3] < 2000000000:
                    continue
                for m in (await self.api("messages.getById",message_ids=event[1]))["items"]:
                    await save_message(str(event[3]),None,m,False)
            conn["ts"] = result["ts"]

    async def exchange(self, **data):
        async with self.http.post("https://id.vk.com/oauth2/auth",
                  data={**data,"client_id":self.app},allow_redirects=False) as res:
            body=await res.json(content_type=None)
        if "access_token" not in body:
            raise PermissionError("vk oauth")
        self.creds.update({k:body[k] for k in ("access_token","refresh_token") if k in body})
        self.creds["expires_at"]=time.time()+int(body.get("expires_in",3600))
        tmp=self.path.with_suffix(".tmp")
        tmp.write_bytes(self.box.encrypt(json.dumps(self.creds).encode()))
        tmp.replace(self.path)

    async def api(self, method, **values):
        if not hasattr(self,"lock"):
            self.lock=asyncio.Lock()
        async with self.lock:
            if time.time()+60 >= self.creds["expires_at"]:
                await self.exchange(grant_type="refresh_token",refresh_token=self.creds["refresh_token"],device_id=self.creds["device_id"],
                                    state=secrets.token_urlsafe(32))
            await asyncio.sleep(.36)
            async with self.http.post("https://api.vk.com/method/"+method,data={
                      **values,"v":"5.199","access_token":self.creds["access_token"]},allow_redirects=False) as res:
                body=await res.json(content_type=None)
            if "response" not in body:
                raise PermissionError("VK API")
            return body["response"]

    async def resolve(self, peer):
        if str(peer).startswith("+"):
            raise ValueError("phone not shared by VK")
        user=(await self.api("users.get",user_ids=peer))[0]
        return str(user["id"])

    async def send(self, peer, text, file):
        args={"peer_id":peer,"message":text,"random_id":secrets.randbelow(2147483646)+1}
        if file:
            from aiohttp import FormData
            url=(await self.api("docs.getMessagesUploadServer",peer_id=peer,type="audio_message" if file.get("kind")=="audio" else "doc"))["upload_url"]
            if not allowed(url,VK_DOMAINS):
                raise ValueError("unknown VK upload endpoint")
            form=FormData()
            form.add_field("file",base64.b64decode(file["bytes"],validate=True),filename=file["name"])
            async with self.http.post(url,data=form,allow_redirects=False) as res:
                uploaded=await res.json(content_type=None)
            saved=await self.api("docs.save",file=uploaded["file"],title=file["name"])
            doc=saved[saved["type"]]
            args["attachment"]="doc%s_%s"%(doc["owner_id"],doc["id"])
        return str(await self.api("messages.send",**args))

    async def logout(self):
        if hasattr(self,"http"):
            if getattr(self,"creds",{}).get("access_token"):
                async with self.http.post("https://id.vk.com/oauth2/logout",data={
                      "client_id":self.app,"access_token":self.creds["access_token"]},allow_redirects=False):
                    pass
            await self.http.close()
