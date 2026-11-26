import {
  randomBytes,
  randomUUID,
  createCipheriv,
  createDecipheriv,
  createHash,
} from "node:crypto";
import { parseTelegram, parseWhatsApp, sendProvider } from "./providers.mjs";
import { equal, signature } from "./amo.mjs";
const kinds = ["Telegram", "WhatsApp", "MAX", "ВКонтакте"];
const maxHost = "https://platform-api2.max.ru";
const reject = (http, message) => {
  throw Object.assign(new Error(message), { http, definite: true });
};
const vkVersion = process.env.VK_API_VERSION || "5.199";
async function request(url, options) {
  let res;
  try {
    res = await fetch(url, {
      ...options,
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw Object.assign(Error("Нет ответа от мессенджера"), { http: 502 });
  }
  if (!res.ok)
    throw Object.assign(
      Error("Мессенджер отклонил запрос (HTTP " + res.status + ")"),
      { http: 502, definite: res.status < 500 && res.status !== 408 },
    );
  const data = await res.json();
  if (data.error || data.ok === false)
    reject(
      422,
      "Мессенджер отклонил запрос. Проверьте ключ и права приложения.",
    );
  return data;
}
const post = (url, body, headers = {}) =>
  request(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
async function vk(method, token, args = {}) {
  return (
    await request("https://api.vk.com/method/" + method, {
      method: "POST",
      body: new URLSearchParams({ ...args, access_token: token, v: vkVersion }),
    })
  ).response;
}
function credentials(channel, c) {
  return channel === "Telegram"
    ? { TG_TOKEN: c.token }
    : { WA_TOKEN: c.token, WA_PHONE_ID: c.phoneId, WA_VERSION: c.version };
}
function seal(key, data) {
  const iv = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, iv);
  const bytes = Buffer.concat([
    cipher.update(JSON.stringify(data), "utf8"),
    cipher.final(),
  ]);
  return Buffer.concat([iv, cipher.getAuthTag(), bytes]).toString("base64");
}
function unseal(key, value) {
  const data = Buffer.from(value, "base64"),
    dec = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
  dec.setAuthTag(data.subarray(12, 28));
  return JSON.parse(
    Buffer.concat([dec.update(data.subarray(28)), dec.final()]),
  );
}
export { seal, unseal };
export function createAccounts(db) {
  const key = Buffer.from(process.env.BECHAT_ACCOUNT_KEY || "", "base64");
  const origin = process.env.PUBLIC_ORIGIN;
  db.exec(`CREATE TABLE IF NOT EXISTS personal_accounts(id TEXT PRIMARY KEY, owner TEXT NOT NULL,channel TEXT NOT NULL, external TEXT NOT NULL,label TEXT NOT NULL, vault TEXT, ready INTEGER NOT NULL DEFAULT 0, UNIQUE(channel,external));
 CREATE UNIQUE INDEX IF NOT EXISTS personal_owner_channel ON personal_accounts(owner,channel) WHERE vault IS NOT NULL;`);
  const q = (s) => db.prepare(s);
  const callback = (id) => new URL("/hooks/account/" + id, origin).href;
  const publicRow = (r) => ({
    id: r.id,
    channel: r.channel,
    label: r.label,
    ready: Boolean(r.ready),
    callback: callback(r.id),
    ...(["WhatsApp", "ВКонтакте"].includes(r.channel)
      ? { verify: unseal(key, r.vault).verify }
      : {}),
  });
  const list = (owner) =>
    q(
      "SELECT * FROM personal_accounts WHERE owner=? AND vault IS NOT NULL ORDER BY channel",
    )
      .all(owner)
      .map(publicRow);
  function get(id) {
    const row = q(
      "SELECT * FROM personal_accounts WHERE id=? AND vault IS NOT NULL",
    ).get(id);
    if (!row) reject(409, "Аккаунт отключён");
    return { ...row, config: unseal(key, row.vault) };
  }
  async function connect(u, v) {
    if (!kinds.includes(v.channel)) reject(400, "Выберите мессенджер");
    if (key.length !== 32 || !origin || new URL(origin).protocol !== "https:")
      reject(
        503,
        "Для личных каналов настройте ключ шифрования и публичный HTTPS-адрес сервера",
      );
    const token = String(v.token || "").trim(),
      c = { token, verify: randomBytes(24).toString("hex") };
    if (!token || token.length > 4000) reject(400, "Укажите ключ подключения");
    let external, label;
    if (v.channel === "Telegram") {
      if (!/^\d+:[\w-]+$/.test(token)) reject(400, "Проверьте токен бота");
      const me = (
        await request("https://api.telegram.org/bot" + token + "/getMe")
      ).result;
      external = String(me.id);
      label = "@" + me.username;
      if (process.env.TG_TOKEN?.split(":")[0] === external)
        reject(409, "Этот бот уже используется общим каналом");
    } else if (v.channel === "WhatsApp") {
      c.version = v.version;
      c.phoneId = v.phoneId;
      c.appSecret = v.appSecret;
      if (
        !/^v\d{1,3}\.\d{1,2}$/.test(c.version) ||
        !/^\d{3,30}$/.test(c.phoneId) ||
        !c.appSecret ||
        c.appSecret.length > 512
      )
        reject(
          400,
          "Проверьте версию Graph API, ID номера и секрет приложения",
        );
      const me = await request(
        "https://graph.facebook.com/" +
          c.version +
          "/" +
          c.phoneId +
          "?fields=id,display_phone_number,verified_name",
        { headers: { Authorization: "Bearer " + token } },
      );
      if (String(me.id) !== c.phoneId) reject(422, "Номер недоступен");
      external = c.phoneId;
      label = me.display_phone_number || me.verified_name || external;
      if (process.env.WA_PHONE_ID === external)
        reject(409, "Номер уже используется общим каналом");
    } else if (v.channel === "MAX") {
      const me = await request(maxHost + "/me", {
        headers: { Authorization: token },
      });
      if (!me.user_id) reject(422, "Не получен ID бота MAX");
      external = String(me.user_id);
      label = me.username || me.name || external;
    } else {
      const me = await vk("groups.getById", token),
        group = (me.groups || me)[0];
      if (!group?.id)
        reject(422, "Нужен ключ сообщества с правом на сообщения");
      external = String(group.id);
      label = group.name;
      const conf = await vk("groups.getCallbackConfirmationCode", token, {
        group_id: external,
      });
      c.confirm = conf.code;
      if (!c.confirm) reject(422, "Не получен код подтверждения Callback API");
    }
    const prior = q(
      "SELECT * FROM personal_accounts WHERE channel=? AND external=?",
    ).get(v.channel, external);
    if (prior && prior.owner !== u.login)
      reject(409, "Аккаунт закреплён за другим сотрудником");
    const other = q(
      "SELECT id FROM personal_accounts WHERE owner=? AND channel=? AND vault IS NOT NULL",
    ).get(u.login, v.channel);
    if (other && other.id !== prior?.id)
      reject(409, "Сначала отключите текущий аккаунт этого мессенджера");
    const id = prior?.id || randomUUID();
    if (prior?.vault) c.verify = unseal(key, prior.vault).verify;
    const stored = seal(key, c);
    q(
      "INSERT INTO personal_accounts(id,owner,channel,external,label,vault,ready) VALUES(?,?,?,?,?,?,0) ON CONFLICT(id) DO UPDATE SET label=excluded.label,vault=excluded.vault,ready=0",
    ).run(id, u.login, v.channel, external, label, stored);
    if (v.channel === "Telegram" || v.channel === "MAX") {
      const url = callback(id);
      if (v.channel === "Telegram")
        await post("https://api.telegram.org/bot" + token + "/setWebhook", {
          url,
          secret_token: c.verify,
          allowed_updates: ["message", "channel_post"],
        });
      else
        await post(
          maxHost + "/subscriptions",
          { url, update_types: ["message_created"], secret: c.verify },
          { Authorization: token },
        );
      q("UPDATE personal_accounts SET ready=1 WHERE id=? AND vault=?").run(
        id,
        stored,
      );
    }
    return list(u.login);
  }
  function remove(owner, id) {
    q(
      "UPDATE personal_accounts SET vault=NULL,ready=0 WHERE id=? AND owner=?",
    ).run(String(id), owner);
    return list(owner);
  }
  function hook(id, method, params, headers, raw) {
    const a = get(id),
      c = a.config;
    const ready = () =>
      q(
        "UPDATE personal_accounts SET ready=1 WHERE id=? AND vault IS NOT NULL",
      ).run(id);
    if (method === "GET") {
      if (
        a.channel !== "WhatsApp" ||
        params.get("hub.mode") !== "subscribe" ||
        !equal(c.verify, params.get("hub.verify_token"))
      )
        reject(403, "Проверка отклонена");
      ready();
      return { text: params.get("hub.challenge"), events: [] };
    }
    let v;
    try {
      v = JSON.parse(raw);
    } catch {
      reject(400, "Некорректное событие");
    }
    let events = [],
      text = "ok";
    if (a.channel === "Telegram") {
      if (!equal(c.verify, headers["x-telegram-bot-api-secret-token"]))
        reject(403, "Проверка отклонена");
      events = parseTelegram(v);
    } else if (a.channel === "WhatsApp") {
      if (
        !equal(
          "sha256=" + signature("sha256", c.appSecret, raw),
          headers["x-hub-signature-256"],
        )
      )
        reject(403, "Проверка отклонена");
      events = parseWhatsApp(v, c.phoneId);
    } else if (a.channel === "MAX") {
      if (!equal(c.verify, headers["x-max-bot-api-secret"]))
        reject(403, "Проверка отклонена");
      const m = v.message;
      if (
        v.update_type === "message_created" &&
        m?.recipient?.chat_id != null &&
        m.body?.mid &&
        !m.sender?.is_bot
      )
        events = [
          {
            peer: String(m.recipient.chat_id),
            remoteId: m.body.mid,
            name: m.sender?.name || String(m.recipient.chat_id),
            text: m.body.text || "[Вложение MAX]",
            at: new Date(m.timestamp || Date.now()).toISOString(),
          },
        ];
    } else {
      if (String(v.group_id) !== a.external || !equal(c.verify, v.secret))
        reject(403, "Проверка отклонена");
      if (v.type === "confirmation") {
        ready();
        text = c.confirm;
      }
      const m = v.object?.message;
      if (v.type === "message_new" && m?.peer_id && m.id != null)
        events = [
          {
            peer: String(m.peer_id),
            remoteId: String(m.id || m.conversation_message_id),
            name: "ВКонтакте · " + m.peer_id,
            text: m.text || "[Вложение ВКонтакте]",
            at: new Date(m.date * 1000).toISOString(),
          },
        ];
    }
    return {
      text,
      events: events.map((e) => ({
        ...e,
        channel: a.channel,
        accountId: id,
        owner: a.owner,
        remotePeer: e.peer,
        peer: id + ":" + e.peer,
      })),
    };
  }
  function pick(owner, channel) {
    return q(
      "SELECT id FROM personal_accounts WHERE owner=? AND channel=? AND ready=1 AND vault IS NOT NULL",
    ).get(owner, channel)?.id;
  }
  async function send(row, m, file) {
    const meta = JSON.parse(row.meta),
      a = get(meta.accountId),
      peer = meta.remotePeer;
    if (!a.ready) reject(409, "Завершите подключение аккаунта");
    if (["Telegram", "WhatsApp"].includes(a.channel))
      return sendProvider(
        { ...row, peer },
        m,
        file,
        credentials(a.channel, a.config),
      );
    if (file || m.template)
      reject(400, "Канал поддерживает текстовые сообщения");
    if (a.channel === "MAX") {
      const r = await post(
        maxHost + "/messages?chat_id=" + encodeURIComponent(peer),
        { text: m.text },
        { Authorization: a.config.token },
      );
      return r.message.body.mid;
    }
    return String(
      await vk("messages.send", a.config.token, {
        peer_id: peer,
        message: m.text,
        random_id: String(
          createHash("sha256").update(m.id).digest().readUInt32BE(0) &
            0x7fffffff,
        ),
      }),
    );
  }
  return {
    list,
    available: (owner) =>
      q(
        "SELECT channel FROM personal_accounts WHERE owner=? AND ready=1 AND vault IS NOT NULL ORDER BY channel",
      )
        .all(owner)
        .map((r) => r.channel),
    connect,
    remove,
    hook,
    pick,
    send,
    media: (id) => {
      const a = get(id);
      return credentials(a.channel, a.config);
    },
  };
}
