/* Riff Platform — Frontend-Logik.
   Kein Framework: die Seite hat genau eine Aufgabe (Code einlösen),
   und die soll in unter einer Sekunde interaktiv sein. */

"use strict";

const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ?static: sofortiges Springen statt Smooth-Scroll (Screenshots/Tests).
// ?static&goto=<section-id>: schiebt die Sektion per Margin in den Viewport —
// Headless-Browser painten nach programmatischem Scroll nicht zuverlässig.
{
  const params = new URLSearchParams(location.search);
  if (params.has("static")) {
    document.documentElement.style.scrollBehavior = "auto";
    const goto = params.get("goto");
    if (goto) {
      addEventListener("load", () => {
        const el = document.getElementById(goto);
        if (el) {
          document.querySelector(".nav").style.display = "none";
          document.documentElement.style.marginTop = `-${Math.max(0, el.offsetTop)}px`;
        }
      });
    }
  }
}

/* ═══════════════ Liquid-Metal-Hero (Canvas) ═══════════════
   Grauwertige, langsam fließende "Metallströme" auf einem niedrig
   aufgelösten Canvas; die Verschmelzung zu flüssigem Chrom entsteht über
   einen CSS-Kontrastfilter auf dem hochskalierten Element — GPU-billig. */

(function liquidMetal() {
  const canvas = document.getElementById("metal");
  if (!canvas) return;
  const ctx = canvas.getContext("2d", { alpha: false });

  const SCALE = 0.14; // Render-Auflösung: 14 % der Anzeige — weich & schnell
  let w = 0, h = 0;

  function resize() {
    w = Math.max(120, Math.floor(canvas.clientWidth * SCALE));
    h = Math.max(80, Math.floor(canvas.clientHeight * SCALE));
    canvas.width = w;
    canvas.height = h;
  }
  resize();
  window.addEventListener("resize", resize, { passive: true });

  // CSS-seitiger "Metall"-Filter: hoher Kontrast verschmilzt die Formen
  // zu flüssigem Chrom statt weichem Nebel
  canvas.style.filter = "contrast(1.85) brightness(0.8) saturate(0.35)";

  // Zwei "Metallströme" (oben/unten), gestreckte Ellipsen statt Kugeln —
  // die Textzone in der Mitte bleibt frei
  const blobs = Array.from({ length: 9 }, (_, i) => ({
    band: i % 2 ? 0.18 : 0.82,
    ax: 0.36 + 0.14 * Math.random(),
    ay: 0.05 + 0.06 * Math.random(),
    fx: 0.00006 + 0.00005 * Math.random(),
    fy: 0.00005 + 0.00004 * Math.random(),
    phase: Math.random() * Math.PI * 2,
    r: 0.11 + 0.1 * Math.random(),
    stretch: 2.0 + 1.3 * Math.random(),
    tilt: (Math.random() - 0.5) * 0.45,
    tone: i % 2 ? 228 : 185,
  }));

  let running = true;
  document.addEventListener("visibilitychange", () => {
    running = !document.hidden;
    if (running && !reducedMotion) requestAnimationFrame(frame);
  });

  function drawFrame(t) {
    ctx.fillStyle = "#0b0b0d";
    ctx.fillRect(0, 0, w, h);

    ctx.globalCompositeOperation = "lighter";
    for (const b of blobs) {
      const cx = w * (0.5 + b.ax * Math.sin(t * b.fx + b.phase));
      const cy = h * (b.band + b.ay * Math.cos(t * b.fy + b.phase * 1.7));
      const r = Math.max(6, Math.min(w, h) * b.r * (1 + 0.12 * Math.sin(t * 0.0002 + b.phase)));
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, r);
      g.addColorStop(0, `rgba(${b.tone}, ${b.tone}, ${b.tone + 8}, 0.5)`);
      g.addColorStop(0.55, `rgba(${b.tone - 60}, ${b.tone - 60}, ${b.tone - 50}, 0.2)`);
      g.addColorStop(1, "rgba(0, 0, 0, 0)");
      ctx.save();
      ctx.translate(cx, cy);
      ctx.rotate(b.tilt + 0.08 * Math.sin(t * 0.00004 + b.phase));
      ctx.scale(b.stretch, 0.75);
      ctx.fillStyle = g;
      ctx.beginPath();
      ctx.arc(0, 0, r, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    // Chrom-Verlauf: vertikale Bänder wie auf poliertem Metall
    ctx.globalCompositeOperation = "overlay";
    const chrome = ctx.createLinearGradient(0, 0, 0, h);
    chrome.addColorStop(0, "rgba(255, 255, 255, 0.16)");
    chrome.addColorStop(0.42, "rgba(20, 20, 24, 0.5)");
    chrome.addColorStop(0.55, "rgba(215, 215, 222, 0.28)");
    chrome.addColorStop(0.72, "rgba(10, 10, 12, 0.55)");
    chrome.addColorStop(1, "rgba(120, 120, 128, 0.12)");
    ctx.fillStyle = chrome;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = "source-over";
  }

  function frame(t) {
    if (!running) return;
    drawFrame(t);
    if (!reducedMotion) requestAnimationFrame(frame);
  }

  drawFrame(performance.now()); // erstes Bild sofort (auch bei reduced motion)
  if (!reducedMotion) requestAnimationFrame(frame);
})();

/* ═══════════════ Scroll-Reveal ═══════════════ */

(function reveals() {
  // ?static: Reveal-Animationen aus (Screenshots, Tests, Debugging)
  const staticMode = new URLSearchParams(location.search).has("static");
  if (staticMode || reducedMotion || !("IntersectionObserver" in window)) return;
  document.documentElement.classList.add("js");
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (e.isIntersecting) {
          e.target.classList.add("visible");
          io.unobserve(e.target);
        }
      }
    },
    { rootMargin: "0px 0px -8% 0px", threshold: 0.08 }
  );
  document.querySelectorAll(".reveal").forEach((el) => io.observe(el));
})();

/* ═══════════════ Live-Status (Knappheit, ehrlich) ═══════════════ */

function renderScarcity(status) {
  const wrap = document.getElementById("scarcity");
  if (!wrap || !status || !status.poolLoaded || status.remaining === null) return;
  const total = status.totalSlots || 100;
  const redeemed = Math.min(status.redeemed, total);
  document.getElementById("scarcity-count").textContent = String(redeemed);
  document.getElementById("scarcity-total").textContent = String(total);
  wrap.hidden = false;
  requestAnimationFrame(() => {
    document.getElementById("scarcity-fill").style.width =
      `${Math.max(2, Math.round((redeemed / total) * 100))}%`;
  });
}

async function fetchStatus() {
  try {
    const res = await fetch("api/status?product=riff", { headers: { Accept: "application/json" } });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null; // Zähler bleibt dann einfach ausgeblendet — nie geraten
  }
}

fetchStatus().then(renderScarcity);

/* ═══════════════ Code-Einlösung ═══════════════ */

const form = document.getElementById("redeem-form");
const input = document.getElementById("code-input");
const btn = document.getElementById("redeem-btn");
const errorBox = document.getElementById("redeem-error");
const CODE_RE = /^RIFF-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}-[2-9A-HJKMNP-TV-Z]{4}$/;

/* Auto-Formatierung: Nutzer darf tippen oder einfügen, wie er will —
   Großschreibung, Präfix und Bindestriche setzen wir. Jede Reibung
   im einzigen Formularfeld der Seite kostet echte Conversions. */
input.addEventListener("input", () => {
  let raw = input.value.toUpperCase().replace(/[^A-Z2-9]/g, "");
  if (raw.startsWith("RIFF")) raw = raw.slice(4);
  const groups = raw.slice(0, 12).match(/.{1,4}/g) || [];
  input.value = raw.length ? ["RIFF", ...groups].join("-") : "";
  input.setAttribute("aria-invalid", "false");
  errorBox.hidden = true;
});

const ERROR_COPY = {
  invalid_format:
    "Das sieht noch nicht wie ein vollständiger Code aus. Das Format ist RIFF-XXXX-XXXX-XXXX — bitte prüfe, ob alle 12 Zeichen da sind.",
  not_found:
    "Diesen Code kennen wir nicht. Bitte prüfe die Schreibweise — Codes enthalten nie 0, O, 1 oder I. Dein Code wurde nicht verbraucht.",
  already_redeemed:
    "Dieser Code wurde bereits eingelöst. Falls du das nicht selbst warst, melde dich mit deinem Kaufnachweis — jede Einlösung ist bei uns nachvollziehbar protokolliert.",
  rate_limited:
    "Zu viele Versuche in kurzer Zeit. Bitte warte einen Moment — diese Bremse schützt die Codes aller Nutzer.",
  server_error:
    "Bei uns ist gerade etwas schiefgelaufen — dein Code wurde nicht verbraucht. Bitte versuch es gleich noch einmal.",
  network:
    "Keine Verbindung zum Server. Dein Code wurde nicht verbraucht — bitte prüfe deine Verbindung und versuch es erneut.",
};

function showError(reason, retryAfterSeconds) {
  let msg = ERROR_COPY[reason] || ERROR_COPY.server_error;
  if (reason === "rate_limited" && retryAfterSeconds) {
    const min = Math.ceil(retryAfterSeconds / 60);
    msg = `Zu viele Versuche in kurzer Zeit. Bitte warte etwa ${
      retryAfterSeconds < 90 ? `${retryAfterSeconds} Sekunden` : `${min} Minuten`
    } — diese Bremse schützt die Codes aller Nutzer.`;
  }
  errorBox.textContent = msg;
  errorBox.hidden = false;
  input.setAttribute("aria-invalid", "true");
  const card = document.querySelector(".redeem-card");
  card.classList.remove("shake");
  void card.offsetWidth; // Animation neu triggern
  card.classList.add("shake");
}

function showSuccess(data) {
  document.getElementById("redeem-form-state").hidden = true;
  const successState = document.getElementById("redeem-success-state");
  document.querySelector(".redeem-card").classList.add("success");

  const slot = data.status && data.status.redeemed ? data.status.redeemed : "–";
  document.getElementById("success-slot").textContent = String(slot);
  document.getElementById("success-receipt-id").textContent = data.redemptionId || "–";

  const delivery = data.delivery || {};
  const platforms = delivery.platforms || {};
  const deliveryBox = document.getElementById("success-delivery");
  const stepsList = document.getElementById("success-steps");

  function renderPlatform(key) {
    const p = platforms[key];
    if (!p) return;
    const a = document.createElement("a");
    a.className = "btn btn-glass btn-primary";
    a.href = p.url;
    a.rel = "noopener";
    a.textContent = p.label || "Jetzt herunterladen";
    stepsList.replaceChildren(
      ...(p.steps || []).map((s) => {
        const li = document.createElement("li");
        li.textContent = s;
        return li;
      })
    );
    const picker = deliveryBox.querySelector(".platform-picker");
    if (picker) {
      for (const btn of picker.children) {
        const active = btn.dataset.platform === key;
        btn.className = `btn btn-small ${active ? "btn-glass btn-primary" : "btn-ghost"}`;
      }
    }
    const existingLink = deliveryBox.querySelector("a.btn-primary");
    if (existingLink) existingLink.replaceWith(a);
    else deliveryBox.appendChild(a);
  }

  const platformKeys = Object.keys(platforms);
  if (platformKeys.length > 1) {
    // Mehr als eine Plattform (win/mac) — Umschalter, Default nach OS-
    // Erkennung (navigator.userAgent), aber jederzeit manuell wechselbar,
    // z.B. wenn jemand den Link an einen Freund mit anderem OS weiterreicht.
    const detected = /Mac/i.test(navigator.userAgent) && platforms.mac ? "mac" : "win";
    const picker = document.createElement("div");
    picker.className = "platform-picker";
    picker.style.cssText = "display:flex;gap:8px;justify-content:center;margin-bottom:14px;";
    for (const key of platformKeys) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.dataset.platform = key;
      btn.textContent = platforms[key].beta ? `${key === "mac" ? "macOS" : "Windows"} (Beta)` : key === "mac" ? "macOS" : "Windows";
      btn.addEventListener("click", () => renderPlatform(key));
      picker.appendChild(btn);
    }
    deliveryBox.replaceChildren(picker);
    renderPlatform(detected);
  } else if (platformKeys.length === 1) {
    deliveryBox.replaceChildren();
    renderPlatform(platformKeys[0]);
  } else {
    const note = document.createElement("p");
    note.className = "success-delivery-note";
    note.textContent =
      "Dein Zugang ist reserviert und verbucht. Der Download-Link wird gerade freigeschaltet — bewahre deine Beleg-ID auf, sie ist dein Nachweis.";
    deliveryBox.replaceChildren(note);
  }

  successState.hidden = false;
  if (data.status) renderScarcity(data.status);
  successState.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "center" });
}

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  errorBox.hidden = true;

  const code = input.value.trim().toUpperCase();
  if (!CODE_RE.test(code)) {
    showError("invalid_format");
    input.focus();
    return;
  }

  btn.disabled = true;
  btn.classList.add("loading");

  let res, data;
  try {
    res = await fetch("api/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ product: "riff", code }),
    });
    data = await res.json();
  } catch {
    btn.disabled = false;
    btn.classList.remove("loading");
    showError("network");
    return;
  }

  btn.disabled = false;
  btn.classList.remove("loading");

  if (data && data.ok) {
    showSuccess(data);
  } else {
    showError((data && data.reason) || "server_error", data && data.retryAfterSeconds);
  }
});
