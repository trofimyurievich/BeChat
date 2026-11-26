define(["jquery"], function ($) {
  "use strict";
  return function BeChatWidget() {
    const self = this,
      ns = ".bechatWidget";
    function source(context) {
      let url;
      try {
        url = new URL(self.get_settings().service_url || "");
      } catch {
        return null;
      }
      if (url.protocol !== "https:" || url.username || url.password)
        return null;
      const target = new URL("/", url.origin);
      target.searchParams.set("embed", "1");
      if (context) {
        const card = location.pathname.match(
          /^\/(leads|contacts)\/detail\/(\d+)/,
        );
        if (card) {
          target.searchParams.set("entity", card[1]);
          target.searchParams.set("entityId", card[2]);
        }
      }
      return target.href;
    }
    const frames = new Set();
    function onIdentity(event) {
      const message = event.data;
      if (
        message?.type !== "bechat:sso:ready" ||
        !/^[-\\w]{43}$/.test(message.challenge || "") ||
        !/^[-\\w]{43}$/.test(message.nonce || "")
      )
        return;
      let match;
      for (const el of frames) {
        if (!el.isConnected) {
          frames.delete(el);
          continue;
        }
        if (
          event.source === el.contentWindow &&
          event.origin === new URL(el.src).origin
        ) {
          match = el;
          break;
        }
      }
      if (!match) return;
      const dest = event.origin,
        reply = (ticket) => {
          if (match.isConnected)
            event.source.postMessage(
              { type: "bechat:sso:result", nonce: message.nonce, ticket },
              dest,
            );
        };
      try {
        self
          .$authorizedAjax({
            url: dest + "/auth/widget",
            method: "POST",
            type: "POST",
            contentType: "application/json",
            dataType: "json",
            data: JSON.stringify({ challenge: message.challenge }),
          })
          .done((r) => reply(r.ticket))
          .fail(() => reply(null));
      } catch {
        reply(null);
      }
    }
    function frame(context) {
      const src = source(context);
      if (!src)
        return $("<p>").text(
          "Укажите HTTPS-адрес сервера BeChat в настройках интеграции.",
        );
      const result = $("<iframe>", {
        src,
        title: "BeChat — переписка",
        allow: "clipboard-write",
        referrerpolicy: "no-referrer",
      }).css({
        width: "100%",
        height: "100%",
        border: 0,
        background: "#03051c",
      });
      frames.add(result[0]);
      return result;
    }
    function leave() {
      document.querySelector("#bechat-dialog")?.close();
      $("#bechat-dialog").remove();
    }
    function show() {
      leave();
      const d = $("<dialog>", {
        id: "bechat-dialog",
        "aria-label": "Переписка BeChat",
      }).css({
        width: "min(1450px,95vw)",
        height: "min(900px,91vh)",
        padding: 0,
        background: "#03051c",
        border: "1px solid #1b3275",
        borderRadius: "14px",
        color: "#dee1f4",
        overflow: "hidden",
      });
      const close = $("<button>", { type: "button", text: "Закрыть ✕" })
        .css({
          height: 32,
          display: "block",
          marginLeft: "auto",
          padding: "0 12px",
          color: "#dee1f4",
          background: "transparent",
          border: 0,
          cursor: "pointer",
        })
        .on("click", leave);
      d.append(
        close,
        $("<div>").css({ height: "calc(100% - 32px)" }).append(frame(true)),
      ).appendTo("body");
      d[0].addEventListener("close", () => d.remove(), { once: true });
      d[0].showModal();
    }
    this.callbacks = {
      render: function () {
        if (/^\/(leads|contacts)\/detail\/\d+/.test(location.pathname)) {
          const crm = window.AMOCRM || window.APP;
          const account = String(crm?.constant("account")?.id || "");
          const employee = String(crm?.constant("user")?.id || "");
          const identifiers =
            /^\d+$/.test(account) && /^\d+$/.test(employee)
              ? '<details style="margin-top:10px"><summary>Данные для настройки</summary><div>ID аккаунта: ' +
                account +
                "</div><div>Мой ID в amoCRM: " +
                employee +
                "</div></details>"
              : "";
          self.render_template({
            caption: { class_name: "bechat-caption", html: "BeChat · BeQuick" },
            body: "",
            render:
              '<button type="button" class="bechat-open" style="padding:10px 16px;border:0;border-radius:9px;cursor:pointer;background:#1b3275;color:#dee1f4">Открыть переписку</button>' +
              identifiers,
          });
        }
        return true;
      },
      init: function () {
        window.addEventListener("message", onIdentity);
        return true;
      },
      bind_actions: function () {
        $(document)
          .off("click" + ns, ".bechat-open")
          .on("click" + ns, ".bechat-open", show);
        return true;
      },
      settings: function () {
        return true;
      },
      onSave: function () {
        return true;
      },
      advancedSettings: function () {
        $("#list_page_holder")
          .empty()
          .append(
            $("<div>", { class: "bechat-workspace" })
              .css({ height: "calc(100vh - 80px)", minHeight: 400 })
              .append(frame(false)),
          );
        return true;
      },
      destroy: function () {
        window.removeEventListener("message", onIdentity);
        frames.clear();
        $(document).off(ns);
        leave();
        $(".bechat-workspace").remove();
        return true;
      },
    };
    return this;
  };
});
