const env = process.env;
const configured = {
  Telegram: Boolean(env.TG_TOKEN && env.TG_WEBHOOK_SECRET),
  WhatsApp: Boolean(
    env.WA_TOKEN &&
      env.WA_PHONE_ID &&
      env.WA_VERSION &&
      env.WA_APP_SECRET &&
      env.WA_VERIFY_TOKEN,
  ),
};
const waTemplates = JSON.parse(env.WA_TEMPLATES || "[]");
function endpoint(env) {
  const tg = (method) =>
    `https://api.telegram.org/bot${env.TG_TOKEN}/${method}`;
  const graph = (path) =>
    `https://graph.facebook.com/${env.WA_VERSION}/${path}`;
  const auth = () => ({ Authorization: "Bearer " + env.WA_TOKEN });
  return { tg, graph, auth };
}
async function remote(url, options) {
  const r = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(20000),
  });
  if (!r.ok) {
    const error = Error("Провайдер вернул HTTP " + r.status);
    error.definite = r.status < 500;
    throw error;
  }
  return r.json();
}
const post = (url, data, headers = {}) =>
  remote(url, {
    method: "POST",
    headers: { ...headers, "Content-Type": "application/json" },
    body: JSON.stringify(data),
  });
async function sendProvider(chat, m, file, account = env) {
  const { tg, graph, auth } = endpoint(account);
  if (account === env && !configured[chat.channel])
    throw Object.assign(Error("Канал не настроен"), { definite: true });
  if (chat.channel === "Telegram") {
    if (file) {
      const fd = new FormData();
      fd.append("chat_id", chat.peer);
      fd.append("document", new Blob([file.bytes]), file.name);
      if (m.text) fd.append("caption", m.text);
      return String(
        (await remote(tg("sendDocument"), { method: "POST", body: fd })).result
          .message_id,
      );
    }
    return String(
      (await post(tg("sendMessage"), { chat_id: chat.peer, text: m.text }))
        .result.message_id,
    );
  }
  const base = {
    messaging_product: "whatsapp",
    recipient_type: "individual",
    to: chat.peer,
  };
  let message;
  if (m.template) {
    const preset = waTemplates.find((x) => x.name === m.template);
    if (!preset)
      throw Object.assign(Error("Шаблон не настроен"), { definite: true });
    message = {
      type: "template",
      template: { name: preset.name, language: { code: preset.language } },
    };
  } else if (file) {
    const fd = new FormData();
    fd.append("messaging_product", "whatsapp");
    fd.append("file", new Blob([file.bytes], { type: file.mime }), file.name);
    const { id } = await remote(graph(account.WA_PHONE_ID + "/media"), {
      method: "POST",
      headers: auth(),
      body: fd,
    });
    message = {
      type: "document",
      document: {
        id,
        filename: file.name,
        ...(m.text ? { caption: m.text } : {}),
      },
    };
  } else message = { type: "text", text: { body: m.text } };
  return (
    await post(
      graph(account.WA_PHONE_ID + "/messages"),
      { ...base, ...message },
      auth(),
    )
  ).messages[0].id;
}
function parseTelegram(update) {
  const m = update.message || update.channel_post;
  if (!m?.chat) return [];
  const a =
    m.document || m.photo?.at(-1) || m.voice || m.audio || m.video || m.sticker;
  const label = m.document
    ? "Документ"
    : m.photo
      ? "Фото"
      : m.voice
        ? "Голосовое"
        : m.audio
          ? "Аудио"
          : m.video
            ? "Видео"
            : "Стикер";
  return [
    {
      channel: "Telegram",
      peer: String(m.chat.id),
      name:
        m.chat.title ||
        [m.chat.first_name, m.chat.last_name].filter(Boolean).join(" ") ||
        String(m.chat.id),
      username: m.chat.username || "",
      remoteId: String(m.message_id),
      at: new Date(m.date * 1000).toISOString(),
      text:
        m.text ||
        m.caption ||
        (!a
          ? "[" +
            (m.location
              ? "Геопозиция"
              : m.contact
                ? "Контакт"
                : "Событие Telegram") +
            "]"
          : ""),
      media: a
        ? {
            remote: a.file_id,
            name:
              a.file_name ||
              label +
                (m.photo ? ".jpg" : m.voice ? ".ogg" : m.video ? ".mp4" : ""),
            size: a.file_size || 0,
            mime: a.mime_type || "application/octet-stream",
          }
        : null,
    },
  ];
}
function parseWhatsApp(payload, phoneId = env.WA_PHONE_ID) {
  const events = [];
  for (const e of payload.entry || [])
    for (const change of e.changes || []) {
      const v = change.value || {};
      if (String(v.metadata?.phone_number_id) !== phoneId) continue;
      for (const s of v.statuses || [])
        events.push({
          status: s.status,
          remoteId: s.id,
          peer: s.recipient_id,
          channel: "WhatsApp",
        });
      for (const m of v.messages || []) {
        const a = m[m.type],
          hasMedia = [
            "document",
            "image",
            "audio",
            "video",
            "sticker",
          ].includes(m.type);
        events.push({
          channel: "WhatsApp",
          peer: m.from,
          name:
            (v.contacts || []).find((c) => c.wa_id === m.from)?.profile?.name ||
            m.from,
          remoteId: m.id,
          at: new Date(Number(m.timestamp) * 1000).toISOString(),
          text:
            m.text?.body ||
            a?.caption ||
            m.reaction?.emoji ||
            m.button?.text ||
            m.interactive?.button_reply?.title ||
            (!hasMedia ? "[" + m.type + "]" : ""),
          media: hasMedia
            ? {
                remote: a.id,
                name: a.filename || m.type,
                mime: a.mime_type || "application/octet-stream",
                size: 0,
              }
            : null,
        });
      }
    }
  return events;
}
async function fetchMedia(channel, id, account = env) {
  const { tg, graph, auth } = endpoint(account);
  let url,
    headers = {};
  if (channel === "Telegram") {
    const { result } = await post(tg("getFile"), { file_id: id });
    url =
      "https://api.telegram.org/file/bot" +
      account.TG_TOKEN +
      "/" +
      result.file_path;
  } else {
    const result = await remote(graph(encodeURIComponent(id)), {
      headers: auth(),
    });
    url = new URL(result.url);
    if (
      url.protocol !== "https:" ||
      !(
        url.hostname === "lookaside.fbsbx.com" ||
        url.hostname.endsWith(".facebook.com") ||
        url.hostname.endsWith(".fbcdn.net")
      )
    )
      throw Error("Недопустимый адрес медиа");
    headers = auth();
  }
  const r = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(20000),
    redirect: "error",
  });
  if (!r.ok) throw Error("Файл недоступен");
  const chunks = [];
  let n = 0;
  for await (const buf of r.body) {
    n += buf.length;
    if (n > 8 * 1024 * 1024) throw Error("Файл больше 8 МБ");
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}
export {
  configured,
  waTemplates,
  sendProvider,
  parseTelegram,
  parseWhatsApp,
  fetchMedia,
};
