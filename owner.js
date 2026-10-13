const notice = document.querySelector("#owner-notice");

function showNotice(message) {
  notice.textContent = message;
  notice.hidden = false;
  notice.className = "owner-notice is-error";
}

async function loadOverview() {
  notice.hidden = true;
  try {
    const response = await fetch("/api/owner", { credentials: "same-origin", cache: "no-store" });
    const data = await response.json();
    if (response.status === 401) {
      window.location.assign("/login?next=%2Fowner");
      return;
    }
    if (response.status === 403) {
      window.location.assign("/dashboard");
      return;
    }
    if (!response.ok) throw new Error(data.error || "We couldn’t load your owner overview.");

    const firstName = data.admin?.name || "Founder";
    document.querySelector("#owner-name").textContent = firstName.split(/\s+/)[0];
    document.querySelector("#total-users").textContent = new Intl.NumberFormat().format(data.users.total);
    document.querySelector("#new-users").textContent = new Intl.NumberFormat().format(data.users.newThisMonth);
    document.querySelector("#free-users").textContent = new Intl.NumberFormat().format(data.users.free);
    document.querySelector("#plus-users").textContent = new Intl.NumberFormat().format(data.users.plus);
    document.querySelector("#total-tasks").textContent = new Intl.NumberFormat().format(data.product.tasks);
    document.querySelector("#total-activities").textContent = new Intl.NumberFormat().format(data.product.activities);
    document.querySelector("#live-sessions").textContent = new Intl.NumberFormat().format(data.product.liveSessions);

    const recurring = document.querySelector("#recurring-value");
    if (data.billing.provider === "paddle") {
      recurring.textContent = data.billing.configured ? "Paddle connected" : "Paddle setup pending";
      document.querySelector("#revenue-caption").textContent = data.billing.note || "Check Paddle for payment, fee, and payout reports";
    } else if (!data.billing.configured) {
      recurring.textContent = "Not connected";
      document.querySelector("#revenue-caption").textContent = "Connect an available payment provider";
    } else if (!data.billing.monthlyRecurring.length) {
      recurring.textContent = "$0";
      document.querySelector("#revenue-caption").textContent = `${data.billing.activeSubscriptions} active Stripe subscription${data.billing.activeSubscriptions === 1 ? "" : "s"}; no recurring prices found`;
    } else {
      recurring.replaceChildren();
      data.billing.monthlyRecurring.forEach((entry, index) => {
        if (index) recurring.append(document.createElement("br"));
        recurring.append(document.createTextNode(new Intl.NumberFormat(undefined, {
          style: "currency",
          currency: entry.currency.toUpperCase(),
        }).format(entry.amountMinor / 100)));
      });
      document.querySelector("#revenue-caption").textContent = `Estimated monthly recurring value across ${data.billing.activeSubscriptions} active Stripe subscription${data.billing.activeSubscriptions === 1 ? "" : "s"}; before fees/tax`;
      if (data.billing.truncated) document.querySelector("#revenue-caption").textContent += " · first 2,000 counted";
    }

    const tableBody = document.querySelector("#recent-students");
    tableBody.replaceChildren();
    if (!data.recentUsers.length) {
      const row = document.createElement("tr");
      const cell = document.createElement("td");
      cell.colSpan = 3;
      cell.className = "loading-cell";
      cell.textContent = "Your first students will show up here.";
      row.append(cell);
      tableBody.append(row);
    } else {
      data.recentUsers.forEach((student) => {
        const row = document.createElement("tr");
        const identity = document.createElement("td");
        identity.className = "student-cell";
        const name = document.createElement("b");
        name.textContent = student.name;
        const email = document.createElement("small");
        email.textContent = student.email;
        identity.append(name, email);
        const plan = document.createElement("td");
        const badge = document.createElement("span");
        badge.className = `plan-badge${student.plan === "plus" ? " is-plus" : ""}`;
        badge.textContent = student.plan === "plus" ? "✦ Plus" : "Free";
        plan.append(badge);
        const joined = document.createElement("td");
        joined.className = "joined-cell";
        joined.textContent = new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric", year: "numeric" }).format(new Date(student.created_at));
        row.append(identity, plan, joined);
        tableBody.append(row);
      });
    }
    document.querySelector("#updated-at").textContent = `Updated ${new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(data.generatedAt))}`;
  } catch (error) {
    showNotice(error.message);
  }
}

document.querySelector("#refresh-owner").addEventListener("click", loadOverview);
document.querySelector("#owner-signout").addEventListener("click", async () => {
  try {
    const response = await fetch("/api/logout", {
      method: "POST",
      credentials: "same-origin",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!response.ok) throw new Error("Could not sign out. Please try again.");
    window.location.assign("/");
  } catch (error) {
    showNotice(error.message);
  }
});

loadOverview();
