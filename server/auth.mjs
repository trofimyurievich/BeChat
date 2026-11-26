import {
  createHash,
  createHmac,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

const digest = (value) =>
  createHash("sha256").update(value).digest("base64url");
const secret = () => randomBytes(32).toString("base64url");
const seconds = () => Math.floor(Date.now() / 1000);
const deny = (status, message) => {
  throw Object.assign(new Error(message), { http: status });
};
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const numberId = (value) =>
  /^[1-9]\d{0,15}$/.test(String(value)) && Number.isSafeInteger(Number(value));
const challengeFormat = /^[A-Za-z0-9_-]{43}$/;
const verifierFormat = /^[A-Za-z0-9_.~-]{43,128}$/;
function same(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const x = Buffer.from(a),
    y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function authConfig(env) {
  const origin = new URL(env.PUBLIC_ORIGIN || "https://bechat.onbequick.ru");
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.href !== origin.origin + "/"
  )
    throw Error(
      "PUBLIC_ORIGIN должен быть полным HTTPS-адресом выделенного домена BeChat",
    );
  const subdomain = env.AMO_SUBDOMAIN || "lcns";
  if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$|^[a-z0-9]$/.test(subdomain))
    throw Error("Проверьте AMO_SUBDOMAIN");
  for (const name of ["AMO_TENANT_ID", "BECHAT_FOUNDER_ID"])
    if (!numberId(env[name]))
      throw Error("Заполните " + name + " числовым ID из amoCRM");
  if (
    !uuid.test(env.AMO_CLIENT_ID || "") ||
    !(env.AMO_CLIENT_SECRET || "").trim()
  )
    throw Error(
      "Заполните AMO_CLIENT_ID и AMO_CLIENT_SECRET приватной интеграции",
    );
  if (Buffer.from(env.BECHAT_ACCOUNT_KEY || "", "base64").length !== 32)
    throw Error("Заполните BECHAT_ACCOUNT_KEY ключом из 32 байт в Base64");
  const roles = new Map([[String(env.BECHAT_FOUNDER_ID), "founder"]]);
  for (const [key, role] of [
    ["BECHAT_ADMIN_IDS", "admin"],
    ["BECHAT_OBSERVER_IDS", "observer"],
  ])
    for (const id of (env[key] || "")
      .split(",")
      .map((x) => x.trim())
      .filter(Boolean)) {
      if (!numberId(id) || roles.has(id))
        throw Error("Проверьте списки ролей: " + key);
      roles.set(id, role);
    }
  const inbox = env.BECHAT_INBOX_OWNER_ID || env.BECHAT_FOUNDER_ID;
  if (!numberId(inbox) || roles.get(String(inbox)) === "observer")
    throw Error("Проверьте BECHAT_INBOX_OWNER_ID");
  const aliases = JSON.parse(env.BECHAT_LEGACY_LOGINS || "{}");
  if (
    !aliases ||
    typeof aliases !== "object" ||
    Array.isArray(aliases) ||
    Object.entries(aliases).some(
      ([id, v]) =>
        !numberId(id) ||
        typeof v !== "string" ||
        !v.trim() ||
        v.startsWith("amo:"),
    ) ||
    new Set(Object.values(aliases)).size !== Object.keys(aliases).length
  )
    throw Error("Проверьте BECHAT_LEGACY_LOGINS");
  return {
    origin: origin.origin,
    crm: "https://" + subdomain + ".amocrm.ru",
    tenant: String(env.AMO_TENANT_ID),
    client: env.AMO_CLIENT_ID.toLowerCase(),
    clientSecret: env.AMO_CLIENT_SECRET,
    callback: origin.origin + "/auth/callback",
    roles,
    inbox: String(inbox),
    aliases,
  };
}
function widgetClaims(token, cfg) {
  if (typeof token !== "string" || token.length > 8192)
    deny(401, "Требуется подтверждение от amoCRM");
  const parts = token.split(".");
  if (
    parts.length !== 3 ||
    parts.some((p) => !p || !/^[a-zA-Z0-9_-]+$/.test(p))
  )
    deny(401, "Некорректное подтверждение amoCRM");
  let header, payload;
  try {
    header = JSON.parse(Buffer.from(parts[0], "base64url"));
    payload = JSON.parse(Buffer.from(parts[1], "base64url"));
  } catch {
    deny(401, "Некорректное подтверждение amoCRM");
  }
  const expected = createHmac("sha256", cfg.clientSecret)
    .update(parts[0] + "." + parts[1])
    .digest("base64url");
  if (
    header?.alg !== "HS256" ||
    !same(parts[2], expected) ||
    !payload ||
    payload.iss !== cfg.crm ||
    payload.aud !== cfg.origin ||
    String(payload.account_id) !== cfg.tenant ||
    String(payload.client_uuid).toLowerCase() !== cfg.client ||
    !numberId(payload.user_id) ||
    !uuid.test(payload.jti || "")
  )
    deny(403, "Подтверждение выдано другому аккаунту или приложению");
  const now = seconds();
  if (
    ![payload.iat, payload.exp, payload.nbf].every(Number.isSafeInteger) ||
    payload.exp <= now ||
    payload.nbf > now + 30 ||
    payload.iat > now + 30 ||
    payload.iat >= payload.exp ||
    payload.nbf >= payload.exp
  )
    deny(401, "Истёк срок подтверждения. Откройте BeChat в CRM ещё раз");
  return payload;
}
function redirect(res, dest, headers = {}) {
  res.writeHead(302, {
    Location: dest,
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    ...headers,
  });
  res.end();
}
async function crmJson(url, opt = {}) {
  let r;
  try {
    r = await fetch(url, {
      ...opt,
      redirect: "error",
      signal: AbortSignal.timeout(12000),
    });
  } catch {
    deny(502, "Нет ответа от amoCRM. Повторите вход позже");
  }
  if (!r.ok)
    deny(
      r.status === 401 || r.status === 403 ? 403 : 502,
      "amoCRM отклонила запрос. Проверьте доступ и настройки интеграции",
    );
  return r.json();
}
export function createAuth(db, cfg, { readBody, json }) {
  db.exec(`CREATE TABLE IF NOT EXISTS amo_staff(uid TEXT PRIMARY KEY,login TEXT NOT NULL UNIQUE,name TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS auth_used(jti TEXT PRIMARY KEY,until INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS auth_pending(state TEXT PRIMARY KEY, lane TEXT NOT NULL, proof TEXT NOT NULL, browser TEXT NOT NULL, nonce TEXT NOT NULL, until INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS auth_tickets(hash TEXT PRIMARY KEY, uid TEXT NOT NULL, lane TEXT NOT NULL, proof TEXT NOT NULL, until INTEGER NOT NULL);
 CREATE TABLE IF NOT EXISTS auth_sessions(hash TEXT PRIMARY KEY, uid TEXT NOT NULL, until INTEGER NOT NULL);
 CREATE INDEX IF NOT EXISTS auth_sessions_exp ON auth_sessions(until);`);
  const q = (sql) => db.prepare(sql);
  const loginFor = (id) =>
    Object.hasOwn(cfg.aliases, String(id))
      ? cfg.aliases[String(id)]
      : "amo:" + cfg.tenant + ":" + id;
  const nameFor = (login) =>
    q("SELECT name FROM amo_staff WHERE login=?").get(login)?.name || login;
  function principal(uid, name) {
    const login = loginFor(uid),
      previous = q("SELECT name FROM amo_staff WHERE uid=?").get(uid);
    const label =
      (typeof name === "string" ? name.trim().slice(0, 160) : "") ||
      previous?.name ||
      "Сотрудник " + uid;
    q(
      "INSERT INTO amo_staff VALUES(?,?,?) ON CONFLICT(uid) DO UPDATE SET login=excluded.login,name=excluded.name",
    ).run(uid, login, label);
    return { uid, login, name: label, role: cfg.roles.get(uid) || "manager" };
  }
  function current(req) {
    const bearer = /^Bearer ([\w-]{43})$/.exec(
      req.headers.authorization || "",
    )?.[1];
    const row =
      bearer &&
      q(
        "SELECT s.uid,u.login,u.name FROM auth_sessions s JOIN amo_staff u ON u.uid=s.uid WHERE s.hash=? AND s.until>?",
      ).get(digest(bearer), seconds());
    if (!row) deny(401, "Требуется вход через amoCRM");
    return { ...row, role: cfg.roles.get(row.uid) || "manager" };
  }
  function ticket(uid, lane, proof) {
    const val = secret();
    q("INSERT INTO auth_tickets VALUES(?,?,?,?,?)").run(
      digest(val),
      uid,
      lane,
      proof,
      seconds() + 90,
    );
    return val;
  }
  const read = async (req) => {
    try {
      const raw = await readBody(req, 8192);
      const data = JSON.parse(raw.toString());
      if (data && typeof data === "object" && !Array.isArray(data)) return data;
    } catch (e) {
      if (e.http) throw e;
    }
    deny(400, "Некорректный запрос");
  };
  function browserCookie(req, name) {
    return (
      (req.headers.cookie || "")
        .split(";")
        .map((p) => p.trim())
        .find((p) => p.startsWith(name + "="))
        ?.slice(name.length + 1) || ""
    );
  }
  function closeSession(req) {
    const bearer = (req.headers.authorization || "").slice(7);
    if (bearer) q("DELETE FROM auth_sessions WHERE hash=?").run(digest(bearer));
  }
  function sweep() {
    for (const table of [
      "auth_used",
      "auth_pending",
      "auth_tickets",
      "auth_sessions",
    ])
      q("DELETE FROM " + table + " WHERE until<=?").run(seconds());
  }
  const timer = setInterval(sweep, 60000);
  timer.unref();
  async function route(req, res, url) {
    const path = url.pathname,
      method = req.method,
      params = url.searchParams;
    if (path === "/auth/widget") {
      if (req.headers.origin !== cfg.crm)
        deny(403, "Откройте виджет из своего аккаунта amoCRM");
      res.setHeader("Access-Control-Allow-Origin", cfg.crm);
      res.setHeader("Vary", "Origin");
      if (method === "OPTIONS") {
        res.writeHead(204, {
          "Access-Control-Allow-Methods": "POST",
          "Access-Control-Allow-Headers":
            "Content-Type, X-Auth-Token, X-Requested-With",
          "Access-Control-Max-Age": "600",
        });
        res.end();
        return;
      }
      if (method !== "POST") deny(405, "Требуется POST");
      const { challenge } = await read(req);
      if (!challengeFormat.test(challenge || "")) deny(400, "Обновите виджет");
      const p = widgetClaims(req.headers["x-auth-token"], cfg);
      if (
        !q("INSERT OR IGNORE INTO auth_used VALUES(?,?)").run(p.jti, p.exp)
          .changes
      )
        deny(401, "Подтверждение уже использовано. Откройте виджет ещё раз");
      const uid = String(p.user_id);
      principal(uid);
      json(res, { ticket: ticket(uid, "widget", challenge) });
      return;
    }
    if (path === "/auth/start" && method === "GET") {
      const lane = params.get("client"),
        proof = params.get("challenge"),
        nonce = params.get("nonce");
      if (
        !["ios", "web"].includes(lane) ||
        !challengeFormat.test(proof || "") ||
        !challengeFormat.test(nonce || "")
      )
        deny(400, "Начните вход из BeChat");
      sweep();
      if (q("SELECT COUNT(*) AS n FROM auth_pending").get().n >= 5000)
        deny(429, "Повторите через несколько минут");
      const state = secret(),
        binder = secret(),
        cookieName = "__Host-bechat-" + state;
      q("INSERT INTO auth_pending VALUES(?,?,?,?,?,?)").run(
        digest(state),
        lane,
        proof,
        digest(binder),
        nonce,
        seconds() + 600,
      );
      const auth = new URL("https://www.amocrm.ru/oauth");
      auth.search = new URLSearchParams({
        client_id: cfg.client,
        state,
        mode: "popup",
      }).toString();
      redirect(res, auth.href, {
        "Set-Cookie":
          cookieName +
          "=" +
          binder +
          "; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=600",
      });
      return;
    }
    if (path === "/auth/callback" && method === "GET") {
      const state = params.get("state") || "",
        code = params.get("code");
      if (!state && params.get("from_widget") === "1") {
        res.writeHead(200, {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
        });
        res.end("BeChat установлен. Откройте переписку из карточки amoCRM.");
        return;
      }
      if (!challengeFormat.test(state))
        deny(400, "Начните вход из приложения BeChat");
      const cookieName = "__Host-bechat-" + state,
        binder = browserCookie(req, cookieName);
      const pending = q(
        "DELETE FROM auth_pending WHERE state=? AND browser=? AND until>? RETURNING *",
      ).get(digest(state), digest(binder), seconds());
      if (!pending) deny(401, "Срок попытки входа истёк. Вернитесь в BeChat");
      res.setHeader(
        "Set-Cookie",
        cookieName + "=; Path=/; Secure; HttpOnly; SameSite=Lax; Max-Age=0",
      );
      const dest =
        pending.lane === "ios"
          ? new URL("bechat-auth://oauth/complete")
          : new URL(cfg.origin + "/");
      const finish = (fields) => {
        const returned = new URLSearchParams({
          ...fields,
          nonce: pending.nonce,
        });
        if (pending.lane === "ios") dest.search = returned.toString();
        else dest.hash = returned.toString();
        redirect(res, dest.href);
      };
      if (params.has("error") || !code || code.length > 8192) {
        finish({ error: "denied" });
        return;
      }
      const referer = params.get("referer");
      if (
        referer &&
        ![cfg.crm, new URL(cfg.crm).hostname, cfg.crm + "/"].includes(referer)
      ) {
        finish({ error: "account" });
        return;
      }
      try {
        const grant = await crmJson(cfg.crm + "/oauth2/access_token", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            client_id: cfg.client,
            client_secret: cfg.clientSecret,
            grant_type: "authorization_code",
            code,
            redirect_uri: cfg.callback,
          }),
        });
        if (!grant.access_token) deny(403, "amoCRM не подтвердила вход");
        const headers = { Authorization: "Bearer " + grant.access_token };
        const info = await crmJson(cfg.crm + "/api/v4/account", { headers });
        if (String(info.id) !== cfg.tenant || !numberId(info.current_user_id)) {
          finish({ error: "account" });
          return;
        }
        const uid = String(info.current_user_id);
        let name;
        try {
          const self = await crmJson(cfg.crm + "/api/v4/users/" + uid, {
            headers,
          });
          if (String(self.id) === uid) name = self.name;
        } catch {}
        principal(uid, name);
        finish({ ticket: ticket(uid, pending.lane, pending.proof) });
      } catch {
        finish({ error: "access" });
      }
      return;
    }
    if (path === "/auth/exchange" && method === "POST") {
      if (req.headers.origin && req.headers.origin !== cfg.origin)
        deny(403, "Недопустимый источник входа");
      const { ticket: code, verifier, client } = await read(req);
      if (
        !challengeFormat.test(code || "") ||
        !verifierFormat.test(verifier || "") ||
        !["ios", "web", "widget"].includes(client)
      )
        deny(400, "Неполная попытка входа");
      const token = secret(),
        until = seconds() + 8 * 3600;
      db.exec("BEGIN IMMEDIATE");
      try {
        const row = q(
          "DELETE FROM auth_tickets WHERE hash=? AND proof=? AND lane=? AND until>? RETURNING uid",
        ).get(digest(code), digest(verifier), client, seconds());
        if (!row) deny(401, "Разрешение истекло. Повторите вход");
        q("INSERT INTO auth_sessions VALUES(?,?,?)").run(
          digest(token),
          row.uid,
          until,
        );
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      json(res, { token, expiresAt: new Date(until * 1000).toISOString() });
      return;
    }
    deny(404, "Маршрут авторизации не найден");
  }
  return {
    route,
    current,
    logout: closeSession,
    nameFor,
    firstOwner: () => loginFor(cfg.inbox),
    close: () => clearInterval(timer),
  };
}
