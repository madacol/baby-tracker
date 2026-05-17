const eventTypes = [
  {
    id: "bottle",
    label: "Biberón",
    icon: "icon-bottle",
    tone: "mint",
    hint: "Toma rapida o con inicio y fin opcional.",
    session: true,
  },
  {
    id: "breast",
    label: "Pecho",
    icon: "icon-breast",
    tone: "blue",
    hint: "Permite guardar lado, inicio y fin.",
    session: true,
  },
  {
    id: "diaper-pee",
    label: "Pis",
    icon: "icon-diaper",
    tone: "gold",
    hint: "Panal solo con pis.",
    groupType: "diaper",
    defaults: { pee: true, poop: false },
  },
  {
    id: "diaper-poop",
    label: "Popó",
    icon: "icon-diaper",
    tone: "coral",
    hint: "Panal con popo; se puede marcar tambien pis.",
    groupType: "diaper",
    defaults: { pee: false, poop: true },
  },
  {
    id: "sleep",
    label: "Sueño",
    icon: "icon-sleep",
    tone: "violet",
    hint: "Si hace falta, guarda siesta con inicio y fin.",
    session: true,
  },
  {
    id: "spitup",
    label: "Vómito",
    icon: "icon-spit",
    tone: "coral",
    hint: "Registra buches, reflujo o vomito.",
  },
];

const typeOptions = [
  { id: "bottle", label: "Biberón" },
  { id: "breast", label: "Pecho" },
  { id: "diaper", label: "Panal" },
  { id: "sleep", label: "Sueño" },
  { id: "spitup", label: "Vómito" },
];

const typeChipMeta = {
  bottle: { icon: "icon-bottle", tone: "mint" },
  breast: { icon: "icon-breast", tone: "blue" },
  diaper: { icon: "icon-diaper", tone: "gold" },
  sleep: { icon: "icon-sleep", tone: "violet" },
  spitup: { icon: "icon-spit", tone: "coral" },
};

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
const timeWheel = document.querySelector("#timeWheel");
const timeMode = document.querySelector("#timeMode");
const countLabel = document.querySelector("#countLabel");
const todaySummary = document.querySelector("#todaySummary");
const entryDialog = document.querySelector("#entryDialog");
const entryForm = document.querySelector("#entryForm");
const exportDialog = document.querySelector("#exportDialog");
const exportText = document.querySelector("#exportText");

const fields = {
  type: document.querySelector("#detailType"),
  time: document.querySelector("#detailTime"),
  start: document.querySelector("#detailStart"),
  end: document.querySelector("#detailEnd"),
  amount: document.querySelector("#detailAmount"),
  side: document.querySelector("#detailSide"),
  pee: document.querySelector("#detailPee"),
  poop: document.querySelector("#detailPoop"),
  notes: document.querySelector("#detailNotes"),
};

const timeOffsets = Array.from({ length: 289 }, (_, index) => index * -5);
let wheelScrollFrame = null;
let isSyncingWheel = false;

init();

async function init() {
  populateTypeOptions();
  populateTimeWheel();
  syncWheelPadding();
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
  wireTimeWheel();

  eventTime.addEventListener("input", () => {
    useCurrentTime = false;
    markTimeMode("manual", null);
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
  fields.type.innerHTML = typeOptions
    .map((type) => `<option value="${type.id}">${type.label}</option>`)
    .join("");
}

function populateTimeWheel() {
  timeWheel.innerHTML = timeOffsets
    .map((minutes) => {
      const label = minutes === 0 ? "Ahora" : offsetLabel(minutes);
      return `<button class="time-tick" data-offset="${minutes}" type="button">
        <span>${label}</span>
        <small>${wheelClockLabel(minutes)}</small>
      </button>`;
    })
    .join("");
}

function wireTimeWheel() {
  window.addEventListener("resize", () => {
    syncWheelPadding();
    centerWheelTick(timeWheel.querySelector(".time-tick.active"));
  });

  timeWheel.addEventListener(
    "scroll",
    () => {
      if (isSyncingWheel) return;
      if (wheelScrollFrame) cancelAnimationFrame(wheelScrollFrame);
      wheelScrollFrame = requestAnimationFrame(() => {
        const tick = nearestWheelTick();
        if (!tick) return;
        selectWheelOffset(Number(tick.dataset.offset), tick, false);
      });
    },
    { passive: true },
  );

  timeWheel.addEventListener("click", (event) => {
    const tick = event.target.closest(".time-tick");
    if (!tick) return;
    selectWheelOffset(Number(tick.dataset.offset), tick, true);
  });
}

function renderEvents() {
  eventGrid.innerHTML = eventTypes
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

      return `<article class="event-card" data-tone="${type.tone}">
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
        <div class="card-actions">
          <button class="quick-add" data-add="${type.id}" type="button" title="Registrar ${type.label}" aria-label="Registrar ${type.label}">
            <svg><use href="#icon-plus"></use></svg>
            Registrar
          </button>
          ${sessionBtn}
        </div>
      </article>`;
    })
    .join("");

  eventGrid.querySelectorAll("[data-add]").forEach((button) => {
    wireLongPress(button, () => openNewEntryModal(button.dataset.add));
    button.addEventListener("click", () => {
      if (suppressNextClick) { suppressNextClick = false; return; }
      addQuickEntry(button.dataset.add);
    });
  });

  eventGrid.querySelectorAll(".event-card").forEach((card) => {
    card.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      const typeId = card.querySelector("[data-add]")?.dataset.add;
      if (typeId) openNewEntryModal(typeId);
    });
  });

  eventGrid.querySelectorAll("[data-session]").forEach((button) => {
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
      return `<article class="entry-row" data-tone="${tone}">
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
          <button class="icon-button" data-edit="${entry.id}" type="button" aria-label="Editar ${type.label}">
            <svg><use href="#icon-edit"></use></svg>
          </button>
          <button class="icon-button" data-delete="${entry.id}" type="button" aria-label="Eliminar ${type.label}">
            <svg><use href="#icon-trash"></use></svg>
          </button>
        </div>
      </article>`;
    })
    .join("");

  timeline.querySelectorAll("[data-edit]").forEach((button) => {
    button.addEventListener("click", () => openEditor(button.dataset.edit, false));
  });

  timeline.querySelectorAll("[data-delete]").forEach((button) => {
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
  fields.amount.value = entry.amount || "";
  fields.side.value = entry.side || "";
  fields.pee.checked = Boolean(entry.pee);
  fields.poop.checked = Boolean(entry.poop);
  fields.notes.value = entry.notes || "";
  updateDetailVisibility(entry.type);
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

async function saveDialogEntry() {
  const entry = entries.find((item) => item.id === editingId);
  if (!entry) return;

  const updated = {
    ...entry,
    type: fields.type.value,
    timestamp: fromDatetimeLocal(fields.time.value).toISOString(),
    startTime: fields.start.value ? fromDatetimeLocal(fields.start.value).toISOString() : "",
    endTime: fields.end.value ? fromDatetimeLocal(fields.end.value).toISOString() : "",
    amount: fields.amount.value.trim(),
    side: fields.side.value,
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
  bar.innerHTML = typeOptions
    .map((type) => {
      const meta = typeChipMeta[type.id] || { icon: "icon-plus", tone: "blue" };
      const isActive = activeTypeFilter.has(type.id);
      return `<button class="type-chip${isActive ? " active" : ""}" data-type-filter="${type.id}" data-tone="${meta.tone}" type="button">
        <svg><use href="#${meta.icon}"></use></svg>
        ${type.label}
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
  useCurrentTime = true;
  updateTimeInput(new Date());
  const tick = timeWheel.querySelector('[data-offset="0"]');
  syncWheelPadding();
  markTimeMode("Ahora", 0);
  centerWheelTick(tick);
}

function markTimeMode(text, activeOffset = null) {
  timeWheel.querySelectorAll(".time-tick").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.offset) === activeOffset);
  });
  timeMode.textContent = text;
}

function selectWheelOffset(minutes, tick, shouldCenter) {
  useCurrentTime = minutes === 0;
  const date = new Date();
  date.setMinutes(date.getMinutes() + minutes);
  updateTimeInput(date);
  markTimeMode(minutes === 0 ? "Ahora" : offsetLabel(minutes), minutes);
  if (shouldCenter) centerWheelTick(tick);
}

function centerWheelTick(tick) {
  if (!tick) return;
  syncWheelPadding();
  isSyncingWheel = true;
  const top = tick.offsetTop - (timeWheel.clientHeight - tick.offsetHeight) / 2;
  timeWheel.scrollTo({ top });
  window.setTimeout(() => {
    isSyncingWheel = false;
  }, 120);
}

function syncWheelPadding() {
  const inset = Math.max(46, Math.floor(timeWheel.clientHeight / 2 - 19));
  timeWheel.style.setProperty("--wheel-inset", `${inset}px`);
}

function nearestWheelTick() {
  const ticks = [...timeWheel.querySelectorAll(".time-tick")];
  const wheelBounds = timeWheel.getBoundingClientRect();
  const center = wheelBounds.top + wheelBounds.height / 2;
  return ticks.reduce((nearest, tick) => {
    const bounds = tick.getBoundingClientRect();
    const distance = Math.abs(bounds.top + bounds.height / 2 - center);
    if (!nearest || distance < nearest.distance) return { tick, distance };
    return nearest;
  }, null)?.tick;
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

function wheelClockLabel(minutes) {
  const date = new Date();
  date.setMinutes(date.getMinutes() + minutes);
  return formatTime(date);
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
  const byType = {
    bottle: { label: "Biberón", icon: "icon-bottle" },
    breast: { label: "Pecho", icon: "icon-breast" },
    diaper: { label: diaperLabel(entry), icon: "icon-diaper" },
    sleep: { label: "Sueño", icon: "icon-sleep" },
    spitup: { label: "Vómito", icon: "icon-spit" },
  };
  return byType[entry.type] || { label: "Registro", icon: "icon-plus" };
}

function diaperLabel(entry) {
  if (entry.pee && entry.poop) return "Pis y popó";
  if (entry.poop) return "Popó";
  if (entry.pee) return "Pis";
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
  const tones = {
    bottle: "mint",
    breast: "blue",
    sleep: "violet",
    spitup: "coral",
    diaper: entry.poop ? "coral" : "gold",
  };
  return tones[entry.type] || "blue";
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
