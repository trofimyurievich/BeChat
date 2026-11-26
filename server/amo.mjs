import { createHmac, createHash, timingSafeEqual } from "node:crypto";
const env = process.env;
const crmOrigin =
  env.AMO_SUBDOMAIN && /^[a-z0-9-]+$/.test(env.AMO_SUBDOMAIN)
    ? `https://${env.AMO_SUBDOMAIN}.amocrm.ru`
    : "";
const chatsReady = Boolean(env.AMO_SCOPE_ID && env.AMO_CHANNEL_SECRET);
function equal(secret, actual) {
  if (!secret || !actual) return false;
  const a = Buffer.from(String(secret)),
    b = Buffer.from(String(actual));
  return a.length === b.length && timingSafeEqual(a, b);
}
function signature(alg, secret, raw) {
  return createHmac(alg, secret).update(raw).digest("hex");
}
async function amoPost(path, data) {
  const body = JSON.stringify(data),
    date = new Date().toUTCString(),
    hash = createHash("md5").update(body).digest("hex"),
    type = "application/json";
  const sig = signature(
    "sha1",
    env.AMO_CHANNEL_SECRET,
    ["POST", hash, type, date, path].join("\n"),
  );
  const r = await fetch("https://amojo.amocrm.ru" + path, {
    method: "POST",
    headers: {
      Date: date,
      "Content-Type": type,
      "Content-MD5": hash,
      "X-Signature": sig,
    },
    body,
    signal: AbortSignal.timeout(12000),
  });
  if (!r.ok) throw Error("amoCRM HTTP " + r.status);
  return r.text();
}
async function readEntity(type, id, userId) {
  if (!id || !env.AMO_TOKEN || !crmOrigin) return null;
  if (!/^[1-9]\d*$/.test(String(id)) || !/^[1-9]\d*$/.test(String(userId)))
    throw Error("Некорректный ID amoCRM");
  const res = await fetch(crmOrigin + "/api/v4/" + type + "/" + id, {
    headers: {
      Authorization: "Bearer " + env.AMO_TOKEN,
      "X-Context-User-ID": String(userId),
    },
    signal: AbortSignal.timeout(12000),
  });
  if (!res.ok)
    throw Error("Не удалось открыть запись amoCRM · HTTP " + res.status);
  return res.json();
}
function importMessage(chat, m) {
  const client = {
    id: chat.id,
    name: chat.name,
    ...(["WhatsApp", "SMS"].includes(chat.channel)
      ? { profile: { phone: chat.peer } }
      : {}),
  };
  const agent = {
    id: "bechat-agent",
    ...(env.AMO_BOT_ID ? { ref_id: env.AMO_BOT_ID } : {}),
    name: m.author || "BeChat",
  };
  const t = Date.parse(m.at);
  return {
    event_type: "new_message",
    payload: {
      timestamp: Math.floor(t / 1000),
      msec_timestamp: t,
      msgid: m.id,
      conversation_id: chat.id,
      sender: m.side === "in" ? client : agent,
      ...(m.side === "out" ? { receiver: client } : {}),
      message: {
        type: "text",
        text: [
          m.quote ? "❝ " + m.quote : "",
          m.text,
          m.file ? "📎 " + m.file.name : "",
        ]
          .filter(Boolean)
          .join("\n"),
      },
      silent: m.side === "out",
    },
  };
}
export {
  crmOrigin,
  chatsReady,
  equal,
  signature,
  amoPost,
  readEntity,
  importMessage,
};
