"use strict";
function setBeChatTheme(value, persist = false) {
  const theme = value === "light" ? "light" : "dark";
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]').content =
    theme === "light" ? "#dee1f4" : "#03051c";
  if (persist)
    try {
      localStorage.setItem("bechat-theme", theme);
    } catch {}
}
try {
  setBeChatTheme(localStorage.getItem("bechat-theme"));
} catch {
  setBeChatTheme("dark");
}
document.addEventListener("change", (event) => {
  if (event.target.name === "bechat-theme")
    setBeChatTheme(event.target.value, true);
});
function themeOptions() {
  return (
    '<fieldset class="theme-choice"><legend>Тема оформления</legend>' +
    [
      ["light", "Светлая"],
      ["dark", "Тёмная"],
    ]
      .map(
        ([value, label]) =>
          '<label><input type="radio" name="bechat-theme" value="' +
          value +
          '" ' +
          (document.documentElement.dataset.theme === value ? "checked" : "") +
          "><span>" +
          label +
          "</span></label>",
      )
      .join("") +
    "</fieldset>"
  );
}
