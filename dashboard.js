const dashboard = {
  tasks: [],
  activities: [],
  usage: {},
  summary: {},
  user: null,
  filter: "open",
  taskCounts: { active: 0, completed: 0 },
  taskHasMore: false,
};

const notice = document.querySelector("#dashboard-notice");
const taskDialog = document.querySelector("#task-dialog");
const activityDialog = document.querySelector("#activity-dialog");
const billingDialog = document.querySelector("#billing-dialog");

function showNotice(message, type = "error") {
  notice.textContent = message;
  notice.hidden = false;
  notice.className = `notice is-${type}`;
  notice.scrollIntoView({ behavior: "smooth", block: "nearest" });
}

function hideNotice() {
  notice.hidden = true;
  notice.textContent = "";
  notice.className = "notice";
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    credentials: "same-origin",
    ...options,
    headers: { ...(options.body ? { "Content-Type": "application/json" } : {}), ...options.headers },
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.error || "Something went wrong. Please try again.");
    error.status = response.status;
    error.code = result.code;
    error.fieldErrors = result.fieldErrors;
    throw error;
  }
  return result;
}

function textElement(tag, className, text) {
  const element = document.createElement(tag);
  element.className = className;
  element.textContent = text;
  return element;
}

function formatShortDate(dateString) {
  if (!dateString) return "No due date";
  const date = new Date(`${dateString}T00:00:00`);
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  if (date.getTime() === today.getTime()) return "Today";
  if (date.getTime() === tomorrow.getTime()) return "Tomorrow";
  return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
}

function formatAgendaDate(timestamp) {
  return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" }).format(new Date(timestamp));
}

function renderTasks() {
  const visibleTasks = dashboard.tasks;
  const taskList = document.querySelector("#task-list");
  taskList.replaceChildren();
  document.querySelector("#nav-task-count").textContent = String(dashboard.taskCounts.active);
  document.querySelector("#filter-open-count").textContent = String(dashboard.taskCounts.active);
  document.querySelector("#filter-done-count").textContent = String(dashboard.taskCounts.completed);
  document.querySelector("#task-footer-count").textContent = `${dashboard.taskCounts.completed} completed · showing ${visibleTasks.length}`;
  document.querySelector("#load-more-tasks").hidden = !dashboard.taskHasMore;
  document.querySelectorAll("[data-filter]").forEach((button) => button.classList.toggle("active", button.dataset.filter === dashboard.filter));

  if (!visibleTasks.length) {
    document.querySelector("#task-empty").hidden = false;
    document.querySelector("#task-empty b").textContent = dashboard.filter === "open" ? "A little breathing room." : "Your next small win is waiting.";
    document.querySelector("#task-empty p").textContent = dashboard.filter === "open"
      ? "No tasks here yet. Add one small next step to get started."
      : "Finished tasks will find a home here. Keep going at your own pace.";
    return;
  }
  document.querySelector("#task-empty").hidden = true;
  visibleTasks.forEach((task) => {
    const row = document.createElement("article");
    row.className = `task-row${task.completed ? " is-completed" : ""}`;
    const complete = document.createElement("button");
    complete.className = "task-complete";
    complete.type = "button";
    complete.setAttribute("aria-label", task.completed ? `Mark ${task.title} as to do` : `Complete ${task.title}`);
    complete.setAttribute("aria-pressed", String(task.completed));
    complete.textContent = task.completed ? "✓" : "";
    complete.addEventListener("click", () => updateTask(task.id, { completed: !task.completed }));

    const details = document.createElement("div");
    details.className = "task-details";
    details.append(textElement("b", "task-title", task.title));
    const meta = document.createElement("span");
    meta.className = "task-meta";
    const date = textElement("span", "task-date", task.completed ? "Nicely done" : formatShortDate(task.dueDate));
    const dot = textElement("i", `priority-dot priority-${task.priority}`, "");
    const priority = textElement("span", "priority-label", task.priority === "high" ? "Important" : task.priority === "low" ? "Whenever" : "Normal");
    meta.append(date, dot, priority);
    details.append(meta);
    const remove = document.createElement("button");
    remove.className = "task-remove";
    remove.type = "button";
    remove.textContent = "×";
    remove.setAttribute("aria-label", `Delete ${task.title}`);
    remove.addEventListener("click", () => deleteTask(task.id));
    row.append(complete, details, remove);
    taskList.append(row);
  });
}

function renderActivities() {
  const activityList = document.querySelector("#activity-list");
  activityList.replaceChildren();
  const now = Date.now();
  const upcoming = dashboard.activities.filter((activity) => activity.endsAt > now);
  document.querySelector("#activity-empty").hidden = upcoming.length > 0;
  document.querySelector("#activity-list").hidden = upcoming.length === 0;
  upcoming.slice(0, 4).forEach((activity) => {
    const row = document.createElement("article");
    row.className = `activity-row kind-${activity.kind}`;
    const icon = textElement("span", "activity-kind-icon", ({ club: "✳", sport: "◉", class: "▤", study: "✦", break: "☼", other: "•" })[activity.kind]);
    const detail = document.createElement("div");
    detail.className = "activity-details";
    detail.append(textElement("b", "activity-title", activity.title));
    detail.append(textElement("small", "", `${formatAgendaDate(activity.startsAt)} · ${new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(activity.startsAt))}`));
    const remove = document.createElement("button");
    remove.className = "activity-remove";
    remove.type = "button";
    remove.setAttribute("aria-label", `Remove ${activity.title}`);
    remove.textContent = "×";
    remove.addEventListener("click", () => deleteActivity(activity.id));
    row.append(icon, detail, remove);
    activityList.append(row);
  });
}

function renderWeek() {
  const container = document.querySelector("#week-days");
  container.replaceChildren();
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  document.querySelector("#week-date").textContent = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(today);
  const dates = Array.from({ length: 7 }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() + index);
    return date;
  });
  dates.forEach((date) => {
    const button = document.createElement("div");
    button.className = `week-day${date.getTime() === today.getTime() ? " is-today" : ""}`;
    button.append(textElement("span", "week-day-name", new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(date)));
    button.append(textElement("b", "week-day-number", String(date.getDate())));
    const dot = document.createElement("i");
    if (dashboard.activities.some((activity) => new Date(activity.startsAt).toDateString() === date.toDateString())) dot.className = "has-event";
    button.append(dot);
    container.append(button);
  });

  const agenda = document.querySelector("#week-agenda");
  agenda.replaceChildren();
  const nextActivity = dashboard.activities.find((activity) => activity.endsAt > Date.now());
  if (!nextActivity) {
    agenda.append(textElement("p", "agenda-empty", "A little open space. Add a class, study session, or something fun."));
    return;
  }
  const row = document.createElement("div");
  row.className = `agenda-feature kind-${nextActivity.kind}`;
  row.append(textElement("span", "agenda-time", new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(nextActivity.startsAt))));
  const detail = document.createElement("div");
  detail.append(textElement("b", "agenda-title", nextActivity.title));
  detail.append(textElement("small", "", `${formatAgendaDate(nextActivity.startsAt)} · ${nextActivity.kind}`));
  row.append(detail);
  agenda.append(row);
  const task = dashboard.tasks.find((item) => !item.completed && item.dueDate);
  if (task) agenda.append(textElement("p", "agenda-next-task", `A next step: ${task.title} · ${formatShortDate(task.dueDate)}`));
}

function renderDashboard() {
  const { user, tasks, activities, usage, summary } = dashboard;
  const name = user.name.split(/\s+/)[0];
  const hour = new Date().getHours();
  const greeting = hour < 12 ? "A FRESH MORNING AWAITS" : hour < 17 ? "A LITTLE SPACE TO FOCUS" : "YOU DID ENOUGH FOR TODAY";
  document.querySelector("#greeting-eyebrow").textContent = greeting;
  document.querySelector("#greeting").textContent = `${hour >= 17 ? "Easy does it," : "You’ve got this,"} ${name}.`;
  document.querySelector("#profile-name").textContent = user.name;
  document.querySelector("#profile-plan").textContent = user.plan === "plus" ? "Northstar Plus" : "Free plan";
  document.querySelector("#profile-avatar").textContent = name.charAt(0).toUpperCase();
  document.querySelector("#top-avatar").textContent = name.charAt(0).toUpperCase();
  document.querySelector("#today-label").textContent = new Intl.DateTimeFormat(undefined, { weekday: "long", month: "short", day: "numeric" }).format(new Date());
  document.querySelector("#stat-open").textContent = String(usage.activeTasks);
  document.querySelector("#stat-due").textContent = String(summary.dueToday);
  document.querySelector("#stat-done").textContent = String(summary.completedThisWeek);
  document.querySelector("#stat-events").textContent = String(summary.upcomingThisWeek);
  const limitLabel = document.querySelector("#task-limit-label");
  if (usage.taskLimit === null) {
    limitLabel.textContent = "Unlimited with Plus";
    document.querySelector("#activity-limit").textContent = "Unlimited extracurriculars with Plus";
  } else {
    limitLabel.textContent = `${usage.activeTasks} of ${usage.taskLimit} free tasks`;
    document.querySelector("#activity-limit").textContent = `${usage.monthlyActivities} of ${usage.activityLimit} free extracurricular activities this month`;
  }
  const premium = user.plan === "plus" && ["active", "trialing"].includes(user.subscriptionStatus);
  document.querySelector("#owner-side-link").hidden = !user.isAdmin;
  document.querySelector("#upgrade-card").hidden = premium;
  document.querySelector("#plus-banner").hidden = premium;
  document.querySelector("#manage-billing").hidden = !user.hasPaymentProfile;
  renderTasks();
  renderActivities();
  renderWeek();
}

async function loadDashboard(append = false) {
  try {
    const offset = append ? dashboard.tasks.length : 0;
    const data = await api(`/api/dashboard?taskFilter=${dashboard.filter}&taskOffset=${offset}`);
    dashboard.user = data.user;
    dashboard.tasks = append ? [...dashboard.tasks, ...data.tasks] : data.tasks;
    dashboard.activities = data.activities;
    dashboard.usage = data.usage;
    dashboard.summary = data.summary;
    dashboard.taskCounts = data.taskCounts;
    dashboard.taskHasMore = data.taskHasMore;
    renderDashboard();
    const billingResult = new URLSearchParams(window.location.search).get("billing");
    if (billingResult === "success") showNotice("Thanks! Your payment provider is confirming the subscription. Your Plus plan will appear here once payment is confirmed.", "success");
    if (billingResult === "cancelled") showNotice("Checkout was cancelled. Your free plan is unchanged.", "success");
    if (billingResult) window.history.replaceState({}, "", "/dashboard");
  } catch (error) {
    if (error.status === 401) {
      window.location.assign("/login");
      return;
    }
    showNotice(error.message);
  }
}

async function updateTask(id, changes) {
  hideNotice();
  try {
    await api(`/api/tasks/${id}`, { method: "PATCH", body: JSON.stringify(changes) });
    await loadDashboard();
  } catch (error) {
    showNotice(error.message);
  }
}

async function deleteTask(id) {
  hideNotice();
  try {
    await api(`/api/tasks/${id}`, { method: "DELETE" });
    await loadDashboard();
  } catch (error) {
    showNotice(error.message);
  }
}

async function deleteActivity(id) {
  hideNotice();
  try {
    await api(`/api/activities/${id}`, { method: "DELETE" });
    await loadDashboard();
  } catch (error) {
    showNotice(error.message);
  }
}

function openDialog(dialog) {
  hideNotice();
  if (!dialog.open) dialog.showModal();
}

function setDefaultActivityDate() {
  const now = new Date();
  const nextHour = new Date(now);
  nextHour.setMinutes(0, 0, 0);
  nextHour.setHours(now.getHours() + 1);
  document.querySelector("#activity-date").value = [
    nextHour.getFullYear(),
    String(nextHour.getMonth() + 1).padStart(2, "0"),
    String(nextHour.getDate()).padStart(2, "0"),
  ].join("-");
  document.querySelector("#activity-time").value = `${String(nextHour.getHours()).padStart(2, "0")}:00`;
}

async function startCheckout(cadence) {
  hideNotice();
  const checkoutButtons = [...document.querySelectorAll("[data-checkout]")];
  checkoutButtons.forEach((button) => { button.disabled = true; });
  try {
    const result = await api("/api/billing/checkout", {
      method: "POST",
      body: JSON.stringify({ cadence }),
    });
    window.location.assign(result.url);
  } catch (error) {
    if (billingDialog.open) billingDialog.close();
    showNotice(error.message);
  } finally {
    checkoutButtons.forEach((button) => { button.disabled = false; });
  }
}

function formatStripePrice(price) {
  const currency = price.currency.toUpperCase();
  const fractionDigits = new Intl.NumberFormat(undefined, { style: "currency", currency }).resolvedOptions().maximumFractionDigits;
  return new Intl.NumberFormat(undefined, {
    style: "currency",
    currency,
  }).format(price.amount / (10 ** fractionDigits));
}

async function showBillingOptions() {
  hideNotice();
  openDialog(billingDialog);
  document.querySelector("#monthly-price").textContent = "Loading price…";
  document.querySelector("#yearly-price").textContent = "Loading price…";
  document.querySelector("#billing-footnote").textContent = "Secure checkout and card management are handled by your payment provider.";
  document.querySelectorAll("[data-checkout]").forEach((button) => { button.disabled = true; });
  try {
    const result = await api("/api/billing/prices");
    if (!result.configured || !result.prices) {
      document.querySelector("#monthly-price").textContent = "Available after Paddle setup";
      document.querySelector("#yearly-price").textContent = "Available after Paddle setup";
      const footnote = document.querySelector("#billing-footnote");
      footnote.replaceChildren(
        document.createTextNode("Paddle seller approval and a payout route to Sri Lanka must be confirmed first. No card will be requested until checkout is ready. "),
        Object.assign(document.createElement("a"), { href: "https://www.paddle.com", target: "_blank", rel: "noopener noreferrer", textContent: "Learn about Paddle ↗" }),
      );
      return;
    }
    const { monthly, yearly } = result.prices;
    document.querySelector("#monthly-price").textContent = `${formatStripePrice(monthly)} / ${monthly.interval}`;
    document.querySelector("#yearly-price").textContent = `${formatStripePrice(yearly)} / ${yearly.interval}`;
    document.querySelectorAll("[data-checkout]").forEach((button) => { button.disabled = false; });
    if (result.environment === "sandbox") {
      document.querySelectorAll("[data-checkout]").forEach((button) => { button.disabled = false; });
      document.querySelector("#billing-footnote").textContent = "Paddle sandbox checkout is for testing only. Do not use a real card.";
    }
  } catch (error) {
    document.querySelector("#monthly-price").textContent = "Price unavailable";
    document.querySelector("#yearly-price").textContent = "Price unavailable";
    document.querySelector("#billing-footnote").textContent = error.message;
  }
}

async function openBillingPortal() {
  hideNotice();
  try {
    const result = await api("/api/billing/portal", { method: "POST", body: JSON.stringify({}) });
    window.location.assign(result.url);
  } catch (error) {
    showNotice(error.message);
  }
}

document.querySelector("#task-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const title = document.querySelector("#task-title").value.trim();
  if (title.length < 2) {
    document.querySelector("#task-title-error").textContent = "Add a little more detail (at least 2 characters).";
    return;
  }
  try {
    await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        title,
        dueDate: document.querySelector("#task-date").value || null,
        priority: document.querySelector("#task-priority").value,
      }),
    });
    form.reset();
    taskDialog.close();
    await loadDashboard();
    showNotice("Your task is on the list. One small step at a time.", "success");
  } catch (error) {
    taskDialog.close();
    showNotice(error.message);
  }
});

document.querySelector("#activity-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const title = document.querySelector("#activity-title").value.trim();
  const date = document.querySelector("#activity-date").value;
  const time = document.querySelector("#activity-time").value;
  const startsAt = new Date(`${date}T${time}`).getTime();
  if (title.length < 2 || !date || !time || !Number.isFinite(startsAt)) {
    document.querySelector("#activity-date-error").textContent = "Please add a title, date, and start time.";
    return;
  }
  const durationMinutes = Number(document.querySelector("#activity-duration").value);
  try {
    await api("/api/activities", {
      method: "POST",
      body: JSON.stringify({
        title,
        kind: document.querySelector("#activity-kind").value,
        startsAt,
        endsAt: startsAt + durationMinutes * 60_000,
      }),
    });
    event.currentTarget.reset();
    activityDialog.close();
    await loadDashboard();
    showNotice("Added to your week. Make room for the things you love.", "success");
  } catch (error) {
    activityDialog.close();
    showNotice(error.message);
  }
});

document.querySelectorAll("[data-filter]").forEach((button) => button.addEventListener("click", () => {
  dashboard.filter = button.dataset.filter;
  loadDashboard();
}));
document.querySelector("#load-more-tasks").addEventListener("click", () => loadDashboard(true));
document.querySelectorAll("#add-task-button, #add-task-link, [data-open-task]").forEach((button) => button.addEventListener("click", () => openDialog(taskDialog)));
document.querySelectorAll("#add-activity-button, [data-open-activity]").forEach((button) => button.addEventListener("click", () => {
  setDefaultActivityDate();
  openDialog(activityDialog);
}));
document.querySelectorAll("[data-close-dialog]").forEach((button) => button.addEventListener("click", () => button.closest("dialog").close()));
document.querySelectorAll("[data-billing]").forEach((button) => button.addEventListener("click", showBillingOptions));
document.querySelectorAll("[data-checkout]").forEach((button) => button.addEventListener("click", () => startCheckout(button.dataset.checkout)));
document.querySelector("#signout-button").addEventListener("click", async () => {
  try {
    await api("/api/logout", { method: "POST", body: JSON.stringify({}) });
    window.location.assign("/");
  } catch (error) {
    showNotice(error.message);
  }
});
document.querySelector("#mobile-menu").addEventListener("click", (event) => {
  const expanded = event.currentTarget.getAttribute("aria-expanded") === "true";
  event.currentTarget.setAttribute("aria-expanded", String(!expanded));
  event.currentTarget.setAttribute("aria-label", expanded ? "Open menu" : "Close menu");
  document.querySelector("#sidebar").classList.toggle("is-open", !expanded);
});
document.querySelectorAll(".side-link").forEach((link) => link.addEventListener("click", () => {
  document.querySelector("#sidebar").classList.remove("is-open");
  document.querySelector("#mobile-menu").setAttribute("aria-expanded", "false");
}));
document.querySelector("#activity-date").addEventListener("input", () => {
  document.querySelector("#activity-date-error").textContent = "";
});
document.querySelector("#task-title").addEventListener("input", () => {
  document.querySelector("#task-title-error").textContent = "";
});
document.querySelector("#activity-title").addEventListener("input", () => {
  document.querySelector("#activity-date-error").textContent = "";
});

const manageBilling = document.createElement("button");
manageBilling.type = "button";
manageBilling.id = "manage-billing";
manageBilling.className = "manage-billing";
manageBilling.textContent = "Manage subscription & card";
manageBilling.addEventListener("click", openBillingPortal);
document.querySelector("#plus-banner").after(manageBilling);
loadDashboard();
