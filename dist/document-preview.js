"use strict";
function previewType(file) {
  const ext = file.name?.split(".").at(-1).toLowerCase();
  if (["pdf", "docx"].includes(ext)) return ext;
  return (
    {
      "application/pdf": "pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
        "docx",
    }[file.mime || file.type] || ""
  );
}
const reader = document.querySelector("#file-preview"),
  scrollPane = document.querySelector("#viewer-scroll"),
  paperTray = document.querySelector("#viewer-content"),
  notice = document.querySelector("#viewer-status"),
  pageInput = document.querySelector("#viewer-page");
let opened = null;
function currentPreview(session) {
  return opened === session && reader.open;
}
function readerState(s, page, count, zoom) {
  if (!currentPreview(s)) return;
  s.page = page;
  s.count = count;
  s.zoom = zoom;
  if (document.activeElement !== pageInput) pageInput.value = page;
  pageInput.max = count;
  pageInput.disabled = false;
  document.querySelector("#viewer-total").textContent = "/ " + count;
  document.querySelector("#viewer-scale").textContent =
    Math.round(zoom * 100) + "%";
  for (const [action, disabled] of [
    ["prev", page <= 1],
    ["next", page >= count],
    ["minus", zoom <= 0.2],
    ["plus", zoom >= 3],
    ["fit", false],
  ])
    reader.querySelector('[data-view="' + action + '"]').disabled = disabled;
  notice.hidden = true;
}
function readerNotice(message, ask = false) {
  notice.hidden = false;
  notice.querySelector("p").textContent = message;
  const form = document.querySelector("#viewer-password");
  form.hidden = !ask;
  if (ask) {
    form.elements.password.value = "";
    form.elements.password.focus();
  }
}
function disposePreview() {
  const s = opened;
  opened = null;
  if (!s) return;
  s.abort.abort();
  s.cleanup?.();
  paperTray.replaceChildren();
  paperTray.removeAttribute("style");
  paperTray.className = "";
  document.querySelector("#viewer-password").reset();
  s.opener?.focus({ preventScroll: true });
}
function downloadBlob(blob, name) {
  const url = URL.createObjectURL(blob),
    a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 30000);
}
async function openDocument(file, opener) {
  if (window.webkit?.messageHandlers?.bechatIdentity && file.id && /\.(pdf|docx)$/i.test(file.name)) {
    window.webkit.messageHandlers.bechatIdentity.postMessage({type:"document",id:file.id,name:file.name});
    return;
  }
  const kind = previewType(file);
  if (!kind) return;
  if (opened) disposePreview();
  const s = {
    file,
    opener,
    page: 1,
    count: 0,
    zoom: 1,
    abort: new AbortController(),
  };
  opened = s;
  const download=document.querySelector("#viewer-download"); download.download=file.name;
  if(file.download) download.href=file.download; else download.removeAttribute("href");
  document.querySelector("#viewer-title").textContent = file.name;
  document.querySelector(".viewer-type").textContent = kind.toUpperCase();
  pageInput.value = "";
  pageInput.disabled = true;
  document.querySelector("#viewer-total").textContent = "/ —";
  document.querySelector("#viewer-scale").textContent = "";
  reader.querySelectorAll("[data-view]").forEach((b) => (b.disabled = true));
  readerNotice("Открываем документ…");
  reader.showModal();
  document.querySelector("#viewer-close").focus();
  try {
    s.blob = await attachmentBlob(file, s.abort.signal);
    if (!currentPreview(s)) return;
    const bytes = await s.blob.arrayBuffer();
    if (!currentPreview(s)) return;
    if (kind === "pdf") await openPdf(s, bytes);
    else openDocx(s, bytes);
  } catch (e) {
    if (currentPreview(s)) {
      readerNotice(
        e.name === "InvalidPDFException"
          ? "PDF повреждён или имеет другой формат."
          : e.message || "Не удалось открыть документ.",
      );
    }
  }
}
function openDocx(s, bytes) {
  const frame = document.createElement("iframe");
  frame.className = "viewer-docx";
  frame.title = s.file.name;
  frame.setAttribute("sandbox", "allow-scripts");
  frame.src = "docx-frame.html";
  const channel = new MessageChannel();
  s.cleanup = () => channel.port1.close();
  channel.port1.onmessage = ({ data }) => {
    if (!currentPreview(s)) return;
    if (data.type === "state") readerState(s, data.page, data.count, data.zoom);
    if (data.type === "error") readerNotice(data.message);
    if (data.type === "close") reader.close();
  };
  s.goto = (n) => channel.port1.postMessage({ type: "page", n });
  s.setZoom = (value) => channel.port1.postMessage({ type: "zoom", value });
  frame.addEventListener(
    "load",
    () => {
      if (currentPreview(s))
        frame.contentWindow.postMessage({ type: "open-docx", bytes }, "*", [
          channel.port2,
          bytes,
        ]);
    },
    { once: true },
  );
  paperTray.style.height = "100%";
  paperTray.replaceChildren(frame);
}
async function openPdf(s, bytes) {
  const pdfjs = await import("./assets/pdf-reader.js");
  if (!currentPreview(s)) return;
  const resources = new URL("assets/", document.baseURI).href;
  pdfjs.GlobalWorkerOptions.workerSrc = resources + "pdf-worker.js";
  const loading = pdfjs.getDocument({
    data: bytes,
    cMapUrl: resources,
    cMapPacked: true,
    standardFontDataUrl: resources,
    wasmUrl: resources,
    iccUrl: resources,
    isEvalSupported: false,
    enableXfa: false,
    maxImageSize: 32 * 1024 * 1024,
  });
  loading.onPassword = (resume, reason) => {
    if (currentPreview(s)) {
      s.unlock = resume;
      readerNotice(
        reason === 2
          ? "Пароль не подошёл. Попробуйте ещё раз."
          : "Для просмотра PDF введите пароль.",
        true,
      );
    }
  };
  let observer,
    resize,
    raf = 0;
  const sheets = [],
    visible = new Set();
  s.cleanup = () => {
    observer?.disconnect();
    resize?.disconnect();
    cancelAnimationFrame(raf);
    for (const sheet of sheets) sheet.task?.cancel();
    loading.destroy().catch(() => {});
  };
  const doc = await loading.promise;
  if (!currentPreview(s)) return;
  const first = await doc.getPage(1);
  if (!currentPreview(s)) return;
  const base = first.getViewport({ scale: 96 / 72 });
  let mode = "fit",
    scale = 1,
    largest = base.width,
    usable = 0;
  paperTray.className = "pdf-pages";
  function dimensions(item) {
    item.el.style.width = Math.round(item.w * scale) + "px";
    item.el.style.height = Math.round(item.h * scale) + "px";
  }
  function trayWidth() {
    paperTray.style.width =
      Math.max(scrollPane.clientWidth, Math.ceil(largest * scale) + 24) + "px";
  }
  function getTop(el) {
    return (
      scrollPane.scrollTop +
      el.getBoundingClientRect().top -
      scrollPane.getBoundingClientRect().top
    );
  }
  function goto(n) {
    if (!currentPreview(s)) return;
    const sheet = sheets[Math.max(0, Math.min(n - 1, sheets.length - 1))];
    if (sheet) scrollPane.scrollTop = getTop(sheet.el) - 12;
  }
  function sync() {
    if (!currentPreview(s)) return;
    let a = 0,
      b = sheets.length - 1;
    while (a < b) {
      const n = Math.ceil((a + b) / 2);
      if (
        getTop(sheets[n].el) <=
        scrollPane.scrollTop + Math.min(120, scrollPane.clientHeight / 3)
      )
        a = n;
      else b = n - 1;
    }
    readerState(
      s,
      scrollPane.scrollTop > 0 &&
        scrollPane.scrollTop + scrollPane.clientHeight >=
          scrollPane.scrollHeight - 2
        ? sheets.length
        : a + 1,
      sheets.length,
      scale,
    );
  }
  function release(item) {
    item.seq++;
    item.task?.cancel();
    item.task = null;
    item.el.replaceChildren();
    item.drawn = 0;
  }
  async function draw(item) {
    if (!currentPreview(s) || item.drawn === scale) return;
    release(item);
    const seq = item.seq,
      at = scale;
    item.drawn = at;
    try {
      const page = await doc.getPage(item.n);
      if (!currentPreview(s) || seq !== item.seq) return;
      const size = page.getViewport({ scale: 96 / 72 });
      item.w = size.width;
      item.h = size.height;
      largest = Math.max(largest, item.w);
      dimensions(item);
      trayWidth();
      const view = page.getViewport({ scale: (at * 96) / 72 }),
        density = Math.min(
          devicePixelRatio || 1,
          2,
          8192 / Math.max(view.width, view.height),
          Math.sqrt(8500000 / (view.width * view.height)),
        );
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.ceil(view.width * density));
      canvas.height = Math.max(1, Math.ceil(view.height * density));
      item.el.replaceChildren(canvas);
      item.task = page.render({
        canvas,
        canvasContext: canvas.getContext("2d"),
        viewport: view,
        transform: [density, 0, 0, density, 0, 0],
      });
      await item.task.promise;
    } catch (e) {
      if (
        currentPreview(s) &&
        seq === item.seq &&
        e.name !== "RenderingCancelledException"
      ) {
        item.el.textContent = "Не удалось показать страницу " + item.n;
        item.el.style.color = "#18264b";
      }
    }
  }
  function layout(keep = true) {
    if (!currentPreview(s)) return;
    const anchor = s.page;
    usable = scrollPane.clientWidth;
    scale =
      mode === "fit"
        ? Math.min(1.6, Math.max(0.08, (usable - 24) / base.width))
        : mode;
    sheets.forEach(dimensions);
    trayWidth();
    if (keep) goto(anchor);
    visible.forEach(draw);
    sync();
  }
  for (let i = 1; i <= doc.numPages; i++) {
    const el = document.createElement("section");
    el.className = "pdf-sheet";
    el.setAttribute("aria-label", "Страница " + i);
    el.dataset.page = i;
    const item = { el, n: i, w: base.width, h: base.height, seq: 0, drawn: 0 };
    sheets.push(item);
    paperTray.append(el);
  }
  observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        const item = sheets[Number(entry.target.dataset.page) - 1];
        if (entry.isIntersecting) {
          visible.add(item);
          draw(item);
        } else {
          visible.delete(item);
          release(item);
        }
      }
    },
    { root: scrollPane, rootMargin: "350px 0px" },
  );
  s.goto = goto;
  s.setZoom = (value) => {
    mode = value;
    layout();
  };
  layout(false);
  sheets.forEach((item) => observer.observe(item.el));
  scrollPane.scrollTop = 0;
  resize = new ResizeObserver(() => {
    if (Math.abs(usable - scrollPane.clientWidth) > 1) layout();
  });
  resize.observe(scrollPane);
  scrollPane.addEventListener(
    "scroll",
    () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(sync);
    },
    { passive: true, signal: s.abort.signal },
  );
}
reader.addEventListener("close", disposePreview);
document.querySelector("#viewer-close").onclick = () => reader.close();
document.querySelector("#viewer-download").onclick = (e) => {
  const id=opened?.file?.id;
  const fresh=id && c()?.messages.flatMap(m=>m.files || (m.file?[m.file]:[])).find(f=>f.id===id);
  if(fresh?.download) {e.currentTarget.href=fresh.download;return;}
  if(e.currentTarget.hasAttribute("href")) return;
  e.preventDefault();
  guarded(async () => {
    const s = opened;
    if (s) {
      const blob = s.blob || (await attachmentBlob(s.file, s.abort.signal));
      if (currentPreview(s)) downloadBlob(blob, s.file.name);
    }
  });
};
document.querySelector("#viewer-password").onsubmit = (e) => {
  e.preventDefault();
  if (opened?.unlock) {
    const pw = e.target.elements.password.value;
    readerNotice("Открываем документ…");
    opened.unlock(pw);
  }
};
function viewAction(action) {
  const s = opened;
  if (!s?.count) return;
  if (action === "prev" || action === "next")
    s.goto(
      Math.max(1, Math.min(s.count, s.page + (action === "next" ? 1 : -1))),
    );
  else
    s.setZoom(
      action === "fit"
        ? "fit"
        : Math.min(
            3,
            Math.max(
              0.2,
              Math.round((s.zoom + (action === "plus" ? 0.25 : -0.25)) * 100) /
                100,
            ),
          ),
    );
}
reader
  .querySelectorAll("[data-view]")
  .forEach((b) => (b.onclick = () => viewAction(b.dataset.view)));
function jumpToInput() {
  const s = opened;
  if (!s?.count) return;
  const n = Math.trunc(Number(pageInput.value));
  pageInput.value = n >= 1 && n <= s.count ? n : s.page;
  s.goto(Number(pageInput.value));
}
pageInput.onchange = jumpToInput;
pageInput.onkeydown = (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    jumpToInput();
    pageInput.blur();
  }
};
reader.addEventListener("keydown", (e) => {
  if (e.key === "Escape" || e.key === "Tab") return;
  if (e.target.tagName === "INPUT") return;
  const action = {
    ArrowRight: "next",
    ArrowLeft: "prev",
    "+": "plus",
    "-": "minus",
    0: "fit",
  }[e.key];
  if (action) {
    e.preventDefault();
    viewAction(action);
  }
  e.stopPropagation();
});
