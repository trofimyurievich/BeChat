import { readFileSync } from "node:fs";
import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";
import { seal, unseal } from "./accounts.mjs";
import sms from "../dist/sms-core.js";
const { measure, senders, transports, gsmBytes, gsmText } = sms;
const fail = (http, msg) => {
  throw Object.assign(Error(msg), { http });
};
function normalize(phone) {
  try {
    return sms.normalize(phone);
  } catch (e) {
    fail(400, e.message);
  }
}
const safeEqual = (a, b) => {
  const x = Buffer.from(a || ""),
    y = Buffer.from(b || "");
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
};
const terminal = new Set(["failed", "expired", "delivered", "cancelled"]);
function validateSender(p) {
  if (
    !Object.hasOwn(senders, p.kind) ||
    !p.sender ||
    (!["short", "shared", "alpha"].includes(p.kind) &&
      normalize(p.sender) !== p.sender) ||
    (["short", "shared"].includes(p.kind) && !/^\d{2,8}$/.test(p.sender)) ||
    (p.kind === "shared" && !p.keyword) ||
    (p.kind === "alpha" &&
      (!/^[A-Za-z0-9 ]{1,11}$/.test(p.sender) || p.inbound))
  )
    fail(400, "Проверьте адрес отправителя SMS");
}
function readRoutes() {
  const list = process.env.BECHAT_SMS_ROUTES
    ? JSON.parse(readFileSync(process.env.BECHAT_SMS_ROUTES, "utf8"))
    : [];
  const routes = new Map();
  for (const p of list) {
    if (
      !/^[a-z0-9_-]{1,40}$/.test(p.id) ||
      routes.has(p.id) ||
      !Object.hasOwn(senders, p.kind) ||
      !Object.hasOwn(transports, p.transport)
    )
      throw Error("Проверьте профиль SMS");
    validateSender(p);
    const url = new URL(p.endpoint);
    if (
      url.username ||
      url.password ||
      !(
        url.protocol === "https:" ||
        (url.protocol === "http:" &&
          ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))
      )
    )
      throw Error("Для SMS нужен HTTPS или локальный шлюз");
    if (
      !(p.hookSecretEnv && process.env[p.hookSecretEnv]?.length >= 24) ||
      !p.credentialEnv ||
      !process.env[p.credentialEnv]
    )
      throw Error("Задайте секреты выбранного профиля SMS");
    if (p.transport === "smpp" && (!p.username || !process.env.PUBLIC_ORIGIN))
      throw Error("Для Jasmin укажите пользователя и PUBLIC_ORIGIN");
    routes.set(p.id, p);
  }
  return routes;
}
function formatPayload(template, values) {
  if (typeof template === "string")
    return template.replace(/\{(to|from|text|id)\}/g, (_, k) => values[k]);
  if (Array.isArray(template))
    return template.map((x) => formatPayload(x, values));
  if (template && typeof template === "object")
    return Object.fromEntries(
      Object.entries(template).map(([k, v]) => [k, formatPayload(v, values)]),
    );
  return template;
}
async function transmit(p, phone, text, id) {
  const secret = p.credential || process.env[p.credentialEnv];
  let body,
    headers = {};
  if (p.transport === "smpp") {
    const gsm = measure(text).encoding === "GSM-7";
    const bytes = gsm
      ? Buffer.from(gsmBytes(text))
      : Buffer.from(text, "utf16le").swap16();
    body = new URLSearchParams({
      username: p.username,
      password: secret,
      to: phone,
      from: p.sender,
      coding: gsm ? "0" : "8",
      "hex-content": bytes.toString("hex"),
      dlr: "yes",
      "dlr-level": "3",
      "dlr-method": "POST",
      "dlr-url": new URL(
        "/hooks/sms/" +
          p.id +
          "/" +
          encodeURIComponent(p.hookSecret || process.env[p.hookSecretEnv]),
        process.env.PUBLIC_ORIGIN,
      ).href,
    });
  } else {
    body = JSON.stringify(
      formatPayload(
        p.payload || {
          to: "{to}",
          from: "{from}",
          text: "{text}",
          client_id: "{id}",
        },
        { to: phone, from: p.sender, text, id },
      ),
    );
    headers = {
      "Content-Type": "application/json",
      [p.authHeader || "Authorization"]: (p.authPrefix ?? "Bearer ") + secret,
      "Idempotency-Key": id,
    };
  }
  const res = await fetch(p.endpoint, {
    method: "POST",
    headers,
    body,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!res.ok)
    throw Object.assign(Error("HTTP " + res.status), {
      definite: res.status >= 400 && res.status < 500 && res.status !== 408,
      retry: res.status === 429,
    });
  const data = await res.text();
  const ref =
    p.transport === "smpp"
      ? /^Success\s+"([^"]+)"$/i.exec(data.trim())?.[1]
      : String(
          (p.idPath || "id")
            .split(".")
            .reduce((o, k) => o?.[k], JSON.parse(data)) ?? "",
        );
  if (!ref || ref.length > 200) throw Error("Ответ без ID");
  return ref;
}
function createSmsService(
  db,
  { getChat, put, update, ingest, importSent, report },
) {
  const routes = readRoutes(),
    q = (s) => db.prepare(s);
  db.exec(`CREATE TABLE IF NOT EXISTS sms_config(id INTEGER PRIMARY KEY CHECK(id=1),plan TEXT NOT NULL,active TEXT NOT NULL);
 INSERT OR IGNORE INTO sms_config VALUES(1,'{}','');
 CREATE TABLE IF NOT EXISTS sms_out(id TEXT PRIMARY KEY REFERENCES messages(id),route TEXT NOT NULL,phone TEXT NOT NULL,payload TEXT NOT NULL,due INTEGER,expires INTEGER,phase TEXT NOT NULL,attempt INTEGER DEFAULT 0,ref TEXT, batch TEXT);
 CREATE INDEX IF NOT EXISTS sms_due ON sms_out(phase,due);
 CREATE UNIQUE INDEX IF NOT EXISTS sms_ref ON sms_out(route,ref);
 CREATE TABLE IF NOT EXISTS sms_receipts(route TEXT,ref TEXT,status TEXT,PRIMARY KEY(route,ref));
 CREATE TABLE IF NOT EXISTS sms_profiles(id TEXT PRIMARY KEY,data TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS sms_block(phone TEXT PRIMARY KEY);
 CREATE TABLE IF NOT EXISTS sms_batches(id TEXT PRIMARY KEY,title TEXT,paused INTEGER DEFAULT 0);
 UPDATE sms_out SET phase='unknown' WHERE phase='sending';`);
  const key = Buffer.from(process.env.BECHAT_ACCOUNT_KEY || "", "base64");
  for (const row of q("SELECT * FROM sms_profiles").all()) {
    if (key.length !== 32) throw Error("Восстановите BECHAT_ACCOUNT_KEY");
    routes.set(row.id, unseal(key, row.data));
  }
  function register(v) {
    if (key.length !== 32) fail(503, "Задайте BECHAT_ACCOUNT_KEY на сервере");
    let endpoint;
    try {
      endpoint = new URL(v.endpoint);
    } catch {
      fail(400, "Проверьте адрес шлюза");
    }
    const allowed = (process.env.BECHAT_SMS_HOSTS || "")
      .toLowerCase()
      .split(",")
      .map((x) => x.trim());
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password ||
      !allowed.includes(endpoint.host)
    )
      fail(400, "Укажите HTTPS-шлюз из BECHAT_SMS_HOSTS");
    const p = {
      id: randomUUID(),
      name: String(v.name || "")
        .trim()
        .slice(0, 100),
      sender: String(v.sender || "").trim(),
      kind: v.kind,
      transport: v.transport,
      endpoint: endpoint.href,
      keyword: String(v.keyword || "").trim(),
      inbound: !!v.inbound,
      credential: String(v.credential || ""),
      hookSecret: randomUUID().replaceAll("-", ""),
      username: String(v.username || "").trim(),
      idPath: String(v.idPath || "id"),
      authHeader: String(v.authHeader || "Authorization"),
      authPrefix: String(v.authPrefix ?? "Bearer "),
      payload: v.payload,
    };
    if (
      !p.name ||
      !p.credential ||
      p.credential.length > 4000 ||
      !Object.hasOwn(transports, p.transport) ||
      !process.env.PUBLIC_ORIGIN?.startsWith("https://") ||
      (p.transport === "smpp" && !p.username) ||
      !/^[-a-zA-Z0-9]+$/.test(p.authHeader) ||
      /[\r\n]/.test(p.authPrefix) ||
      (typeof p.payload !== "undefined" &&
        (!p.payload ||
          typeof p.payload !== "object" ||
          Array.isArray(p.payload)))
    )
      fail(400, "Проверьте поля подключения и PUBLIC_ORIGIN");
    validateSender(p);
    transaction(() => {
      q("INSERT INTO sms_profiles VALUES(?,?)").run(p.id, seal(key, p));
      q("UPDATE sms_config SET active=?,plan=? WHERE id=1").run(
        p.id,
        JSON.stringify({
          kind: p.kind,
          transport: p.transport,
          inbound: p.inbound,
        }),
      );
    });
    routes.set(p.id, p);
    return overview(true);
  }
  const transaction = (fn) => {
    db.exec("BEGIN IMMEDIATE");
    try {
      const v = fn();
      db.exec("COMMIT");
      return v;
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };
  const config = () => q("SELECT * FROM sms_config WHERE id=1").get();
  const active = () => routes.get(config().active);
  const blocked = (n) => !!q("SELECT 1 FROM sms_block WHERE phone=?").get(n);
  const getRoute = (id) => {
    const p = routes.get(id);
    if (!p) fail(409, "Подключите согласованный с оператором SMS-маршрут");
    return p;
  };
  function address(p, phone) {
    return p.id + ":" + phone;
  }
  function chatFor(p, phone, name, owner, extra = {}) {
    return getChat("SMS", address(p, phone), name || phone, owner, {
      ...extra,
      smsRoute: p.id,
      smsNumber: phone,
      smsSender: p.sender,
    });
  }
  function queue(row, m, input) {
    const meta = JSON.parse(row.meta),
      p = getRoute(meta.smsRoute);
    const phone = meta.smsNumber;
    if (active()?.id !== p.id)
      fail(
        409,
        "Для этого диалога отключён SMS-маршрут. Создайте диалог на активном номере.",
      );
    if (blocked(phone)) fail(409, "Номер в стоп-листе");
    const text = m.quote ? "❝ " + m.quote + "\n\n" + m.text : m.text;
    if (!text.trim() || input.file || input.template || text.length > 4000)
      fail(400, "SMS поддерживает текст до 4000 знаков");
    const due = input.smsAt ? Date.parse(input.smsAt) : Date.now(),
      ttl = Number(input.smsTTL ?? 1440);
    if (
      !Number.isFinite(due) ||
      due > Date.now() + 366 * 86400000 ||
      !Number.isInteger(ttl) ||
      ttl < 1 ||
      ttl > 4320
    )
      fail(400, "Проверьте время отправки и срок действия");
    m.sms = {
      ...measure(text),
      route: p.id,
      sender: p.sender,
      phone,
      due: new Date(due).toISOString(),
    };
    m.status = due > Date.now() + 1000 ? "scheduled" : "queued";
    put(row.id, m);
    q(
      "INSERT INTO sms_out(id,route,phone,payload,due,expires,phase,batch) VALUES(?,?,?,?,?,?,?,?)",
    ).run(
      m.id,
      p.id,
      phone,
      text,
      due,
      due + ttl * 60000,
      "queued",
      input.batch || null,
    );
    return m;
  }
  function transition(id, status, ref = null) {
    const row = q("SELECT * FROM messages WHERE id=?").get(id);
    if (!row) return;
    const m = JSON.parse(row.body);
    if (
      terminal.has(m.status) ||
      (m.status === "sent" && status === "accepted")
    )
      return;
    m.status = status;
    update(m, ref);
    report(m);
    q("UPDATE sms_out SET phase=?,ref=COALESCE(?,ref) WHERE id=?").run(
      status,
      ref,
      id,
    );
  }
  const recover = q("SELECT id FROM sms_out WHERE phase='unknown'").all();
  for (const { id } of recover) transition(id, "unknown");
  let working = false;
  async function pump() {
    if (working) return;
    working = true;
    try {
      const item = transaction(() => {
        const row = q(
          `SELECT o.* FROM sms_out o LEFT JOIN sms_batches b ON b.id=o.batch WHERE o.phase='queued' AND o.due<=? AND (COALESCE(b.paused,0)=0 OR o.expires<=?) ORDER BY o.due,o.rowid LIMIT 1`,
        ).get(Date.now(), Date.now());
        if (!row) return;
        if (
          row.expires <= Date.now() ||
          blocked(row.phone) ||
          active()?.id !== row.route
        ) {
          transition(
            row.id,
            row.expires <= Date.now()
              ? "expired"
              : blocked(row.phone)
                ? "cancelled"
                : "failed",
          );
          return;
        }
        transition(row.id, "sending");
        return row;
      });
      if (!item) return;
      let ref;
      try {
        ref = await transmit(
          routes.get(item.route),
          item.phone,
          item.payload,
          item.id,
        );
      } catch (e) {
        transaction(() => {
          if (e.retry && item.attempt < 3) {
            transition(item.id, "queued");
            q("UPDATE sms_out SET due=?,attempt=attempt+1 WHERE id=?").run(
              Date.now() + 30000 * 2 ** item.attempt,
              item.id,
            );
          } else transition(item.id, e.definite ? "failed" : "unknown");
        });
        return;
      }
      transaction(() => {
        transition(item.id, "accepted", ref);
        const r = q(
          "SELECT status FROM sms_receipts WHERE route=? AND ref=?",
        ).get(item.route, ref);
        if (r) transition(item.id, r.status);
        const saved = q("SELECT * FROM messages WHERE id=?").get(item.id);
        importSent(saved);
      });
    } catch {
      console.error("SMS: ошибка обработки очереди, проверьте состояние БД");
    } finally {
      working = false;
    }
  }
  const timer = setInterval(pump, 1000);
  timer.unref();
  function receipt(route, ref, status) {
    if (
      !ref ||
      ref.length > 200 ||
      !["sent", "delivered", "failed", "expired", "unknown"].includes(status)
    )
      fail(400, "Некорректный отчёт");
    const prev = q(
      "SELECT status FROM sms_receipts WHERE route=? AND ref=?",
    ).get(route, ref);
    if (
      prev &&
      (terminal.has(prev.status) ||
        (prev.status === "sent" && status === "unknown"))
    )
      return;
    q("INSERT OR REPLACE INTO sms_receipts VALUES(?,?,?)").run(
      route,
      ref,
      status,
    );
    const row = q("SELECT id FROM sms_out WHERE route=? AND ref=?").get(
      route,
      ref,
    );
    if (row) transition(row.id, status);
  }
  function hook(routeId, proof, raw, headers) {
    const p = getRoute(routeId),
      secret = p.hookSecret || process.env[p.hookSecretEnv],
      jas = p.transport === "smpp";
    if (
      jas
        ? !safeEqual(secret, proof)
        : !safeEqual(
            "sha256=" + createHmac("sha256", secret).update(raw).digest("hex"),
            headers["x-sms-signature"],
          )
    )
      fail(403, "Неверная подпись SMS");
    let v;
    try {
      v = jas
        ? Object.fromEntries(new URLSearchParams(raw.toString()))
        : JSON.parse(raw);
    } catch {
      fail(400, "Некорректный JSON");
    }
    transaction(() => {
      if (jas ? v.message_status : v.type === "receipt") {
        const state = String(v.message_status || "");
        const status = jas
          ? {
              DELIVRD: "delivered",
              EXPIRED: "expired",
              ESME_ROK: "sent",
              ACCEPTD: "sent",
              ENROUTE: "sent",
              REJECTD: "failed",
              UNDELIV: "failed",
              DELETED: "failed",
            }[state] || (state.startsWith("ESME_") ? "failed" : "unknown")
          : v.status;
        receipt(p.id, String(v.id ?? ""), status);
        return;
      }
      if (!jas && v.type !== "inbound") fail(400, "Неизвестный тип события");
      if (active()?.id !== p.id) return;
      const phone = normalize(v.from),
        dest = String(v.to || "").replace(/^\+/, "");
      if (!p.inbound || dest !== p.sender.replace(/^\+/, ""))
        fail(400, "Неверный входящий маршрут");
      let text = String(v.content ?? v.text ?? "");
      if (jas && v.binary) {
        const bytes = Buffer.from(v.binary, "hex");
        text =
          String(v.coding) === "8"
            ? bytes.swap16().toString("utf16le")
            : String(v.coding || 0) === "0"
              ? gsmText(bytes)
              : text;
      }
      if (
        p.kind === "shared" &&
        !text.toUpperCase().startsWith(p.keyword.toUpperCase() + " ")
      )
        return;
      if (p.kind === "shared") text = text.slice(p.keyword.length).trimStart();
      if (!v.id || !text || String(v.id).length > 200 || text.length > 16384)
        fail(400, "Некорректное входящее SMS");
      const peer = address(p, phone);
      chatFor(p, phone);
      const fresh = ingest({
        channel: "SMS",
        peer,
        name: phone,
        text,
        at: new Date().toISOString(),
        remoteId: String(v.id),
      });
      if (fresh && /^(STOP|СТОП)$/i.test(text.trim()))
        q("INSERT OR IGNORE INTO sms_block VALUES(?)").run(phone);
    });
    return jas ? "ACK/Jasmin" : "OK";
  }
  function overview(admin) {
    const cfg = config(),
      p = active();
    if (!admin)
      return { connected: !!p, sender: p?.sender || "", inbound: !!p?.inbound };
    return {
      active: cfg.active,
      plan: admin ? JSON.parse(cfg.plan) : {},
      setup:
        p && process.env.PUBLIC_ORIGIN
          ? {
              url: new URL(
                "/hooks/sms/" +
                  p.id +
                  (p.transport === "smpp"
                    ? "/" +
                      encodeURIComponent(
                        p.hookSecret || process.env[p.hookSecretEnv],
                      )
                    : ""),
                process.env.PUBLIC_ORIGIN,
              ).href,
              secret:
                p.transport === "https"
                  ? p.hookSecret || process.env[p.hookSecretEnv]
                  : "",
            }
          : null,
      routes: [...routes.values()].map(
        ({ id, name, sender, kind, transport, inbound }) => ({
          id,
          name: name || id,
          sender,
          kind,
          transport,
          inbound: !!inbound,
        }),
      ),
      ...(admin
        ? {
            blocked: q("SELECT phone FROM sms_block ORDER BY phone")
              .all()
              .map((r) => r.phone),
            batches: q(
              `SELECT b.id,b.title,b.paused,COUNT(o.id) AS total,SUM(o.phase='delivered') AS delivered,SUM(o.phase='queued') AS queued FROM sms_batches b JOIN sms_out o ON o.batch=b.id GROUP BY b.id ORDER BY b.rowid DESC LIMIT 100`,
            ).all(),
          }
        : {}),
    };
  }
  function manage(u, v) {
    if (u.role !== "founder")
      fail(403, "Общим SMS-аккаунтом управляет учредитель");
    if (v.op === "register") return register(v);
    if (v.op === "settings") {
      if (
        !Object.hasOwn(senders, v.kind) ||
        !Object.hasOwn(transports, v.transport)
      )
        fail(400, "Некорректный план подключения");
      if (v.active) getRoute(v.active);
      q("UPDATE sms_config SET plan=?,active=? WHERE id=1").run(
        JSON.stringify({
          kind: v.kind,
          transport: v.transport,
          inbound: !!v.inbound && v.kind !== "alpha",
        }),
        v.active || "",
      );
    } else if (v.op === "block")
      q("INSERT OR IGNORE INTO sms_block VALUES(?)").run(normalize(v.phone));
    else if (v.op === "unblock")
      q("DELETE FROM sms_block WHERE phone=?").run(normalize(v.phone));
    else if (v.op === "batch") {
      const p = active();
      if (!p) fail(409, "Выберите подключённый маршрут");
      if (
        !Array.isArray(v.phones) ||
        !v.phones.length ||
        v.phones.length > 1000 ||
        typeof v.text !== "string" ||
        !v.text.trim() ||
        typeof v.title !== "string" ||
        !v.title.trim() ||
        !/^[\w-]{8,100}$/.test(v.id)
      )
        fail(400, "Проверьте параметры рассылки");
      const phones = [...new Set(v.phones.map(normalize))];
      transaction(() => {
        if (q("SELECT 1 FROM sms_batches WHERE id=?").get(v.id)) return;
        q("INSERT INTO sms_batches(id,title) VALUES(?,?)").run(
          v.id,
          v.title.slice(0, 120),
        );
        for (const phone of phones) {
          const row = chatFor(p, phone, phone, u.login),
            meta = JSON.parse(row.meta);
          queue(
            row,
            {
              id: randomUUID(),
              at: new Date().toISOString(),
              side: "out",
              author: u.name,
              text: v.text.replaceAll("{имя}", meta.name.split(" ")[0]),
            },
            { ...v, batch: v.id },
          );
        }
      });
    } else if (["pause", "resume", "cancel"].includes(v.op)) {
      transaction(() => {
        if (v.op === "cancel") {
          for (const r of q(
            "SELECT id FROM sms_out WHERE batch=? AND phase='queued'",
          ).all(v.id))
            transition(r.id, "cancelled");
        } else
          q("UPDATE sms_batches SET paused=? WHERE id=?").run(
            Number(v.op === "pause"),
            v.id,
          );
      });
    } else fail(400, "Неизвестная команда");
    return overview(true);
  }
  return {
    active,
    chatFor,
    queue,
    overview,
    manage,
    hook,
    transaction,
    close: () => clearInterval(timer),
  };
}
export { createSmsService };
