(() => {
  // AppKit represents Home as NSHomeFunctionKey (U+F729). It is a navigation
  // key, but WKWebView can also offer its private-use character as insertText.
  let homeDown = false;
  window.addEventListener("keydown", event => {
    homeDown = event.key === "Home" || event.code === "Home" || event.key === "\uF729";
  }, true);
  window.addEventListener("beforeinput", event => {
    if (homeDown && !event.isComposing && event.inputType === "insertText" && event.data === "\uF729") {
      event.preventDefault();
    }
  }, true);
  const reset = () => { homeDown = false; };
  window.addEventListener("keyup", reset, true);
  window.addEventListener("blur", reset);
})();
