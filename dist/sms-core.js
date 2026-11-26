"use strict";
const BeChatSms = (() => {
  const alphabet =
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞ\u001bÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà";
  const extension = new Map([
    [10, "\f"],
    [20, "^"],
    [40, "{"],
    [41, "}"],
    [47, "\\"],
    [60, "["],
    [61, "~"],
    [62, "]"],
    [64, "|"],
    [101, "€"],
  ]);
  const extensions = new Map([...extension].map(([n, c]) => [c, n]));
  function normalize(value) {
    let n = String(value ?? "")
      .trim()
      .replace(/[ ()\t-]/g, "");
    if (/^8\d{10}$/.test(n)) n = "7" + n.slice(1);
    if (n.startsWith("00")) n = n.slice(2);
    n = n.replace(/^\+/, "");
    if (!/^[1-9]\d{6,14}$/.test(n))
      throw Error("Укажите номер с кодом страны, например +7 999 123-45-67");
    return "+" + n;
  }
  function measure(text) {
    const chars = Array.from(text);
    const gsm = chars.every(
      (c) => (c !== "\u001b" && alphabet.includes(c)) || extensions.has(c),
    );
    const weights = chars.map((c) =>
      gsm ? (extensions.has(c) ? 2 : 1) : c.length,
    );
    const units = weights.reduce((a, b) => a + b, 0),
      single = gsm ? 160 : 70,
      limit = units <= single ? single : gsm ? 153 : 67;
    let parts = units ? 1 : 0,
      used = 0;
    for (const size of weights) {
      if (used + size > limit) {
        parts++;
        used = 0;
      }
      used += size;
    }
    return {
      encoding: gsm ? "GSM-7" : "Unicode",
      units,
      parts,
      left: limit - used,
    };
  }
  function gsmBytes(text) {
    return Array.from(text).flatMap((c) =>
      extensions.has(c) ? [27, extensions.get(c)] : [alphabet.indexOf(c)],
    );
  }
  function gsmText(bytes) {
    let s = "";
    for (let i = 0; i < bytes.length; i++)
      s +=
        bytes[i] === 27
          ? (extension.get(bytes[++i]) ?? "�")
          : (alphabet[bytes[i]] ?? "�");
    return s;
  }
  const labels = {
    queued: "В очереди",
    scheduled: "Запланировано",
    sending: "Передаётся",
    accepted: "Принято шлюзом",
    sent: "У оператора",
    delivered: "Доставлено",
    failed: "Ошибка",
    expired: "Истёк срок",
    unknown: "Статус неизвестен",
    cancelled: "Отменено",
    demo: "Демо · без отправки",
  };
  const senders = {
    long: "Выделенный номер оператора",
    existing: "Существующий номер компании",
    virtual: "Виртуальный номер",
    short: "Выделенный короткий номер",
    shared: "Общий короткий номер с ключевым словом",
    alpha: "Буквенное имя отправителя",
  };
  const transports = {
    https: "HTTPS API оператора",
    smpp: "SMPP через собственный шлюз Jasmin",
  };
  return { normalize, measure, gsmBytes, gsmText, labels, senders, transports };
})();
if (typeof module !== "undefined") module.exports = BeChatSms;
