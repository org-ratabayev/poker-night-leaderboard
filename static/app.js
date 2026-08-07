/* Poker Night Leaderboard — single-page frontend. Vanilla JS, no deps. */
"use strict";

const $ = (sel) => document.querySelector(sel);

let state = null;

// --- Helpers ---

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: "same-origin",
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  let body = null;
  try { body = await res.json(); } catch { /* empty */ }
  if (!res.ok) {
    const msg = (body && body.error) || `Request failed (${res.status})`;
    throw new Error(msg);
  }
  return body;
}

function today() {
  return new Date().toISOString().slice(0, 10);
}

// --- Views ---

function showAuth() {
  $("#auth-view").classList.remove("hidden");
  $("#app-view").classList.add("hidden");
}

function showApp() {
  $("#auth-view").classList.add("hidden");
  $("#app-view").classList.remove("hidden");
}

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.tab === name));
  document.querySelectorAll(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${name}`));
}

function renderUserbox() {
  const box = $("#userbox");
  if (!state.me) {
    box.innerHTML = "";
    return;
  }
  const admin = state.me.isAdmin ? " <span class='admin-badge'>admin</span>" : "";
  box.innerHTML =
    `<span>👤 ${esc(state.me.name)}${admin}</span>` +
    `<button class="ghost small" id="logout-btn">Log out</button>`;
  $("#logout-btn").addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" });
    state = await api("/api/state");
    render();
  });
}

function renderSeasonLabel() {
  const s = state.activeSeason;
  $("#season-label").textContent = s ? `${s.name} — ${s.games.length} game(s), ${s.standings.length} players` : "No active season";
}

function renderStandings() {
  const s = state.activeSeason;
  const body = $("#standings-body");
  const empty = $("#standings-empty");
  const banner = $("#champion-banner");

  if (!s || s.standings.length === 0) {
    body.innerHTML = "";
    empty.classList.remove("hidden");
    banner.innerHTML = "";
    return;
  }
  empty.classList.add("hidden");
  body.innerHTML = s.standings
    .map((row, i) => {
      const rank = i + 1;
      const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : rank;
      return `<tr class="${rank === 1 ? "rank-1" : ""}">
        <td><span class="pos">${medal}</span></td>
        <td>${esc(row.player.name)}</td>
        <td>${row.games}</td>
        <td class="num">${row.points}</td>
      </tr>`;
    })
    .join("");

  const champion = s.standings[0];
  const prize = s.prize ? ` · ${esc(s.prize)}` : "";
  banner.innerHTML = `
    <div class="champion-banner">
      <div class="trophy">🏆</div>
      <div>
        <div class="title">${esc(champion.player.name)} leads the season</div>
        <div class="prize">${champion.points} pts in ${champion.games} game(s)${prize}</div>
      </div>
    </div>`;
}

// --- Games ---

function gameRowsHtml() {
  const rows = $("#game-rows");
  const players = (state && state.players) || [];
  if (players.length === 0) return; // no registered players yet — nothing to add a row for
  const n = rows.querySelectorAll(".game-row").length;
  const options = players
    .map((p) => `<option value="${p.id}">${esc(p.name)}</option>`)
    .join("");
  const div = document.createElement("div");
  div.className = "game-row";
  div.innerHTML = `
    <span class="pos-badge">${n + 1}</span>
    <select class="game-player">${options}</select>
    <button type="button" class="danger small game-remove" ${n === 0 ? "disabled" : ""}>✕</button>`;
  rows.appendChild(div);
  div.querySelector(".game-remove").addEventListener("click", () => {
    div.remove();
    renumberRows();
  });
}

function renumberRows() {
  document.querySelectorAll("#game-rows .pos-badge").forEach((b, i) => {
    b.textContent = i + 1;
    const btn = b.closest(".game-row").querySelector(".game-remove");
    btn.disabled = i === 0;
  });
}

function renderGameHistory() {
  const s = state.activeSeason;
  const host = $("#game-history");
  if (!s || s.games.length === 0) {
    host.innerHTML = `<p class="muted">No games yet this season.</p>`;
    return;
  }
  host.innerHTML = s.games
    .map((g) => `
      <div class="game-card">
        <div class="ghead">
          <span class="gdate">${esc(g.date)}${g.createdBy ? ` · by ${esc(g.createdBy)}` : ""}</span>
          ${canDeleteGame(g) ? `<button class="danger small game-del" data-id="${g.id}">Delete</button>` : ""}
        </div>
        <div class="gresults">
          ${g.results.map((r) => `<div><b>${r.position}.</b> ${esc(r.name)} <span class="pts">+${r.points}</span></div>`).join("")}
        </div>
        ${g.notes ? `<div class="gnotes">${esc(g.notes)}</div>` : ""}
      </div>`)
    .join("");
  host.querySelectorAll(".game-del").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this game and its points?")) return;
      await api(`/api/games/${btn.dataset.id}`, { method: "DELETE" });
      state = await api("/api/state");
      render();
    }),
  );
}

function canDeleteGame(g) {
  if (!state.me) return false;
  return state.me.isAdmin || g.createdBy === state.me.name;
}

// --- Seasons ---

function renderSeasons() {
  const list = $("#season-list");
  list.innerHTML = state.seasons
    .map((s) => `
      <div class="season-item">
        <div>
          <div class="sname">${esc(s.name)}${s.archived ? "" : " <span class='admin-badge'>active</span>"}</div>
          <div class="smeta">${s.champion ? `🏆 Champion: ${esc(s.champion.name)}` : "No champion yet"}${s.prize ? ` · ${esc(s.prize)}` : ""}</div>
        </div>
        ${state.me && state.me.isAdmin && !s.archived ? `<button class="ghost small season-archive" data-id="${s.id}">Archive</button>` : ""}
      </div>`)
    .join("");
  list.querySelectorAll(".season-archive").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm("Archive this season? A new season will start automatically.")) return;
      await api(`/api/seasons/${btn.dataset.id}/archive`, { method: "POST" });
      state = await api("/api/state");
      render();
    }),
  );
  $("#season-form").classList.toggle("hidden", !(state.me && state.me.isAdmin));
}

// --- Players ---

function renderPlayers() {
  const list = $("#player-list");
  if (!state.me) { list.innerHTML = ""; return; }
  const isAdmin = state.me.isAdmin;
  list.innerHTML = state.players
    .map((p) => `
      <div class="player-item">
        <span>${esc(p.name)}${p.isAdmin ? " <span class='admin-badge'>admin</span>" : ""}</span>
        ${isAdmin ? `
          <span>
            <input type="text" class="rename-input" data-id="${p.id}" value="${esc(p.name)}" maxlength="30" style="width:140px;margin-top:0">
            <button class="ghost small rename-btn" data-id="${p.id}">Rename</button>
            ${p.id !== state.me.id ? `<button class="ghost small admin-toggle" data-id="${p.id}" data-admin="${p.isAdmin ? 1 : 0}">${p.isAdmin ? "Revoke admin" : "Make admin"}</button>` : ""}
          </span>` : ""}
      </div>`)
    .join("");
  list.querySelectorAll(".rename-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const input = list.querySelector(`.rename-input[data-id="${btn.dataset.id}"]`);
      await api(`/api/players/${btn.dataset.id}/rename`, { method: "POST", body: JSON.stringify({ name: input.value }) });
      state = await api("/api/state");
      render();
    }),
  );
  list.querySelectorAll(".admin-toggle").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await api(`/api/players/${btn.dataset.id}/admin`, { method: "POST", body: JSON.stringify({ isAdmin: btn.dataset.admin === "0" }) });
      state = await api("/api/state");
      render();
    }),
  );
}

// --- Root render ---

function render() {
  renderUserbox();
  renderSeasonLabel();
  if (!state.me) { showAuth(); return; }
  showApp();
  renderStandings();
  renderGameHistory();
  renderSeasons();
  renderPlayers();
}

// --- Events ---

function bindEvents() {
  // auth tabs
  $("#tab-login").addEventListener("click", () => {
    $("#tab-login").classList.add("active");
    $("#tab-register").classList.remove("active");
    $("#login-form").classList.remove("hidden");
    $("#register-form").classList.add("hidden");
  });
  $("#tab-register").addEventListener("click", () => {
    $("#tab-register").classList.add("active");
    $("#tab-login").classList.remove("active");
    $("#register-form").classList.remove("hidden");
    $("#login-form").classList.add("hidden");
  });

  $("#login-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ name: $("#login-name").value, password: $("#login-password").value }),
      });
      state = await api("/api/state");
      render();
    } catch (err) { $("#login-error").textContent = err.message; }
  });

  $("#register-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({ name: $("#reg-name").value, password: $("#reg-password").value, invite: $("#reg-invite").value }),
      });
      state = await api("/api/state");
      render();
    } catch (err) { $("#register-error").textContent = err.message; }
  });

  // app tabs
  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));

  // game form
  $("#game-date").value = today();
  $("#add-row").addEventListener("click", gameRowsHtml);
  gameRowsHtml(); // start with one row

  $("#game-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const rows = [...document.querySelectorAll("#game-rows .game-row")];
    const results = rows
      .map((row, i) => ({ playerId: Number(row.querySelector(".game-player").value), position: i + 1 }))
      .filter((r) => Number.isFinite(r.playerId));
    try {
      await api("/api/games", {
        method: "POST",
        body: JSON.stringify({ date: $("#game-date").value, notes: $("#game-notes").value, results }),
      });
      $("#game-notes").value = "";
      $("#game-date").value = today();
      state = await api("/api/state");
      render();
      renderGameHistory();
      switchTab("standings");
    } catch (err) { $("#game-error").textContent = err.message; }
  });

  // season form
  $("#season-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/seasons", {
        method: "POST",
        body: JSON.stringify({ name: $("#season-name").value || undefined, prize: $("#season-prize").value }),
      });
      $("#season-name").value = "";
      $("#season-prize").value = "";
      state = await api("/api/state");
      render();
    } catch (err) { $("#season-error").textContent = err.message; }
  });
}

// --- Boot ---

(async function boot() {
  state = await api("/api/state"); // must be set BEFORE bindEvents (gameRowsHtml reads state.players)
  bindEvents();
  render();
})().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<main><div class="panel"><h2>Failed to load</h2><p>${esc(err.message)}</p></div></main>`;
});
