"use strict";
const BeChatAttachments = (() => {
  const choices = [
    ["media", "image", "Фото или видео", "image/*,video/*"],
    ["document", "file", "Документ", ""],
    ["poll", "poll", "Опрос"],
    ["tasks", "select", "Список задач"],
    ["article", "note", "Статья"],
    ["location", "location", "Геопозиция"],
    ["music", "music", "Музыка", "audio/*"],
  ];
  let menu, trigger, owner, internal;
  function close(focus = false) {
    menu?.remove();
    menu = null;
    trigger?.setAttribute("aria-expanded","false");
    if (focus) trigger?.focus();
    trigger = null;
  }
  function edit(kind, label) {
    const chat = active, wasNote = note;
    const title = '<label class="formfield">'+(kind==="poll"?"Вопрос":"Заголовок")+'<input name="title" required maxlength="180"></label>';
    const coord = (name, text, limit) => '<label class="formfield">'+text+'<input name="'+name+'" type="number" min="-'+limit+'" max="'+limit+'" step="any" required></label>';
    const fields = kind==="location" ? coord("lat","Широта",90)+coord("lon","Долгота",180) :
      title+'<label class="formfield">'+({poll:"Варианты ответа, каждый с новой строки",tasks:"Задачи, каждая с новой строки",article:"Текст статьи"})[kind]+
      '<textarea name="body" rows="5" maxlength="'+(kind==="article"?20000:7529)+'" required></textarea></label>';
    modal(label,'<form class="attachment-form">'+fields+'<button class="primary" type="submit">Добавить в '+(note?"заметку":"сообщение")+'</button></form>',"attachment");
    const form = $("#modalbody .attachment-form");
    form.querySelector("input").focus();
    form.addEventListener("submit", e => {
      e.preventDefault();
      if (chat!==active || wasNote!==note) return closeModal();
      const fields = new FormData(form);
      if (kind==="location") {
        const lat=Number(fields.get("lat")), lon=Number(fields.get("lon"));
        const link="https://www.openstreetmap.org/?mlat="+lat+"&mlon="+lon+"#map=16/"+lat+"/"+lon;
        const text=[draftBag()[chat],link].filter(Boolean).join("\n");
        if (text.length>4000) return toast("Сократите текст, чтобы добавить геопозицию");
        draftBag()[chat]=text;
      } else {
        const title=fields.get("title").trim(), body=fields.get("body").trim();
        const items=body.split(/\r?\n/).map(s=>s.trim()).filter(Boolean);
        if (!title || !body) return toast("Заполните заголовок и текст");
        if (kind!=="article" && (items.length<(kind==="poll"?2:1) || items.length>30 || items.some(s=>s.length>250)))
          return toast("Добавьте от "+(kind==="poll"?2:1)+" до 30 пунктов длиной до 250 символов");
        attachment={name:label+" · "+title,card:{kind,title,...(kind==="article"?{body}:{items})}};
      }
      closeModal();
      renderCompose();
      $("#draft")?.focus();
    });
  }
  function choose(choice) {
    close();
    const [kind,,label,accept] = choice;
    if (accept===undefined) return edit(kind,label);
    const input=$("#fileinput");
    input.accept=accept;
    Object.assign(input.dataset,{chat:active,mode:String(note),purpose:kind});
    input.click();
  }
  function toggle() {
    if (menu) return close(true);
    owner=active; internal=note;
    trigger=$('#composer [data-act="attach"]');
    if (!trigger) return;
    trigger.setAttribute("aria-expanded","true");
    menu=document.createElement("div");
    menu.className="attachment-menu";
    menu.id="attachment-menu";
    menu.setAttribute("role","menu");
    menu.setAttribute("aria-label","Вложения");
    for (const choice of choices) {
      const button=document.createElement("button");
      button.type="button"; button.setAttribute("role","menuitem");
      button.innerHTML=icon(choice[1])+choice[2];
      button.onclick=()=>choose(choice);
      menu.append(button);
    }
    menu.onkeydown=e=>{
      const items=[...menu.children], i=items.indexOf(document.activeElement);
      const index={ArrowDown:(i+1)%items.length,ArrowUp:(i+items.length-1)%items.length,Home:0,End:items.length-1}[e.key];
      if(index!==undefined){e.preventDefault();items[index].focus();}
      if(e.key==="Escape"){e.preventDefault();close(true);}
      if(e.key==="Tab")close(true);
    };
    $("#composer .composewrap").append(menu);
    menu.firstElementChild.focus({preventScroll:true});
  }
  document.addEventListener("pointerdown",e=>{
    if(menu && !menu.contains(e.target) && !trigger.contains(e.target))close();
  });
  return {toggle,close,preserve:(chat,isNote)=>menu?.isConnected && owner===chat && internal===isNote};
})();
