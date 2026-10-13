const form = document.querySelector("#auth-form");
const tabs = document.querySelector(".auth-tabs");
const fields = {
  name: document.querySelector("#name"),
  email: document.querySelector("#email"),
  password: document.querySelector("#password"),
  confirm: document.querySelector("#confirm-password"),
};
const notice = document.querySelector("#notice");
const submitButton = document.querySelector("#submit-button");
let mode = "login";

function authDestination(user) {
  const requested = new URLSearchParams(window.location.search).get("next");
  if (user.isAdmin && (requested === "/owner" || requested === "/admin")) return requested;
  if (requested === "/dashboard") return requested;
  return "/dashboard";
}

const passwordChecks = {
  length: (value) => value.length >= 10,
  upper: (value) => /[A-Z]/.test(value),
  lower: (value) => /[a-z]/.test(value),
  number: (value) => /\d/.test(value),
  special: (value) => /[^A-Za-z0-9]/.test(value),
};

function setMode(nextMode) {
  mode = nextMode;
  const isSignup = mode === "signup";
  const activeTab = document.querySelector(`#${mode}-tab`);
  tabs.dataset.mode = mode;
  document.querySelectorAll(".auth-tab").forEach((tab) => {
    const active = tab === activeTab;
    tab.classList.toggle("is-active", active);
    tab.setAttribute("aria-selected", String(active));
  });
  document.querySelector("#heading-eyebrow").textContent = isSignup ? "A FRESH START" : "YOUR NEXT CHAPTER";
  document.querySelector("#form-title").textContent = isSignup ? "Create your account" : "Welcome back";
  document.querySelector("#form-subtitle").textContent = isSignup
    ? "A few details and you’ll be on your way."
    : "Sign in to pick up where you left off.";
  document.querySelector("#submit-label").textContent = isSignup ? "Create account" : "Sign in";
  document.querySelector("#name-field").hidden = !isSignup;
  document.querySelector("#confirm-field").hidden = !isSignup;
  document.querySelector("#password-rules").hidden = !isSignup;
  document.querySelector("#remember-row").hidden = isSignup;
  document.querySelector("#forgot-password").hidden = isSignup;
  const switchPrompt = document.querySelector("#switch-prompt");
  const switchButton = document.createElement("button");
  switchButton.className = "text-button";
  switchButton.type = "button";
  switchButton.dataset.switch = isSignup ? "login" : "signup";
  switchButton.textContent = isSignup ? "Sign in" : "Create an account";
  switchPrompt.replaceChildren(
    document.createTextNode(isSignup ? "Already have an account? " : "New to Northstar? "),
    switchButton,
  );
  fields.password.autocomplete = isSignup ? "new-password" : "current-password";
  clearErrors();
  hideNotice();
}

function setFieldError(name, message) {
  const input = fields[name];
  const errorName = name === "confirm" ? "confirm" : name;
  document.querySelector(`#${errorName}-error`).textContent = message;
  input.closest(".input-wrap").classList.toggle("has-error", Boolean(message));
  input.setAttribute("aria-invalid", String(Boolean(message)));
}

function clearErrors() {
  ["name", "email", "password", "confirm"].forEach((name) => setFieldError(name, ""));
}

function showNotice(message, type = "error") {
  notice.textContent = message;
  notice.hidden = false;
  notice.className = `notice is-${type}`;
}

function hideNotice() {
  notice.hidden = true;
  notice.textContent = "";
  notice.className = "notice";
}

function validate() {
  clearErrors();
  let valid = true;
  const email = fields.email.value.trim();
  const password = fields.password.value;

  if (mode === "signup" && fields.name.value.trim().length < 2) {
    setFieldError("name", "Please enter a name with at least 2 characters.");
    valid = false;
  }
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
    setFieldError("email", "Enter a valid email address.");
    valid = false;
  }
  if (mode === "signup") {
    const missing = Object.entries(passwordChecks).filter(([, check]) => !check(password));
    if (missing.length) {
      setFieldError("password", "Your password does not meet all the requirements yet.");
      valid = false;
    }
    if (fields.confirm.value !== password) {
      setFieldError("confirm", "The passwords do not match.");
      valid = false;
    }
  } else if (!password) {
    setFieldError("password", "Enter your password.");
    valid = false;
  }
  return valid;
}

function updatePasswordRules() {
  const value = fields.password.value;
  Object.entries(passwordChecks).forEach(([rule, check]) => {
    document.querySelector(`[data-rule="${rule}"]`).classList.toggle("is-valid", check(value));
  });
}

async function submitForm(event) {
  event.preventDefault();
  hideNotice();
  if (!validate()) return;

  submitButton.disabled = true;
  submitButton.classList.add("is-loading");
  try {
    const payload = {
      email: fields.email.value.trim(),
      password: fields.password.value,
      remember: mode === "login" && document.querySelector("#remember").checked,
    };
    if (mode === "signup") payload.name = fields.name.value.trim();

    const response = await fetch(`/api/${mode}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "same-origin",
      body: JSON.stringify(payload),
    });
    const result = await response.json();
    if (!response.ok) {
      if (result.fieldErrors) {
        Object.entries(result.fieldErrors).forEach(([name, message]) => {
          if (name in fields) setFieldError(name, message);
        });
      }
      showNotice(result.error || "Something went wrong. Please try again.");
      return;
    }

    window.location.assign(authDestination(result.user || {}));
  } catch {
    showNotice("Could not reach the server. Check your connection and try again.");
  } finally {
    submitButton.disabled = false;
    submitButton.classList.remove("is-loading");
  }
}

tabs.addEventListener("click", (event) => {
  const tab = event.target.closest("[data-mode]");
  if (tab) setMode(tab.dataset.mode);
});

document.addEventListener("click", (event) => {
  const switchButton = event.target.closest("[data-switch]");
  if (switchButton) setMode(switchButton.dataset.switch);
});

form.addEventListener("submit", submitForm);
fields.password.addEventListener("input", () => {
  updatePasswordRules();
  if (fields.password.value) setFieldError("password", "");
});

document.querySelector(".password-toggle").addEventListener("click", (event) => {
  const button = event.currentTarget;
  const showing = fields.password.type === "text";
  fields.password.type = showing ? "password" : "text";
  button.setAttribute("aria-pressed", String(!showing));
  button.setAttribute("aria-label", showing ? "Show password" : "Hide password");
});

document.querySelector("#forgot-password").addEventListener("click", () => {
  showNotice("Password reset isn’t set up yet. Please contact your administrator for help.", "success");
});

if (window.location.pathname === "/signup" || new URLSearchParams(window.location.search).get("mode") === "signup") {
  setMode("signup");
}

async function restoreSession() {
  try {
    const response = await fetch("/api/session", { credentials: "same-origin" });
    if (!response.ok) throw new Error("Session lookup failed");
    const result = await response.json();
    if (result.user) {
      window.location.assign(authDestination(result.user));
    }
  } catch {
    showNotice("We couldn’t check your sign-in status. Refresh the page to try again.");
  }
}

restoreSession();
