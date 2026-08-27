const state = {
  csrf: null,
  authenticated: false,
  summary: null,
  recordings: [],
  selectedId: null,
  toastTimer: null,
};

const elements = Object.fromEntries(
  [
    "owner-button", "unlock-button", "login-dialog", "login-form", "close-dialog",
    "credential-input", "login-error", "operator-state", "locked-message", "operator-controls",
    "logout-button", "creator-name", "consent-state", "consent-button", "duration-select",
    "record-button", "metric-active", "system-health", "recording-list", "refresh-button",
    "detail-title", "detail-status", "empty-detail", "recording-detail", "detail-segments",
    "detail-bytes", "detail-duration", "detail-version", "timeline", "playback", "stop-button", "toast",
  ].map((id) => [id, document.getElementById(id)]),
);

const activeStatuses = new Set(["REQUESTED", "STARTING", "RECORDING", "FINALIZING"]);
const statusLabels = {
  REQUESTED: "Requested",
  STARTING: "Starting",
  RECORDING: "Recording",
  FINALIZING: "Finalizing",
  READY: "Ready",
  CANCELLED: "Cancelled",
  FAILED: "Failed",
  REJECTED_NO_CONSENT: "No consent",
};

async function request(path, options = {}) {
  const headers = new Headers(options.headers ?? {});
  if (options.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  if (state.csrf && options.method && !["GET", "HEAD"].includes(options.method)) {
    headers.set("x-csrf-token", state.csrf);
  }
  const response = await fetch(path, { ...options, headers, credentials: "same-origin" });
  const contentType = response.headers.get("content-type") ?? "";
  const body = contentType.includes("application/json") ? await response.json() : await response.text();
  if (!response.ok) {
    const message = typeof body === "object" ? body.message ?? body.error : body;
    const error = new Error(message || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function restoreSession() {
  try {
    const session = await request("/api/operator/session");
    setSession(session.authenticated, session.csrf ?? null);
  } catch {
    setSession(false, null);
  }
}

function setSession(authenticated, csrf) {
  state.authenticated = authenticated;
  state.csrf = csrf;
  elements["operator-state"].textContent = authenticated ? "Unlocked" : "Locked";
  elements["operator-state"].className = `access-pill ${authenticated ? "open" : "locked"}`;
  elements["locked-message"].hidden = authenticated;
  elements["operator-controls"].hidden = !authenticated;
  elements["stop-button"].hidden = !authenticated || !isSelectedActive();
  elements["owner-button"].textContent = authenticated ? "Owner session" : "Owner access";
}

async function refreshAll({ quiet = false } = {}) {
  try {
    const [summary, listing] = await Promise.all([
      request("/api/public/summary"),
      request("/api/public/recordings?limit=18"),
    ]);
    state.summary = summary;
    state.recordings = listing.recordings;
    renderSummary();
    renderRecordings();
    setHealth(true);
    if (state.selectedId) await selectRecording(state.selectedId, true);
  } catch (error) {
    setHealth(false);
    if (!quiet) showToast(error.message, true);
  }
}

function renderSummary() {
  const { creator, counts } = state.summary;
  elements["creator-name"].textContent = creator.displayName;
  elements["consent-state"].textContent = creator.consentGranted ? "Granted" : "Revoked";
  elements["consent-state"].className = `consent-badge ${creator.consentGranted ? "granted" : "revoked"}`;
  elements["consent-button"].setAttribute("aria-checked", String(creator.consentGranted));
  elements["consent-button"].querySelector("b").textContent = creator.consentGranted ? "Revoke" : "Grant";
  elements["record-button"].disabled = !creator.consentGranted;
  const active = [...activeStatuses].reduce((sum, status) => sum + (counts[status] ?? 0), 0);
  elements["metric-active"].textContent = String(active);
}

function setHealth(healthy) {
  elements["system-health"].className = `health-pill ${healthy ? "healthy" : "unavailable"}`;
  elements["system-health"].lastChild.textContent = healthy ? " Healthy" : " Unavailable";
}

function renderRecordings() {
  const list = elements["recording-list"];
  list.replaceChildren();
  if (!state.recordings.length) {
    const empty = document.createElement("div");
    empty.className = "empty-list";
    empty.textContent = "No public demo recordings yet. The event log is waiting for its first workload.";
    list.append(empty);
    return;
  }
  for (const recording of state.recordings) {
    const card = document.createElement("article");
    card.className = `recording-card${state.selectedId === recording.id ? " selected" : ""}`;
    card.tabIndex = 0;
    card.setAttribute("role", "button");
    card.setAttribute("aria-label", `Inspect recording ${recording.id}`);

    const top = document.createElement("div");
    top.className = "card-top";
    const id = document.createElement("span");
    id.className = "recording-id";
    id.textContent = `REC / ${recording.id.slice(0, 8)}`;
    top.append(id, statusBadge(recording.status));

    const title = document.createElement("h3");
    title.textContent = recording.creatorDisplayName;
    const requested = document.createElement("div");
    requested.className = "requested";
    requested.textContent = formatDate(recording.requestedAt);
    const track = document.createElement("div");
    track.className = "progress-track";
    const fill = document.createElement("span");
    fill.className = `progress-${recording.status.toLowerCase()}`;
    track.append(fill);
    const bottom = document.createElement("div");
    bottom.className = "card-bottom";
    const segments = document.createElement("span");
    segments.textContent = `${recording.segmentCount} SEG`;
    const size = document.createElement("span");
    size.textContent = formatBytes(recording.byteCount);
    bottom.append(segments, size);
    card.append(top, title, requested, track, bottom);
    card.addEventListener("click", () => selectRecording(recording.id));
    card.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        selectRecording(recording.id);
      }
    });
    list.append(card);
  }
}

async function selectRecording(recordingId, quiet = false) {
  state.selectedId = recordingId;
  renderRecordings();
  try {
    const detail = await request(`/api/public/recordings/${recordingId}`);
    renderDetail(detail.recording, detail.timeline);
  } catch (error) {
    if (!quiet) showToast(error.message, true);
  }
}

function renderDetail(recording, timeline) {
  elements["empty-detail"].hidden = true;
  elements["recording-detail"].hidden = false;
  elements["detail-title"].textContent = `Recording ${recording.id.slice(0, 8)}`;
  const badge = elements["detail-status"];
  badge.textContent = statusLabels[recording.status] ?? recording.status;
  badge.className = `status-badge ${recording.status.toLowerCase()}`;
  elements["detail-segments"].textContent = String(recording.segmentCount);
  elements["detail-bytes"].textContent = formatBytes(recording.byteCount);
  elements["detail-duration"].textContent = formatDuration(recording.durationMillis);
  elements["detail-version"].textContent = `v${recording.projectionVersion}`;

  const playback = elements.playback;
  if (recording.playbackAvailable) {
    const mediaUrl = `/api/public/recordings/${recording.id}/media`;
    if (playback.getAttribute("src") !== mediaUrl) playback.setAttribute("src", mediaUrl);
    playback.hidden = false;
  } else {
    playback.pause();
    playback.removeAttribute("src");
    playback.load();
    playback.hidden = true;
  }

  const eventList = elements.timeline;
  eventList.replaceChildren();
  if (!timeline.length) {
    const item = document.createElement("li");
    item.className = "empty-timeline";
    item.textContent = "The request is committed; lifecycle events have not arrived yet.";
    eventList.append(item);
  } else {
    for (const event of timeline) {
      const item = document.createElement("li");
      const sequence = document.createElement("span");
      sequence.textContent = String(event.sequence).padStart(2, "0");
      const type = document.createElement("span");
      type.className = "event-type";
      type.textContent = event.type.replaceAll("_", " ");
      const time = document.createElement("time");
      time.dateTime = event.occurredAt;
      time.textContent = new Date(event.occurredAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
      item.append(sequence, type, time);
      eventList.append(item);
    }
  }
  elements["stop-button"].hidden = !state.authenticated || !activeStatuses.has(recording.status);
}

function statusBadge(status) {
  const badge = document.createElement("span");
  badge.className = `status-badge ${status.toLowerCase()}`;
  badge.textContent = statusLabels[status] ?? status;
  return badge;
}

function openLogin() {
  if (state.authenticated) {
    document.querySelector("#control-room").scrollIntoView({ behavior: "smooth" });
    return;
  }
  elements["login-error"].textContent = "";
  elements["credential-input"].value = "";
  elements["login-dialog"].showModal();
  elements["credential-input"].focus();
}

elements["owner-button"].addEventListener("click", openLogin);
elements["unlock-button"].addEventListener("click", openLogin);
elements["close-dialog"].addEventListener("click", () => elements["login-dialog"].close());
elements["login-form"].addEventListener("submit", async (event) => {
  event.preventDefault();
  const credential = elements["credential-input"].value;
  elements["credential-input"].value = "";
  try {
    const session = await request("/api/operator/session", {
      method: "POST",
      body: JSON.stringify({ credential }),
    });
    setSession(true, session.csrf);
    elements["login-dialog"].close();
    showToast("Owner controls unlocked for this session.");
  } catch (error) {
    elements["login-error"].textContent = error.message;
  }
});
elements["logout-button"].addEventListener("click", async () => {
  try { await request("/api/operator/session", { method: "DELETE" }); } catch { /* expire locally */ }
  setSession(false, null);
  showToast("Owner session ended.");
});
elements["consent-button"].addEventListener("click", async () => {
  if (!state.summary) return;
  const granted = !state.summary.creator.consentGranted;
  elements["consent-button"].disabled = true;
  try {
    await request(`/api/creators/${state.summary.creator.id}/consent`, {
      method: "PUT",
      body: JSON.stringify({ granted, evidence: "Owner-operated synthetic portfolio demonstration" }),
    });
    showToast(granted ? "Creator consent granted." : "Consent revoked; active leases will fail closed.");
    await refreshAll({ quiet: true });
  } catch (error) { showToast(error.message, true); }
  finally { elements["consent-button"].disabled = false; }
});
elements["record-button"].addEventListener("click", async () => {
  elements["record-button"].disabled = true;
  try {
    const result = await request("/api/recordings", {
      method: "POST",
      headers: { "idempotency-key": crypto.randomUUID() },
      body: JSON.stringify({
        creatorId: state.summary.creator.id,
        sourceId: "synthetic-hls",
        maxDurationSeconds: Number(elements["duration-select"].value),
        publicDemo: true,
      }),
    });
    showToast("Recording requested. The outbox now owns delivery.");
    await refreshAll({ quiet: true });
    await selectRecording(result.recording.id, true);
  } catch (error) { showToast(error.message, true); }
  finally { elements["record-button"].disabled = !state.summary?.creator.consentGranted; }
});
elements["stop-button"].addEventListener("click", async () => {
  if (!state.selectedId) return;
  try {
    await request(`/api/recordings/${state.selectedId}/stop`, { method: "POST" });
    showToast("Stop requested. Playback exposure is blocked immediately.");
    await refreshAll({ quiet: true });
  } catch (error) { showToast(error.message, true); }
});
elements["refresh-button"].addEventListener("click", () => refreshAll());

function isSelectedActive() {
  const selected = state.recordings.find((recording) => recording.id === state.selectedId);
  return Boolean(selected && activeStatuses.has(selected.status));
}
function formatDate(value) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(value));
}
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  const index = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  return `${(bytes / 1024 ** index).toFixed(index ? 1 : 0)} ${units[index]}`;
}
function formatDuration(milliseconds) {
  if (!milliseconds) return "0s";
  return `${Math.round(milliseconds / 100) / 10}s`;
}
function showToast(message, error = false) {
  clearTimeout(state.toastTimer);
  elements.toast.textContent = message;
  elements.toast.className = `toast${error ? " error" : ""}`;
  elements.toast.hidden = false;
  state.toastTimer = setTimeout(() => { elements.toast.hidden = true; }, 4_500);
}

await restoreSession();
await refreshAll({ quiet: true });
setInterval(() => refreshAll({ quiet: true }), 4_000);
