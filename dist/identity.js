"use strict";
const embeddedCRM =
  window.parent !== window &&
  new URLSearchParams(location.search).get("embed") === "1";
const nativeApp = () => window.webkit?.messageHandlers?.bechatIdentity;
let widgetAttempt = null;
const enc64 = (bytes) =>
  btoa(String.fromCharCode(...new Uint8Array(bytes)))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
async function makeProof() {
  const verifier = enc64(crypto.getRandomValues(new Uint8Array(32)));
  return {
    verifier,
    challenge: enc64(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    ),
    nonce: enc64(crypto.getRandomValues(new Uint8Array(32))),
  };
}
function clearIdentity() {
  token = "";
  try {
    sessionStorage.removeItem("bechat-session-v2");
  } catch {}
  state = { chats: [], templates: [] };
  active = "";
  Object.assign(profile, { name: "", role: "", founder: false });
  for (const store of [drafts, attempts, smsSchedule])
    for (const k of Object.keys(store)) delete store[k];
  attachment = null;
  reply = null;
  document.querySelector("#file-preview")?.close();
  render();
}
function showAmoLogin(message = "") {
  modal(
    "Вход в BeChat",
    '<div class="identity-form"><p>Войдите в рабочий аккаунт amoCRM. Переписка откроется с правами вашего сотрудника.</p><button class="primary" type="button" id="amo-signin">Войти через amoCRM</button><p class="minor" id="auth-status" role="status">' +
      esc(message) +
      "</p></div>",
    "login",
  );
  document.querySelector("#amo-signin").onclick = () => guarded(beginSignIn);
}
function authStatus(msg) {
  const el = document.querySelector("#auth-status");
  if (el) el.textContent = msg;
}
async function acceptSession(value) {
  if (!/^[\w-]{43}$/.test(value || ""))
    throw Error("Не удалось подтвердить вход");
  token = value;
  try {
    await refresh();
  } catch (e) {
    token = "";
    throw e;
  }
  if (!embeddedCRM && !nativeApp())
    try {
      sessionStorage.setItem("bechat-session-v2", token);
    } catch {}
  if (widgetAttempt) {
    clearTimeout(widgetAttempt.timer);
    widgetAttempt = null;
  }
  closeModal();
  render();
}
async function redeem(code, verifier, client) {
  const response = await fetch("/auth/exchange", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ ticket: code, verifier, client }),
  });
  const result = await response.json();
  if (!response.ok) throw Error(result.error || "Не удалось подтвердить вход");
  await acceptSession(result.token);
}
async function beginSignIn() {
  const cfg = window.BECHAT_CONFIG;
  if (!cfg?.crmOrigin) {
    authStatus("Откройте BeChat по адресу сервера организации.");
    return;
  }
  if (embeddedCRM) {
    if (widgetAttempt) clearTimeout(widgetAttempt.timer);
    const proof = await makeProof();
    widgetAttempt = proof;
    proof.timer = setTimeout(() => {
      if (widgetAttempt === proof) {
        widgetAttempt = null;
        authStatus(
          "Виджет не ответил. Проверьте адрес сервера в настройках amoCRM и повторите вход.",
        );
      }
    }, 15000);
    authStatus("Подтверждаем вход через виджет amoCRM…");
    window.parent.postMessage(
      {
        type: "bechat:sso:ready",
        challenge: proof.challenge,
        nonce: proof.nonce,
      },
      cfg.crmOrigin,
    );
    return;
  }
  if (nativeApp()) {
    nativeApp().postMessage({ type: "login" });
    return;
  }
  const p = await makeProof();
  try {
    sessionStorage.setItem(
      "bechat-oauth",
      JSON.stringify({ verifier: p.verifier, nonce: p.nonce }),
    );
  } catch {
    authStatus("Разрешите хранение данных для этого сайта и повторите вход.");
    return;
  }
  const target = new URL("/auth/start", location.origin);
  target.search = new URLSearchParams({
    client: "web",
    challenge: p.challenge,
    nonce: p.nonce,
  });
  location.assign(target.href);
}
window.addEventListener("message", (e) => {
  if (
    !embeddedCRM ||
    e.source !== window.parent ||
    e.origin !== window.BECHAT_CONFIG?.crmOrigin ||
    !widgetAttempt ||
    e.data?.type !== "bechat:sso:result" ||
    e.data.nonce !== widgetAttempt.nonce
  )
    return;
  const attempt = widgetAttempt;
  widgetAttempt = null;
  clearTimeout(attempt.timer);
  if (!e.data.ticket) {
    authStatus(
      "amoCRM не подтвердила вход. Проверьте настройки интеграции или повторите попытку.",
    );
    return;
  }
  redeem(e.data.ticket, attempt.verifier, "widget").catch((err) =>
    authStatus(err.message),
  );
});
window.beChatNativeSession = async function (value) {
  if (!nativeApp()) return false;
  try {
    await acceptSession(value);
    return true;
  } catch (e) {
    showAmoLogin(e.message);
    return false;
  }
};
window.beChatNativeStatus = (message) => {
  if (nativeApp()) authStatus(message);
};
async function bootIdentity() {
  render();
  if (embeddedCRM) {
    token = "";
    showAmoLogin();
    await beginSignIn();
    return;
  }
  const result = new URLSearchParams(location.hash.slice(1));
  if (result.has("ticket") || result.has("error")) {
    history.replaceState(null, "", location.pathname + location.search);
    let pending;
    try {
      pending = JSON.parse(sessionStorage.getItem("bechat-oauth"));
      sessionStorage.removeItem("bechat-oauth");
    } catch {}
    showAmoLogin();
    if (!pending || pending.nonce !== result.get("nonce")) {
      authStatus("Эта попытка входа началась в другом окне. Войдите ещё раз.");
      return;
    }
    if (result.has("error")) {
      authStatus(
        result.get("error") === "account"
          ? "Выберите корпоративный аккаунт amoCRM."
          : "Вход не завершён. Проверьте, что администратор установил BeChat, и повторите попытку.",
      );
      return;
    }
    try {
      await redeem(result.get("ticket"), pending.verifier, "web");
    } catch (e) {
      authStatus(e.message);
    }
    return;
  }
  if (nativeApp()) {
    showAmoLogin();
    nativeApp().postMessage({ type: "ready" });
    return;
  }
  if (token) {
    try {
      await acceptSession(token);
      return;
    } catch {
      clearIdentity();
    }
  }
  showAmoLogin();
}
