const menuButton = document.querySelector(".menu-toggle");
const navigation = document.querySelector(".nav-links");

menuButton.addEventListener("click", () => {
  const expanded = menuButton.getAttribute("aria-expanded") === "true";
  menuButton.setAttribute("aria-expanded", String(!expanded));
  menuButton.setAttribute("aria-label", expanded ? "Open navigation" : "Close navigation");
  navigation.classList.toggle("is-open", !expanded);
});

navigation.addEventListener("click", (event) => {
  if (event.target.closest("a, [data-install-app]")) {
    menuButton.setAttribute("aria-expanded", "false");
    menuButton.setAttribute("aria-label", "Open navigation");
    navigation.classList.remove("is-open");
  }
});

const revealElements = document.querySelectorAll(".reveal");
if ("IntersectionObserver" in window && !window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
  const observer = new IntersectionObserver((entries, currentObserver) => {
    entries.forEach((entry) => {
      if (entry.isIntersecting) {
        entry.target.classList.add("is-visible");
        currentObserver.unobserve(entry.target);
      }
    });
  }, { threshold: 0.12, rootMargin: "0px 0px -35px 0px" });
  revealElements.forEach((element) => observer.observe(element));
} else {
  revealElements.forEach((element) => element.classList.add("is-visible"));
}

async function loadPublicPricing() {
  try {
    const response = await fetch("/api/pricing", { cache: "no-store" });
    if (!response.ok) throw new Error("Unable to load plan pricing.");
    const result = await response.json();
    if (!result.configured || !result.prices) return;
    const currency = (price) => {
      const code = price.currency.toUpperCase();
      const digits = new Intl.NumberFormat(undefined, { style: "currency", currency: code }).resolvedOptions().maximumFractionDigits;
      return new Intl.NumberFormat(undefined, { style: "currency", currency: code }).format(price.amount / (10 ** digits));
    };
    const monthly = result.prices.monthly;
    const yearly = result.prices.yearly;
    document.querySelector(".public-price > b").replaceChildren(
      document.createTextNode(`${currency(monthly)} `),
      Object.assign(document.createElement("small"), { textContent: `/ ${monthly.interval}` }),
    );
    document.querySelector(".public-price > span").textContent = `${currency(yearly)} / ${yearly.interval} · final price shown at Paddle checkout`;
    document.querySelector("#plus-price-note").textContent = "Secure checkout is handled by Paddle. Card details never enter Northstar.";
  } catch (error) {
    console.error("Could not load current plan pricing:", error);
  }
}

loadPublicPricing();
