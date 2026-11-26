class ChannelPicker extends HTMLElement {
  connectedCallback() {
    this.control = this.querySelector("[role=combobox]");
    this.list = this.querySelector("[role=listbox]");
    this.options = [...this.list.querySelectorAll("[role=option]")];
    this.input = this.querySelector("input");
    this.addEventListener("pointerdown", this.keepFocus);
    this.addEventListener("click", this.onClick);
    this.addEventListener("keydown", this.onKey);
    this.addEventListener("focusout", this.onBlur);
    document.addEventListener("pointerdown", this.onOutside, true);
  }
  disconnectedCallback() {
    this.removeEventListener("pointerdown", this.keepFocus);
    this.removeEventListener("click", this.onClick);
    this.removeEventListener("keydown", this.onKey);
    this.removeEventListener("focusout", this.onBlur);
    document.removeEventListener("pointerdown", this.onOutside, true);
  }
  keepFocus = (event) => {
    if (event.target.closest("[role=option]")) event.preventDefault();
  };
  onOutside = (event) => {
    if (!this.contains(event.target)) this.close();
  };
  onBlur = (event) => {
    if (!this.contains(event.relatedTarget)) this.close();
  };
  onClick = (event) => {
    const option = event.target.closest("[role=option]");
    if (option) {
      this.choose(this.options.indexOf(option));
      return;
    }
    if (this.control.contains(event.target)) {
      if (this.list.hidden) this.open();
      else this.close();
    }
  };
  onKey = (event) => {
    if (event.target !== this.control) return;
    const key = event.key;
    if (key === "Tab") {
      this.close();
      return;
    }
    if (key === "Escape" && !this.list.hidden) {
      event.preventDefault();
      event.stopPropagation();
      this.close();
      return;
    }
    if (!["Enter", " ", "ArrowDown", "ArrowUp", "Home", "End"].includes(key))
      return;
    event.preventDefault();
    if (this.list.hidden) {
      this.open();
      if (key === "End") this.highlight(this.options.length - 1);
      else if (key === "Home") this.highlight(0);
      return;
    }
    if (key === " " || key === "Enter") {
      this.choose(this.index);
      return;
    }
    if (key === "Home") {
      this.highlight(0);
      return;
    }
    if (key === "End") {
      this.highlight(this.options.length - 1);
      return;
    }
    this.highlight(
      (this.index + (key === "ArrowDown" ? 1 : -1) + this.options.length) %
        this.options.length,
    );
  };
  open() {
    this.list.hidden = false;
    const panel = this.closest("dialog").getBoundingClientRect();
    this.classList.toggle(
      "above",
      panel.bottom - this.control.getBoundingClientRect().bottom <
        this.list.offsetHeight + 12 &&
        this.control.getBoundingClientRect().top - panel.top >
          this.list.offsetHeight,
    );
    this.control.setAttribute("aria-expanded", "true");
    this.highlight(Number(this.input.value));
  }
  close() {
    this.list.hidden = true;
    this.control.setAttribute("aria-expanded", "false");
    this.control.removeAttribute("aria-activedescendant");
  }
  highlight(i) {
    this.index = i;
    this.options.forEach((node, k) =>
      node.classList.toggle("current", k === i),
    );
    this.control.setAttribute("aria-activedescendant", this.options[i].id);
  }
  choose(i) {
    const option = this.options[i];
    if (!option) return;
    this.input.value = String(i);
    this.options.forEach((node, k) =>
      node.setAttribute("aria-selected", String(k === i)),
    );
    this.control
      .querySelector(".channel-value")
      .replaceChildren(
        ...[...option.querySelector(".channel-value").childNodes].map((node) =>
          node.cloneNode(true),
        ),
      );
    this.close();
    this.control.focus();
    this.input.dispatchEvent(new Event("change", { bubbles: true }));
  }
}
customElements.define("bechat-channel-picker", ChannelPicker);
function channelSelector(channels) {
  const value = (name) =>
    `<span class="channel-value">${icon(chIcon(name))}<span>${esc(name)}</span></span>`;
  return `<div class="formfield"><span id="channel-label">Канал</span>
 <bechat-channel-picker><input type="hidden" name="channel" value="0">
 <button type="button" class="channel-control" role="combobox" aria-expanded="false" aria-haspopup="listbox" aria-labelledby="channel-label selected-channel" aria-controls="channel-list"><span id="selected-channel">${value(channels[0])}</span>${icon("down")}</button>
 <div role="listbox" id="channel-list" aria-labelledby="channel-label" hidden>${channels.map((name, i) => `<div role="option" id="channel-option-${i}" aria-selected="${i === 0}">${value(name)}<span class="chosen">${icon("check")}</span></div>`).join("")}</div>
 </bechat-channel-picker></div>`;
}
