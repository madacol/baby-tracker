// Single source of truth for all event types.
// groupType  → the id stored in the DB (diaper-pee / diaper-poop both save as "diaper")
// groupLabel → label used in the edit-dialog select for grouped types
// session    → has a start/stop session button
// modal      → always opens the detail modal instead of quick-saving
const eventTypes = [
  // score = frecuencia relativa; mayor score → más abajo en la grilla (zona del pulgar)
  { id: "event",      label: "Evento",   icon: "icon-event",  tone: "gold",   score:   5, modal: true, hint: "Anota un hito o momento especial." },
  { id: "nails",      label: "Uñas",     icon: "icon-nails",  tone: "mint",   score:  10, hint: "Corte de uñas." },
  { id: "bath",       label: "Baño",     icon: "icon-bath",   tone: "blue",   score:  20, hint: "Registra el baño del bebé." },
  { id: "spitup",     label: "Vómito",   icon: "icon-spit",   tone: "coral",  score:  40, hint: "Registra buches, reflujo o vomito." },
  { id: "sleep",      label: "Sueño",    icon: "icon-sleep",  tone: "violet", score:  60, session: true, hint: "Si hace falta, guarda siesta con inicio y fin." },
  { id: "diaper-poop",label: "Pupú",     icon: "icon-diaper", tone: "coral",  score:  70, groupType: "diaper", groupLabel: "Panal", defaults: { pee: false, poop: true  }, hint: "Panal con popo; se puede marcar tambien pis." },
  { id: "diaper-pee", label: "Miaito",   icon: "icon-diaper", tone: "gold",   score:  80, groupType: "diaper", groupLabel: "Panal", defaults: { pee: true,  poop: false }, hint: "Panal solo con pis." },
  { id: "bottle",     label: "Teterito", icon: "icon-bottle", tone: "mint",   score:  95, session: true, hint: "Toma rapida o con inicio y fin opcional." },
  { id: "breast",     label: "Tetica",   icon: "icon-breast", tone: "blue",   score: 100, session: true, hint: "Permite guardar lado, inicio y fin." },
];

// Derived: one entry per stored type (deduplicates grouped types like diaper).
// Used for the edit-dialog select and the filter chips.
const storageTypes = (() => {
  const seen = new Set();
  return eventTypes.filter(t => {
    const id = t.groupType || t.id;
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  }).map(t => ({ id: t.groupType || t.id, label: t.groupLabel || t.label, icon: t.icon, tone: t.tone }));
})();

let entries = [];
let sessions = {};
let activeFilter = "24h";
let activeTypeFilter = new Set();
let suppressNextClick = false;
let editingId = null;
let useCurrentTime = true;
let isSaving = false;

const eventGrid = document.querySelector("#eventGrid");
const timeline = document.querySelector("#timeline");
const eventTime = document.querySelector("#eventTime");
const timeScrubber = document.querySelector("#timeScrubber");
const scrubOffsetEl = document.querySelector("#scrubOffset");
const scrubClockEl  = document.querySelector("#scrubClock");
const timeMode = document.querySelector("#timeMode");
const countLabel = document.querySelector("#countLabel");
const todaySummary = document.querySelector("#todaySummary");
const entryDialog = document.querySelector("#entryDialog");
const entryForm = document.querySelector("#entryForm");
const exportDialog = document.querySelector("#exportDialog");
const exportText = document.querySelector("#exportText");

const fields = {
  type:        document.querySelector("#detailType"),
  time:        document.querySelector("#detailTime"),
  start:       document.querySelector("#detailStart"),
  end:         document.querySelector("#detailEnd"),
  amount:      document.querySelector("#detailAmount"),
  side:        document.querySelector("#detailSide"),
  pee:         document.querySelector("#detailPee"),
  poop:        document.querySelector("#detailPoop"),
  diaperQty:   document.querySelector("#detailDiaperQty"),
  diaperColor: document.querySelector("#detailDiaperColor"),
  notes:       document.querySelector("#detailNotes"),
};

let currentOffset = 0; // minutes from now (0 = now, negative = past)

init();

async function init() {
  populateTypeOptions();
  setNowMode();
  renderEvents();
  renderTypeFilters();
  renderTimeline();
  wireEvents();
  await refreshState();
  setInterval(() => {
    if (useCurrentTime) updateTimeInput(new Date());
    renderAll(); // refresh session timers + elapsed hints
  }, 30000);
  setInterval(refreshState, 15000);
}

function wireEvents() {
  wireDragScrub();
  wirePillButtons();

  eventTime.addEventListener("input", () => {
    useCurrentTime = false;
    currentOffset = null;
    scrubOffsetEl.textContent = "Manual";
    scrubClockEl.textContent  = "";
    timeMode.textContent = "Manual";
  });

  document.querySelectorAll(".segmented button").forEach((button) => {
    button.addEventListener("click", () => {
      activeFilter = button.dataset.filter;
      document.querySelectorAll(".segmented button").forEach((item) => {
        item.classList.toggle("active", item === button);
      });
      renderTimeline();
    });
  });

  fields.type.addEventListener("change", () => updateDetailVisibility(fields.type.value));

  entryForm.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (event.submitter?.value === "cancel") {
      entryDialog.close();
      return;
    }
    await saveDialogEntry();
  });

  document.querySelector("#deleteFromDialog").addEventListener("click", async () => {
    if (!editingId) return;
    await deleteEntry(editingId);
    entryDialog.close();
  });

  document.querySelector("#exportButton").addEventListener("click", () => {
    exportText.value = JSON.stringify(sortEntries(entries), null, 2);
    exportDialog.showModal();
    exportText.focus();
    exportText.select();
  });
}

function populateTypeOptions() {
  fields.type.innerHTML = storageTypes
    .map((t) => `<option value="${t.id}">${t.label}</option>`)
    .join("");
}

function wireDragScrub() {
  const PIXELS_PER_STEP = 12; // px of drag per 5-minute step
  let startY = null;
  let startOffset = 0;

  timeScrubber.addEventListener("pointerdown", (e) => {
    startY = e.clientY;
    startOffset = currentOffset ?? 0;
    timeScrubber.setPointerCapture(e.pointerId);
    timeScrubber.classList.add("dragging");
    e.preventDefault();
  });

  timeScrubber.addEventListener("pointermove", (e) => {
    if (startY === null) return;
    const deltaY = startY - e.clientY; // positive = dragged up = go back in time
    const steps = Math.round(deltaY / PIXELS_PER_STEP);
    const raw = startOffset - steps * 5;
    applyOffset(Math.max(-1440, Math.min(0, raw)));
  });

  const endDrag = () => {
    startY = null;
    timeScrubber.classList.remove("dragging");
  };
  timeScrubber.addEventListener("pointerup", endDrag);
  timeScrubber.addEventListener("pointercancel", endDrag);

  timeScrubber.addEventListener("keydown", (e) => {
    if (e.key === "ArrowUp")   { applyOffset(Math.max(-1440, (currentOffset ?? 0) - 5)); e.preventDefault(); }
    if (e.key === "ArrowDown") { applyOffset(Math.min(0,     (currentOffset ?? 0) + 5)); e.preventDefault(); }
    if (e.key === "Home")      { applyOffset(0); e.preventDefault(); }
  });
}

function applyOffset(minutes) {
  currentOffset = Math.round(minutes / 5) * 5; // snap to 5-min grid
  useCurrentTime = currentOffset === 0;
  const date = new Date();
  date.setMinutes(date.getMinutes() + currentOffset);
  updateTimeInput(date);
  const label = currentOffset === 0 ? "Ahora" : offsetLabel(currentOffset);
  scrubOffsetEl.textContent = label;
  scrubClockEl.textContent  = currentOffset === 0 ? "" : formatTime(date);
  timeMode.textContent = label;
}

function renderEvents() {
  const sorted = [...eventTypes].sort((a, b) => (a.score ?? 0) - (b.score ?? 0));
  eventGrid.innerHTML = sorted
    .map((type) => {
      const running = sessions[type.id];
      const lastTs = lastEntryTimestamp(type.id);

      let elapsedHtml;
      if (running) {
        elapsedHtml = `
          <span class="elapsed-sub">en sesión</span>
          <span class="elapsed-val session-live">${durationText(running.startedAt)}</span>`;
      } else if (lastTs) {
        elapsedHtml = `
          <span class="elapsed-sub">último</span>
          <span class="elapsed-val">${escapeHtml(cardElapsed(lastTs))}</span>`;
      } else {
        elapsedHtml = `<span class="elapsed-sub" style="opacity:.55">sin registros</span>`;
      }

      const sessionBtn = type.session
        ? `<button class="session-btn ${running ? "running" : ""}" data-session="${type.id}" type="button"
             title="${running ? "Terminar sesión" : "Iniciar sesión"}"
             aria-label="${running ? "Terminar sesión" : "Iniciar sesión"}">
            <svg><use href="#${running ? "icon-stop" : "icon-play"}"></use></svg>
          </button>`
        : "";

      return `<article class="event-card" data-tone="${type.tone}" data-add="${type.id}"
          role="button" tabindex="0"
          title="Registrar ${type.label}" aria-label="Registrar ${type.label}">
        <div class="event-main">
          <span class="event-icon"><svg><use href="#${type.icon}"></use></svg></span>
          <div class="event-copy">
            <div class="card-top">
              <span class="card-label">${type.label}</span>
              ${running ? '<span class="running-dot"></span>' : ""}
            </div>
            <div class="card-elapsed">${elapsedHtml}</div>
          </div>
        </div>
        ${sessionBtn ? `<div class="card-actions">${sessionBtn}</div>` : ""}
      </article>`;
    })
    .join("");

  eventGrid.querySelectorAll(".event-card[data-add]").forEach((card) => {
    wireLongPress(card, () => openNewEntryModal(card.dataset.add));
    card.addEventListener("click", (e) => {
      if (suppressNextClick) { suppressNextClick = false; return; }
      if (e.target.closest(".session-btn")) return;
      const type = eventTypes.find((t) => t.id === card.dataset.add);
      if (type?.modal) openNewEntryModal(card.dataset.add);
      else addQuickEntry(card.dataset.add);
    });
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      openNewEntryModal(card.dataset.add);
    });
  });

  eventGrid.querySelectorAll("[data-session]").forEach((button) => {
    button.addEventListener("pointerdown", (e) => e.stopPropagation());
    button.addEventListener("click", () => toggleSession(button.dataset.session));
  });
}

async function addQuickEntry(buttonTypeId) {
  if (isSaving) return;
  const type = eventTypes.find((item) => item.id === buttonTypeId);
  const entryType = type.groupType || type.id;
  const timestamp = currentSelectedDate().toISOString();
  const entry = {
    type: entryType,
    timestamp,
    startTime: "",
    endTime: "",
    amount: "",
    side: "",
    pee: false,
    poop: false,
    notes: "",
    ...type.defaults,
  };

  await createEntry(entry);
  showToast(`${type.label} registrado`, "success");
}

async function openNewEntryModal(buttonTypeId) {
  if (isSaving) return;
  const type = eventTypes.find((item) => item.id === buttonTypeId);
  const entryType = type.groupType || type.id;
  const timestamp = currentSelectedDate().toISOString();
  const entry = {
    type: entryType,
    timestamp,
    startTime: "",
    endTime: "",
    amount: "",
    side: "",
    pee: false,
    poop: false,
    notes: "",
    ...type.defaults,
  };
  const created = await createEntry(entry);
  if (created) openEditor(created.id, true);
}

function wireLongPress(element, callback, delay = 500) {
  let timer = null;

  element.addEventListener("pointerdown", () => {
    element.classList.add("pressing");
    timer = setTimeout(() => {
      timer = null;
      element.classList.remove("pressing");
      suppressNextClick = true;
      callback();
    }, delay);
  });

  const cancel = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    element.classList.remove("pressing");
  };
  element.addEventListener("pointerup", cancel);
  element.addEventListener("pointercancel", cancel);
  element.addEventListener("pointermove", cancel);
}

async function toggleSession(typeId) {
  if (isSaving) return;
  const selectedDate = currentSelectedDate();
  const running = sessions[typeId];

  if (!running) {
    await apiRequest(`/api/sessions/${typeId}`, {
      method: "PUT",
      body: { startedAt: selectedDate.toISOString() },
    });
    await refreshState();
    return;
  }

  await apiRequest(`/api/sessions/${typeId}`, { method: "DELETE" });
  const created = await createEntry({
    type: typeId,
    timestamp: selectedDate.toISOString(),
    startTime: running.startedAt,
    endTime: selectedDate.toISOString(),
    amount: "",
    side: "",
    pee: false,
    poop: false,
    notes: "",
  });
  if (created) openEditor(created.id, true);
}

function renderTimeline() {
  const visible = sortEntries(entries).filter((entry) => {
    const matchesTime = activeFilter === "all" || isWithin24h(new Date(entry.timestamp));
    const matchesType = activeTypeFilter.size === 0 || activeTypeFilter.has(entry.type);
    return matchesTime && matchesType;
  });

  countLabel.textContent = visible.length
    ? `${visible.length} ${visible.length === 1 ? "registro" : "registros"}`
    : "Sin registros todavia.";

  todaySummary.textContent = buildTodaySummary();

  if (!visible.length) {
    timeline.innerHTML = `<div class="empty-state">Toca un evento para crear el primer registro.</div>`;
    return;
  }

  timeline.innerHTML = visible
    .map((entry) => {
      const type = typeDisplay(entry);
      const tone = entryTone(entry);
      const stamp = new Date(entry.timestamp);
      return `<article class="entry-row" data-tone="${tone}" data-edit="${entry.id}"
          role="button" tabindex="0" aria-label="Editar ${type.label}">
        <div class="entry-stamp">
          <div class="entry-time">${formatTime(stamp)}</div>
          <div class="entry-date">${formatDate(stamp)}</div>
        </div>
        <div class="entry-main">
          <div class="entry-label">
            <svg><use href="#${type.icon}"></use></svg>
            <span>${type.label}</span>
          </div>
          <div class="entry-meta">${entrySummary(entry)}</div>
        </div>
        <div class="row-actions">
          <button class="icon-button" data-delete="${entry.id}" type="button" aria-label="Eliminar ${type.label}">
            <svg><use href="#icon-trash"></use></svg>
          </button>
        </div>
      </article>`;
    })
    .join("");

  timeline.querySelectorAll(".entry-row[data-edit]").forEach((row) => {
    row.addEventListener("click", (e) => {
      if (e.target.closest(".row-actions")) return;
      openEditor(row.dataset.edit, false);
    });
  });

  timeline.querySelectorAll("[data-delete]").forEach((button) => {
    button.addEventListener("pointerdown", (e) => e.stopPropagation());
    button.addEventListener("click", () => deleteEntry(button.dataset.delete));
  });
}

function openEditor(id, isNew) {
  const entry = entries.find((item) => item.id === id);
  if (!entry) return;

  editingId = id;
  document.querySelector("#dialogTitle").textContent = isNew ? "Completar registro" : "Editar registro";
  document.querySelector("#dialogSubtitle").textContent = typeDisplay(entry).label;
  document.querySelector("#deleteFromDialog").classList.toggle("hidden", isNew);

  fields.type.value = entry.type;
  fields.time.value = toDatetimeLocal(new Date(entry.timestamp));
  fields.start.value = entry.startTime ? toDatetimeLocal(new Date(entry.startTime)) : "";
  fields.end.value = entry.endTime ? toDatetimeLocal(new Date(entry.endTime)) : "";
  fields.amount.value      = entry.type !== "diaper" ? (entry.amount || "") : "";
  fields.side.value        = entry.type !== "diaper" ? (entry.side   || "") : "";
  fields.diaperQty.value   = entry.type === "diaper" ? (entry.amount || "") : "";
  fields.diaperColor.value = entry.type === "diaper" ? (entry.side   || "") : "";
  fields.pee.checked   = Boolean(entry.pee);
  fields.poop.checked  = Boolean(entry.poop);
  fields.notes.value   = entry.notes || "";
  updateDetailVisibility(entry.type);
  syncPillButtons();
  entryDialog.showModal();
}

function updateDetailVisibility(type) {
  document.querySelectorAll(".detail-field").forEach((field) => {
    field.classList.toggle("hidden", field.dataset.for !== type);
  });
  document.querySelectorAll(".optional-time").forEach((field) => {
    field.classList.toggle("hidden", !["bottle", "breast", "sleep"].includes(type));
  });
}

function syncPillButtons() {
  document.querySelectorAll(".pill-group").forEach((group) => {
    const target = document.querySelector(group.dataset.target);
    if (!target) return;
    group.querySelectorAll("button").forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.value === target.value);
    });
  });
}

function wirePillButtons() {
  document.querySelectorAll(".pill-group button").forEach((btn) => {
    btn.addEventListener("click", () => {
      const group  = btn.closest(".pill-group");
      const target = document.querySelector(group.dataset.target);
      if (!target) return;
      const newVal = target.value === btn.dataset.value ? "" : btn.dataset.value;
      target.value = newVal;
      group.querySelectorAll("button").forEach((b) => {
        b.classList.toggle("active", b.dataset.value === newVal);
      });
    });
  });
}

async function saveDialogEntry() {
  const entry = entries.find((item) => item.id === editingId);
  if (!entry) return;

  const updated = {
    ...entry,
    type: fields.type.value,
    timestamp: fromDatetimeLocal(fields.time.value).toISOString(),
    startTime: fields.start.value ? fromDatetimeLocal(fields.start.value).toISOString() : "",
    endTime: fields.end.value ? fromDatetimeLocal(fields.end.value).toISOString() : "",
    amount: fields.type.value === "diaper" ? fields.diaperQty.value   : fields.amount.value.trim(),
    side:   fields.type.value === "diaper" ? fields.diaperColor.value : fields.side.value,
    pee: fields.pee.checked,
    poop: fields.poop.checked,
    notes: fields.notes.value.trim(),
  };

  await updateEntry(updated);
  entryDialog.close();
}

async function createEntry(entry) {
  return withSaving(async () => {
    const created = await apiRequest("/api/entries", { method: "POST", body: entry });
    entries.push(created);
    renderAll();
    return created;
  });
}

async function updateEntry(entry) {
  return withSaving(async () => {
    const saved = await apiRequest(`/api/entries/${entry.id}`, { method: "PUT", body: entry });
    entries = entries.map((item) => (item.id === saved.id ? saved : item));
    renderAll();
    showToast("Registro guardado", "success");
    return saved;
  });
}

async function deleteEntry(id) {
  if (!confirm("¿Eliminar este registro?")) return;
  return withSaving(async () => {
    await apiRequest(`/api/entries/${id}`, { method: "DELETE" });
    entries = entries.filter((entry) => entry.id !== id);
    renderAll();
    showToast("Registro eliminado", "info");
  });
}

async function refreshState() {
  try {
    const state = await apiRequest("/api/state");
    entries = state.entries || [];
    sessions = state.sessions || {};
    renderAll();
  } catch (error) {
    showConnectionError(error);
  }
}

async function withSaving(callback) {
  isSaving = true;
  document.body.classList.add("saving");
  try {
    return await callback();
  } catch (error) {
    showConnectionError(error);
    return null;
  } finally {
    isSaving = false;
    document.body.classList.remove("saving");
  }
}

async function apiRequest(path, options = {}) {
  const response = await fetch(path, {
    method: options.method || "GET",
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });

  if (!response.ok) {
    const message = await response.text();
    throw new Error(message || `Error ${response.status}`);
  }

  if (response.status === 204) return null;
  return response.json();
}

function showConnectionError(error) {
  todaySummary.textContent = "No se pudo conectar con el servidor central.";
  timeline.innerHTML = `<div class="empty-state">Abre la app desde el servidor Node. Detalle: ${escapeHtml(
    error.message,
  )}</div>`;
}

function renderAll() {
  renderEvents();
  renderTypeFilters();
  renderTimeline();
}

function renderTypeFilters() {
  const bar = document.querySelector("#typeFilterBar");
  bar.innerHTML = storageTypes
    .map((t) => {
      const isActive = activeTypeFilter.has(t.id);
      return `<button class="type-chip${isActive ? " active" : ""}" data-type-filter="${t.id}" data-tone="${t.tone}" type="button">
        <svg><use href="#${t.icon}"></use></svg>
        ${t.label}
      </button>`;
    })
    .join("");

  bar.querySelectorAll("[data-type-filter]").forEach((button) => {
    button.addEventListener("click", () => {
      const clicked = button.dataset.typeFilter;
      if (activeTypeFilter.has(clicked)) {
        activeTypeFilter.delete(clicked);
      } else {
        activeTypeFilter.add(clicked);
      }
      renderTypeFilters();
      renderTimeline();
    });
  });
}

function setNowMode() {
  applyOffset(0);
}

function offsetLabel(minutes) {
  const absolute = Math.abs(minutes);
  if (absolute >= 60) {
    const hours = Math.floor(absolute / 60);
    const rest = absolute % 60;
    return rest ? `−${hours}h ${rest}m` : `−${hours}h`;
  }
  return `−${absolute}m`;
}

function currentSelectedDate() {
  return useCurrentTime ? new Date() : fromDatetimeLocal(eventTime.value);
}

function updateTimeInput(date) {
  eventTime.value = toDatetimeLocal(date);
}

function sortEntries(items) {
  return [...items].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
}

function typeDisplay(entry) {
  const t = storageTypes.find((s) => s.id === entry.type);
  if (!t) return { label: "Registro", icon: "icon-plus" };
  return { label: entry.type === "diaper" ? diaperLabel(entry) : t.label, icon: t.icon };
}

function diaperLabel(entry) {
  if (entry.pee && entry.poop) return "Miaito y pupú";
  if (entry.poop) return "Pupú";
  if (entry.pee) return "Miaito";
  return "Panal";
}

function entrySummary(entry) {
  const pieces = [];
  if (entry.startTime || entry.endTime) {
    pieces.push(sessionRange(entry.startTime, entry.endTime));
  }
  if (entry.amount) pieces.push(entry.amount);
  if (entry.side) pieces.push(entry.side);
  if (entry.notes) pieces.push(entry.notes);
  return pieces.length ? pieces.map(escapeHtml).join(" · ") : "Sin detalles extra";
}

function sessionRange(startTime, endTime) {
  const start = startTime ? formatTime(new Date(startTime)) : "sin inicio";
  const end = endTime ? formatTime(new Date(endTime)) : "sin fin";
  const duration = startTime && endTime ? `, ${durationBetween(startTime, endTime)}` : "";
  return `${start} a ${end}${duration}`;
}

function buildTodaySummary() {
  const todayEntries = entries.filter((entry) => isToday(new Date(entry.timestamp)));
  if (!todayEntries.length) return "Hoy no hay registros.";

  const counts = todayEntries.reduce((acc, entry) => {
    const label = typeDisplay(entry).label;
    acc[label] = (acc[label] || 0) + 1;
    return acc;
  }, {});

  return Object.entries(counts)
    .map(([label, count]) => `${count} ${label}`)
    .join(" · ");
}

function durationText(startIso) {
  return durationBetween(startIso, new Date().toISOString());
}

function durationBetween(startIso, endIso) {
  const diff = Math.max(0, new Date(endIso) - new Date(startIso));
  const minutes = Math.round(diff / 60000);
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  if (hours > 0) return `${hours}h ${rest}m`;
  return `${rest}m`;
}

function isWithin24h(date) {
  return Date.now() - date.getTime() < 24 * 60 * 60 * 1000;
}

function isToday(date) {
  const today = new Date();
  return (
    date.getFullYear() === today.getFullYear() &&
    date.getMonth() === today.getMonth() &&
    date.getDate() === today.getDate()
  );
}

function formatTime(date) {
  return new Intl.DateTimeFormat("es", {
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function formatDate(date) {
  return new Intl.DateTimeFormat("es", {
    day: "2-digit",
    month: "short",
  }).format(date);
}

function toDatetimeLocal(date) {
  const offset = date.getTimezoneOffset() * 60000;
  return new Date(date.getTime() - offset).toISOString().slice(0, 16);
}

function fromDatetimeLocal(value) {
  return value ? new Date(value) : new Date();
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

// Returns the color tone for a given entry (used for timeline row coloring)
function entryTone(entry) {
  if (entry.type === "diaper") return entry.poop ? "coral" : "gold";
  return storageTypes.find((t) => t.id === entry.type)?.tone ?? "blue";
}

// Returns the ISO timestamp of the most recent entry for a card type, or null
function lastEntryTimestamp(buttonTypeId) {
  let matching;
  if (buttonTypeId === "diaper-pee") {
    matching = entries.filter((e) => e.type === "diaper" && e.pee);
  } else if (buttonTypeId === "diaper-poop") {
    matching = entries.filter((e) => e.type === "diaper" && e.poop);
  } else {
    matching = entries.filter((e) => e.type === buttonTypeId);
  }
  if (!matching.length) return null;
  return matching.reduce((best, e) =>
    new Date(e.timestamp) > new Date(best.timestamp) ? e : best,
  ).timestamp;
}

// Compact elapsed format for the card hero: "ahora" / "5m" / "2h 15m" / "ayer" / "3d"
function cardElapsed(isoDate) {
  const diff = Math.floor((Date.now() - new Date(isoDate)) / 60000);
  if (diff < 1) return "ahora";
  if (diff < 60) return `${diff}m`;
  const hours = Math.floor(diff / 60);
  const mins = diff % 60;
  if (hours < 24) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return days === 1 ? "ayer" : `${days}d`;
}

// Toast notification
function showToast(message, type = "success") {
  const container = document.querySelector("#toastContainer");
  const toast = document.createElement("div");
  toast.className = `toast toast--${type}`;
  toast.textContent = message;
  container.appendChild(toast);
  // Double rAF ensures the initial state is painted before transitioning
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      toast.classList.add("toast--visible");
    });
  });
  setTimeout(() => {
    toast.classList.remove("toast--visible");
    setTimeout(() => toast.remove(), 350);
  }, 2200);
}
