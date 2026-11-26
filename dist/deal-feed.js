"use strict";
const feedParams = new URLSearchParams(location.search);
const dealFeedMode = window.parent !== window && feedParams.get("feed") === "1" &&
  feedParams.get("entity") === "leads" && /^[1-9]\d*$/.test(feedParams.get("entityId"));
let feedChoices = null, contactList = [], contactGeneration=0, contactRevision="";
async function publishContactPhotos() {
  if (!dealFeedMode || !token || !contactList.length) return;
  const generation=++contactGeneration;
  try {
    const items=await api("contact-photos","POST",{contacts:contactList,lead:feedParams.get("entityId")});
    if (generation===contactGeneration) feedParent("photos",{items});
  } catch {}
}
window.addEventListener("message",event=>{
  if (!dealFeedMode || event.source!==parent || event.origin!==window.BECHAT_CONFIG?.crmOrigin ||
      event.data?.type!=="bechat:contacts" || !Array.isArray(event.data.contacts)) return;
  contactList=event.data.contacts.slice(0,50);
  publishContactPhotos();
});
document.addEventListener("keydown",event=>{
  if (event.key==="Escape" && !event.defaultPrevented && window!==parent && !dealFeedMode &&
      !document.querySelector("dialog[open]") && window.BECHAT_CONFIG?.crmOrigin)
    parent.postMessage({type:"bechat:panel:close"},window.BECHAT_CONFIG.crmOrigin);
});

if (dealFeedMode) {
  let looking=null, wake=null;
  window.addEventListener("message",e=>{
    if (e.origin===window.BECHAT_CONFIG?.crmOrigin && e.source===parent && e.data?.type==="bechat:crm:matches" && looking && e.data.phone===looking) wake?.(e.data.matches);
  });
  window.addEventListener("DOMContentLoaded",async()=>{
    const pause=ms=>new Promise(done=>setTimeout(done,ms));
    while(true) {
      if (!token || !editable() || document.hidden) {await pause(2500);continue;}
      try {
        looking=(await api("contact-match")).phone;
        if (!looking) {await pause(15000);continue;}
        const matches=await new Promise(done=>{
          const timer=setTimeout(()=>done(null),15000);
          wake=value=>{clearTimeout(timer);done(value);};
          parent.postMessage({type:"bechat:crm:find",phone:looking},window.BECHAT_CONFIG.crmOrigin);
        });
        if(Array.isArray(matches)) await api("contact-match","POST",{phone:looking,matches});
        else await pause(15000);
      } catch {await pause(15000);}
      finally {looking=null;wake=null;}
      await pause(750);
    }
  },{once:true});
  document.body.classList.add("deal-feed");
  const panel = document.createElement("section");
  panel.id = "deal-conversations";
  document.body.append(panel);
  new ResizeObserver(() => feedParent("size", { height: panel.offsetHeight + 4 })).observe(panel);
  panel.addEventListener("click", e => guarded(async () => {
    const button = e.target.closest("button");
    if (!button) return;
    if (button.dataset.feed === "open") return feedParent("open");
    if (!token) return;
    if (button.dataset.feed === "choose") {
      feedChoices = feedChoices ? null : await api("deal-dialogs");
    } else if (button.dataset.link) {
      await api("deal-dialogs", "POST", { chat: button.dataset.link, lead: feedParams.get("entityId") });
      feedChoices = null;
      await refresh();
    }
    renderDealFeed();
  }));
}
function feedParent(action, values = {}) {
  if (window.BECHAT_CONFIG?.crmOrigin)
    window.parent.postMessage({type: (["ready","photos"].includes(action)?"bechat:contacts:":"bechat:feed:") + action, ...values}, window.BECHAT_CONFIG.crmOrigin);
}
let publishedHistory="", loadingHistory="", timelineGeneration=0;
async function publishDealHistory(key) {
  if (key===publishedHistory || key===loadingHistory) return;
  const generation=++timelineGeneration;
  loadingHistory=key;
  try {
    let cursor=0;
    const items=[];
    do {
      const page=await api("deal-timeline?"+new URLSearchParams({lead:feedParams.get("entityId"),after:String(cursor)}));
      if(generation!==timelineGeneration)return;
      items.push(...page.items);
      cursor=page.next;
    } while(cursor!==null);
    feedParent("history",{lead:feedParams.get("entityId"),items});
    publishedHistory=key;
  } catch {
    if(generation===timelineGeneration) setTimeout(()=>{if(token)renderDealFeed();},4000);
  } finally {if(generation===timelineGeneration)loadingHistory="";}
}
function renderDealFeed() {
  const panel = document.querySelector("#deal-conversations");
  if (!token) { panel.textContent = "Подключение BeChat…"; return; }
  if (contactRevision!==knownRevision) {contactRevision=knownRevision; feedParent("ready");}
  const labels = {sent:"Отправлено", delivered:"Доставлено", read:"Прочитано", sending:"Отправляется", failed:"Ошибка отправки"};
  const chronological=feedParams.get("timeline")==="1";
  if (chronological) publishDealHistory(JSON.stringify([knownRevision,state.chats.map(c=>c.id)]));
  const groups = (chronological?[]:state.chats).map(chat => {
    const messages = chat.messages.filter(m => ["in","out"].includes(m.side)).slice(-6);
    return '<article><header>[' + esc(chat.channel) + '] ' + esc(chat.name) + '</header>' +
      messages.map(m => '<div class="feed-line ' + (m.side === "out" ? "out" : "in") +
        '"><div><small>' + esc(new Date(m.at).toLocaleString("ru-RU",{dateStyle:"short",timeStyle:"short"})) +
        ' · ' + esc(m.side === "in" ? chat.name : m.author || chat.owner) +
        (m.side === "out" && labels[m.status] ? ' · ' + labels[m.status] : '') +
        '</small><p>' + esc(m.text || "") + (m.file ? ' 📎 ' + esc(m.file.name) : '') + '</p></div></div>').join("") +
      (messages.length ? '' : '<p>Сообщений пока нет</p>') + '</article>';
  });
  panel.innerHTML = (groups.join("") || (chronological && state.chats.length ? "" : '<p>К этой сделке пока не привязана переписка BeChat.</p>')) +
    '<footer><button data-feed="open">Открыть BeChat</button>' +
    (editable() ? '<button data-feed="choose">' + (feedChoices ? "Закрыть список" : "Привязать диалог") + '</button>' : '') + '</footer>' +
    (feedChoices ? '<section class="feed-choices">' + (feedChoices.map(c => '<button data-link="' + esc(c.id) + '">' + esc(c.channel + ' · ' + c.name) + '</button>').join("") || '<p>Свободных диалогов пока нет. Новый диалог можно начать через «Открыть BeChat».</p>') + '</section>' : '');
}
