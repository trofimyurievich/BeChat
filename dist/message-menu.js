"use strict";
window.beChatMessageMenu = (() => {
  const quick = ["❤️", "🤝", "🔥", "❤️‍🔥", "🤣", "🤯", "👌"],
    extra = [
      "👍",
      "👎",
      "👏",
      "🎉",
      "🥰",
      "😁",
      "🤔",
      "💯",
      "🙏",
      "💙",
      "✨",
      "👀",
    ];
  const host = document.createElement("div");
  host.id = "message-menu";
  host.hidden = true;
  host.setAttribute("role", "dialog");
  host.setAttribute("aria-label", "Действия с сообщением");
  document.body.append(host);
  let target = null,
    origin = null,
    anchor = null,
    expanded = false,
    selectedChat = "",
    touchTimer = null,
    touchPoint = null;
  const selected = new Set();
  const message = (mid) => c()?.messages.find((m) => m.id === mid);
  const bubble = (mid) =>
    document.querySelector(`[data-mid="${CSS.escape(mid)}"] .bubble`);
  const preview = (m) => m.text || m.file?.name || "";
  function close(focus = false) {
    host.hidden = true;
    host.replaceChildren();
    origin?.classList.remove("context-active");
    if (focus && origin?.isConnected) origin.focus({ preventScroll: true });
    origin = null;
    target = null;
    expanded = false;
  }
  function position() {
    if (host.hidden || !anchor) return;
    const viewportWidth = document.documentElement.clientWidth;
    const viewportHeight = document.documentElement.clientHeight;
    const margin = 6,
      w = host.offsetWidth,
      h = host.offsetHeight;
    const x = Math.min(
      Math.max(margin, anchor.x - 20),
      Math.max(margin, viewportWidth - w - margin),
    );
    const y =
      anchor.y + h + margin <= viewportHeight
        ? anchor.y
        : Math.max(margin, anchor.y - h);
    host.style.left = x + "px";
    host.style.top = y + "px";
  }
  function paint() {
    const m = message(target);
    if (!m) {
      close();
      return;
    }
    const pinned = c().pinMessage === m.id;
    const actions = [
      ["reply", "reply", "Ответить", editable() && m.side !== "note"],
      ["edit", "edit", "Изменить", editable()],
      [
        "pin",
        "pin",
        pinned ? "Открепить" : "Закрепить",
        editable() && m.side !== "note",
      ],
      ["copy", "copy", "Копировать текст", !!m.text],
      ["forward", "forward", "Переслать", editable() && m.side !== "note"],
      ["delete", "trash", "Удалить", editable()],
      ["select", "select", "Выделить", true],
    ];
    const reaction = (e) =>
      `<button type="button" data-reaction="${e}" aria-label="Реакция ${e}" aria-pressed="${m.reaction === e}" ${editable() ? "" : "disabled"}>${e === "❤️‍🔥" ? '<span class="burning-heart" aria-hidden="true">🔥</span>' : e}</button>`;
    const when = dayKey(m.at) === dayKey(Date.now()) ? "сегодня" : date(m.at);
    host.innerHTML = `<div class="reaction-tray" role="group" aria-label="Реакции BeChat">${quick.map(reaction).join("")}<button type="button" class="more-reactions" data-menu="expand" aria-label="Ещё реакции" aria-expanded="${expanded}">${icon("down")}</button>${expanded ? `<div class="reaction-extra">${extra.map(reaction).join("")}</div>` : ""}</div>
  <div class="message-menu-sheet"><div role="menu" aria-label="Сообщение">${actions.map(([a, i, t, ok]) => `<button type="button" role="menuitem" data-menu="${a}" ${ok ? "" : "disabled"}>${icon(i)}<span>${t}</span></button>`).join("")}</div><div class="message-menu-time">${icon(m.side === "out" && (m.status === "read" || m.status === "delivered") ? "checks" : "clock")}<time datetime="${esc(m.at)}">${when} в ${time(m.at)}</time></div></div>`;
    position();
  }
  function show(el, x, y) {
    const mid = el.closest("[data-mid]")?.dataset.mid;
    if (!message(mid)) return;
    close();
    origin = el;
    target = mid;
    anchor = { x, y };
    host.style.left = "0px";
    host.style.top = "0px";
    host.hidden = false;
    el.classList.add("context-active");
    paint();
    host
      .querySelector("[role=menuitem]:not(:disabled)")
      ?.focus({ preventScroll: true });
  }
  function resetSelection() {
    selected.clear();
    selectedChat = "";
    document.querySelector(".selection-bar")?.remove();
    document
      .querySelectorAll(".msg-selected")
      .forEach((el) => el.classList.remove("msg-selected"));
  }
  function sync() {
    if (!host.hidden) close();
    if (selectedChat !== active) {
      resetSelection();
      return;
    }
    for (const id of selected) if (!message(id)) selected.delete(id);
    document.querySelector(".selection-bar")?.remove();
    if (!selected.size) return;
    document
      .querySelectorAll("#thread [data-mid]")
      .forEach((el) =>
        el.classList.toggle("msg-selected", selected.has(el.dataset.mid)),
      );
    $("#chathead").insertAdjacentHTML(
      "afterend",
      `<div class="selection-bar"><b>Выбрано: ${selected.size}</b><button type="button" data-selection="copy">${icon("copy")}Копировать</button><button type="button" data-selection="cancel" aria-label="Снять выделение">${icon("close")}</button></div>`,
    );
  }
  function toggle(mid) {
    selectedChat = active;
    if (selected.has(mid)) {
      selected.delete(mid);
      bubble(mid)?.closest(".msg").classList.remove("msg-selected");
    } else selected.add(mid);
    sync();
  }
  async function copyText(text) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
      toast("Текст скопирован");
    } catch {
      modal(
        "Копировать текст",
        '<label class="formfield"><span>Нажмите Ctrl+C или выберите «Копировать»</span><textarea readonly id="copy-message-text"></textarea></label>',
      );
      const field = $("#copy-message-text");
      field.value = text;
      field.focus();
      field.select();
    }
  }
  async function change(chatId, mid, op, value) {
    const chat = state.chats.find((x) => x.id === chatId),
      m = chat?.messages.find((m) => m.id === mid);
    if (!m || !editable()) return;
    {
      await api("chats/" + encodeURIComponent(chatId) + "/messages", "PATCH", {
        id: mid,
        op,
        value,
      });
      await refresh();
    }
    render(false);
  }
  function editMessage(chatId, m) {
    modal(
      "Изменить текст в BeChat",
      `<form id="message-edit">${area("Текст сообщения", "text", m.text)}<p class="minor">Правка будет видна вам в истории BeChat.</p><button class="primary mspace" type="submit">Сохранить</button></form>`,
    );
    const form = $("#message-edit");
    form.querySelector("textarea").focus();
    form.addEventListener("submit", (e) => {
      e.preventDefault();
      const v = form.elements.text.value.trim();
      if (!v) {
        toast("Введите текст");
        return;
      }
      guarded(async () => {
        await change(chatId, m.id, "edit", v);
        closeModal();
      });
    });
  }
  function confirmHide(chatId, m) {
    modal(
      "Удалить сообщение?",
      `<p>Сообщение будет скрыто в вашей истории BeChat.</p><div class="message-confirm"><button type="button" data-act="close">Отмена</button><button type="button" class="primary" id="message-hide">Удалить у меня</button></div>`,
    );
    $("#message-hide").onclick = () =>
      guarded(async () => {
        await change(chatId, m.id, "hide", true);
        closeModal();
      });
  }
  async function forward(m) {
    const choices = state.chats.filter((x) => x.id !== active && !x.archived);
    modal(
      "Переслать в диалог",
      choices
        .map(
          (x) =>
            `<button type="button" class="modalbtn" data-destination="${esc(x.id)}">${avatar(x)}<span>${esc(x.name)}<small>${esc(x.channel)}</small></span></button>`,
        )
        .join("") || '<p class="minor">Нет других доступных диалогов.</p>',
    );
    const destButtons = $("#modalbody").querySelectorAll("[data-destination]");
    for (const b of destButtons)
      b.onclick = () =>
        guarded(async () => {
          destButtons.forEach((el) => (el.disabled = true));
          try {
            let file = null;
            if (m.file) {
              const f = m.file;
              let blob;
              {
                const res = await fetch(
                  "/api/files/" + encodeURIComponent(f.id),
                  { headers: { Authorization: "Bearer " + token } },
                );
                if (!res.ok) throw Error("Не удалось получить вложение");
                blob = await res.blob();
              }
              if (!blob) throw Error("Вложение недоступно");
              file = new File([blob], f.name, { type: f.type || blob.type });
            }
            const dest = b.dataset.destination,
              txt = [drafts[dest], m.text].filter(Boolean).join("\n\n");
            if (txt.length > 4000)
              throw Error("В черновике недостаточно места для пересылки");
            closeModal();
            openChat(dest);
            drafts[dest] = txt;
            attachment = file;
            renderCompose();
            $("#draft")?.focus();
            toast("Пересылка подготовлена к отправке");
          } finally {
            destButtons.forEach((el) => (el.disabled = false));
          }
        });
  }
  host.addEventListener("click", (e) =>
    guarded(async () => {
      const button = e.target.closest("button");
      if (!button || button.disabled) return;
      if (button.dataset.menu === "expand") {
        expanded = !expanded;
        paint();
        host.querySelector("[data-menu=expand]")?.focus();
        return;
      }
      const m = message(target),
        chatId = active;
      if (!m) return close();
      const action = button.dataset.menu,
        reaction = button.dataset.reaction;
      close(true);
      if (reaction) {
        await change(
          chatId,
          m.id,
          "reaction",
          m.reaction === reaction ? "" : reaction,
        );
        return;
      }
      if (action === "reply") {
        note = false;
        reply = preview(m).slice(0, 220);
        renderCompose();
        $("#draft")?.focus();
      }
      if (action === "edit") editMessage(chatId, m);
      if (action === "copy") await copyText(m.text);
      if (action === "pin")
        await patch({ pinMessage: c().pinMessage === m.id ? "" : m.id });
      if (action === "forward") await forward(m);
      if (action === "delete") confirmHide(chatId, m);
      if (action === "select") toggle(m.id);
    }),
  );
  const thread = $("#thread");
  thread.addEventListener("contextmenu", (e) => {
    const el = e.target.closest(".bubble");
    if (el) {
      e.preventDefault();
      clearTimeout(touchTimer);
      show(el, e.clientX, e.clientY);
    }
  });
  thread.addEventListener("keydown", (e) => {
    if (e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey)) {
      const el = e.target.closest(".bubble");
      if (!el) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      show(el, r.left + 20, r.top + 15);
    }
  });
  function cancelHold() {
    clearTimeout(touchTimer);
    touchPoint = null;
  }
  thread.addEventListener("pointerdown", (e) => {
    if (e.pointerType !== "touch") return;
    cancelHold();
    const el = e.target.closest(".bubble");
    if (!el) return;
    touchPoint = { x: e.clientX, y: e.clientY };
    touchTimer = setTimeout(() => show(el, e.clientX, e.clientY), 520);
  });
  thread.addEventListener("pointermove", (e) => {
    if (
      touchPoint &&
      Math.hypot(e.clientX - touchPoint.x, e.clientY - touchPoint.y) > 9
    )
      cancelHold();
  });
  for (const event of ["pointerup", "pointercancel"])
    thread.addEventListener(event, cancelHold);
  thread.addEventListener(
    "click",
    (e) => {
      const row = e.target.closest("[data-mid]");
      if (!row) return;
      if (!host.hidden || selected.size) {
        e.stopImmediatePropagation();
        e.preventDefault();
        if (host.hidden) toggle(row.dataset.mid);
        return;
      }
      if (e.target.closest(".message-reaction") && editable()) {
        guarded(() => change(active, row.dataset.mid, "reaction", ""));
        e.stopPropagation();
      }
    },
    true,
  );
  document.addEventListener("pointerdown", (e) => {
    if (!host.hidden && !host.contains(e.target)) close();
  });
  document.addEventListener("keydown", (e) => {
    if (host.hidden) {
      if (selected.size && e.key === "Escape" && !$("#modal").open)
        resetSelection();
      return;
    }
    if (e.key === "Escape") {
      e.preventDefault();
      close(true);
      return;
    }
    if (e.key === "Tab") {
      close(true);
      return;
    }
    if (
      ![
        "ArrowDown",
        "ArrowUp",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
      ].includes(e.key)
    )
      return;
    e.preventDefault();
    const buttons = [...host.querySelectorAll("button:not(:disabled)")],
      i = buttons.indexOf(document.activeElement);
    buttons[
      e.key === "Home"
        ? 0
        : e.key === "End"
          ? buttons.length - 1
          : (i +
              (["ArrowUp", "ArrowLeft"].includes(e.key) ? -1 : 1) +
              buttons.length) %
            buttons.length
    ].focus();
  });
  document.addEventListener("click", (e) => {
    const act = e.target.closest("[data-selection]")?.dataset.selection;
    if (act === "copy") {
      const txt = c()
        .messages.filter((m) => selected.has(m.id))
        .map(preview)
        .join("\n");
      guarded(() => copyText(txt));
    }
    if (act === "cancel") resetSelection();
  });
  thread.addEventListener(
    "scroll",
    () => {
      cancelHold();
      if (!host.hidden) close();
    },
    { passive: true },
  );
  window.addEventListener("resize", position);
  window.addEventListener("blur", () => close());
  return { sync };
})();
