"use strict";
const embeddedCRM =
  window.parent !== window &&
  new URLSearchParams(location.search).get("embed") === "1";
const nativeApp = () => window.webkit?.messageHandlers?.bechatIdentity;
let widgetAttempt = null, widgetRetries = 0, fallback = null;
function pendingIdentity() {
  if ($("#modal").open && activeModal==="login") $("#modal").close();
  activeModal="";
  document.body.classList.add("bechat-auth-pending");
  let status=document.getElementById("bechat-auth-pending");
  if (!status) {status=document.createElement("p");status.id="bechat-auth-pending";status.setAttribute("role","status");document.body.append(status);}
  status.textContent="Открываем BeChat…";
}
function loginProblem(message) {
  if (typeof dealFeedMode!=="undefined" && dealFeedMode) {
    document.body.classList.remove("bechat-auth-pending");
    const panel=document.getElementById("deal-conversations");
    if($("#modal").open) $("#modal").close();
    panel.innerHTML='<p>Ожидаем подтверждение от amoCRM.</p><footer><button type="button" data-feed="open">Открыть BeChat</button></footer>';
    return;
  }
  document.body.classList.remove("bechat-auth-pending");
  if (!document.querySelector("#auth-status") || !document.querySelector("#modal")?.open) showAmoLogin(message);
  else authStatus(message);
  const button=document.getElementById("amo-signin");
  if (embeddedCRM && button) {
    button.hidden=false;
    button.textContent="Войти в отдельном окне amoCRM";
    button.onclick=()=>guarded(openCrmWindow);
  }
}
function widgetFailure(message) {
  if (widgetRetries++ < 1) { setTimeout(()=>{if(!token && !widgetAttempt) beginSignIn().catch(()=>loginProblem(message));},450); }
  else loginProblem(message);
}
async function openCrmWindow() {
  const child=window.open("about:blank","_blank","popup,width=760,height=740");
  if (!child) return loginProblem("Разрешите всплывающее окно для входа через amoCRM.");
  const proof=await makeProof();
  fallback={...proof,child};
  const target=new URL("/auth/start",location.origin);
  target.search=new URLSearchParams({client:"web",challenge:proof.challenge,nonce:proof.nonce});
  child.location.replace(target.href);
  authStatus("Завершите вход в открывшемся окне amoCRM.");
}
window.addEventListener("message",async e=>{
  if (!fallback || e.origin!==location.origin || e.source!==fallback.child || e.data?.type!=="bechat:oauth:done" || e.data.nonce!==fallback.nonce) return;
  const attempt=fallback; fallback=null;
  attempt.child.close();
  try {
    if (!e.data.ticket) throw Error("Вход не завершён. Откройте рабочий аккаунт amoCRM.");
    await redeem(e.data.ticket,attempt.verifier,"web");
  } catch(error) {loginProblem(error.message);}
});

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
  if(typeof thumbnails!=="undefined"){for(const p of thumbnails.values())p.then(src=>{if(src)URL.revokeObjectURL(src);}); thumbnails.clear();}
  if (typeof photos!=="undefined") {for(const p of photos.values())p.then(src=>{if(src)URL.revokeObjectURL(src);}); photos.clear();}
  try {
    sessionStorage.removeItem("bechat-widget-session");
    sessionStorage.removeItem("bechat-session-v2");
  } catch {}
  state = { chats: [], templates: [] };
  active = "";
  Object.assign(profile, { name: "", role: "", founder: false });
  BeChatVoice.clear();
  if(dealFeedMode){publishedHistory="";timelineGeneration++;loadingHistory="";feedParent("history",{lead:feedParams.get("entityId"),items:[]});}
  for (const store of [drafts,noteDrafts,modeDrafts, attempts, smsSchedule])
    for (const k of Object.keys(store)) delete store[k];
  attachment = null;
  reply = null;
  document.querySelector("#file-preview")?.close();
  render();
}
function showAmoLogin(message = "") {
  if (typeof dealFeedMode!=="undefined" && dealFeedMode) return loginProblem(message);
  document.body.classList.remove("bechat-auth-pending");
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
    const expected=embeddedCRM && new URLSearchParams(location.search).get("crmUser");
    if(expected && String(profile.crmUserId)!==expected) {clearIdentity();throw Error("Выберите в amoCRM сотрудника, открывшего сделку.");}
  } catch (e) {
    token = "";
    throw e;
  }
  if (embeddedCRM) {try {sessionStorage.setItem("bechat-widget-session",value);} catch {}}
  document.body.classList.remove("bechat-auth-pending");
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
  if (embeddedCRM && !dealFeedMode && ctx.get("open")==="settings") await handle("settings");
  widgetRetries=0;
  if(embeddedCRM) parent.postMessage({type:"bechat:sso:active",uid:profile.crmUserId},window.BECHAT_CONFIG.crmOrigin);
}
async function redeem(code, verifier, client) {
  if (client==="widget" && typeof code==="string" && code.startsWith("resume.")) {
    const challenge=enc64(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(verifier)));
    let cached;
    try {cached=sessionStorage.getItem("bechat-widget-session");} catch {}
    const resume=async(session)=>fetch("/auth/widget-resume",{method:"POST",credentials:"include",headers:{
      "Content-Type":"application/json",...(session?{Authorization:"Bearer "+session}:{})
    },body:JSON.stringify({assertion:code,challenge})});
    let result=await resume(cached);
    if (!result.ok && cached) result=await resume("");
    for (const delay of [200,500,1000,1600]) {
      if (result.ok || !embeddedCRM) break;
      await new Promise(resolve=>setTimeout(resolve,delay));
      result=await resume("");
    }
    if(!result.ok) throw Error("Для этого браузера требуется подтверждение сотрудника через amoCRM.");
    code=(await result.json()).ticket;
  }
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
        widgetFailure("amoCRM не ответила на запрос автоматического входа.");
      }
    }, 9000);
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
window.addEventListener("message", async e=>{
  if (!embeddedCRM || !token || e.source!==parent || e.origin!==window.BECHAT_CONFIG?.crmOrigin ||
      e.data?.type!=="bechat:sso:delegate" || !/^[\w-]{43}$/.test(e.data.nonce||"") ||
      !/^[\w-]{43}$/.test(e.data.challenge||"")) return;
  let ticket=null;
  try {
    const r=await fetch("/auth/widget-ticket",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Bearer "+token},
      body:JSON.stringify({uid:e.data.uid,challenge:e.data.challenge})});
    if(r.ok) ticket=(await r.json()).ticket;
  } finally {parent.postMessage({type:"bechat:sso:delegated",nonce:e.data.nonce,ticket},e.origin);}
});
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
    widgetFailure(e.data.message || "Не удалось подтвердить вход из виджета.");
    return;
  }
  redeem(e.data.ticket, attempt.verifier, "widget").catch((err) =>
    widgetFailure(err.message),
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
    pendingIdentity();
    await beginSignIn();
    return;
  }
  const result = new URLSearchParams(location.hash.slice(1));
  if (result.has("ticket") || result.has("error")) {
    history.replaceState(null, "", location.pathname + location.search);
    if (window.opener && result.get("nonce")) {
      window.opener.postMessage({type:"bechat:oauth:done",nonce:result.get("nonce"),ticket:result.get("ticket")},location.origin);
      document.body.textContent="Вход обрабатывается. Вернитесь к карточке сделки.";
      return;
    }
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
