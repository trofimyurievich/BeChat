"use strict";
const messengerTypes = {
  Telegram: "Личный профиль Telegram",
  WhatsApp: "Личный номер WhatsApp",
  MAX: "Личный профиль MAX",
  ВКонтакте: "Личная страница ВКонтакте",
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
    rows
      .map((a) =>
        actionRow(
          "account:" + a.channel,
          a.channel,
          a.id
            ? (a.label || messengerTypes[a.channel]) + " · " + a.description
            : messengerTypes[a.channel],
          chIcon(a.channel),
        ),
      )
      .join("") + settingsNav(),
  );
}
const pairingHints = {
  Telegram:
    "В Telegram на телефоне откройте «Настройки → Устройства → Подключить устройство» и отсканируйте код.",
  WhatsApp:
    "В WhatsApp на телефоне откройте «Связанные устройства → Привязка устройства» и отсканируйте код.",
  MAX: "На телефоне откройте сканер QR в MAX и подтвердите вход в свой профиль.",
  ВКонтакте:
    "Войдите на странице VK ID и разрешите BeChat доступ к сообщениям своей страницы.",
};
let pairingTimer,
  pairingVersion = 0;
async function openAccount(channel, update = false) {
  if (!Object.hasOwn(messengerTypes, channel)) return;
  clearTimeout(pairingTimer);
  const pageId = "personal-" + channel,
    version = ++pairingVersion;
  const visible = () => version === pairingVersion && activeModal === pageId && $("#modal").open;
  const poll = (delay = 1500) => {
    pairingTimer = setTimeout(() => {
      if (visible()) guarded(() => openAccount(channel, true));
    }, delay);
  };
  let a;
  try {
    a = (await api("accounts")).find((row) => row.channel === channel);
  } catch (err) {
    if (!update || !visible()) throw err;
    toast("Нет ответа от сервера. Повторяем проверку подключения.");
    poll(3500);
    return;
  }
  if (
    !a ||
    version !== pairingVersion ||
    (update && (activeModal !== pageId || !$("#modal").open))
  )
    return;
  const back = actionRow(
    "accounts",
    "Мои мессенджеры",
    "Все подключения",
    "network",
  );
  const disconnect =
    a.id && editable()
      ? actionRow(
          "disconnect:" + channel,
          a.ready ? "Отключить аккаунт" : "Отменить подключение",
          "Завершить сеанс BeChat",
          "close",
        )
      : "";
  const intro =
    '<p class="minor">' +
    esc(messengerTypes[channel]) +
    " · Подключение с сервера BeChat</p>";
  let body = "";
  if (a.ready)
    body =
      '<div class="modalrow"><b>' +
      esc(a.label) +
      "</b><small>Подключён</small></div>";
  else if (a.requirement)
    body = '<p class="pair-notice">' + esc(a.requirement) + "</p>";
  else if (
    a.status === "new" ||
    a.status === "failed" ||
    a.status === "offline"
  ) {
    body =
      (a.status === "new"
        ? ""
        : '<p role="status" class="minor">' + esc(a.description) + "</p>") +
      (editable()
        ? '<form class="pair-form"><p>' +
          esc(pairingHints[channel]) +
          '</p>' + (channel === "MAX" ? '<label class="formfield"><span>Способ входа</span><select name="method"><option value="qr">По QR-коду</option><option value="phone">По номеру телефона</option></select></label><label class="formfield" id="pair-phone-wrap" style="display:none"><span>Номер в MAX с кодом страны</span><input type="tel" name="phone" autocomplete="tel" placeholder="+7…" disabled></label>' : '') +
          '<p class="minor">После входа появится доступная история личных диалогов.</p><button class="primary" type="submit">' +
          (a.status === "new"
            ? "Подключить личный аккаунт"
            : "Повторить подключение") +
          "</button></form>"
        : "");
  } else if (a.status === "password" || a.status === "code") {
    if (update && $("#pair-answer")?.dataset.step === a.status && !a.codeRejected) { poll(); return; }
    if (update && a.codeRejected && $("#pair-answer")?.dataset.rejected==="1") {poll();return;}
    const code = a.status === "code";
    body = '<form>' + (a.codeRejected ? '<p class="pair-notice" role="alert">MAX не принял код. Проверьте цифры в последней SMS и введите ещё раз.</p>' : '') + '<label class="formfield"><span>' + (code ? "Код подтверждения от MAX" : "Пароль двухэтапной проверки " + esc(channel)) +
      '</span><input id="pair-answer" data-step="' + a.status + '" name="answer" ' +
      (code ? 'type="text" inputmode="numeric" autocomplete="one-time-code" pattern="[0-9]{4,10}"' : 'type="password" autocomplete="off"') +
      ' required></label><button class="primary" type="submit">Подтвердить</button></form>';
  } else if (a.authorize) {
    body =
      "<p>" +
      esc(pairingHints[channel]) +
      '</p><a class="primary pair-link" href="' +
      esc(a.authorize) +
      '" rel="noopener noreferrer" target="_blank">Продолжить в VK ID</a>';
  } else if (a.qr) {
    body =
      '<figure class="pair-code"><img src="' +
      esc(a.qr) +
      '" width="224" height="224" alt="QR для подключения личного аккаунта"><figcaption>' +
      esc(pairingHints[channel]) +
      "</figcaption></figure>";
  } else
    body =
      '<p role="status" class="pair-notice">' + esc(a.description) + "</p>";
  modal(channel, intro + body + disconnect + back, pageId);
  const answer=$("#pair-answer");
  if (answer) {
    answer.dataset.rejected=a.codeRejected?"1":"0";
    if (a.status==="code" && a.digits) {answer.pattern="[0-9]{"+a.digits+"}";answer.maxLength=a.digits;}
  }
  const method = $("#modalbody select[name=method]");
  if (method) {
    method.value=a.method==="phone"?"phone":"qr";
    method.onchange = () => {
    const phone = $("#modalbody input[name=phone]");
    const usePhone = method.value === "phone";
    phone.disabled = !usePhone;
    phone.required = usePhone;
    $("#pair-phone-wrap").style.display = usePhone ? "" : "none";
    $("#modalbody .pair-form > p").textContent=usePhone ? "Введите номер, к которому привязан профиль MAX. Затем введите код из SMS." : pairingHints[channel];
    if (usePhone && document.activeElement===method) phone.focus();
    };
    method.onchange();
  }
  if ($("#modalbody form"))
    bindSettingsForm(async (values) => {
      ++pairingVersion; clearTimeout(pairingTimer);
      if (a.status === "password" || a.status === "code")
        await api("accounts", "POST", {
          op: "answer",
          channel,
          answer: a.status==="code" ? values.answer.trim() : values.answer,
        });
      else
        await api("accounts", "POST", {
          op: "connect",
          channel,
          method: values.method || "qr",
          phone: values.phone,
          history: true,
        });
      await openAccount(channel);
    });
  if (a.ready && update) {
    await refresh();
    render();
    return;
  }
  if (["starting", "qr", "oauth", "code", "password", "confirming"].includes(a.status)) poll();
}
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-setting]");
  if (!b) return;
  guarded(async () => {
    const [op, channel] = b.dataset.setting.split(":");
    if (op === "accounts") {
      ++pairingVersion;
      clearTimeout(pairingTimer);
      return openPersonalAccounts();
    }
    if (op === "my-polls") return showMyPolls();
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
