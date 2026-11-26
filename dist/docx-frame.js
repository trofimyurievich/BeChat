"use strict";
window.addEventListener("message", async function init(event) {
  if (
    event.source !== parent ||
    event.data?.type !== "open-docx" ||
    !event.ports[0]
  )
    return;
  window.removeEventListener("message", init);
  const port = event.ports[0],
    paper = document.querySelector("#paper"),
    stage = document.querySelector("#stage");
  let pages = [],
    stops = [],
    mode = "fit",
    zoom = 1,
    nativeWidth = 1,
    frame = 0,
    current = 1;
  function sync() {
    if (!stops.length) return;
    let low = 0,
      high = stops.length - 1;
    while (low < high) {
      const m = Math.ceil((low + high) / 2);
      if (stops[m] <= scrollY + Math.min(120, innerHeight * 0.25)) low = m;
      else high = m - 1;
    }
    current =
      scrollY > 0 &&
      scrollY + innerHeight >= document.documentElement.scrollHeight - 2
        ? stops.length
        : low + 1;
    port.postMessage({
      type: "state",
      page: current,
      count: stops.length,
      zoom,
    });
  }
  function goto(n) {
    const dest = stops[Math.max(0, Math.min(stops.length - 1, n - 1))];
    if (Number.isFinite(dest)) scrollTo({ top: dest - 12 });
  }
  function layout(keep = true) {
    const first = current;
    zoom =
      mode === "fit"
        ? Math.min(
            1.6,
            Math.max(
              0.08,
              (document.documentElement.clientWidth - 24) / nativeWidth,
            ),
          )
        : Number(mode);
    paper.style.zoom = zoom;
    stage.style.minWidth = Math.ceil(nativeWidth * zoom + 20) + "px";
    stops = [];
    for (const page of pages) {
      const start = scrollY + page.getBoundingClientRect().top,
        base =
          parseFloat(getComputedStyle(page).minHeight) || page.offsetHeight;
      const count = Math.max(
        1,
        Math.ceil((page.offsetHeight - 2) / Math.max(1, base)),
      );
      for (let i = 0; i < count; i++) stops.push(start + i * base * zoom);
    }
    if (keep) goto(first);
    sync();
  }
  port.onmessage = (e) => {
    if (e.data.type === "page") goto(e.data.n);
    if (e.data.type === "zoom") {
      mode = e.data.value;
      layout();
    }
  };
  try {
    const archive = await JSZip.loadAsync(event.data.bytes);
    const entries = Object.values(archive.files);
    if (
      !archive.file("word/document.xml") ||
      entries.length > 5000 ||
      entries.reduce((t, f) => t + (f._data?.uncompressedSize || 0), 0) >
        100 * 1024 * 1024
    )
      throw Error(
        "Не удалось прочитать структуру DOCX или документ слишком большой",
      );
    await docx.renderAsync(event.data.bytes, paper, paper, {
      breakPages: true,
      ignoreLastRenderedPageBreak: false,
      renderAltChunks: false,
      renderComments: false,
      renderChanges: false,
      useBase64URL: true,
    });
    pages = [...paper.querySelectorAll(".docx-wrapper>section")];
    if (!pages.length) throw Error("В документе нет страниц для просмотра");
    paper.querySelectorAll("a").forEach((a) => a.removeAttribute("href"));
    nativeWidth = Math.max(...pages.map((p) => p.offsetWidth));
    layout(false);
    addEventListener(
      "scroll",
      () => {
        cancelAnimationFrame(frame);
        frame = requestAnimationFrame(sync);
      },
      { passive: true },
    );
    addEventListener("resize", () => layout());
    addEventListener("keydown", (e) => {
      if (e.key === "Escape") {
        e.preventDefault();
        port.postMessage({ type: "close" });
      } else if (["ArrowRight", "ArrowLeft"].includes(e.key)) {
        e.preventDefault();
        goto(current + (e.key === "ArrowRight" ? 1 : -1));
      }
    });
  } catch {
    port.postMessage({
      type: "error",
      message:
        "Не удалось открыть DOCX. Проверьте, что файл исправен и не защищён паролем.",
    });
  }
});
