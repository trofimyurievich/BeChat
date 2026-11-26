"use strict";
const messengerTypes = {
  Telegram: "Бот Telegram",
  WhatsApp: "Номер WhatsApp Business",
  MAX: "Бот MAX",
  ВКонтакте: "Сообщество ВКонтакте",
};
function isFounder() {
  return profile.founder === true;
}

function chatChannels() {
  return serverChannels;
}
function bindSettingsForm(fn) {
  const el = $("#modalbody form");
  el.addEventListener("submit", (e) => {
    e.preventDefault();
    const button = el.querySelector('[type="submit"]');
    if (button.disabled) return;
    button.disabled = true;
    guarded(async () => {
      try {
        await fn(Object.fromEntries(new FormData(el)));
      } finally {
        button.disabled = false;
      }
    });
  });
}
function optionField(label, name, values, current) {
  return (
    '<label class="formfield"><span>' +
    esc(label) +
    '</span><select name="' +
    esc(name) +
    '">' +
    Object.entries(values)
      .map(
        ([v, l]) =>
          '<option value="' +
          esc(v) +
          '" ' +
          (v === current ? "selected" : "") +
          ">" +
          esc(l) +
          "</option>",
      )
      .join("") +
    "</select></label>"
  );
}
function actionRow(name, label, detail, ico = "chat") {
  return (
    '<button class="modalbtn account-row" type="button" data-setting="' +
    esc(name) +
    '">' +
    icon(ico) +
    "<span><b>" +
    esc(label) +
    "</b><small>" +
    esc(detail) +
    "</small></span>" +
    icon("right") +
    "</button>"
  );
}
function settingsNav() {
  return modalBtn("settings", "settings", "К настройкам");
}
async function openPersonalAccounts() {
  const rows = await api("accounts");
  modal(
    "Мои мессенджеры",
    Object.entries(messengerTypes)
      .map(([channel, desc]) => {
        const row = rows.find((a) => a.channel === channel);
        return actionRow(
          "account:" + channel,
          channel,
          row
            ? row.label +
                " · " +
                (row.ready ? "Подключён" : "Ожидает настройки")
            : desc,
          chIcon(channel),
        );
      })
      .join("") + settingsNav(),
  );
}
async function openAccount(channel) {
  if (!Object.hasOwn(messengerTypes, channel)) return;
  const rows = await api("accounts"),
    a = rows.find((x) => x.channel === channel);
  const manual = ["WhatsApp", "ВКонтакте"].includes(channel);
  const technical =
    a && manual
      ? '<details class="setting-detail" ' +
        (a.ready ? "" : "open") +
        '><summary>Приём сообщений</summary><p class="minor">' +
        (channel === "WhatsApp"
          ? "В настройках Webhooks Meta укажите Callback URL и Verify token. Подпишите приложение на messages и на нужный WhatsApp Business Account."
          : "В Callback API сообщества добавьте адрес сервера и секретный ключ, подтвердите адрес и включите событие message_new.") +
        "</p><p>Адрес</p><code>" +
        esc(a.callback) +
        "</code><p>" +
        (channel === "WhatsApp" ? "Verify token" : "Секретный ключ") +
        "</p><code>" +
        esc(a.verify) +
        "</code></details>"
      : "";
  const connected = a
    ? '<div class="modalrow"><b>' +
      esc(a.label) +
      "</b><small>" +
      esc(a.ready ? "Подключён" : "Ожидает настройки") +
      "</small></div>" +
      technical
    : "";
  const formBody =
    field("Токен доступа", "token", "", "password", true) +
    (channel === "WhatsApp"
      ? field("ID номера в Meta", "phoneId", "", "text", true) +
        field("Версия Graph API, например v23.0", "version", "", "text", true) +
        field("App Secret приложения Meta", "appSecret", "", "password", true)
      : "") +
    (["Telegram", "MAX"].includes(channel)
      ? '<p class="minor">BeChat зарегистрирует свой адрес для входящих событий этого бота. Для Telegram это заменит прежний webhook.</p>'
      : "");
  modal(
    channel,
    connected +
      (editable() && (!a || !a.ready)
        ? '<form autocomplete="off">' +
          formBody +
          '<button type="submit" class="primary">' +
          (a ? "Повторить подключение" : "Подключить") +
          "</button></form>"
        : "") +
      (a && editable()
        ? actionRow(
            "disconnect:" + channel,
            "Отключить аккаунт",
            "Сохранить историю переписки",
            "close",
          )
        : "") +
      actionRow("accounts", "Мои мессенджеры", "Все подключения", "network"),
  );
  if ($("#modalbody form"))
    bindSettingsForm(async (values) => {
      {
        await api("accounts", "POST", { ...values, op: "connect", channel });
        await refresh();
      }
      await openAccount(channel);
    });
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-setting]");
  if (!b) return;
  guarded(async () => {
    const [op, channel] = b.dataset.setting.split(":");
    if (op === "accounts") return openPersonalAccounts();
    if (op === "account") return openAccount(channel);
    if (op === "disconnect") {
      const a = (await api("accounts")).find((x) => x.channel === channel);
      if (!a) return;
      modal(
        "Отключить " + channel + "?",
        '<p class="minor">BeChat прекратит отправку и приём сообщений этого аккаунта. История останется доступна.</p>' +
          actionRow("remove:" + channel, "Отключить", a.label, "close") +
          actionRow("account:" + channel, "Назад", channel, "chat"),
      );
      return;
    }
    if (op === "remove") {
      const a = (await api("accounts")).find((x) => x.channel === channel);
      if (!a) return;
      {
        await api("accounts", "POST", { op: "disconnect", id: a.id });
        await refresh();
      }
      return openPersonalAccounts();
    }
  });
});
