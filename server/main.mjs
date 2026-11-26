import { crmLinks, telegramName } from "./crm-links.mjs";
import { makeCard, cardPages } from "./cards.mjs";
import { searchGifs, getAnimation, normalizeVoice, voiceText } from "./media.mjs";
import { createReadReceipts } from "./receipts.mjs";
import { createAuth, authConfig } from "./auth.mjs";
import { legacyMedia } from "./accounts.mjs";
import { createPersonal } from "./personal.mjs";
import { createSmsService } from "./sms.mjs";
import smsCore from "../dist/sms-core.js";
import { get as httpsGet } from "node:https";
import { rootCertificates } from "node:tls";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import {
  configured,
  waTemplates,
  sendProvider,
  parseTelegram,
  parseWhatsApp,
  fetchMedia,
} from "./providers.mjs";
import {
  crmOrigin,
  chatsReady,
  equal,
  signature,
  amoPost,
  readEntity,
  importMessage,
} from "./amo.mjs";
const env = process.env,
  base = dirname(fileURLToPath(import.meta.url)),
  dist = resolve(base, "../dist");
const uiHash=createHash("sha256");
for (const asset of readdirSync(dist).filter(s=>/\.(html|js|css)$/.test(s)).sort())
  uiHash.update(asset).update(readFileSync(resolve(dist,asset)));
const uiBuild=uiHash.digest("hex").slice(0,16);
const maxAuthority = await readFile(new URL("./max-root.pem", import.meta.url), "utf8");
function maxDownload(url, signal) {
  const onMax = url.hostname==="oneme.ru" || url.hostname.endsWith(".oneme.ru") || url.hostname==="max.ru" || url.hostname.endsWith(".max.ru");
  if (!onMax) return fetch(url,{redirect:"manual",signal});
  return new Promise((done,reject) => {
    const request=httpsGet(url,{signal,ca:[...rootCertificates,maxAuthority]}, response => {
      done(new Response(Readable.toWeb(response),{status:response.statusCode,headers:response.headers}));
    });
    request.once("error",reject);
  });
}
const authSettings = authConfig(env);
const dbPath = resolve(env.BECHAT_DB || "data/bechat.sqlite");
mkdirSync(dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS chats(id TEXT PRIMARY KEY,channel TEXT,peer TEXT,owner TEXT,meta TEXT,UNIQUE(channel,peer));
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,chat TEXT REFERENCES chats(id),remote TEXT,body TEXT);
CREATE TABLE IF NOT EXISTS message_views(message TEXT REFERENCES messages(id),login TEXT,edited_text TEXT,reaction TEXT,hidden INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(message,login));
CREATE INDEX IF NOT EXISTS msg_chat ON messages(chat);
CREATE INDEX IF NOT EXISTS msg_chat_date ON messages(chat,json_extract(body,'$.at'));
CREATE INDEX IF NOT EXISTS msg_chat_remote ON messages(chat,remote);
CREATE TABLE IF NOT EXISTS crm_chat_links(owner TEXT,chat TEXT REFERENCES chats(id),lead TEXT,contact TEXT,PRIMARY KEY(owner,chat,lead,contact));
CREATE TABLE IF NOT EXISTS crm_contact_numbers(owner TEXT,lead TEXT,contact TEXT,phone TEXT,PRIMARY KEY(owner,lead,contact,phone));
CREATE TABLE IF NOT EXISTS crm_phone_checks(owner TEXT,phone TEXT,checked INTEGER NOT NULL,PRIMARY KEY(owner,phone));
CREATE INDEX IF NOT EXISTS crm_exact_phone ON crm_contact_numbers(owner,phone);
CREATE TABLE IF NOT EXISTS avatars(chat TEXT PRIMARY KEY REFERENCES chats(id),digest TEXT NOT NULL, jpeg TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY,owner TEXT,chat TEXT,name TEXT,mime TEXT,size INTEGER,remote TEXT,bytes BLOB);
CREATE TABLE IF NOT EXISTS templates(id TEXT PRIMARY KEY,title TEXT,text TEXT);
CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,path TEXT,body TEXT,attempt INTEGER DEFAULT 0,due INTEGER DEFAULT 0);
CREATE TABLE IF NOT EXISTS wa_receipts(remote TEXT PRIMARY KEY,status TEXT);`);
const run = (sql, ...a) => db.prepare(sql).run(...a),
  one = (sql, ...a) => db.prepare(sql).get(...a),
  many = (sql, ...a) => db.prepare(sql).all(...a);
const transaction = (fn) => {
  db.exec("BEGIN IMMEDIATE");
  try {
    const r = fn();
    db.exec("COMMIT");
    return r;
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
};
for (const r of many(
  "SELECT * FROM messages WHERE json_extract(body,'$.status')='sending'",
)) {
  const m = JSON.parse(r.body);
  m.status = "unknown";
  run("UPDATE messages SET body=? WHERE id=?", JSON.stringify(m), m.id);
}
const stamp = () => new Date().toISOString(),
  id = () => randomUUID();
const bad = (n, msg) => {
  throw Object.assign(Error(msg), { http: n });
};
const trim = (s, n = 400) =>
  String(s ?? "")
    .trim()
    .slice(0, n);
const auth = createAuth(db, authSettings, { readBody, json });
const clockId = randomUUID(), revisions = new Map(), listeners = new Set();
let sequence = 0, sharedRevision = 0;
function signal(chat) {
  const row = one("SELECT owner,meta FROM chats WHERE id=?",chat);
  if (!row) return;
  if (JSON.parse(row.meta).accountId) revisions.set(row.owner,++sequence);
  else sharedRevision = ++sequence;
  for (const fn of listeners) fn();
}
function revision(login) { return clockId + ":" + Math.max(sharedRevision,revisions.get(login)||0); }
function listenChanges(login,since,res) {
  const finish = () => { clean(); json(res,{revision:revision(login)}); };
  const change = () => { if (revision(login)!==since) finish(); };
  const clean = () => { clearTimeout(timer); listeners.delete(change); res.off("close",clean); };
  const timer = setTimeout(finish,22000);
  res.once("close",clean);
  listeners.add(change);
  change();
}
function normalPhone(value) {
  try { return smsCore.normalize(value); } catch { return ""; }
}
const accounts = createPersonal(db, (value) =>
  transaction(() => ingest(value)),
);
const roleName = {
  founder: "Учредитель",
  admin: "Администратор",
  manager: "Менеджер",
  observer: "Наблюдатель",
};
const canSee = (u, row) =>
  row &&
  (JSON.parse(row.meta).accountId
    ? row.owner === u.login
    : u.role !== "manager" || u.login === row.owner);
const requireWrite = (u) => {
  if (u.role === "observer") bad(403, "Доступ только для просмотра");
};
const metadata = (row) => ({
  ...JSON.parse(row.meta),
  id: row.id,
  channel: row.channel,
  peer:
    row.channel === "SMS"
      ? JSON.parse(row.meta).smsNumber
      : JSON.parse(row.meta).remotePeer || row.peer,
  owner: auth.nameFor(row.owner),
});
const saveMeta = (cid, data) =>
  run("UPDATE chats SET meta=? WHERE id=?", JSON.stringify(data), cid);
const firstOwner = auth.firstOwner;
function getChat(channel, peer, name, owner = firstOwner(), extra = {}) {
  let row = one(
    "SELECT * FROM chats WHERE channel=? AND peer=?",
    channel,
    peer,
  );
  if (!row) {
    const cid = id(),
      m = {
        name,
        stage: 0,
        tags: [],
        tasks: [],
        unanswered: 0,
        archived: false,
        pinned: false,
        ...extra,
      };
    run(
      "INSERT INTO chats VALUES(?,?,?,?,?)",
      cid,
      channel,
      peer,
      owner,
      JSON.stringify(m),
    );
    row = one("SELECT * FROM chats WHERE id=?", cid);
  }
  return row;
}
const scopePath =
  "/v2/origin/custom/" + encodeURIComponent(env.AMO_SCOPE_ID || "");
function job(j, path, body) {
  if (chatsReady)
    run(
      "INSERT OR IGNORE INTO jobs(id,path,body) VALUES(?,?,?)",
      j,
      path,
      JSON.stringify(body),
    );
}
let pumping = false;
async function pump() {
  if (pumping || !chatsReady) return;
  pumping = true;
  try {
    for (const j of many(
      "SELECT * FROM jobs WHERE due<=? ORDER BY rowid LIMIT 15",
      Date.now(),
    )) {
      try {
        await amoPost(j.path, JSON.parse(j.body));
        run("DELETE FROM jobs WHERE id=?", j.id);
      } catch {
        run(
          "UPDATE jobs SET attempt=attempt+1,due=? WHERE id=?",
          Date.now() + Math.min(3600000, 5000 * 2 ** Math.min(j.attempt, 9)),
          j.id,
        );
      }
    }
  } finally {
    pumping = false;
  }
}
setInterval(pump, 5000).unref();
const put = (chat, m, remote = null) => {
  run(
    "INSERT INTO messages VALUES(?,?,?,?)",
    m.id,
    chat,
    remote,
    JSON.stringify(m),
  );
  signal(chat);
};
const update = (m, remote = null) =>
  run(
    "UPDATE messages SET body=?,remote=COALESCE(?,remote) WHERE id=?",
    JSON.stringify(m),
    remote,
    m.id,
  );
const readReceipts = createReadReceipts(db, setStatus, signal);
const delivery = { sent: 1, delivered: 2, read: 3, failed: 4 };
function setStatus(m, status) {
  if (!delivery[status] || delivery[status] <= (delivery[m.status] || 0))
    return;
  m.status = status;
  update(m);
  if (m.amoId && status !== "sent")
    job(
      m.id + status,
      scopePath + "/" + encodeURIComponent(m.amoId) + "/delivery_status",
      {
        status_code: status === "read" ? 2 : status === "delivered" ? 1 : -1,
        ...(status === "failed"
          ? { error_code: 903, error: "Ошибка доставки" }
          : {}),
      },
    );
}
const automaticLinks=crmLinks(db,signal);
function ingest(v) {
  if (v.receipt && v.accountId) return readReceipts.receive(v);
  if (v.profile) {
    const row = getChat(v.channel,v.peer,v.name || v.remotePeer,v.owner,{accountId:v.accountId,remotePeer:v.remotePeer});
    const meta = JSON.parse(row.meta);
    if (v.name) meta.name = v.name;
    if (normalPhone(v.phone)) meta.phone = normalPhone(v.phone);
    if (v.photo) {
      const digest = createHash("sha256").update(v.photo).digest("hex");
      run("INSERT OR REPLACE INTO avatars VALUES(?,?,?)",row.id,digest,v.photo);
      meta.avatarVersion = digest;
    }
    if(row.channel==="Telegram" && v.username!==undefined)meta.username=telegramName(v.username);
    if (JSON.stringify(meta)!==row.meta) {
      saveMeta(row.id,meta);automaticLinks.reconcile({...row,meta:JSON.stringify(meta)});signal(row.id);
    }
    return;
  }
  if (v.status) {
    if (!delivery[v.status]) return;
    const receiptKey = v.accountId
      ? v.accountId + ":" + v.remoteId
      : v.remoteId;
    const was = one(
      "SELECT status FROM wa_receipts WHERE remote=?",
      receiptKey,
    );
    if (!was || delivery[was.status] < delivery[v.status])
      run(
        "INSERT OR REPLACE INTO wa_receipts VALUES(?,?)",
        receiptKey,
        v.status,
      );
    const row = one(
      "SELECT m.* FROM messages m JOIN chats c ON c.id=m.chat WHERE c.channel='WhatsApp' AND c.peer=? AND m.remote=?",
      v.peer,
      v.remoteId,
    );
    if (row) { setStatus(JSON.parse(row.body), v.status); signal(row.chat); }
    return;
  }
  const mid = createHash("sha256")
    .update(JSON.stringify([v.channel, v.peer, v.remoteId]))
    .digest("hex");

  const row = getChat(
      v.channel,
      v.peer,
      v.name,
      v.owner,
      v.accountId ? { accountId: v.accountId, remotePeer: v.remotePeer } : {},
    ),
    meta = JSON.parse(row.meta);
  const saved = one("SELECT * FROM messages WHERE id=? OR (chat=? AND remote=?) LIMIT 1",mid,row.id,v.remoteId);
  const attachments = (v.mediaItems||[]).filter(f=>Number.isSafeInteger(f.slot) && f.slot>=0 && f.slot<100).map(f=>{
    const fid=createHash("sha256").update(mid+":"+f.slot).digest("hex"), name=trim(f.name,180)||"Вложение";
    const kind=["photo","video","audio","sticker"].includes(f.kind)?f.kind:"file";
    const contentType=({photo:"image/jpeg",video:"video/mp4",audio:"audio/ogg",sticker:"image/webp"})[kind] || mime[extname(name).toLowerCase()] || "application/octet-stream";
    run("INSERT OR IGNORE INTO files VALUES(?,?,?,?,?,?,?,?)",fid,row.owner,row.id,name,contentType,Number(f.size)||0,JSON.stringify({provider:"MAX",message:v.remoteId,slot:f.slot}),null);
    return {id:fid,name,kind,mime:contentType,size:Number(f.size)||0};
  });
  if(saved) {
    const original=JSON.parse(saved.body);
    if(attachments.length && (JSON.stringify(original.files)!==JSON.stringify(attachments) || original.text==="[Вложение MAX]")) {
      original.files=attachments;original.file=attachments[0];
      if(original.text==="[Вложение MAX]") original.text=v.text||"";
      update(original); signal(row.id);
    }
    return;
  }
  if (!v.outgoing && !v.history) meta.unanswered = (meta.unanswered || 0) + 1;
  meta.archived = false;
  const oldName=meta.username;
  if (v.username) meta.username = v.username;
  saveMeta(row.id, meta);
  if(oldName!==meta.username || row.channel==="WhatsApp" && !meta.phone)automaticLinks.reconcile({...row,meta:JSON.stringify(meta)});
  const m = {
    id: mid,
    side: v.outgoing ? "out" : "in",
    text: v.text || "",
    at: v.at,
    ...(v.outgoing ? { status: readReceipts.forMessage(v.channel,v.peer,v.remoteId,v.at) || "sent" } : {}),
    ...(attachments.length?{files:attachments,file:attachments[0]}:{}),
  };
  if (v.directFile) {
    const f = v.directFile,
      fid = id();
    run(
      "INSERT INTO files VALUES(?,?,?,?,?,?,?,?)",
      fid,
      row.owner,
      row.id,
      f.name,
      mime[extname(f.name).toLowerCase()] || "application/octet-stream",
      f.bytes.length,
      null,
      f.bytes,
    );
    m.file = { id: fid, name: f.name, size: f.bytes.length };
  }
  if (v.media) {
    const f = v.media,
      fid = id();
    run(
      "INSERT INTO files VALUES(?,?,?,?,?,?,?,?)",
      fid,
      "",
      row.id,
      f.name,
      f.mime,
      f.size,
      f.remote,
      null,
    );
  }
  if (v.media) {
    const f = one(
      "SELECT id,name,size FROM files WHERE chat=? AND remote=? ORDER BY rowid DESC LIMIT 1",
      row.id,
      v.media.remote,
    );
    m.file = f;
  }
  put(row.id, m, v.remoteId);
  if (!v.accountId) job(mid, scopePath, importMessage(metadata(row), m));
  return true;
}
const smsService = createSmsService(db, {
  getChat,
  put,
  update,
  ingest,
  report(m) {
    if (
      !m.amoId ||
      !["delivered", "failed", "expired", "cancelled"].includes(m.status)
    )
      return;
    const delivered = m.status === "delivered";
    job(
      m.id + "-" + m.status,
      scopePath + "/" + encodeURIComponent(m.amoId) + "/delivery_status",
      {
        status_code: delivered ? 1 : -1,
        ...(delivered
          ? {}
          : { error_code: 903, error: smsCore.labels[m.status] }),
      },
    );
  },
  importSent(saved) {
    const row = one("SELECT * FROM chats WHERE id=?", saved.chat),
      m = JSON.parse(saved.body);
    const later = one(
      "SELECT 1 FROM messages WHERE chat=? AND json_extract(body,'$.side')='in' AND rowid>(SELECT rowid FROM messages WHERE id=?)",
      saved.chat,
      m.id,
    );
    if (!later) {
      const meta = JSON.parse(row.meta);
      meta.unanswered = 0;
      saveMeta(row.id, meta);
    }
    if (!m.amoId) job(m.id, scopePath, importMessage(metadata(row), m));
  },
});
async function sendMessage(u, row, input, amoId = "") {
  requireWrite(u);
  const mid = trim(input.id, 120);
  if (!/^[\w-]{8,120}$/.test(mid)) bad(400, "Некорректный ID сообщения");
  const existing = one("SELECT * FROM messages WHERE id=?", mid);
  if (existing) {
    if (existing.chat !== row.id) bad(409, "ID занят");
    const m = JSON.parse(existing.body);
    if (m.status === "failed" || m.status === "unknown")
      bad(
        409,
        m.status === "unknown"
          ? "Доставка не подтверждена. Проверьте переписку перед повтором."
          : "Провайдер отклонил сообщение. Исправьте его перед повтором.",
      );
    return m;
  }
  const isNote = input.side === "note",
    text = trim(input.text, 4000),
    file = input.file
      ? one(
          "SELECT * FROM files WHERE id=? AND owner=? AND (chat IS NULL OR chat=?)",
          String(input.file.id),
          u.login,
          row.id,
        )
      : null;
  if (input.file && !file) bad(400, "Файл недоступен");
  const card = input.card ? makeCard(input.card) : null;
  if (card && (file || row.channel==="SMS" && !isNote)) bad(400,"Этот канал не поддерживает карточки");
  if (!text && !file && !card) bad(400, "Введите текст");
  if (!isNote && file && text.length > 1000)
    bad(400, "Подпись к файлу ограничена 1000 символами");
  const kind = input.file?.kind;
  if (kind && (!file || !((kind==="audio" && file.mime==="audio/ogg") ||
      (kind==="photo" && ["image/jpeg","image/png","image/webp"].includes(file.mime)) ||
      (kind==="music" && file.mime.startsWith("audio/")) || (kind==="video" && file.mime.startsWith("video/")) ||
      (["gif","sticker"].includes(kind) && file.mime==="image/gif")))) bad(400,"Неверный формат медиа");
  const m = {
    id: mid,
    text:card ? [text,card.title].filter(Boolean).join("\n") : text,
    ...(card ? {card} : {}),
    quote: trim(input.quote, 220),
    side: isNote ? "note" : "out",
    author: u.name,
    at: stamp(),
    status: isNote ? "saved" : "sending",
    ...(amoId ? { amoId } : {}),
    ...(file
      ? { file: { id: file.id, name: file.name, size: file.size, ...(kind ? {kind,mime:file.mime,duration:Math.max(0,Math.min(600000,Number(input.file.duration)||0))} : {}) } }
      : {}),
  };
  if (row.channel === "SMS" && !isNote) {
    if (String(input.text ?? "").length > 4000)
      bad(400, "Текст SMS слишком длинный");
    return transaction(() =>
      smsService.queue(row, m, { ...input, batch: null }),
    );
  }
  if (input.template) {
    if (
      row.channel !== "WhatsApp" ||
      !waTemplates.some((t) => t.name === input.template)
    )
      bad(400, "Шаблон недоступен");
    m.template = input.template;
  }
  transaction(() => {
    put(row.id, m);
    if (file) run("UPDATE files SET chat=? WHERE id=?", row.id, file.id);
  });
  if (isNote) return m;
  try {
    const quoted = m.quote
      ? { ...m, text: "❝ " + m.quote + "\n\n" + m.text }
      : m;
    const outbound=card ? {...quoted,text:quoted.text+"\n"+authSettings.origin+"/share/"+card.id} : quoted;
    const remote = JSON.parse(row.meta).accountId
      ? await accounts.send(row, outbound, file)
      : await sendProvider(row, outbound, file);
    transaction(() => {
      m.status = "sent";
      update(m, remote);
      const now = one("SELECT * FROM chats WHERE id=?", row.id);
      const meta = JSON.parse(now.meta);
      const later = one(
        "SELECT 1 FROM messages WHERE chat=? AND json_extract(body,'$.side')='in' AND rowid>(SELECT rowid FROM messages WHERE id=?)",
        row.id,
        mid,
      );
      if (!later) meta.unanswered = 0;
      saveMeta(row.id, meta);
      if (!amoId && !meta.accountId)
        job(m.id, scopePath, importMessage(metadata(now), m));
      if (meta.accountId && remote) {
        const echoId = createHash("sha256")
          .update(JSON.stringify([row.channel, row.peer, String(remote)]))
          .digest("hex");
        if (echoId !== m.id) {
          run(
            "DELETE FROM message_views WHERE message=? AND EXISTS(SELECT 1 FROM messages WHERE id=? AND chat=? AND remote=?)",
            echoId,
            echoId,
            row.id,
            String(remote),
          );
          run(
            "DELETE FROM messages WHERE id=? AND chat=? AND remote=?",
            echoId,
            row.id,
            String(remote),
          );
        }
      }
      const observed = readReceipts.forMessage(row.channel,row.peer,remote,m.at);
      if (observed) setStatus(m,observed);
      signal(row.id);
      if (row.channel === "WhatsApp") {
        const account = JSON.parse(row.meta).accountId;
        const s = one(
          "SELECT status FROM wa_receipts WHERE remote=?",
          account ? account + ":" + remote : remote,
        );
        if (s) setStatus(m, s.status);
      }
    });
    return m;
  } catch (e) {
    m.status = e.definite ? "failed" : "unknown";
    update(m);
    if (amoId && e.definite)
      job(
        m.id + "failed",
        scopePath + "/" + encodeURIComponent(amoId) + "/delivery_status",
        {
          status_code: -1,
          error_code: 903,
          error: "Провайдер отклонил отправку",
        },
      );
    bad(
      502,
      e.definite
        ? "Провайдер отклонил сообщение"
        : "Подтверждение доставки не получено",
    );
  }
}
async function readBody(req, limit = 1024 * 1024) {
  const chunks = [];
  let n = 0;
  for await (const b of req) {
    n += b.length;
    if (n > limit) bad(413, "Превышен размер запроса");
    chunks.push(b);
  }
  return Buffer.concat(chunks);
}
function parse(raw) {
  try {
    return JSON.parse(raw.toString() || "{}");
  } catch {
    bad(400, "Некорректный JSON");
  }
}
function json(res, data, status = 200) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(JSON.stringify(data));
}
function visibleChat(cid, u) {
  const row = one("SELECT * FROM chats WHERE id=?", cid);
  if (!canSee(u, row)) bad(404, "Диалог недоступен");
  return row;
}
const mime = {
  ".wasm": "application/wasm",
  ".ttf": "font/ttf",
  ".pdf": "application/pdf",
  ".jpg": "image/jpeg",
  ".webp": "image/webp",
  ".png": "image/png",
  ".jpeg": "image/jpeg",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".m4a": "audio/mp4",
  ".wav": "audio/wav",
  ".txt": "text/plain",
  ".json": "application/json; charset=utf-8",
  ".ogg": "audio/ogg",
  ".gif": "image/gif",
  ".mp3": "audio/mpeg",
  ".mp4": "video/mp4",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  ".svg": "image/svg+xml",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};
async function attachmentSource(f,row,res) {
      if(row?.channel==="MAX" && f.remote?.startsWith("{") && JSON.parse(f.remote).provider==="MAX") {
        const value = await accounts.media(row,JSON.parse(f.remote));
        let target;
        try { target=new URL(value); } catch { bad(410,"Мессенджер больше не предоставляет файл"); }
        const cdns=["max.ru","oneme.ru","okcdn.ru","mycdn.me","vkuser.net","userapi.com","ok.ru","vkvideo.ru"];
        const safe = u=>u.protocol==="https:" && !u.username && !u.password && (!u.port || u.port==="443") && cdns.some(d=>u.hostname===d || u.hostname.endsWith("."+d));
        const abort = new AbortController();
        res.once("close",()=>abort.abort());
        let upstream;
        for(let n=0;n<4;n++) {
          if(!safe(target)) bad(422,"Адрес вложения не принадлежит хранилищу MAX");
          try {
            upstream=await maxDownload(target,AbortSignal.any([abort.signal,AbortSignal.timeout(240000)]));
          } catch(error) {
            console.warn("MAX content host:",target.hostname,error.cause?.code||error.name);throw error;
          }
          if (![301,302,303,307,308].includes(upstream.status)) break;
          const dest=upstream.headers.get("location"); await upstream.body?.cancel();
          if(!dest) break;
          target=new URL(dest,target);
        }
        if(!upstream?.ok) {await upstream?.body?.cancel();bad(410,"MAX не предоставил вложение");}
        const source=Readable.fromWeb(upstream.body);
      const size=Number(upstream.headers.get("content-length"));
      if(size>0 && !upstream.headers.get("content-encoding"))source.mediaLength=size;
      return source;
      }
      const bytes = f.bytes
        ? Buffer.from(f.bytes)
        : await fetchMedia(
            row.channel,
            f.remote,
            JSON.parse(row.meta).accountId
              ? legacyMedia(db, JSON.parse(row.meta).accountId)
              : undefined,
          );
      return bytes;
}
async function route(req, res) {
  const url = new URL(req.url, "http://localhost"),
    path = url.pathname,
    method = req.method;
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data: https://upload.wikimedia.org https://fonts.gstatic.com; media-src 'self' blob:; connect-src 'self'; frame-ancestors 'self' ${crmOrigin || ""}; object-src 'none'; base-uri 'none'; form-action 'self'`,
  );
  if (path.startsWith("/share/")) return serveCard(req,res,url);
  if (path === "/docx-frame.html")
    res.setHeader(
      "Content-Security-Policy",
      `default-src 'none'; script-src 'self'; style-src 'unsafe-inline'; img-src blob: data:; font-src blob: data:; frame-ancestors 'self' ${crmOrigin || ""}; form-action 'none'; base-uri 'none'`,
    );
  if (path === "/assets/pdf-worker.js")
    res.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'",
    );
  if (path === "/personal/vk/callback" && method === "GET") {
    await accounts.vkCallback(url.searchParams);
    res.writeHead(200, {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "no-store",
    });
    return res.end(
      "Подтверждение VK ID получено. Вернитесь в окно BeChat, чтобы проверить подключение.",
    );
  }
  if (path.startsWith("/hooks/sms/") && method === "POST") {
    const [, , , rid, proof] = path.split("/");
    const ack = smsService.hook(
      rid,
      decodeURIComponent(proof || ""),
      await readBody(req),
      req.headers,
    );
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end(ack);
  }
  if (path === "/hooks/whatsapp" && method === "GET") {
    if (
      !configured.WhatsApp ||
      url.searchParams.get("hub.mode") !== "subscribe" ||
      !equal(env.WA_VERIFY_TOKEN, url.searchParams.get("hub.verify_token"))
    )
      bad(403, "Проверка отклонена");
    res.end(url.searchParams.get("hub.challenge") || "");
    return;
  }
  if (path.startsWith("/hooks/") && method === "POST") {
    const raw = await readBody(req);
    let entries = [];
    if (
      path === "/hooks/telegram" &&
      configured.Telegram &&
      equal(
        env.TG_WEBHOOK_SECRET,
        req.headers["x-telegram-bot-api-secret-token"],
      )
    )
      entries = parseTelegram(parse(raw));
    else if (
      path === "/hooks/whatsapp" &&
      configured.WhatsApp &&
      equal(
        "sha256=" + signature("sha256", env.WA_APP_SECRET, raw),
        req.headers["x-hub-signature-256"],
      )
    )
      entries = parseWhatsApp(parse(raw));
    else if (
      path === "/hooks/amo/" + encodeURIComponent(env.AMO_SCOPE_ID || "") &&
      chatsReady &&
      equal(
        signature("sha1", env.AMO_CHANNEL_SECRET, raw),
        req.headers["x-signature"],
      )
    ) {
      const data = parse(raw);
      if (!env.AMO_ACCOUNT_ID || data.account_id !== env.AMO_ACCOUNT_ID)
        bad(403, "Другой аккаунт");
      const ev = data.message;
      if (!ev) return json(res, { ok: true });
      const row = one(
        "SELECT * FROM chats WHERE id=?",
        ev.conversation?.client_id || "",
      );
      if (!row) bad(422, "Диалог не связан");
      if (!ev.message?.text || ev.message.type !== "text")
        bad(422, "Поддерживается текстовое сообщение");
      if (JSON.parse(row.meta).accountId)
        bad(403, "Ответьте из виджета под своей учётной записью amoCRM");
      await sendMessage(
        { name: ev.sender?.name || "amoCRM", login: "amo", role: "admin" },
        row,
        { id: "amo-" + ev.message.id, text: ev.message.text },
        ev.message.id,
      );
      return json(res, { ok: true });
    } else bad(403, "Проверка вебхука не пройдена");
    transaction(() => entries.forEach(ingest));
    return json(res, { ok: true });
  }
  if (path.startsWith("/auth/")) return auth.route(req, res, url);
  if (path === "/livez" && method === "GET")
    return json(res, { service: "BeChat", status: "live" });
  if (path === "/healthz" && method === "GET") {
    if (!one("SELECT 1 AS healthy")?.healthy) bad(503, "База недоступна");
    return json(res, { service: "BeChat", version: "1.1.8", status: "ok" });
  }
  if (path.startsWith("/api/")) {
    const u = method==="GET" && path.startsWith("/api/files/") && url.searchParams.has("download")
      ? auth.fileUser(path.slice(11),url.searchParams.get("download")) : auth.current(req);
    if (path.startsWith("/api/voice-text/") && method==="POST") {
      const f=one("SELECT * FROM files WHERE id=?",path.slice("/api/voice-text/".length));
      if(!f || !f.chat)bad(404,"Файл недоступен");
      const row=visibleChat(f.chat,u);
      if(!(f.mime||"").startsWith("audio/") || f.size>8388608)bad(422,"Выберите голосовое сообщение до 8 МБ");
      const result=await voiceText(f.id,async()=>{
        const src=await attachmentSource(f,row,res);
        return Buffer.isBuffer(src)?src:readBody(src,8388608);
      });
      return json(res,result);
    }
    if (path === "/api/library" && method === "GET") return json(res,await searchGifs(url.searchParams));
    if (path === "/api/library/file" && method === "GET") {
      const bytes=await getAnimation(url.searchParams);
      res.writeHead(200,{"Content-Type":"image/gif","Cache-Control":"private, max-age=3600"});
      return res.end(bytes);
    }
    if (path === "/api/changes" && method === "GET") return listenChanges(u.login,url.searchParams.get("since"),res);
    if (path === "/api/contact-match") {
      requireWrite(u);
      if (method==="GET") {
        const key=automaticLinks.due(u.login);
        return json(res,{key,phone:key?.startsWith("+")?key:null});
      }
      if(method!=="POST") bad(405,"Требуется POST");
      const v=parse(await readBody(req,65536)),key=v.key||normalPhone(v.phone);
      if(!transaction(()=>automaticLinks.search(u.login,key,v.matches)))bad(400,"Контакт недоступен");
      return json(res,{ok:true});
    }
    if (path === "/api/contact-photos" && method === "POST") {
      const {contacts,lead,leadFields} = parse(await readBody(req,65536));
      if (!Array.isArray(contacts) || contacts.length>100) bad(400,"Проверьте контакты сделки");
      if (/^[1-9]\d{0,15}$/.test(String(lead)) && u.role!=="observer")
        transaction(()=>automaticLinks.card(u.login,String(lead),contacts,leadFields));
      return json(res,contacts.filter(c=>c?.id).map(c=>({id:String(c.id),photos:
        many("SELECT DISTINCT c.channel,a.jpeg FROM crm_chat_links l JOIN chats c ON c.id=l.chat JOIN avatars a ON a.chat=c.id WHERE l.owner=? AND l.lead=? AND l.contact=? AND c.owner=?",u.login,String(lead),String(c.id),u.login)
        .map(r=>({channel:r.channel,src:"data:image/jpeg;base64,"+r.jpeg}))})));
    }
    if (path.startsWith("/api/avatar/") && method==="GET") {
      const chat=visibleChat(path.slice(12),u);
      const pic=one("SELECT jpeg FROM avatars WHERE chat=?",chat.id);
      if (!pic) bad(404,"Фото недоступно");
      res.writeHead(200,{"Content-Type":"image/jpeg","Cache-Control":"private, no-store"});
      return res.end(Buffer.from(pic.jpeg,"base64"));
    }
    if (path === "/api/deal-dialogs") {
      requireWrite(u);
      if (method === "GET") return json(res, many("SELECT * FROM chats ORDER BY rowid DESC")
        .filter(r => canSee(u,r) && r.owner === u.login && !metadata(r).leadId)
        .map(r => ({id:r.id,channel:r.channel,name:metadata(r).name})));
      if (method !== "POST") bad(405,"Требуется POST");
      const v = parse(await readBody(req,4096));
      if (!/^[1-9]\d{0,15}$/.test(String(v.lead))) bad(400,"Не удалось определить сделку");
      const row = one("SELECT * FROM chats WHERE id=?", trim(v.chat));
      if (!row || row.owner !== u.login || !canSee(u,row)) bad(404,"Диалог недоступен");
      const meta = JSON.parse(row.meta);
      if (meta.leadId && String(meta.leadId) !== String(v.lead)) bad(409,"Диалог уже привязан к другой сделке");
      saveMeta(row.id,{...meta,leadId:String(v.lead)});
      return json(res,{ok:true});
    }
    if (path === "/api/logout" && method === "POST") {
      auth.logout(req);
      return json(res, { ok: true });
    }
    if (path === "/api/accounts") {
      if (method === "GET") return json(res, accounts.list(u.login));
      requireWrite(u);
      if (method === "POST") {
        const input = parse(await readBody(req, 16384));
        if (input.op === "disconnect")
          return json(res, await accounts.remove(u.login, input.id));
        if (input.op === "answer")
          return json(
            res,
            await accounts.answer(u.login, input.channel, input.answer),
          );
        if (input.op === "connect") {
          await accounts.connect(u, input);
          return json(res, accounts.list(u.login));
        }
        bad(400, "Неизвестное действие");
      }
    }
    if (path === "/api/sms" && method === "GET")
      return json(res, smsService.overview(u.role === "founder"));
    if (path === "/api/sms" && method === "POST")
      return json(res, smsService.manage(u, parse(await readBody(req))));
    if (path === "/api/deal-timeline" && method === "GET") {
      const lead=url.searchParams.get("lead"), after=Number(url.searchParams.get("after")||0);
      if (!/^[1-9]\d*$/.test(lead||"") || !Number.isSafeInteger(after) || after<0)
        bad(400,"Неверная страница истории");
      const linked=new Set(many("SELECT chat FROM crm_chat_links WHERE owner=? AND lead=?",u.login,lead).map(r=>r.chat));
      const chats=many("SELECT * FROM chats").filter(r=>canSee(u,r) && (linked.has(r.id)||String(JSON.parse(r.meta).leadId||"")===lead));
      const byId=new Map(chats.map(r=>[r.id,metadata(r)]));
      if (!chats.length) return json(res,{items:[],next:null});
      const page=many("SELECT m.rowid AS cursor,m.chat,m.body,v.edited_text FROM messages m LEFT JOIN message_views v ON v.message=m.id AND v.login=? WHERE m.rowid>? AND m.chat IN (SELECT value FROM json_each(?)) AND COALESCE(v.hidden,0)=0 AND json_extract(m.body,'$.side') IN ('in','out') ORDER BY m.rowid LIMIT 251",u.login,after,JSON.stringify([...byId.keys()]));
      const more=page.length>250;
      if(more)page.pop();
      const items=page.map(r=>{
        const m=JSON.parse(r.body), c=byId.get(r.chat);
        const files=m.files?.length?m.files:(m.file?[m.file]:[]);
        return {id:m.id,chat:r.chat,channel:c.channel,name:c.name,side:m.side,at:m.at,status:m.status,
          author:m.side==="out"?(m.author||c.owner):c.name,text:r.edited_text??m.text,files:files.map(f=>f.name)};
      });
      return json(res,{items,next:more?page.at(-1).cursor:null});
    }
    if (path === "/api/state" && method === "GET") {
      const entity = url.searchParams.get("entity"),
        eid = url.searchParams.get("entityId");
      const related = new Set(many("SELECT chat FROM crm_chat_links WHERE owner=? AND lead=?",u.login,String(eid||url.searchParams.get("lead")||"")).map(r=>r.chat));
      const rows = many("SELECT * FROM chats ORDER BY rowid DESC")
        .filter((r) => canSee(u, r))
        .map((r) => ({ r, m: metadata(r) }))
        .filter(
          ({ m }) =>
            !entity ||
            (entity === "leads" && (m.leadId === eid || related.has(m.id))) ||
            (entity === "contacts" && m.contactId === eid),
        );
      const compact = url.searchParams.get("view")==="inbox", feedOnly = url.searchParams.get("view")==="feed";
      const activeId = url.searchParams.get("active") || rows.find(({m})=>related.has(m.id) || m.leadId===url.searchParams.get("lead"))?.m.id || rows[0]?.m.id;
      const size = Math.max(100,Math.min(10000000,Number.parseInt(url.searchParams.get("limit")) || 100));
      const chats = rows.map(({ m }) => {
        const limit = feedOnly && url.searchParams.get("timeline")==="1" ? 0 : feedOnly ? 6 : compact ? (activeId===m.id ? size : 1) : -1;
        const data = many(
          "SELECT m.body,v.edited_text,v.reaction FROM messages m LEFT JOIN message_views v ON v.message=m.id AND v.login=? WHERE m.chat=? AND COALESCE(v.hidden,0)=0 ORDER BY json_extract(m.body,'$.at') DESC,m.rowid DESC LIMIT ?",
          u.login,m.id,limit<=0?limit:limit+1);
        const hasEarlier = limit>0 && data.length>limit;
        if (hasEarlier) data.pop();
        return {
        ...m,
        hasEarlier,
        searchMatch: url.searchParams.get("q") ? !!one("SELECT 1 FROM messages m LEFT JOIN message_views v ON v.message=m.id AND v.login=? WHERE m.chat=? AND COALESCE(v.hidden,0)=0 AND instr(lower(COALESCE(v.edited_text,json_extract(m.body,'$.text'))),lower(?))>0 LIMIT 1",u.login,m.id,trim(url.searchParams.get("q"),200)) : false,
        messages: data.reverse().map(r => {
          const original=JSON.parse(r.body);
          if(original.card) {
            const id=original.card.id;
            original.card={kind:original.card.kind,title:original.card.title,href:"/share/"+id+(original.side==="note" ? "?access="+auth.fileLink(req,"card-"+id).split("download=")[1] : "")};
          }
          for (const file of [original.file,...(original.files||[])]) if(file) file.download=auth.fileLink(req,file.id);
          return {...original,
          ...(r.edited_text !== null
            ? { text: r.edited_text, edited: true }
            : {}),
          ...(r.reaction ? { reaction: r.reaction } : {})};
        }),
      }; });
      return json(res, {
        uiBuild, selected:activeId, revision:revision(u.login), chats,
        templates: many("SELECT * FROM templates ORDER BY title"),
        sharedSms: smsService.overview(false),
        channels: [
          ...new Set([
            ...accounts.available(u.login),
            ...(smsService.active() ? ["SMS"] : []),
          ]),
        ],
        profile: {
          crmUserId: u.uid,
          name: u.name,
          role: roleName[u.role],
          founder: u.role === "founder",
        },
        crm: true,
        crmOrigin,
      });
    }
    if (path === "/api/wa-templates" && method === "GET")
      return json(
        res,
        waTemplates.map((t) => ({ name: t.name })),
      );
    if (path.startsWith("/api/files/") && method === "GET") {
      const f = one("SELECT * FROM files WHERE id=?", path.slice(11));
      if (!f || (!f.chat && f.owner !== u.login)) bad(404, "Файл недоступен");
      const row = f.chat ? visibleChat(f.chat, u) : null;
      const content=await attachmentSource(f,row,res);
      const length=Buffer.isBuffer(content)?content.length:content.mediaLength;
      res.writeHead(200, {
        ...(Number.isSafeInteger(length)?{"Content-Length":length}:{}),
        "Content-Type": f.mime || "application/octet-stream",
        "Content-Disposition":
          "attachment; filename*=UTF-8''" + encodeURIComponent(f.name),
        "Cache-Control": "no-store",
      });
      if(Buffer.isBuffer(content))return res.end(content);
      return pipeline(content,res);
    }
    requireWrite(u);
    if (path === "/api/files" && method === "POST") {
      let bytes = await readBody(req, 8 * 1024 * 1024),
        name =
          trim(decodeURIComponent(req.headers["x-filename"] || "file"), 200) ||
          "file",
        fid = id();
      const kind = req.headers["x-bechat-media"];
      let duration;
      if (kind === "voice") {
        const normalized=await normalizeVoice(bytes); bytes=normalized.bytes; duration=normalized.duration;
        name="Голосовое сообщение.ogg";
      } else if (kind === "gif" || kind === "sticker") {
        if (!/^GIF8[79]a$/.test(bytes.toString("ascii",0,6))) bad(400,"Ожидалась анимация GIF");
        name=name.replace(/\.gif$/i,"")+".gif";
      }
      run(
        "INSERT INTO files(id,owner,name,mime,size,bytes) VALUES(?,?,?,?,?,?)",
        fid,
        u.login,
        name,
        mime[extname(name).toLowerCase()] || "application/octet-stream",
        bytes.length,
        bytes,
      );
      return json(res, { id: fid, name, size: bytes.length, duration });
    }
    const v = parse(await readBody(req));
    if (path === "/api/chats" && method === "POST") {
      const channel = v.channel,
        name = trim(v.name) || trim(v.peer),
        accountId = accounts.pick(u.login, String(channel));
      if (!name || (channel === "SMS" ? !smsService.active() : !accountId))
        bad(400, "Подключите канал и укажите получателя");
      let peer = trim(v.peer);
      const phoneSearch = v.lookup === "phone" || ["WhatsApp","SMS"].includes(channel);
      let recipientPhone = phoneSearch ? normalPhone(peer) : "";
      if (phoneSearch && !recipientPhone) bad(400,"Укажите номер с кодом страны");
      if (channel !== "SMS") {
        const existing = recipientPhone && one("SELECT meta FROM chats WHERE owner=? AND channel=? AND json_extract(meta,'$.accountId')=? AND json_extract(meta,'$.phone')=?",u.login,channel,accountId,recipientPhone);
        if (existing) peer = JSON.parse(existing.meta).remotePeer;
        else if (channel==="ВКонтакте" && phoneSearch) bad(422,"Среди доступных контактов ВКонтакте нет собеседника с таким номером. Проверьте видимость номера в его профиле.");
        else peer = await accounts.resolvePeer(accountId,recipientPhone || peer);
      }
      const extra = recipientPhone ? {phone:recipientPhone} : {};
      if (
        ["leads", "contacts"].includes(v.entity) &&
        /^[1-9]\d*$/.test(v.entityId)
      ) {
        extra[v.entity === "leads" ? "leadId" : "contactId"] = v.entityId;
        const entity = await readEntity(v.entity, v.entityId, u.uid);
        if (entity && v.entity === "leads") {
          extra.deal = entity.name;
          extra.amount = entity.price;
        }
      }
      let phone;
      if (channel === "SMS") {
        try {
          phone = smsCore.normalize(v.peer);
        } catch (e) {
          bad(400, e.message);
        }
      }
      const row =
        channel === "SMS"
          ? smsService.chatFor(smsService.active(), phone, name, u.login, extra)
          : getChat(
              channel,
              accountId ? accountId + ":" + peer : peer,
              name,
              u.login,
              accountId ? { ...extra, accountId, remotePeer: peer } : extra,
            );
      if (!canSee(u, row)) bad(403, "Контакт ведёт другой менеджер");
      const previous = JSON.parse(row.meta);
      if (extra.leadId && previous.leadId && String(previous.leadId)!==String(extra.leadId))
        bad(409,"Этот диалог уже связан с другой сделкой");

      if (Object.keys(extra).length)
        saveMeta(row.id, { ...JSON.parse(row.meta), ...extra });
      automaticLinks.reconcile({...row,meta:JSON.stringify({...JSON.parse(row.meta),...extra})});
      return json(res, { id: row.id });
    }
    if (path === "/api/templates" && method === "POST") {
      const tid = trim(v.id, 100),
        title = trim(v.title),
        text = trim(v.text, 4000);
      if (!tid || !title || !text) bad(400, "Заполните шаблон");
      run("INSERT OR REPLACE INTO templates VALUES(?,?,?)", tid, title, text);
      return json(res, { ok: true });
    }
    const match = /^\/api\/chats\/([^/]+)(?:\/(messages|tasks))?$/.exec(path);
    if (match) {
      const row = visibleChat(match[1], u),
        meta = JSON.parse(row.meta);
      if (match[2] === "messages" && method === "POST")
        return json(res, await sendMessage(u, row, v));
      if (match[2] === "messages" && method === "PATCH") {
        const messageId = trim(v.id, 120);
        if (
          !one(
            "SELECT id FROM messages WHERE id=? AND chat=?",
            messageId,
            row.id,
          )
        )
          bad(404, "Сообщение недоступно");
        if (v.op === "edit") {
          const value = trim(v.value, 4000);
          if (!value) bad(400, "Введите текст");
          run(
            "INSERT INTO message_views(message,login,edited_text) VALUES(?,?,?) ON CONFLICT(message,login) DO UPDATE SET edited_text=excluded.edited_text",
            messageId,
            u.login,
            value,
          );
        } else if (v.op === "reaction") {
          const allowed = [
            "",
            "❤️",
            "🤝",
            "🔥",
            "❤️‍🔥",
            "🤣",
            "🤯",
            "👌",
            "👍",
            "👎",
            "👏",
            "🎉",
            "🥰",
            "😁",
            "🤔",
            "💯",
            "🙏",
            "💙",
            "✨",
            "👀",
          ];
          if (!allowed.includes(v.value)) bad(400, "Неизвестная реакция");
          run(
            "INSERT INTO message_views(message,login,reaction) VALUES(?,?,?) ON CONFLICT(message,login) DO UPDATE SET reaction=excluded.reaction",
            messageId,
            u.login,
            v.value,
          );
        } else if (v.op === "hide") {
          run(
            "INSERT INTO message_views(message,login,hidden) VALUES(?,?,1) ON CONFLICT(message,login) DO UPDATE SET hidden=1",
            messageId,
            u.login,
          );
        } else bad(400, "Неизвестное действие");
        return json(res, { ok: true });
      }
      if (match[2] === "tasks" && method === "POST") {
        if (!trim(v.text)) bad(400, "Введите задачу");
        meta.tasks.push({ id: id(), text: trim(v.text), done: false });
        saveMeta(row.id, meta);
        return json(res, { ok: true });
      }
      if (match[2] === "tasks" && method === "PATCH") {
        const t = meta.tasks.find((x) => x.id === v.id);
        if (!t) bad(404, "Задача не найдена");
        t.done = !!v.done;
        saveMeta(row.id, meta);
        return json(res, { ok: true });
      }
      if (!match[2] && method === "PATCH") {
        const changes = {};
        for (const k of [
          "pinned",
          "pinMessage",
          "archived",
          "unanswered",
          "deal",
          "amount",
          "stage",
          "company",
          "tags",
          "leadId",
          "contactId",
        ]) {
          if (!(k in v)) continue;
          if (["pinned", "archived"].includes(k)) changes[k] = !!v[k];
          else if (k === "tags")
            changes.tags = (Array.isArray(v.tags) ? v.tags : [])
              .slice(0, 30)
              .map((t) => trim(t, 50));
          else if (["stage", "amount", "unanswered"].includes(k))
            changes[k] = Math.min(
              k === "stage" ? 4 : 1e12,
              Math.max(0, Math.floor(Number(v[k])) || 0),
            );
          else changes[k] = trim(v[k]);
        }
        for (const [k, type] of [
          ["leadId", "leads"],
          ["contactId", "contacts"],
        ])
          if (changes[k]) {
            if (!/^[1-9]\d*$/.test(changes[k]))
              bad(400, "Нужен числовой ID amoCRM");
            const e = await readEntity(type, changes[k], u.uid);
            if (e && k === "leadId") {
              changes.deal = e.name;
              changes.amount = e.price;
            }
          }
        const fresh = one("SELECT meta FROM chats WHERE id=?", row.id);
        saveMeta(row.id, { ...JSON.parse(fresh.meta), ...changes });
        return json(res, { ok: true });
      }
    }
    bad(404, "Метод не найден");
  }
  if (method !== "GET" && method !== "HEAD")
    bad(405, "Метод не поддерживается");
  if (path === "/config.js") {
    res.writeHead(200, {
      "Content-Type": "text/javascript",
      "Cache-Control": "no-store",
    });
    return res.end(
      "window.BECHAT_CONFIG=" +
        JSON.stringify({
          crmOrigin: authSettings.crm,
          accountId:authSettings.tenant,
          serviceOrigin: authSettings.origin,
          version: "1.1.8",
        }) +
        ";",
    );
  }
  if (
    path !== "/" && path!=="/assets/animated-emoji.json" &&
    !/^\/(?:[a-z][\w-]*\.(?:html|css|js|svg)|assets\/[\w.-]+\.(?:jpg|webp|pdf|js|bcmap|pfb|ttf|wasm|icc|txt))$/.test(
      path,
    )
  )
    bad(404, "Страница не найдена");
  const file = resolve(dist, path === "/" ? "index.html" : path.slice(1));
  let data;
  try {
    data = await readFile(file);
  } catch {
    bad(404, "Файл не найден");
  }
  if(file===resolve(dist,"index.html")) {
    data=data.toString().replace("<html ", '<html data-build="'+uiBuild+'" ')
      .replace(/(src|href)="([\w-]+\.(?:js|css))"/g, (all,key,name)=>key+'="'+name+'?build='+uiBuild+'"');
  }
  res.writeHead(200, {
    "Content-Type": mime[extname(file)] || "application/octet-stream",
    "Cache-Control": path.startsWith("/assets/")?"private, max-age=86400":"no-cache",
  });
  res.end(method === "HEAD" ? undefined : data);
}
const serveCard=cardPages(db,{origin:authSettings.origin,readBody,notify:signal,canWrite:requireWrite,
  privateUser:(id,url,chat)=>{const u=auth.fileUser("card-"+id,url.searchParams.get("access"));visibleChat(chat,u);return u;}});
createServer((req, res) =>
  route(req, res).catch((e) => {
    if (req.url?.startsWith("/api/files/")) console.warn("File retrieval:",e.http||500, e.http ? e.message : [e.name,e.cause?.code,String(e.stack||"").match(/main\.mjs:(\d+):\d+/)?.[1]]);
    if (req.url?.split("?")[0]==="/auth/widget" && e.http)
      console.warn("Widget SSO:",e.http,e.message);
    if (!res.headersSent)
      json(
        res,
        { error: e.http ? e.message : "Ошибка обработки запроса" },
        e.http || 500,
      );
    else res.end();
  }),
).listen(Number(env.PORT || 3010), env.HOST || "127.0.0.1", () =>
  console.log("BeChat готов на порту " + (env.PORT || 3010)),
);
