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
        path = self.dir/"vk-cursors.json"
        water = json.loads(path.read_text()) if path.exists() else {}
        initial = not path.exists()
        while True:
            offset = 0
            while True:
                res = await self.api("messages.getConversations",count=200,offset=offset,extended=1)
                names = {p["id"]:p.get("first_name","")+" "+p.get("last_name","") for p in res.get("profiles",[])}
                for entry in res["items"]:
                    p = entry["conversation"]["peer"]
                    if p["type"] != "user":
                        continue
                    key = str(p["id"])
                    latest = int(entry["last_message"]["id"])
                    if int(water.get(key,0)) >= latest:
                        continue
                    if initial and not self.recent:
                        water[key] = latest
                        continue
                    items, last = [],int(water.get(key,0))
                    at = 0
                    while True:
                        size = 25 if initial else 200
                        data = (await self.api("messages.getHistory",peer_id=key,count=size,offset=at))["items"]
                        items.extend(m for m in data if m["id"] > last)
                        if initial or len(data)<size or any(m["id"]<=last for m in data):
                            break
                        at += len(data)
                    for m in reversed(items):
                        doc = next((a["doc"] for a in m.get("attachments",[]) if a.get("type")=="doc" and a.get("doc")), None)
                        file = await read_document(doc.get("url"),doc.get("title"),VK_DOMAINS) if doc and (doc.get("size") or 0) <= MAX_SIZE else None
                        message(key,m["id"],names.get(p["id"],key),m.get("text") or ("[Вложение ВКонтакте]" if m.get("attachments") else ""),
                                m.get("out"),m["date"],initial,file)
                    water[key] = latest
                offset += len(res["items"])
                if not res["items"] or offset >= res.get("count",offset):
                    break
            tmp = path.with_suffix(".tmp")
            tmp.write_text(json.dumps(water))
            tmp.replace(path)
            if initial and self.recent:
                emit("history_complete")
            initial = False
            await asyncio.sleep(14)

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
        user=(await self.api("users.get",user_ids=peer))[0]
        return str(user["id"])

    async def send(self, peer, text, file):
        args={"peer_id":peer,"message":text,"random_id":secrets.randbelow(2147483646)+1}
        if file:
            from aiohttp import FormData
            url=(await self.api("docs.getMessagesUploadServer",peer_id=peer,type="doc"))["upload_url"]
            if not allowed(url,VK_DOMAINS):
                raise ValueError("unknown VK upload endpoint")
            form=FormData()
            form.add_field("file",base64.b64decode(file["bytes"],validate=True),filename=file["name"])
            async with self.http.post(url,data=form,allow_redirects=False) as res:
                uploaded=await res.json(content_type=None)
            doc=(await self.api("docs.save",file=uploaded["file"],title=file["name"]))["doc"]
            args["attachment"]="doc%s_%s"%(doc["owner_id"],doc["id"])
        return str(await self.api("messages.send",**args))

    async def logout(self):
        if hasattr(self,"http"):
            if getattr(self,"creds",{}).get("access_token"):
                async with self.http.post("https://id.vk.com/oauth2/logout",data={
                      "client_id":self.app,"access_token":self.creds["access_token"]},allow_redirects=False):
                    pass
            await self.http.close()
