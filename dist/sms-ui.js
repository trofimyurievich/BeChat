"use strict";
const smsSchedule = {};

function updateSmsMeter() {
  const meter = $("#sms-meter");
  if (!meter) return;
  const text = ($("#draft")?.value || "").trim(),
    size = BeChatSms.measure((reply ? "❝ " + reply + "\n\n" : "") + text);
  meter.textContent =
    size.encoding +
    " · Частей SMS: " +
    size.parts +
    " · Осталось в части: " +
    size.left +
    (smsSchedule[active]
      ? " · Отправка " + new Date(smsSchedule[active]).toLocaleString("ru-RU")
      : "");
}
function openSmsScheduler() {
  if (c()?.channel !== "SMS" || !editable()) return;
  const current = smsSchedule[active] ? new Date(smsSchedule[active]) : null,
    local = current
      ? new Date(current - current.getTimezoneOffset() * 60000)
          .toISOString()
          .slice(0, 16)
      : "";
  modal(
    "Время отправки SMS",
    "<form>" +
      field(
        "Дата и время на этом устройстве",
        "when",
        local,
        "datetime-local",
        true,
      ) +
      '<button type="submit" class="primary">Запланировать</button></form>' +
      (current
        ? '<button type="button" class="modalbtn" id="sms-now">Отправить сразу</button>'
        : ""),
  );
  $("#sms-now")?.addEventListener("click", () => {
    delete smsSchedule[active];
    closeModal();
    updateSmsMeter();
  });
  bindSettingsForm(async (v) => {
    const t = new Date(v.when);
    if (t.getTime() <= Date.now()) throw Error("Выберите время в будущем");
    smsSchedule[active] = t.toISOString();
    closeModal();
    updateSmsMeter();
  });
}
function recipients(input) {
  const raw = input
    .split(/[;,\n]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  if (!raw.length || raw.length > 1000)
    throw Error("Укажите от 1 до 1000 номеров");
  return [...new Set(raw.map(BeChatSms.normalize))];
}
async function smsCommand(v) {
  if (!isFounder()) throw Error("Управление SMS доступно учредителю");
  {
    const result = await api("sms", "POST", v);
    await refresh();
    return result;
  }
}
const smsEntry = (tab, label) =>
  '<button type="button" data-sms-tab="' +
  tab +
  '" class="sms-tab">' +
  esc(label) +
  "</button>";
function smsReport() {
  const rows = state.chats
    .filter((c) => c.channel === "SMS")
    .flatMap((c) =>
      c.messages
        .filter((m) => m.side === "out")
        .map((m) => [
          m.at,
          c.peer,
          BeChatSms.labels[m.status] || m.status,
          m.sms?.parts || BeChatSms.measure(m.text).parts,
        ]),
    );
  const summary = new Map();
  for (const r of rows) summary.set(r[2], (summary.get(r[2]) || 0) + 1);
  const html = [...summary]
    .map(
      ([label, n]) =>
        '<div class="modalrow"><span>' +
        esc(label) +
        "</span><b>" +
        n +
        "</b></div>",
    )
    .join("");
  return {
    rows,
    html:
      (html ||
        '<p class="minor">В доступных диалогах ещё нет исходящих SMS.</p>') +
      (rows.length
        ? '<button id="sms-export" class="modalbtn">' +
          icon("download") +
          "Скачать CSV</button>"
        : ""),
  };
}
async function openSmsCenter(tab = "connect") {
  if (!isFounder()) throw Error("Общий SMS-аккаунт подключает учредитель");
  const data = await api("sms"),
    p = data.plan || {},
    route = data.routes.find((x) => x.id === data.active);
  const nav =
    '<nav class="sms-tabs" aria-label="Разделы SMS">' +
    [
      ["connect", "Номер"],
      ["batches", "Рассылки"],
      ["blocked", "Стоп-лист"],
      ["report", "Отчёт"],
    ]
      .map(([k, l]) =>
        smsEntry(k, l).replace(
          'class="sms-tab"',
          'class="sms-tab" aria-pressed="' + (k === tab) + '"',
        ),
      )
      .join("") +
    "</nav>";
  let content = "",
    submit;
  if (tab === "connect") {
    const profiles = {
      "": "Отключён",
      ...Object.fromEntries(
        data.routes.map((r) => [r.id, r.name + " · " + r.sender]),
      ),
    };
    content =
      "<form>" +
      optionField(
        "Общий SMS-аккаунт сотрудников",
        "active",
        profiles,
        data.active,
      ) +
      '<p class="minor">' +
      esc(
        route
          ? route.inbound
            ? "Принимает ответы клиентов."
            : "Только исходящие сообщения."
          : "Сотрудники смогут отправлять SMS после активации маршрута.",
      ) +
      '</p><details class="setting-detail" ' +
      (!route ? "open" : "") +
      "><summary>Параметры для договора с оператором</summary>" +
      smsPlanFields(p) +
      '</details><button type="submit" class="primary">Сохранить</button></form>' +
      smsEntry("register", "Подключить номер оператора");
    if (data.setup)
      content +=
        '<details class="setting-detail"><summary>Настроить входящие события у оператора</summary><p>Адрес webhook</p><code>' +
        esc(data.setup.url) +
        "</code>" +
        (data.setup.secret
          ? "<p>Секрет подписи HMAC-SHA256</p><code>" +
            esc(data.setup.secret) +
            "</code>"
          : "") +
        "</details>";
    submit = async (v) => {
      await smsCommand({ ...v, op: "settings", inbound: !!v.inbound });
      await openSmsCenter();
      toast("Настройки SMS сохранены");
    };
  } else if (tab === "register") {
    content =
      '<form autocomplete="off">' +
      field("Название подключения", "name", "", "text", true) +
      smsPlanFields(p) +
      field(
        "Номер или имя отправителя по договору",
        "sender",
        "",
        "text",
        true,
      ) +
      field("Ключевое слово для общего короткого номера", "keyword") +
      (field(
        "HTTPS-адрес API оператора или /send вашего Jasmin",
        "endpoint",
        "",
        "url",
        true,
      ) +
        field(
          "Токен API или пароль Jasmin",
          "credential",
          "",
          "password",
          true,
        ) +
        field("Имя пользователя Jasmin", "username") +
        '<details class="setting-detail"><summary>Формат HTTPS API</summary>' +
        field("Заголовок авторизации", "authHeader", "Authorization") +
        field("Префикс токена", "authPrefix", "Bearer ") +
        field("Путь к ID сообщения в ответе", "idPath", "id") +
        '<label class="formfield">JSON запроса<textarea name="payload" placeholder=\'{"to":"{to}","from":"{from}","text":"{text}","client_id":"{id}"}\'></textarea></label></details>') +
      '<button class="primary" type="submit">' +
      "Подключить для сотрудников" +
      "</button></form>";
    submit = async (v) => {
      v.inbound = !!v.inbound && v.kind !== "alpha";
      {
        if (v.payload) v.payload = JSON.parse(v.payload);
        else delete v.payload;
        await smsCommand({ ...v, op: "register" });
      }
      await openSmsCenter();
      toast("Общий SMS-аккаунт выбран");
    };
  } else if (tab === "blocked") {
    content =
      "<form>" +
      field("Номер телефона", "phone", "", "tel", true) +
      '<button class="primary" type="submit">Добавить в стоп-лист</button></form>' +
      data.blocked
        .map(
          (n) =>
            '<div class="modalrow">' +
            esc(n) +
            '<button class="sms-tab" data-unblock="' +
            esc(n) +
            '">Разрешить</button></div>',
        )
        .join("");
    submit = async (v) => {
      await smsCommand({ op: "block", phone: BeChatSms.normalize(v.phone) });
      await openSmsCenter(tab);
    };
  } else if (tab === "batches") {
    content =
      "<form>" +
      field("Название рассылки", "title", "", "text", true) +
      area("Номера получателей, по одному на строку", "phones", "") +
      area("Сообщение · можно использовать {имя}", "text", "") +
      field("Отправить позже", "when", "", "datetime-local") +
      field("Срок действия в минутах", "ttl", "1440", "number", true) +
      '<p class="minor" id="sms-preview"></p><button type="submit" class="primary">' +
      "Поставить в очередь" +
      "</button></form>" +
      data.batches
        .map(
          (b) =>
            '<div class="setting-detail"><b>' +
            esc(b.title) +
            '</b><p class="minor">Получателей: ' +
            b.total +
            " · В очереди: " +
            b.queued +
            " · Доставлено: " +
            b.delivered +
            "</p>" +
            (b.queued
              ? '<button class="sms-tab" data-batch="' +
                esc(b.id) +
                '" data-op="' +
                (b.paused ? "resume" : "pause") +
                '">' +
                (b.paused ? "Продолжить" : "Приостановить") +
                '</button> <button class="sms-tab" data-batch="' +
                esc(b.id) +
                '" data-op="cancel">Отменить остаток</button>'
              : "") +
            "</div>",
        )
        .join("");
    const id = sid();
    submit = async (v) => {
      const when = v.when ? new Date(v.when) : null;
      if (when && when <= Date.now()) throw Error("Выберите время в будущем");
      await smsCommand({
        op: "batch",
        id,
        title: v.title,
        text: v.text,
        phones: recipients(v.phones),
        smsAt: when?.toISOString(),
        smsTTL: Number(v.ttl),
      });
      await openSmsCenter(tab);
      toast("Рассылка сохранена");
    };
  } else content = smsReport().html;
  modal("SMS организации", nav + content + settingsNav());
  const box = $("#modalbody");
  box
    .querySelectorAll("[data-sms-tab]")
    .forEach(
      (b) => (b.onclick = () => guarded(() => openSmsCenter(b.dataset.smsTab))),
    );
  const kind = box.querySelector('[name="kind"]'),
    inbound = box.querySelector('[name="inbound"]');
  if (kind && inbound) {
    const toggle = () => {
      inbound.disabled = kind.value === "alpha";
      if (inbound.disabled) inbound.checked = false;
    };
    kind.onchange = toggle;
    toggle();
  }
  if (submit) bindSettingsForm(submit);
  if (tab === "batches") {
    const f = box.querySelector("form");
    f.elements.ttl.min = 1;
    f.elements.ttl.max = 4320;
    f.oninput = () => {
      let count = 0;
      try {
        count = recipients(f.elements.phones.value).length;
      } catch {}
      $("#sms-preview").textContent =
        "Получателей: " +
        count +
        " · Частей в тексте: " +
        BeChatSms.measure(f.elements.text.value).parts;
    };
  }
  box.querySelectorAll("[data-unblock],[data-batch]").forEach(
    (b) =>
      (b.onclick = () =>
        guarded(async () => {
          await smsCommand(
            b.dataset.unblock
              ? { op: "unblock", phone: b.dataset.unblock }
              : { op: b.dataset.op, id: b.dataset.batch },
          );
          await openSmsCenter(tab);
        })),
  );
  const exportBtn = $("#sms-export");
  if (exportBtn)
    exportBtn.onclick = () => {
      const records = [
        ["Дата", "Телефон", "Статус", "Частей"],
        ...smsReport().rows,
      ];
      const quote = (x) =>
        '"' +
        String(x)
          .replace(/^([=+@-])/, "'$1")
          .replaceAll('"', '""') +
        '"';
      const url = URL.createObjectURL(
        new Blob(
          [
            "\ufeff" +
              records.map((row) => row.map(quote).join(";")).join("\r\n"),
          ],
          { type: "text/csv;charset=utf-8" },
        ),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = "BeChat-SMS.csv";
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
    };
}
function smsPlanFields(p) {
  return (
    optionField(
      "Что увидит получатель",
      "kind",
      BeChatSms.senders,
      p.kind || "long",
    ) +
    optionField(
      "Соединение с оператором",
      "transport",
      BeChatSms.transports,
      p.transport || "https",
    ) +
    '<label class="modalrow">Принимать ответы клиентов<input type="checkbox" name="inbound" ' +
    (p.inbound !== false ? "checked" : "") +
    '></label><p class="minor">Ответы на номер и перенос существующего номера согласуются с оператором. Буквенное имя поддерживает исходящие SMS.</p>'
  );
}
