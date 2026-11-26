"use strict";
document.addEventListener(
  "pointerdown",
  () => {
    document.documentElement.dataset.inputMethod = "pointer";
  },
  true,
);
document.addEventListener(
  "keydown",
  (e) => {
    if (e.key === "Tab")
      document.documentElement.dataset.inputMethod = "keyboard";
  },
  true,
);
const $ = (s) => document.querySelector(s);
const esc = (s) =>
  String(s ?? "").replace(
    /[&<>"']/g,
    (k) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        k
      ],
  );
const ctx = new URLSearchParams(location.search);
const sid = () =>
  crypto.randomUUID?.() ||
  String(Date.now()) + Math.random().toString(36).slice(2);
const profile = { name: "", role: "" };
let token = "",
  state = { chats: [], templates: [] },
  active = "",
  folder = "inbox",
  tab = "all",
  query = "",
  detailsOpen = innerWidth > 1180,
  note = false,
  attachment = null,
  reply = null,
  searchTerm = null,
  sending = false,
  motion = true,
  serverChannels = [],
  crm = false,
  crmOrigin = "",
  activeModal = "",
  lastRender = "",
  busy = 0;
const modeDrafts = {}, drafts = {}, noteDrafts = {},
  draftBag = (internal=note) => internal ? noteDrafts : drafts,
  attempts = {},
  editable = () => profile.role !== "Наблюдатель";
try {
  token = sessionStorage.getItem("bechat-session-v2") || "";
  motion = localStorage.getItem("bechat-motion") !== "off";
} catch {}
const c = () => state.chats.find((x) => x.id === active);
const chIcon = (channel) =>
  channel === "SMS"
    ? "mail"
    : channel === "WhatsApp"
      ? "whatsapp"
      : channel === "Telegram"
        ? "telegram"
        : "chat";
const time = (t) =>
  new Date(t).toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
  });
const date = (t) =>
  new Date(t).toLocaleDateString("ru-RU", { day: "numeric", month: "long" });
const dayKey = (t) => new Date(t).toLocaleDateString("ru-RU");
const btn = (act, ico, title, cl = "icon") =>
  `<button class="${cl}" data-act="${act}" title="${esc(title)}" aria-label="${esc(title)}">${icon(ico)}</button>`;
const modalBtn = (act, ico, title, sub = "") =>
  `<button class="modalbtn" data-act="${act}">${icon(ico)}<span>${esc(title)}${sub ? `<small>${esc(sub)}</small>` : ""}</span></button>`;
const field = (label, name, value = "", type = "text", required = false) =>
  `<label class="formfield"><span>${esc(label)}</span><input type="${type}" name="${name}" value="${esc(value)}" ${required ? "required" : ""} maxlength="400"></label>`;
const area = (label, name, value = "") =>
  `<label class="formfield"><span>${esc(label)}</span><textarea name="${name}" maxlength="4000" required>${esc(value)}</textarea></label>`;
const select = (label, name, items, chosen) =>
  `<label class="formfield"><span>${esc(label)}</span><select name="${name}">${items.map((v, i) => `<option value="${i}" ${i === chosen ? "selected" : ""}>${esc(v)}</option>`).join("")}</select></label>`;
function form(action, body, label = "Сохранить") {
  return `<form data-form="${action}">${body}<button class="primary" type="submit">${label}</button></form>`;
}
const photos = new Map();
const thumbnails=new Map();
const thumbnailObserver=new IntersectionObserver(entries=>{
  for(const entry of entries) {
    if(!entry.isIntersecting) continue;
    const img=entry.target, fid=img.dataset.photo;
    thumbnailObserver.unobserve(img);
    if (!thumbnails.has(fid)) thumbnails.set(fid,attachmentBlob({id:fid}).then(b=>URL.createObjectURL(b)).catch(()=>{thumbnails.delete(fid);return "";}));
    thumbnails.get(fid).then(src=>{
      if(!img.isConnected)return;
      if(src){img.onerror=()=>img.parentElement?.classList.add("unavailable");img.src=src;}
      else img.parentElement?.classList.add("unavailable");
    });
    if(thumbnails.size>100) {const key=thumbnails.keys().next().value;thumbnails.get(key).then(src=>URL.revokeObjectURL(src));thumbnails.delete(key);}
  }
});

function paintPhotos() {
  thumbnailObserver.disconnect();
  for(const img of document.querySelectorAll("img[data-photo]")) thumbnailObserver.observe(img);
  for (const node of document.querySelectorAll("img[data-avatar]")) {
    const chat = state.chats.find(x=>x.id===node.dataset.avatar);
    if (!chat?.avatarVersion || !token) continue;
    const key=chat.id+":"+chat.avatarVersion;
    if (!photos.has(key)) photos.set(key,fetch("/api/avatar/"+encodeURIComponent(chat.id),{headers:{Authorization:"Bearer "+token}})
      .then(r=>{if(!r.ok) throw Error(); return r.blob();}).then(blob=>URL.createObjectURL(blob))
      .catch(()=>{photos.delete(key); return "";}));
    photos.get(key).then(src=>{if(src && node.isConnected){node.src=src;node.hidden=false;}});
  }
}
function avatar(x, badge = false) {
  const chars = x.name
    .split(" ")
    .map((n) => n[0])
    .slice(0, 2)
    .join("");
  return `<span class="avatar">${esc(chars)}${x.avatarVersion ? '<img hidden alt="" data-avatar="'+esc(x.id)+'" style="position:absolute;inset:0;width:100%;height:100%;border-radius:50%;object-fit:cover">' : ""}${badge ? `<i class="chan">${icon(chIcon(x.channel))}</i>` : ""}</span>`;
}
function toast(msg) {
  $("#toast").textContent = msg;
  $("#toast").classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("#toast").classList.remove("show"), 3200);
}
function modal(title, html, id = "") {
  activeModal = id;
  $("#modal>header button").hidden = id === "login";
  $("#modaltitle").textContent = title;
  $("#modalbody").innerHTML = html;
  if ($("#modalbody img[data-photo]")) paintPhotos();
  if (!$("#modal").open) $("#modal").showModal();
}
function closeModal() {
  if (activeModal==="login" && !token) return;
  if ($("#modal").open) $("#modal").close();
  activeModal = "";
}

async function api(path, method = "GET", data) {
  if (!token) {
    if (activeModal!=="login") showAmoLogin("Войдите в рабочий аккаунт amoCRM.");
    throw Error("Требуется вход через amoCRM");
  }
  const requestToken=token;
  const res = await fetch("/api/" + path, {
    method,
    headers: {
      "Content-Type": "application/json",
      Authorization: "Bearer " + token,
    },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const val = await res.json();
  if (!res.ok) {
    if (res.status === 401 && token===requestToken) {
      clearIdentity();
      showAmoLogin("Сессия завершена. Подтверждаем вход.");
      if(embeddedCRM) {widgetRetries=0;beginSignIn().catch(e=>loginProblem(e.message));}
      nativeApp()?.postMessage({ type: "expired" });
    }
    throw Error(val.error || "Сервис временно недоступен");
  }
  return val;
}
let refreshGeneration = 0, historyLimit = 100, knownRevision = "";
async function refresh() {
  const generation = ++refreshGeneration;
  const params = new URLSearchParams({view:dealFeedMode?"feed":"inbox",active,limit:String(historyLimit)});
  if (ctx.get("entity")==="leads") params.set("lead",ctx.get("entityId"));
  if (dealFeedMode) { params.set("entity","leads"); params.set("entityId",ctx.get("entityId")); }
  if (dealFeedMode && feedParams.get("timeline")==="1") params.set("timeline","1");
  if (query.trim()) params.set("q",query.trim());
  const s = await api("state?"+params);
  if (generation !== refreshGeneration) return;
  const loadedBuild=document.documentElement.dataset.build;
  if (loadedBuild && s.uiBuild && loadedBuild!==s.uiBuild && !activeModal && !sending && !attachment &&
      !Object.values(drafts).some(Boolean) && !Object.values(noteDrafts).some(Boolean) &&
      !Object.values(modeDrafts).some(d=>d.attachment||d.reply) && !reply &&
      !document.querySelector("dialog[open],.attachment-menu,.animation-picker,.voice-strip:not([hidden])")) {
    location.reload();
    return;
  }
  knownRevision = s.revision;
  Object.assign(profile, s.profile);
  serverChannels = s.channels;
  crm = s.crm;
  crmOrigin = s.crmOrigin || "";
  state = { chats: s.chats, templates: s.templates, sharedSms: s.sharedSms };
  if (!c()) active = s.selected || state.chats[0]?.id || "";
}
async function patch(fields) {
  if (!editable()) throw Error("Требуются права менеджера");
  {
    await api("chats/" + encodeURIComponent(active), "PATCH", fields);
    await refresh();
  }
  render();
}
function renderRail() {
  $("#railmain").innerHTML = [
    ["inbox", "chat", "Входящие"],
    ["pinned", "pin", "Закреплённые"],
    ["archive", "archive", "Архив"],
    ["templates", "templates", "Шаблоны"],
    ["channels", "network", "Каналы связи"],
  ]
    .map(([act, ico, l]) =>
      btn(act, ico, l, "navbtn" + (folder === act ? " sel" : "")),
    )
    .join("");
}
function renderList() {
  const counts = state.chats.filter((x) => !x.archived),
    titles = { inbox: "Входящие", pinned: "Закреплённые", archive: "Архив" };
  $("#listtitle").textContent = titles[folder];
  $("#crumb").textContent = titles[folder];
  $("#tabs").innerHTML = [
    ["all", "Все", counts.length],
    ["unanswered", "Без ответа", counts.filter((x) => x.unanswered).length],
  ]
    .map(
      ([v, t, n]) =>
        `<button class="tab ${v === tab ? "sel" : ""}" data-tab="${v}">${t}<span>${n}</span></button>`,
    )
    .join("");
  const items = state.chats
    .filter(
      (x) =>
        (folder === "archive" ? x.archived : !x.archived) &&
        (folder !== "pinned" || x.pinned) &&
        (tab !== "unanswered" || x.unanswered) &&
        (x.searchMatch || [
          x.phone,
          x.name,
          x.channel,
          x.company,
          x.username,
          ...x.messages.map((m) => m.text),
        ]
          .join(" ")
          .toLowerCase()
          .includes(query.toLowerCase())),
    )
    .sort((a, b) =>
      (b.messages.at(-1)?.at || "").localeCompare(a.messages.at(-1)?.at || ""),
    );
  const list = (pinned, label) => {
    const rows = items.filter((x) => !!x.pinned === pinned);
    return rows.length
      ? `<div class="sectioncap">${pinned ? icon("pin") : ""}${label}</div>` +
          rows
            .map((x) => {
              const m = x.messages.at(-1);
              return `<button class="chatrow ${x.id === active ? "sel" : ""}" data-chat="${esc(x.id)}">${avatar(x, true)}<span class="rowtext"><span class="rowhead"><b>${esc(x.name)}</b><time>${m ? (dayKey(m.at) === dayKey(Date.now()) ? time(m.at) : date(m.at)) : ""}</time></span><span class="rowdesc"><span class="snip">${esc((m?.side === "out" ? "Вы: " : m?.side === "note" ? "Заметка: " : "") + (m?.text || m?.file?.name || "Новый диалог"))}</span>${x.unanswered ? `<span class="count">${Number(x.unanswered)}</span>` : ""}</span></span></button>`;
            })
            .join("")
      : "";
  };
  $("#chatlist").innerHTML =
    list(true, "Закреплённые") +
      list(false, folder === "archive" ? "В архиве" : "Все диалоги") ||
    '<p class="quickempty">Диалогов пока нет</p>';
}
function messageFiles(m) {
  return m.files?.length ? m.files : m.file ? [m.file] : [];
}
function isPicture(file) {
  return ["photo","sticker","gif"].includes(file.kind) ||
    ((!file.kind || file.kind==="file") && /\.(?:jpe?g|png|webp|gif)$/i.test(file.name));
}
function saveControl(file) {
  const label="Скачать "+esc(file.name);
  return file.download ? '<a class="icon file-download" href="'+esc(file.download)+'" download="'+esc(file.name)+'" title="'+label+'" aria-label="'+label+'">'+icon("download")+'</a>' :
    '<button class="icon file-download" data-download="'+esc(file.id)+'" title="'+label+'" aria-label="'+label+'">'+icon("download")+'</button>';
}
function fileHtml(m) {
  const files=messageFiles(m), pictures=files.filter(isPicture);
  const media=pictures.map(file=>{
    const label=file.kind==="gif"?"Открыть GIF":file.kind==="sticker"?"Открыть стикер":"Открыть фотографию";
    return '<div class="picture-tile"><button type="button" class="picture-open" data-file="'+esc(file.id)+'" aria-label="'+label+'">'+
      '<img class="bechat-photo" data-photo="'+esc(file.id)+'" alt="'+esc(file.name)+'"><span class="picture-fallback">'+icon("file")+label+'</span></button>'+saveControl(file)+'</div>';
  }).join("");
  const documents=files.filter(f=>!isPicture(f)).map(f=>{
    if(BeChatVoice.isVoice(f)) return BeChatVoice.markup(f,m.side==="in");
    const kind=["video","audio","music"].includes(f.kind)?f.kind:previewType(f);
    const label=({video:"Видео",audio:"Голосовое",music:"Музыка"})[kind] || (kind || f.name.split(".").at(-1)).toUpperCase();
    const details=f.size ? " · "+Math.max(1,Math.round(f.size/1024))+" КБ" : "";
    const content=icon(f.kind==="audio"?"mic":"file")+'<span><b>'+esc(f.name)+'</b><small>'+esc(label+details)+'</small></span>';
    const card=f.download && !kind ? '<a class="filecard" href="'+esc(f.download)+'" download="'+esc(f.name)+'" title="Скачать файл">'+content+'</a>' :
      '<button class="filecard" data-file="'+esc(f.id)+'" title="'+(kind?"Открыть предпросмотр":"Скачать файл")+'">'+content+'</button>';
    return '<div class="attachment-row">'+card+(kind?saveControl(f):"")+'</div>';
  }).join("");
  return (media ? '<div class="picture-grid'+(pictures.length>1?' album':'')+'">'+media+'</div>' : "") + documents;
}
function messageContent(m) {
  const attachments=fileHtml(m);
  if(m.card?.href) return '<div class="message-caption">'+esc(m.text)+'</div><a class="card-open" target="_blank" rel="noopener noreferrer" href="'+esc(m.card.href)+'">'+esc(({poll:"Открыть опрос",tasks:"Открыть список задач",article:"Читать статью"})[m.card.kind])+'</a>';
  const caption=m.text ? '<div class="message-caption">'+esc(m.text)+'</div>' : "";
  return messageFiles(m).some(isPicture) ? attachments+caption : caption+attachments;
}
const deliveryLabel = {sent:"Отправлено",delivered:"Доставлено",read:"Прочитано"};
function threadHtml(x) {
  let prior = "";
  return (x.hasEarlier ? '<button class="actionlink" data-act="earlier">Загрузить более ранние сообщения</button>' : "") + (
    x.messages
      .map((m) => {
        let sep = "";
        const d = dayKey(m.at);
        if (d !== prior) {
          prior = d;
          sep = `<div class="day">${d === dayKey(Date.now()) ? "Сегодня, " : ""}${date(m.at)}</div>`;
        }
        return `${sep}<div class="msg ${esc(m.side)}" data-mid="${esc(m.id)}"><div tabindex="0" aria-haspopup="dialog" class="bubble ${messageFiles(m).some(isPicture) ? "filebubble picture-bubble" : m.file ? "filebubble" : ""} ${searchTerm && m.text.toLowerCase().includes(searchTerm.toLowerCase()) ? "hit" : ""}">${m.side === "note" ? "<small>Внутренняя заметка</small><br>" : ""}${m.quote ? `<div class="replyquote">${esc(m.quote)}</div>` : ""}${messageContent(m)}${m.reaction ? `<button type="button" class="message-reaction" title="Реакция в BeChat" aria-label="Снять реакцию ${esc(m.reaction)}">${esc(m.reaction)}</button>` : ""}<span class="meta">${x.channel === "SMS" && m.side === "out" ? esc(BeChatSms.labels[m.status] || m.status) + " · " : ""}${m.edited ? "изменено · " : ""}${time(m.at)} ${m.side === "out" ? (deliveryLabel[m.status] && x.channel !== "SMS" ? '<span class="delivery-state '+esc(m.status)+'">'+deliveryLabel[m.status]+'</span>' : "") + icon(m.status === "read" || m.status === "delivered" ? "checks" : ["sending", "queued", "scheduled", "unknown", "demo"].includes(m.status) ? "clock" : ["failed", "cancelled", "expired"].includes(m.status) ? "close" : "check") : ""}${x.channel !== "SMS" && ["failed", "unknown", "sending"].includes(m.status) ? { failed: "Ошибка", unknown: "Статус уточняется", sending: "Отправляется" }[m.status] : ""}</span></div></div>`;
      })
      .join("") || '<p class="quickempty">Здесь появятся сообщения диалога</p>'
  );
}
function renderHead() {
  const x = c();
  $("#chathead").innerHTML = x
    ? btn("back", "back", "К диалогам", "icon mobileback") +
      `<button class="idbutton" data-act="info">${avatar(x)}<span><strong>${esc(x.name)}</strong><span class="chantext">${icon(chIcon(x.channel))}${esc(x.channel)}</span></span></button><span class="tools">${btn("find", "search", "Поиск по переписке")}${btn("info", "panel", "Карточка контакта")}${btn("more", "more", "Действия с диалогом")}</span>`
    : "";
}
function renderCompose() {
  if (!c() || !editable()) {
    BeChatMedia.cancel();
    $("#composer").innerHTML = "";
    return;
  }
  if (BeChatMedia.preserve(active,note) || BeChatAttachments.preserve(active,note)) return;
  const draft = draftBag()[active] || "";
  $("#composer").innerHTML =
    `<div class="composewrap"><div class="composeactions"><button class="actionlink ${!note ? "sel" : ""}" data-act="message">${icon("chat")}Сообщение</button><button class="actionlink ${note ? "sel" : ""}" data-act="note">${icon("lock")}Заметка</button><button class="actionlink last" data-act="templates">${icon("bolt")}Шаблоны</button></div>${attachment || reply ? `<div class="attached">${icon(attachment ? "attach" : "reply")}${esc(attachment?.name || reply)}${btn("clearattach", "close", "Убрать")}</div>` : ""}<div class="composebox">${c().channel === "SMS" && !note ? btn("sms-time", "clock", "Запланировать SMS") : btn("attach", "attach", "Прикрепить файл")}<textarea id="draft" aria-label="Текст сообщения" placeholder="${note ? "Заметка для коллег…" : "Написать сообщение…"}" maxlength="4000">${esc(draft)}</textarea>${btn("emoji", "smile", "Эмодзи")}${btn("send", "send", note ? "Сохранить заметку" : "Отправить", "icon send")}</div>${c().channel === "SMS" && !note ? '<div class="sms-meter" id="sms-meter"></div>' : ""}</div>`;
  const clip = $('#composer [data-act="attach"]');
  if (clip) { clip.setAttribute("aria-haspopup","menu"); clip.setAttribute("aria-expanded","false"); }
  BeChatMedia.mount();
  updateSmsMeter();
}
function renderDetails() {
  const d = $("#details"),
    x = c();
  d.className =
    "details" +
    (!detailsOpen ? " closed" : innerWidth <= 1180 ? " overlay" : "");
  if (!x || !detailsOpen) {
    d.innerHTML = "";
    return;
  }
  d.innerHTML = `<div class="detailshead"><b>Карточка контакта</b>${btn("detailsclose", "close", "Закрыть карточку")}</div><div class="problock">${avatar(x)}<h2>${esc(x.name)}</h2><small>${esc(x.company || x.channel)}</small></div><section class="detailsection"><div class="sectioncap">${icon("brief")}Сделка</div><button class="dealbox" data-act="deal"><strong>${esc(x.deal || "Связать сделку")}</strong><small>${x.amount ? Number(x.amount).toLocaleString("ru-RU") + " ₽" : ""}</small><span class="stages">${stages.map((_, i) => `<i class="${i <= x.stage ? "on" : ""}"></i>`).join("")}</span><span class="dealfoot">${esc(stages[x.stage] || "Открыть сделку")}${icon("right")}</span></button></section><section class="detailsection"><div class="sectioncap">${icon("user")}Контакт</div>${[
    ["Канал", x.channel],
    ["Аккаунт", x.username ? "@" + x.username : x.peer || "—"],
    ["Ответственный", x.owner || "—"],
  ]
    .map(
      ([k, v]) =>
        `<div class="fielditem"><label>${k}</label><span>${esc(v)}</span></div>`,
    )
    .join(
      "",
    )}${editable() && x.channel !== "SMS" && (x.phone || (x.channel === "WhatsApp" && x.peer)) && chatChannels().includes("SMS") ? modalBtn("contact-sms", "mail", "Написать SMS") : ""}</section><section class="detailsection"><div class="fmrow"><div class="sectioncap">${icon("tag")}Теги</div>${editable() ? btn("tags", "plus", "Изменить теги") : ""}</div><div class="pillset">${(x.tags || []).map((t) => `<span class="chip">${esc(t)}</span>`).join("") || "<small>Нет тегов</small>"}</div></section><section class="detailsection"><div class="fmrow"><div class="sectioncap">${icon("check")}Задачи</div>${editable() ? btn("task", "plus", "Добавить задачу") : ""}</div>${(x.tasks || []).map((t) => `<label class="taskitem"><input type="checkbox" data-task="${esc(t.id)}" ${t.done ? "checked" : ""} ${!editable() ? "disabled" : ""}>${esc(t.text)}</label>`).join("") || "<small>Нет задач</small>"}</section>`;
}
const reducedMotion = matchMedia("(prefers-reduced-motion: reduce)");
function syncMotion() {
  const running = motion && !reducedMotion.matches;
  document.body.classList.toggle("no-motion", !running);
  const sphere = document.getElementById("brand-sphere");
  const src = running ? "assets/sphere-loop.webp" : "assets/sphere-still.webp";
  if (sphere.getAttribute("src") !== src) sphere.setAttribute("src", src);
}
reducedMotion.addEventListener("change", syncMotion);
function render(scroll = true) {
  if (dealFeedMode) { renderDealFeed(); return; }
  renderRail();
  renderList();
  renderHead();
  document.querySelector(".pinbar")?.remove();
  const pm = c()?.messages.find((m) => m.id === c()?.pinMessage);
  if (pm)
    $("#chathead").insertAdjacentHTML(
      "afterend",
      `<button class="pinbar" data-act="jump">${icon("pin")}<span><b>Закреплённое сообщение</b><small>${esc(pm.file?.name || pm.text)}</small></span>${icon("down")}</button>`,
    );
  const el = $("#thread"),
    pos = el.scrollTop;
  el.innerHTML = c()
    ? threadHtml(c())
    : '<p class="quickempty">Выберите диалог или начните новый</p>';
  renderCompose();
  renderDetails();
  if (scroll) el.scrollTop = el.scrollHeight;
  else el.scrollTop = pos;
  BeChatVoice.mount();
  window.beChatMessageMenu?.sync();
  syncMotion();
  paintPhotos();
}
function openChat(id) {
  BeChatAttachments.close();
  BeChatMedia.cancel();
  if(active!==id)BeChatVoice.stop();
  if (active) modeDrafts[active+"|"+String(note)]={attachment,reply};
  active = id;
  historyLimit = 100;
  const saved=modeDrafts[id+"|false"];
  attachment = saved?.attachment||null;
  reply = saved?.reply||null;
  searchTerm = null;
  note = false;
  document.body.classList.add("chat-open");
  document.querySelector(".threadsearch")?.remove();
  $("#thread").classList.remove("switching");
  void $("#thread").offsetWidth;
  $("#thread").classList.add("switching");
  render();
  guarded(async()=>{await refresh(); if(active===id) render();});
}
function selectedForm() {
  return new FormData($("#modalbody form"));
}
function templateMenu() {
  modal(
    "Шаблоны сообщений",
    state.templates
      .map(
        (t) =>
          `<div class="modalrow"><button class="modalbtn" data-template="${esc(t.id)}">${icon("bolt")}<span>${esc(t.title)}<small>${esc(t.text)}</small></span></button>${editable() ? `<button class="icon" aria-label="Редактировать шаблон" data-edit="${esc(t.id)}">${icon("compose")}</button>` : ""}</div>`,
      )
      .join("") +
      (editable() ? modalBtn("newtemplate", "plus", "Создать шаблон") : ""),
    "templates",
  );
}
function templateForm(id) {
  const t = state.templates.find((x) => x.id === id) || {
    id: "",
    title: "",
    text: "",
  };
  modal(
    "Шаблон",
    form(
      "template",
      `<input type="hidden" name="id" value="${esc(t.id)}">` +
        field("Название", "title", t.title, "text", true) +
        area("Текст · переменная {имя}", "text", t.text),
    ),
  );
}

async function attachmentBlob(file, signal) {
  {
    const response = await fetch("/api/files/" + encodeURIComponent(file.id), {
      headers: { Authorization: "Bearer " + token },
      signal,
    });
    if (!response.ok) {
      let reason;
      try {reason=(await response.json()).error;} catch {}
      throw Error(reason || "Ошибка получения файла · "+response.status);
    }
    return response.blob();
  }
}
async function activateAttachment(id, button, save = false) {
  const file = c()?.messages.flatMap(m=>m.files || (m.file?[m.file]:[])).find(f=>f.id===id) || c()?.messages.find(m=>m.id===id)?.file;
  if (!file) return;
  if (!save && (isPicture(file) || ["video","audio","music"].includes(file.kind))) {
    const url=URL.createObjectURL(await attachmentBlob(file));
    modal(file.name,"","media-preview");
    const el=document.createElement(["audio","music"].includes(file.kind)?"audio":file.kind==="video"?"video":"img");
    el.style.cssText="display:block;max-width:100%;max-height:72vh;margin:auto";
    if (el.tagName!=="IMG") el.controls=true; else el.alt=file.name;
    el.src=url;
    $("#modalbody").append(el);
    $("#modal").addEventListener("close",()=>URL.revokeObjectURL(url),{once:true});
    return;
  }
  if (!save && previewType(file)) return openDocument(file, button);
  downloadBlob(await attachmentBlob(file), file.name);
}
async function send() {
  if (sending || !editable() || !c()) return;
  const x = c(),
    txt = (draftBag()[active] || "").trim(),
    f = attachment,
    q = reply,
    isNote = note;
  if (!txt && !f) return;
  if (x.channel === "SMS" && !isNote && f)
    throw Error("Для SMS доступен только текст");

  sending = true;
  $("#draft").disabled = true;
  const fingerprint = JSON.stringify([
    txt,
    f?.name,
    f?.size,
    f?.lastModified,
    f?.card, f?.beChatKind,
    q,
    isNote,
    x.channel === "SMS" ? smsSchedule[active] : null,
  ]);
  let attempt = attempts[x.id];
  if (attempt?.fingerprint !== fingerprint)
    attempt = attempts[x.id] = { id: sid(), fingerprint };
  const msg = {
    id: attempt.id,
    side: isNote ? "note" : "out",
    text: txt,
    quote: q || "",
    at: new Date().toISOString(),
    status: "sent",
    ...(x.channel === "SMS" && !isNote
      ? {
          status: "queued",
          sms: BeChatSms.measure(q ? "❝ " + q + "\n\n" + txt : txt),
          smsAt: smsSchedule[active] || undefined,
        }
      : {}),
  };
  try {
    if(f?.card) msg.card=f.card;
    else if (f) {
      {
        const r = await fetch("/api/files", {
          method: "POST",
          headers: {
            Authorization: "Bearer " + token,
            "X-Filename": encodeURIComponent(f.name),
            "Content-Type": "application/octet-stream",
          },
          body: f,
        });
        const j = await r.json();
        if (!r.ok) throw Error(j.error);
        msg.file = f.beChatKind ? {...j,kind:f.beChatKind} : j;
      }
    }
    {
      await api("chats/" + encodeURIComponent(x.id) + "/messages", "POST", msg);
      await refresh();
    }
    if (!isNote) delete smsSchedule[x.id];
    delete modeDrafts[x.id+"|"+String(isNote)];
    delete attempts[x.id];
    if ((draftBag(isNote)[x.id]||"").trim()===txt) delete draftBag(isNote)[x.id];
    if (active === x.id && note === isNote && attachment===f) {
      attachment = null;
      reply = null;
    }
    render();
    $("#draft")?.focus();
  } finally {
    sending = false;
    if ($("#draft")) $("#draft").disabled = false;
  }
}
async function handle(act) {
  if (act === "earlier") {
    const el=$("#thread"), height=el.scrollHeight, top=el.scrollTop;
    historyLimit+=200;
    await refresh(); render(false); el.scrollTop=top+el.scrollHeight-height;
    return;
  }
  if (act === "close") {
    if (activeModal !== "login") closeModal();
    return;
  }
  if (["inbox", "archive", "pinned"].includes(act)) {
    folder = act;
    tab = "all";
    query = "";
    $("#query").value = "";
    document.body.classList.remove("chat-open");
    renderList();
    renderRail();
    return;
  }
  if (act === "back") {
    document.body.classList.remove("chat-open");
    return;
  }
  if (act === "sms-settings") return openSmsCenter();
  if (act === "sms-time") return openSmsScheduler();
  if (act === "channels") {
    const chans = chatChannels();
    modal(
      "Каналы связи",
      chans
        .map(
          (n) =>
            `<div class="modalrow"><span class="chantext">${icon(chIcon(n))}${esc(n)}</span><small>${"Настроен"}</small></div>`,
        )
        .join("") +
        actionRow(
          "accounts",
          "Мои мессенджеры",
          "Подключение аккаунтов сотрудника",
          "network",
        ) +
        `<div class="modalrow"><b>amoCRM</b><small>${crm ? "Настроена" : "Требуется настройка"}</small></div>` +
        "",
    );
    return;
  }
  if (act === "settings") {
    const commonSender = state.sharedSms?.sender;
    modal(
      "Настройки",
      `<div class="modalrow"><div><b>${esc(profile.name)}</b><small style="display:block">${esc(profile.role)}</small></div>${icon("user")}</div>${themeOptions()}<label class="modalrow">Анимации интерфейса<input id="motion" type="checkbox" ${motion ? "checked" : ""}></label>` +
        actionRow(
          "accounts",
          "Мои мессенджеры",
          "Telegram, WhatsApp, MAX и ВКонтакте",
          "network",
        ) +
        (isFounder()
          ? modalBtn(
              "sms-settings",
              "mail",
              "SMS организации",
              "Общий аккаунт для сотрудников",
            )
          : '<div class="modalrow"><b>SMS организации</b><small>' +
            esc(commonSender || "Ожидает подключения учредителем") +
            "</small></div>") +
        "" +
        (embeddedCRM ? '<details class="formhint"><summary>Данные для настройки</summary>ID аккаунта: '+esc(window.BECHAT_CONFIG?.accountId||"")+'<br>Мой ID в amoCRM: '+esc(profile.crmUserId)+'</details>' : "") +
        modalBtn("logout", "lock", "Выйти"),
    );
    return;
  }
  if (act === "logout") {
    await api("logout", "POST", {});
    clearIdentity();
    nativeApp()?.postMessage({ type: "logout" });
    showAmoLogin();
    return;
  }
  if (act === "templates") {
    templateMenu();
    return;
  }
  if (act === "newtemplate") {
    templateForm("");
    return;
  }
  if (act === "contact-sms") {
    const x = c();
    if (!x || !editable() || !chatChannels().includes("SMS")) return;
    await handle("new");
    const f = $("#modalbody form");
    f.elements.name.value = x.name;
    f.elements.peer.value = x.phone || x.peer;
    f.querySelector("bechat-channel-picker").choose(
      chatChannels().indexOf("SMS"),
    );
    f.elements.peer.focus();
    return;
  }
  if (act === "new") {
    const channels = chatChannels();
    if (!editable()) throw Error("Требуются права менеджера");
    if (!channels.length) return openPersonalAccounts();
    modal(
      "Новый диалог",
      form(
        "new",
        field("Имя контакта (необязательно)", "name", "", "text") +
          channelSelector(channels) +
          field("Аккаунт или телефон", "peer", "", "text", true) +
          '<p id="recipient-hint" class="minor"></p>',
        "Создать диалог",
      ),
    );
    const f = $("#modalbody form"),
      picker = f.elements.channel;
    function labelRecipient() {
      const ch = channels[Number(picker.value)],
        sms = ch === "SMS";
      f.elements.name.required = false;
      f.elements.peer.type = "tel";
      f.elements.peer.autocomplete = "tel";
      f.elements.peer.placeholder = "+7 999 123-45-67";
      f.elements.peer.closest("label").querySelector("span").textContent = "Номер телефона";
      $("#recipient-hint").textContent = sms ? "Сообщение уйдёт с общего номера или имени организации." :
        ch === "ВКонтакте" ? "Поиск среди контактов ВКонтакте с доступным номером." : "Найдём собеседника в " + ch + " по номеру с кодом страны.";
    }
    picker.addEventListener("change", labelRecipient);
    labelRecipient();
    return;
  }
  if (!c()) return;
  const x = c();
  if (act === "jump") {
    const target = [...document.querySelectorAll("[data-mid]")].find(
      (el) => el.dataset.mid === x.pinMessage,
    );
    target?.scrollIntoView({
      block: "center",
      behavior: motion ? "smooth" : "auto",
    });
    target?.classList.add("flash");
    setTimeout(() => target?.classList.remove("flash"), 1000);
    return;
  }
  if (act === "media") {
    modal(
      "Вложения",
      x.messages
        .filter((m) => m.file)
        .map((m) => '<div class="mediaentry">' + fileHtml(m) + "</div>")
        .join("") || '<p class="minor">В этом диалоге пока нет вложений</p>',
    );
    return;
  }
  if (act === "pinmessage") {
    modal(
      "Закрепить сообщение",
      x.messages
        .filter((m) => m.side !== "note")
        .slice(-25)
        .reverse()
        .map(
          (m) =>
            `<button class="modalbtn" data-pin="${esc(m.id)}">${icon("pin")}${esc(m.text || m.file?.name)}</button>`,
        )
        .join("") +
        (x.pinMessage
          ? '<button class="modalbtn" data-pin="none">Снять закрепление</button>'
          : ""),
    );
    return;
  }
  if (act === "info" || act === "detailsclose") {
    detailsOpen = act === "info" ? !detailsOpen : false;
    renderDetails();
    return;
  }
  if (act === "message" || act === "note") {
    BeChatAttachments.close();
    BeChatMedia.cancel();
    const nextNote=act==="note";
    if (note!==nextNote) {
      const key=active+"|"+String(note);
      modeDrafts[key]={attachment,reply};
      const next=modeDrafts[active+"|"+String(nextNote)];
      attachment=next?.attachment||null;
      reply=next?.reply||null;
    }
    note = nextNote;
    renderCompose();
    $("#draft").focus();
    return;
  }
  if (act === "attach") {
    BeChatAttachments.toggle();
    return;
  }
  if (act === "clearattach") {
    attachment = null;
    reply = null;
    renderCompose();
    return;
  }
  if (act === "send") {
    await send();
    return;
  }
  if (act === "emoji" && !note && c()?.channel!=="SMS") return BeChatMedia.picker();
  if (act === "emoji") {
    modal(
      "Эмодзи",
      ["🙂", "👍", "✨", "🤝", "💙", "📎", "🚀", "🎉", "👌", "💬", "✅", "📅"]
        .map((v) => `<button class="emoji" data-emoji="${v}">${v}</button>`)
        .join(""),
    );
    return;
  }
  if (act === "find") {
    if (c()?.hasEarlier) {historyLimit=10000000;await refresh();render(false);}
    const existing = document.querySelector(".threadsearch");
    if (existing) {
      existing.remove();
      searchTerm = null;
      render(false);
      return;
    }
    $("#chathead").insertAdjacentHTML(
      "afterend",
      `<label class="search threadsearch">${icon("search")}<input class="inlineinput" id="threadq" placeholder="Найти сообщение"><span class="resultsinfo"></span>${btn("find", "close", "Закрыть поиск")}</label>`,
    );
    $("#threadq").focus();
    return;
  }
  if (act === "more") {
    modal(
      "Действия с диалогом",
      editable()
        ? modalBtn("pinchat", "pin", x.pinned ? "Открепить" : "Закрепить") +
            modalBtn(
              "answer",
              "mail",
              x.unanswered ? "Отметить отвеченным" : "Вернуть в «Без ответа»",
            ) +
            modalBtn(
              "archivechat",
              "archive",
              x.archived ? "Вернуть из архива" : "Переместить в архив",
            ) +
            modalBtn("reply", "reply", "Цитировать сообщение") +
            modalBtn("pinmessage", "pin", "Закрепить сообщение") +
            modalBtn("media", "attach", "Вложения диалога") +
            (x.channel === "WhatsApp"
              ? modalBtn(
                  "wabapreset",
                  "templates",
                  "Одобренный шаблон WhatsApp",
                )
              : "")
        : modalBtn("find", "search", "Поиск"),
    );
    return;
  }
  if (["pinchat", "answer", "archivechat"].includes(act)) {
    const ops = {
      pinchat: { pinned: !x.pinned },
      answer: { unanswered: x.unanswered ? 0 : 1 },
      archivechat: { archived: !x.archived },
    };
    await patch(ops[act]);
    closeModal();
    return;
  }
  if (act === "reply") {
    modal(
      "Ответить на сообщение",
      x.messages
        .filter((m) => m.side !== "note")
        .slice(-20)
        .reverse()
        .map(
          (m) =>
            `<button class="modalbtn" data-quote="${esc(m.id)}">${icon("reply")}<span>${esc(m.text || m.file?.name)}</span></button>`,
        )
        .join(""),
    );
    return;
  }
  if (act === "deal") {
    const link =
      crmOrigin && x.leadId
        ? `<p class="mspace"><a class="actionlink" href="${esc(crmOrigin)}/leads/detail/${Number(x.leadId)}" target="_blank" rel="noopener">Открыть в amoCRM ${icon("external")}</a></p>`
        : "";
    modal(
      "Сделка",
      editable()
        ? form(
            "deal",
            field("Название", "deal", x.deal) +
              field("Бюджет, ₽", "amount", x.amount, "number") +
              select("Этап в BeChat", "stage", stages, x.stage) +
              field("Компания", "company", x.company) +
              (field("ID сделки amoCRM", "leadId", x.leadId, "number") +
                field(
                  "ID контакта amoCRM",
                  "contactId",
                  x.contactId,
                  "number",
                )),
          ) + link
        : `<p>${esc(x.deal)}</p>${link}`,
    );
    return;
  }
  if (act === "tags") {
    modal(
      "Теги контакта",
      form(
        "tags",
        field("Теги через запятую", "tags", (x.tags || []).join(", ")),
      ),
    );
    return;
  }
  if (act === "task") {
    modal(
      "Новая задача",
      form(
        "task",
        field("Что нужно сделать", "text", "", "text", true),
        "Добавить",
      ),
    );
    return;
  }
  if (act === "wabapreset") {
    const names = await api("wa-templates");
    if (!names.length) throw Error("На сервере нет одобренных шаблонов");
    modal(
      "Одобренные шаблоны",
      names
        .map(
          (t) =>
            `<button class="modalbtn" data-wa="${esc(t.name)}">${icon("templates")}${esc(t.name)}</button>`,
        )
        .join(""),
    );
    return;
  }
}
async function submit(action, fd) {
  const get = (k) => String(fd.get(k) || "").trim(),
    x = c();
  if (!editable()) throw Error("Требуются права менеджера");
  if (action === "new") {
    const channel = chatChannels()[Number(fd.get("channel"))];
    const chat = {
      id: sid(),
      name: get("name"),
      peer: get("peer"),
      channel,
      unanswered: 0,
      messages: [],
      tags: [],
      tasks: [],
      owner: profile.name,
      stage: 0,
    };
    if (channel === "SMS") {
      chat.peer = BeChatSms.normalize(chat.peer);
      chat.name = chat.name || chat.peer;
      chat.smsNumber = chat.peer;
    }
    chat.peer = BeChatSms.normalize(chat.peer);
    chat.name ||= chat.peer;
    {
      const v = await api("chats", "POST", {
        ...chat,
        lookup:"phone",
        entity: ctx.get("entity"),
        entityId: ctx.get("entityId"),
      });
      chat.id = v.id;
      await refresh();
    }
    closeModal();
    folder = "inbox";
    tab = "all";
    query = "";
    $("#query").value = "";
    openChat(chat.id);
    return;
  }
  if (action === "template") {
    const t = {
      id: get("id") || sid(),
      title: get("title"),
      text: get("text"),
    };
    if (!t.title || !t.text) throw Error("Заполните название и текст");
    {
      await api("templates", "POST", t);
      await refresh();
    }
    templateMenu();
    return;
  }
  if (!x) return;
  if (action === "deal") {
    await patch({
      deal: get("deal"),
      amount: Math.max(0, Number(get("amount"))),
      stage: Number(get("stage")),
      company: get("company"),
      ...{ leadId: get("leadId"), contactId: get("contactId") },
    });
  }
  if (action === "tags")
    await patch({
      tags: [
        ...new Set(
          get("tags")
            .split(",")
            .map((t) => t.trim())
            .filter(Boolean),
        ),
      ],
    });
  if (action === "task") {
    if (!get("text")) throw Error("Введите задачу");
    {
      await api("chats/" + encodeURIComponent(active) + "/tasks", "POST", {
        text: get("text"),
      });
      await refresh();
      render();
    }
  }
  closeModal();
}
async function guarded(fn) {
  busy++;
  try {
    await fn();
  } catch (e) {
    toast(e.message);
  } finally {
    busy--;
  }
}
document.addEventListener("click", (e) =>
  guarded(async () => {
    const target = e.target.closest("button");
    if (!target) return;
    if (!token && !target.closest("#modal")) {showAmoLogin(); if(embeddedCRM) await beginSignIn(); return;}
    const a = target.dataset;
    if (a.act) return handle(a.act);
    if (a.chat) return openChat(a.chat);
    if (a.tab) {
      tab = a.tab;
      renderList();
      return;
    }
    if (a.pin) {
      await patch({ pinMessage: a.pin === "none" ? "" : a.pin });
      closeModal();
      return;
    }
    if (a.file || a.download)
      return activateAttachment(a.file || a.download, target, !!a.download);
    if (a.edit) return templateForm(a.edit);
    if (a.template && c() && editable()) {
      const t = state.templates.find((t) => t.id === a.template);
      draftBag()[active] = t.text.replaceAll("{имя}", c().name.split(" ")[0]);
      closeModal();
      renderCompose();
      $("#draft").focus();
      return;
    }
    if (a.wa) {
      await api("chats/" + encodeURIComponent(active) + "/messages", "POST", {
        id: sid(),
        side: "out",
        text: a.wa,
        template: a.wa,
      });
      await refresh();
      closeModal();
      render();
      return;
    }
    if (a.emoji) {
      draftBag()[active] = (draftBag()[active] || "") + a.emoji;
      closeModal();
      renderCompose();
      $("#draft").focus();
      return;
    }
    if (a.quote) {
      const m = c().messages.find((m) => m.id === a.quote);
      reply = (m.text || m.file?.name || "").slice(0, 220);
      closeModal();
      renderCompose();
      $("#draft").focus();
    }
  }),
);
document.addEventListener("submit", (e) => {
  if (!e.target.dataset.form) return;
  e.preventDefault();
  const el = e.target,
    button = el.querySelector("[type=submit]");
  if (button.disabled) return;
  button.disabled = true;
  guarded(async () => {
    try {
      await submit(el.dataset.form, new FormData(el));
    } finally {
      button.disabled = false;
    }
  });
});
document.addEventListener("input", (e) => {
  if (e.target.id === "draft") {
    draftBag()[active] = e.target.value;
    BeChatMedia.sync();
    updateSmsMeter();
  }
  if (e.target.id === "query") {
    query = e.target.value;
    renderList(); paintPhotos();
    clearTimeout(renderList.timer);
    renderList.timer=setTimeout(()=>guarded(async()=>{await refresh();renderList();paintPhotos();}),250);
  }
  if (e.target.id === "threadq") {
    searchTerm = e.target.value;
    $("#thread").innerHTML = threadHtml(c());
    BeChatVoice.mount();
    const hits = document.querySelectorAll(".hit");
    document.querySelector(".resultsinfo").textContent = searchTerm
      ? "Найдено: " + hits.length
      : "";
    hits[0]?.scrollIntoView({ block: "nearest" });
  }
});
document.addEventListener("change", (e) =>
  guarded(async () => {
    if (e.target.id === "fileinput") {
      const f = e.target.files[0];
      e.target.value = "";
      if (!f || e.target.dataset.chat!==active || e.target.dataset.mode!==String(note)) return;
      const purpose=e.target.dataset.purpose, name=f.name.toLowerCase();
      f.beChatKind=purpose==="media" && /\.(jpe?g|png|webp)$/.test(name)?"photo":
        purpose==="media" && /\.(mp4|mov|webm)$/.test(name)?"video":
        purpose==="music" && /\.(mp3|ogg|m4a|wav)$/.test(name)?"music":undefined;
      if (f.size > 8 * 1024 * 1024)
        throw Error("Максимальный размер файла — 8 МБ");
      attachment = f;
      renderCompose();
    }
    if (e.target.id === "motion") {
      motion = e.target.checked;
      localStorage.setItem("bechat-motion", motion ? "on" : "off");
      syncMotion();
    }
    if (e.target.dataset.task) {
      const id = e.target.dataset.task,
        done = e.target.checked;
      {
        await api("chats/" + encodeURIComponent(active) + "/tasks", "PATCH", {
          id,
          done,
        });
        await refresh();
        render(false);
      }
    }
  }),
);
document.addEventListener("keydown", (e) => {
  if (e.isComposing) return;
  if (e.target.id === "draft" && e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    guarded(send);
  }
  if (
    e.key === "/" &&
    !$("#modal").open &&
    !["INPUT", "TEXTAREA", "SELECT"].includes(document.activeElement.tagName)
  ) {
    e.preventDefault();
    $("#query").focus();
  }
});
$("#modal").addEventListener("cancel", (e) => {
  if (activeModal === "login") e.preventDefault();
});
document.addEventListener("dblclick", (e) => {
  const id = e.target.closest("[data-mid]")?.dataset.mid;
  if (!id || !editable()) return;
  const m = c().messages.find((z) => z.id === id);
  if (m.side === "note") return;
  reply = (m.text || m.file?.name || "").slice(0, 220);
  renderCompose();
  $("#draft")?.focus();
});
async function boot() {
  await bootIdentity();
  const pause = ms => new Promise(done=>setTimeout(done,ms));
  while (true) {
    if (!token || document.hidden) {await pause(400); continue;}
    try {
      const before = knownRevision;
      const update = await api("changes?since="+encodeURIComponent(before));
      if (!token || document.hidden) continue;
      while (busy || sending) await pause(120);
      const el=$("#thread"), bottom=el.scrollHeight-el.clientHeight-el.scrollTop<35;
      const old = JSON.stringify(state), focused=document.activeElement?.id==="draft";
      const position=focused ? $("#draft").selectionStart : 0;
      await refresh();
      if (old!==JSON.stringify(state)) {
        render(bottom);
        if (focused && $("#draft")) {$("#draft").focus(); $("#draft").setSelectionRange(position,position);}
      }
      if (update.revision!==before) await pause(180);
    } catch {await pause(1200);}
  }
}
boot();

window.addEventListener("message",event=>{
  if (!embeddedCRM || dealFeedMode || event.source!==parent || event.origin!==window.BECHAT_CONFIG?.crmOrigin ||
      event.data?.type!=="bechat:panel:settings" || !token || !profile.crmUserId) return;
  guarded(()=>handle("settings"));
});
