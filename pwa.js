const installButtons = document.querySelectorAll("[data-install-app]");
let deferredInstallPrompt;

const installDialog = document.createElement("dialog");
installDialog.className = "install-dialog";
installDialog.setAttribute("aria-labelledby", "install-dialog-title");
installDialog.innerHTML = `
  <form method="dialog" class="install-dialog-close">
    <button type="submit" aria-label="Close installation instructions">×</button>
  </form>
  <span class="install-dialog-eyebrow">NORTHSTAR, ON YOUR HOME SCREEN</span>
  <h2 id="install-dialog-title"></h2>
  <p class="install-dialog-copy"></p>
  <ol class="install-dialog-steps"></ol>
`;
document.body.append(installDialog);

function setInstructions(title, message, steps = []) {
  installDialog.querySelector("#install-dialog-title").textContent = title;
  installDialog.querySelector(".install-dialog-copy").textContent = message;
  const list = installDialog.querySelector(".install-dialog-steps");
  list.replaceChildren(...steps.map((step) => {
    const item = document.createElement("li");
    item.textContent = step;
    return item;
  }));
  list.hidden = steps.length === 0;
  installDialog.showModal();
}

function hideInstallButtons() {
  installButtons.forEach((button) => { button.hidden = true; });
}

const isInstalled = window.matchMedia("(display-mode: standalone)").matches || window.navigator.standalone === true;
if (isInstalled) hideInstallButtons();

window.addEventListener("beforeinstallprompt", (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
});

window.addEventListener("appinstalled", () => {
  deferredInstallPrompt = null;
  hideInstallButtons();
});

installButtons.forEach((button) => {
  button.addEventListener("click", async () => {
    if (deferredInstallPrompt) {
      await deferredInstallPrompt.prompt();
      const choice = await deferredInstallPrompt.userChoice;
      if (choice.outcome === "accepted") hideInstallButtons();
      deferredInstallPrompt = null;
      return;
    }

    const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    if (!window.isSecureContext) {
      setInstructions(
        "Open Northstar over HTTPS first",
        "Phone installation requires Northstar to be published at a secure HTTPS address. A localhost address only works on the device running the server.",
      );
    } else if (isIOS) {
      setInstructions("Add Northstar to your Home Screen", "In Safari, use the Share menu to add the app to your iPhone or iPad Home Screen.", [
        "Open this website in Safari.",
        "Tap Share.",
        "Choose Add to Home Screen, then tap Add.",
      ]);
    } else {
      setInstructions("Install Northstar", "Add Northstar to your device for an app-like experience.", [
        "In Chrome, open the browser menu (⋮).",
        "Choose Install app or Add to Home screen.",
        "Confirm Install or Add.",
      ]);
    }
  });
});

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch((error) => {
      console.error("App installation support could not be enabled:", error);
    });
  });
}
