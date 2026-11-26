import { createAuth, authConfig } from "./auth.mjs";
import { createAccounts } from "./accounts.mjs";
import { createSmsService } from "./sms.mjs";
import smsCore from "../dist/sms-core.js";
import { createServer } from "node:http";
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
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
const authSettings = authConfig(env);
const dbPath = resolve(env.BECHAT_DB || "data/bechat.sqlite");
mkdirSync(dirname(dbPath), { recursive: true });
const db = new DatabaseSync(dbPath);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS chats(id TEXT PRIMARY KEY,channel TEXT,peer TEXT,owner TEXT,meta TEXT,UNIQUE(channel,peer));
CREATE TABLE IF NOT EXISTS messages(id TEXT PRIMARY KEY,chat TEXT REFERENCES chats(id),remote TEXT,body TEXT);
CREATE TABLE IF NOT EXISTS message_views(message TEXT REFERENCES messages(id),login TEXT,edited_text TEXT,reaction TEXT,hidden INTEGER NOT NULL DEFAULT 0,PRIMARY KEY(message,login));
CREATE INDEX IF NOT EXISTS msg_chat ON messages(chat);
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
const accounts = createAccounts(db);
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
const put = (chat, m, remote = null) =>
  run(
    "INSERT INTO messages VALUES(?,?,?,?)",
    m.id,
    chat,
    remote,
    JSON.stringify(m),
  );
const update = (m, remote = null) =>
  run(
    "UPDATE messages SET body=?,remote=COALESCE(?,remote) WHERE id=?",
    JSON.stringify(m),
    remote,
    m.id,
  );
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
function ingest(v) {
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
    if (row) setStatus(JSON.parse(row.body), v.status);
    return;
  }
  const mid = createHash("sha256")
    .update(JSON.stringify([v.channel, v.peer, v.remoteId]))
    .digest("hex");
  if (one("SELECT id FROM messages WHERE id=?", mid)) return;
  const row = getChat(
      v.channel,
      v.peer,
      v.name,
      v.owner,
      v.accountId ? { accountId: v.accountId, remotePeer: v.remotePeer } : {},
    ),
    meta = JSON.parse(row.meta);
  meta.unanswered = (meta.unanswered || 0) + 1;
  meta.archived = false;
  if (v.username) meta.username = v.username;
  saveMeta(row.id, meta);
  const m = { id: mid, side: "in", text: v.text || "", at: v.at };
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
  job(mid, scopePath, importMessage(metadata(row), m));
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
  if (!text && !file) bad(400, "Введите текст");
  if (!isNote && file && text.length > 1000)
    bad(400, "Подпись к файлу ограничена 1000 символами");
  const m = {
    id: mid,
    text,
    quote: trim(input.quote, 220),
    side: isNote ? "note" : "out",
    author: u.name,
    at: stamp(),
    status: isNote ? "saved" : "sending",
    ...(amoId ? { amoId } : {}),
    ...(file
      ? { file: { id: file.id, name: file.name, size: file.size } }
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
    const remote = JSON.parse(row.meta).accountId
      ? await accounts.send(row, quoted, file)
      : await sendProvider(row, quoted, file);
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
      if (!amoId) job(m.id, scopePath, importMessage(metadata(now), m));
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
  ".txt": "text/plain",
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
async function route(req, res) {
  const url = new URL(req.url, "http://localhost"),
    path = url.pathname,
    method = req.method;
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader(
    "Content-Security-Policy",
    `default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' blob: data:; connect-src 'self'; frame-ancestors 'self' ${crmOrigin || ""}; object-src 'none'; base-uri 'none'; form-action 'self'`,
  );
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
  const personalHook = /^\/hooks\/account\/([a-f0-9-]{36})$/.exec(path);
  if (personalHook && ["GET", "POST"].includes(method)) {
    const { events, text } = accounts.hook(
      personalHook[1],
      method,
      url.searchParams,
      req.headers,
      method === "POST" ? await readBody(req) : null,
    );
    transaction(() => events.forEach(ingest));
    res.writeHead(200, { "Content-Type": "text/plain" });
    return res.end(text);
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
  if (path === "/healthz" && method === "GET") {
    if (!one("SELECT 1 AS healthy")?.healthy) bad(503, "База недоступна");
    return json(res, { service: "BeChat", version: "1.1.0", status: "ok" });
  }
  if (path.startsWith("/api/")) {
    const u = auth.current(req);
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
          return json(res, accounts.remove(u.login, input.id));
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
    if (path === "/api/state" && method === "GET") {
      const entity = url.searchParams.get("entity"),
        eid = url.searchParams.get("entityId");
      const rows = many("SELECT * FROM chats ORDER BY rowid DESC")
        .filter((r) => canSee(u, r))
        .map((r) => ({ r, m: metadata(r) }))
        .filter(
          ({ m }) =>
            !entity ||
            (entity === "leads" && m.leadId === eid) ||
            (entity === "contacts" && m.contactId === eid),
        );
      const chats = rows.map(({ m }) => ({
        ...m,
        messages: many(
          `SELECT m.body,v.edited_text,v.reaction FROM messages m LEFT JOIN message_views v
              ON v.message=m.id AND v.login=? WHERE m.chat=? AND COALESCE(v.hidden,0)=0 ORDER BY m.rowid`,
          u.login,
          m.id,
        ).map((r) => ({
          ...JSON.parse(r.body),
          ...(r.edited_text !== null
            ? { text: r.edited_text, edited: true }
            : {}),
          ...(r.reaction ? { reaction: r.reaction } : {}),
        })),
      }));
      return json(res, {
        chats,
        templates: many("SELECT * FROM templates ORDER BY title"),
        sharedSms: smsService.overview(false),
        channels: [
          ...new Set([
            ...accounts.available(u.login),
            ...Object.keys(configured).filter((k) => configured[k]),
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
      const bytes = f.bytes
        ? Buffer.from(f.bytes)
        : await fetchMedia(
            row.channel,
            f.remote,
            JSON.parse(row.meta).accountId
              ? accounts.media(JSON.parse(row.meta).accountId)
              : undefined,
          );
      res.writeHead(200, {
        "Content-Type": "application/octet-stream",
        "Content-Disposition":
          "attachment; filename*=UTF-8''" + encodeURIComponent(f.name),
        "Cache-Control": "no-store",
      });
      return res.end(bytes);
    }
    requireWrite(u);
    if (path === "/api/files" && method === "POST") {
      const bytes = await readBody(req, 8 * 1024 * 1024),
        name =
          trim(decodeURIComponent(req.headers["x-filename"] || "file"), 200) ||
          "file",
        fid = id();
      run(
        "INSERT INTO files(id,owner,name,mime,size,bytes) VALUES(?,?,?,?,?,?)",
        fid,
        u.login,
        name,
        mime[extname(name).toLowerCase()] || "application/octet-stream",
        bytes.length,
        bytes,
      );
      return json(res, { id: fid, name, size: bytes.length });
    }
    const v = parse(await readBody(req));
    if (path === "/api/chats" && method === "POST") {
      const channel = v.channel,
        peer = trim(v.peer).replace(
          channel === "WhatsApp" ? /[\s()+-]/g : /\s/g,
          "",
        ),
        name = trim(v.name) || (channel === "SMS" ? peer : ""),
        accountId = accounts.pick(u.login, String(channel));
      if (
        (channel === "SMS"
          ? !smsService.active()
          : !accountId &&
            (!Object.hasOwn(configured, channel) || !configured[channel])) ||
        !name ||
        (channel !== "SMS" &&
          !(channel !== "WhatsApp" ? /^-?\d{1,20}$/ : /^\d{7,16}$/).test(peer))
      )
        bad(400, "Проверьте канал и ID получателя");
      const extra = {};
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
      if (Object.keys(extra).length)
        saveMeta(row.id, { ...JSON.parse(row.meta), ...extra });
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
          serviceOrigin: authSettings.origin,
          version: "1.1.0",
        }) +
        ";",
    );
  }
  if (
    path !== "/" &&
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
  res.writeHead(200, {
    "Content-Type": mime[extname(file)] || "application/octet-stream",
  });
  res.end(method === "HEAD" ? undefined : data);
}
createServer((req, res) =>
  route(req, res).catch((e) => {
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
