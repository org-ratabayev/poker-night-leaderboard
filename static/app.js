/* Poker Night Leaderboard — single-page frontend. Vanilla JS, no deps. */
"use strict";

const $ = (sel) => document.querySelector(sel);

let state = null;
let selectedParticipants = new Set();
let participantsInitialized = false;

// --- Theme (site default from the server, per-browser override) ---

const THEME_KEY = "poker-theme";
let snowLayer = null;

function activeTheme() {
  const personal = localStorage.getItem(THEME_KEY);
  if (personal === "christmas" || personal === "default") return personal;
  return (state && state.siteTheme) || "default";
}

function renderSnow(on) {
  if (!on) {
    if (snowLayer) { snowLayer.remove(); snowLayer = null; }
    return;
  }
  if (snowLayer) return;
  snowLayer = document.createElement("div");
  snowLayer.className = "snow";
  const flakes = ["❄", "❅", "❆", "•"];
  for (let i = 0; i < 28; i++) {
    const flake = document.createElement("span");
    flake.textContent = flakes[i % flakes.length];
    flake.style.left = `${Math.random() * 100}%`;
    flake.style.animationDuration = `${6 + Math.random() * 10}s`;
    flake.style.animationDelay = `${-Math.random() * 14}s`;
    flake.style.fontSize = `${0.55 + Math.random() * 1.1}rem`;
    flake.style.opacity = `${0.3 + Math.random() * 0.5}`;
    snowLayer.appendChild(flake);
  }
  document.body.appendChild(snowLayer);
}

function applyTheme() {
  const theme = activeTheme();
  const christmas = theme === "christmas";
  document.body.classList.toggle("theme-christmas", christmas);
  renderSnow(christmas);
  const btn = $("#theme-btn");
  if (btn) {
    btn.textContent = christmas ? "🃏" : "🎄";
    btn.title = christmas ? "Switch to the classic table" : "Switch to the Christmas theme";
  }
}

// --- Helpers ---

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  }[c]));
}

function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** Round avatar bubble: the character emoji on a colour derived from the nickname. */
function avatarHtml(name, avatar, size = "md") {
  const hue = [...String(name)].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 0) % 360;
  return `<span class="avatar avatar-${size}" style="--hue:${hue}" title="${esc(name)}">${esc(avatar || "🃏")}</span>`;
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

async function reload() {
  state = await api("/api/state");
  participantsInitialized = false;
  selectedParticipants = new Set();
  render();
}

function isAdmin() {
  return !!(state && state.me && state.me.isAdmin);
}

function liveGame() {
  return state && state.activeSeason ? state.activeSeason.runningGame : null;
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
  if (!state.me) { box.innerHTML = ""; return; }
  const admin = state.me.isAdmin ? " <span class='admin-badge'>admin</span>" : "";
  box.innerHTML =
    `<span class="name-cell">${avatarHtml(state.me.name, state.me.avatar)} <span>${esc(state.me.name)}</span>${admin}</span>` +
    `<button class="ghost small" id="logout-btn">Log out</button>`;
  $("#logout-btn").addEventListener("click", async () => {
    await api("/api/auth/logout", { method: "POST" });
    state = await api("/api/state");
    render();
  });
}

function renderSeasonLabel() {
  const s = state.activeSeason;
  $("#season-label").textContent = s
    ? `${s.name} — ${s.games.length} game(s), ${s.standings.length} players`
    : "No active season";
}

function renderStandings() {
  const s = state.activeSeason;
  const body = $("#standings-body");
  const empty = $("#standings-empty");
  const banner = $("#champion-banner");
  const live = liveGame();

  if (!s || s.standings.length === 0) {
    body.innerHTML = "";
    empty.classList.remove("hidden");
    banner.innerHTML = live ? liveBanner(live) : "";
    if (live) bindLiveBanner();
    return;
  }
  empty.classList.add("hidden");
  body.innerHTML = s.standings
    .map((row, i) => {
      const rank = i + 1;
      const medal = rank === 1 ? "🥇" : rank === 2 ? "🥈" : rank === 3 ? "🥉" : rank;
      return `<tr class="${rank === 1 ? "rank-1" : ""}">
        <td><span class="pos">${medal}</span></td>
        <td><span class="name-cell">${avatarHtml(row.player.name, row.player.avatar)} ${esc(row.player.name)}</span></td>
        <td>${row.games}</td>
        <td>${row.bets ? row.bets : "—"}</td>
        <td class="num">${row.points}</td>
      </tr>`;
    })
    .join("");

  const champion = s.standings[0];
  const prize = s.prize ? ` · ${esc(s.prize)}` : "";
  banner.innerHTML =
    (live ? liveBanner(live) : "") +
    `<div class="champion-banner">
      <div class="trophy">🏆</div>
      <div>
        <div class="title">${esc(champion.player.name)} leads the season</div>
        <div class="prize">${champion.points} pts in ${champion.games} game(s)${prize}</div>
      </div>
    </div>`;
  if (live) bindLiveBanner();
}

function liveBanner(live) {
  return `<div class="live-banner" id="live-banner">
    <span class="live-dot">🔴</span>
    <span><b>Live game in progress</b> — ${live.remaining.length} of ${live.totalPlayers} players left</span>
    <button class="ghost small" id="go-live">watch</button>
  </div>`;
}

function bindLiveBanner() {
  const btn = $("#go-live");
  if (btn) btn.addEventListener("click", () => switchTab("games"));
}

// --- Games: live tournament ---

function renderGames() {
  const live = liveGame();
  const admin = isAdmin();
  const todayHasGame = !!state.todayHasGame;

  $("#live-panel").classList.toggle("hidden", !live);
  $("#start-panel").classList.toggle("hidden", !(admin && !live && !todayHasGame));
  $("#no-game-panel").classList.toggle("hidden", !!live || (admin && !todayHasGame));

  if (live) renderLive(live, admin);
  if (admin && !live && !todayHasGame) renderStartForm();
  if (!live) {
    $("#no-game-text").textContent = todayHasGame
      ? "Today's game is already recorded. See the history below."
      : "No game in progress. The admin starts the game at the table.";
  }
  renderHistory();
}

function renderLive(live, admin) {
  $("#live-date").textContent = `· ${live.date}`;
  $("#live-hint").textContent = admin
    ? "Tap “Eliminated” when a player busts out. The last one standing wins."
    : "Watch live — the admin marks players as they bust out.";

  $("#live-remaining").innerHTML =
    `<h3>Still in (${live.remaining.length})</h3>` +
    live.remaining
      .map(
        (p) => `<div class="player-item">
          <span class="name-cell">${avatarHtml(p.name, p.avatar)} ${esc(p.name)}</span>
          ${admin ? `<button class="danger small elim-btn" data-id="${p.id}" data-name="${esc(p.name)}">Eliminated</button>` : ""}
        </div>`,
      )
      .join("");

  $("#live-eliminated").innerHTML = live.eliminated.length
    ? `<h3>Out</h3>` +
      live.eliminated
        .map(
          (e) => `<div class="player-item muted-line">
            <span class="name-cell">${avatarHtml(e.name, e.avatar, "sm")} ${esc(e.name)}</span>
            <span class="muted">${ordinal(e.position)} place</span>
          </div>`,
        )
        .join("")
    : "";

  $("#live-actions").innerHTML = admin
    ? `<button class="ghost" id="undo-btn">Undo last step</button>`
    : "";

  renderLiveBets(live);

  if (admin) {
    $("#live-remaining").querySelectorAll(".elim-btn").forEach((btn) =>
      btn.addEventListener("click", async () => {
        if (!confirm(`Mark ${btn.dataset.name} as eliminated?`)) return;
        try {
          await api(`/api/games/${live.id}/eliminate`, {
            method: "POST",
            body: JSON.stringify({ playerId: Number(btn.dataset.id) }),
          });
          await reload();
        } catch (err) { $("#live-error").textContent = err.message; }
      }),
    );
    const undo = $("#undo-btn");
    if (undo) undo.addEventListener("click", async () => {
      if (!confirm("Undo the last step?")) return;
      try {
        await api(`/api/games/${live.id}/undo`, { method: "POST" });
        await reload();
      } catch (err) { $("#live-error").textContent = err.message; }
    });
  }
}

function renderLiveBets(live) {
  const host = $("#live-bets");
  const b = live.bets;
  const me = state.me;
  if (!b || !me) { host.innerHTML = ""; return; }
  const row = (state.activeSeason.standings || []).find((r) => r.player.id === me.id);
  const myPoints = row ? row.points : 0;

  let html = "";
  if (b.open) {
    // Everyone can bet on anyone still in the game — including themselves.
    const options = live.remaining
      .map((p) => `<option value="${p.id}">${esc(p.name)}${p.id === me.id ? " (you)" : ""}</option>`)
      .join("");
    if (!options) {
      html = `<p class="muted small">Nobody left to bet on.</p>`;
    } else if (myPoints < 5) {
      html = `<p class="muted small">Betting needs at least 5 points (you have ${myPoints}).</p>`;
    } else {
      html = `<h3>🎲 Bets — open until the first bust-out</h3>
        <div class="bet-form">
          <select id="bet-player">${options}</select>
          <input id="bet-stake" type="number" min="5" max="100" step="1" value="10" title="Stake (5–100 points)">
          <button class="primary small" id="bet-btn">Place bet</button>
        </div>
        <p class="muted small">Your balance: ${myPoints} pts · who bet on whom stays hidden until the lock.</p>`;
    }
  } else {
    html = `<h3>🎲 Bets — locked</h3>`;
    if (b.all && b.all.length) {
      html += `<div class="bet-list">${b.all
        .map(
          (x) =>
            `<div class="bet-item"><span class="name-cell">${avatarHtml(x.bettorName, x.bettorAvatar, "sm")} ${esc(x.bettorName)} → ${avatarHtml(x.onName, x.onAvatar, "sm")} <b>${esc(x.onName)}</b></span><span class="muted">${x.stake} pts</span></div>`,
        )
        .join("")}</div><p class="muted small">Pool: ${b.pool} pts</p>`;
    } else {
      html += `<p class="muted small">No bets were placed before the lock.</p>`;
    }
  }

  if (b.mine && b.mine.length) {
    html += `<h3>Your bets</h3><div class="bet-list">${b.mine
      .map(
        (x) =>
          `<div class="bet-item"><span class="name-cell">on ${avatarHtml(x.onName, x.onAvatar, "sm")} <b>${esc(x.onName)}</b></span><span class="muted">${x.stake} pts</span></div>`,
      )
      .join("")}</div>`;
  }
  host.innerHTML = html;

  const btn = $("#bet-btn");
  if (btn) {
    btn.addEventListener("click", async () => {
      try {
        await api(`/api/games/${live.id}/bets`, {
          method: "POST",
          body: JSON.stringify({
            onPlayerId: Number($("#bet-player").value),
            stake: Number($("#bet-stake").value),
          }),
        });
        await reload();
      } catch (err) { $("#live-error").textContent = err.message; }
    });
  }
}

function renderStartForm() {
  const players = state.players || [];
  if (!participantsInitialized) {
    selectedParticipants = new Set(players.map((p) => p.id));
    participantsInitialized = true;
  }
  if (players.length < 2) {
    $("#participants").innerHTML = `<p class="muted">At least 2 registered players are needed.</p>`;
    $("#start-game-btn").disabled = true;
    return;
  }
  $("#start-game-btn").disabled = false;
  $("#participants").innerHTML = players
    .map(
      (p) => `<label class="check-row">
        <input type="checkbox" class="part-check" value="${p.id}" ${selectedParticipants.has(p.id) ? "checked" : ""}>
        <span>${esc(p.name)}</span>
      </label>`,
    )
    .join("");
  $("#participants").querySelectorAll(".part-check").forEach((cb) =>
    cb.addEventListener("change", () => {
      const id = Number(cb.value);
      if (cb.checked) selectedParticipants.add(id);
      else selectedParticipants.delete(id);
    }),
  );
}

function renderHistory() {
  const s = state.activeSeason;
  const host = $("#game-history");
  if (!s || s.games.length === 0) {
    host.innerHTML = `<p class="muted">No completed games yet this season.</p>`;
    return;
  }
  host.innerHTML = s.games
    .map(
      (g) => `<div class="game-card">
        <div class="ghead">
          <span class="gdate">${esc(g.date)}${g.createdBy ? ` · started by ${esc(g.createdBy)}` : ""}</span>
          ${isAdmin() ? `<button class="danger small game-del" data-id="${g.id}">Delete</button>` : ""}
        </div>
        <div class="gresults">
          ${g.results.map((r) => `<div class="name-cell">${avatarHtml(r.name, r.avatar, "sm")} <span><b>${r.position}.</b> ${esc(r.name)}</span> <span class="pts">+${r.points}</span></div>`).join("")}
        </div>
        ${(g.bets && g.bets.length)
          ? `<div class="gbets"><h4>🎲 Bets</h4>${g.bets
              .map((b) => {
                const outcome =
                  b.payout === 0 ? "lost" : b.payout > b.stake ? `won +${b.payout - b.stake}` : "returned";
                return `<div class="bet-item"><span class="name-cell">${avatarHtml(b.bettorName, b.bettorAvatar, "sm")} ${esc(b.bettorName)} → ${avatarHtml(b.onName, b.onAvatar, "sm")} <b>${esc(b.onName)}</b></span><span class="muted">${b.stake} pts · ${outcome}</span></div>`;
              })
              .join("")}</div>`
          : ""}
        ${g.notes ? `<div class="gnotes">${esc(g.notes)}</div>` : ""}
      </div>`,
    )
    .join("");
  host.querySelectorAll(".game-del").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm("Delete this game and its points?")) return;
      await api(`/api/games/${btn.dataset.id}`, { method: "DELETE" });
      await reload();
    }),
  );
}

// --- Seasons ---

function renderSeasons() {
  const list = $("#season-list");
  list.innerHTML = state.seasons
    .map(
      (s) => `<div class="season-item">
        <div>
          <div class="sname">${esc(s.name)}${s.archived ? "" : " <span class='admin-badge'>active</span>"}</div>
          <div class="smeta">${s.champion ? `🏆 Champion: ${esc(s.champion.name)}` : "No champion yet"}${s.prize ? ` · ${esc(s.prize)}` : ""}</div>
        </div>
        ${isAdmin() && !s.archived ? `<button class="ghost small season-archive" data-id="${s.id}">Archive</button>` : ""}
      </div>`,
    )
    .join("");
  list.querySelectorAll(".season-archive").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (!confirm("Archive this season? A new season will start automatically.")) return;
      await api(`/api/seasons/${btn.dataset.id}/archive`, { method: "POST" });
      await reload();
    }),
  );
  $("#season-form").classList.toggle("hidden", !isAdmin());

  // Site theme controls (admin)
  const themePanel = $("#site-theme-panel");
  if (themePanel) {
    themePanel.classList.toggle("hidden", !isAdmin());
    const setting = state.siteThemeSetting || "auto";
    themePanel.querySelectorAll(".theme-set").forEach((b) => {
      b.classList.toggle("active", b.dataset.theme === setting);
    });
  }
}

// --- Players ---

function renderPlayers() {
  const list = $("#player-list");
  if (!state.me) { list.innerHTML = ""; return; }
  const admin = isAdmin();
  list.innerHTML = state.players
    .map(
      (p) => `<div class="player-item">
        <span class="name-cell">${avatarHtml(p.name, p.avatar)} <span>${esc(p.name)}</span>${p.isAdmin ? " <span class='admin-badge'>admin</span>" : ""}</span>
        ${admin ? `<span>
            <input type="text" class="rename-input" data-id="${p.id}" value="${esc(p.name)}" maxlength="30" style="width:140px;margin-top:0">
            <button class="ghost small rename-btn" data-id="${p.id}">Rename</button>
            <button class="ghost small avatar-btn" data-id="${p.id}" title="Change avatar">🎭</button>
            ${p.id !== state.me.id ? `<button class="ghost small admin-toggle" data-id="${p.id}" data-admin="${p.isAdmin ? 1 : 0}">${p.isAdmin ? "Revoke admin" : "Make admin"}</button>` : ""}
          </span>` : ""}
      </div>`,
    )
    .join("");
  list.querySelectorAll(".rename-btn").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const input = list.querySelector(`.rename-input[data-id="${btn.dataset.id}"]`);
      await api(`/api/players/${btn.dataset.id}/rename`, { method: "POST", body: JSON.stringify({ name: input.value }) });
      await reload();
    }),
  );
  list.querySelectorAll(".admin-toggle").forEach((btn) =>
    btn.addEventListener("click", async () => {
      await api(`/api/players/${btn.dataset.id}/admin`, {
        method: "POST",
        body: JSON.stringify({ isAdmin: btn.dataset.admin === "0" }),
      });
      await reload();
    }),
  );
  list.querySelectorAll(".avatar-btn").forEach((btn) =>
    btn.addEventListener("click", () => {
      avatarTarget = Number(btn.dataset.id);
      renderAvatarPanel();
      $("#avatar-panel").scrollIntoView({ behavior: "smooth", block: "start" });
    }),
  );
}

// --- Avatars ---

let avatarTarget = null; // player id whose avatar is being edited (null = me)

function renderAvatarPanel() {
  const panel = $("#avatar-panel");
  const me = state.me;
  if (!panel || !me) return;
  const target = avatarTarget ?? me.id;
  const player = (state.players || []).find((p) => p.id === target) || me;
  const isSelf = player.id === me.id;

  $("#avatar-title").textContent = isSelf ? "🎭 Your avatar" : `🎭 Avatar for ${player.name}`;
  $("#avatar-current").innerHTML =
    avatarHtml(player.name, player.avatar, "lg") +
    `<span class="muted small">${esc(player.name)} — ${isSelf ? "this is you" : "editing as admin"}</span>`;

  const avatars = state.avatars || [];
  $("#avatar-grid").innerHTML = avatars
    .map(
      (a) =>
        `<button class="avatar-pick${a === player.avatar ? " active" : ""}" data-avatar="${a}" title="${a}">${a}</button>`,
    )
    .join("");
  $("#avatar-grid").querySelectorAll(".avatar-pick").forEach((btn) =>
    btn.addEventListener("click", () => saveAvatar(target, btn.dataset.avatar)),
  );
  $("#avatar-auto").onclick = () => saveAvatar(target, null);
  $("#avatar-random").onclick = () => {
    if (avatars.length === 0) return;
    saveAvatar(target, avatars[Math.floor(Math.random() * avatars.length)]);
  };
}

async function saveAvatar(playerId, avatar) {
  try {
    await api(`/api/players/${playerId}/avatar`, {
      method: "POST",
      body: JSON.stringify({ avatar }),
    });
    avatarTarget = null;
    await reload();
  } catch (err) {
    $("#avatar-title").textContent = `🎭 ${err.message}`;
  }
}

// --- Root render ---

function render() {
  applyTheme();
  renderUserbox();
  renderSeasonLabel();
  if (!state.me) { showAuth(); return; }
  showApp();
  renderStandings();
  renderGames();
  renderSeasons();
  renderPlayers();
  renderAvatarPanel();
}

// --- Events ---

function bindEvents() {
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
      await reload();
    } catch (err) { $("#login-error").textContent = err.message; }
  });

  $("#register-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/auth/register", {
        method: "POST",
        body: JSON.stringify({ name: $("#reg-name").value, password: $("#reg-password").value, invite: $("#reg-invite").value }),
      });
      await reload();
    } catch (err) { $("#register-error").textContent = err.message; }
  });

  document.querySelectorAll(".tab").forEach((t) => t.addEventListener("click", () => switchTab(t.dataset.tab)));

  // Personal theme toggle (this browser only)
  $("#theme-btn").addEventListener("click", () => {
    const next = activeTheme() === "christmas" ? "default" : "christmas";
    localStorage.setItem(THEME_KEY, next);
    applyTheme();
  });

  // Site-wide theme (admin). Selecting one clears the local override.
  document.querySelectorAll(".theme-set").forEach((btn) =>
    btn.addEventListener("click", async () => {
      try {
        await api("/api/settings/theme", {
          method: "POST",
          body: JSON.stringify({ theme: btn.dataset.theme }),
        });
        localStorage.removeItem(THEME_KEY);
        await reload();
      } catch (err) { /* non-admins never see these buttons */ }
    }),
  );

  $("#start-game-btn").addEventListener("click", async () => {
    try {
      await api("/api/games", {
        method: "POST",
        body: JSON.stringify({
          participants: [...selectedParticipants],
          notes: $("#game-notes").value,
        }),
      });
      $("#game-notes").value = "";
      await reload();
    } catch (err) { $("#start-error").textContent = err.message; }
  });

  $("#season-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    try {
      await api("/api/seasons", {
        method: "POST",
        body: JSON.stringify({ name: $("#season-name").value || undefined, prize: $("#season-prize").value }),
      });
      $("#season-name").value = "";
      $("#season-prize").value = "";
      await reload();
    } catch (err) { $("#season-error").textContent = err.message; }
  });
}

// --- Live updates for observers (and the admin's other devices) ---

async function refreshState() {
  if (document.hidden) return;
  try {
    const fresh = await api("/api/state");
    const wasLive = !!liveGame();
    const nowLive = !!(fresh.activeSeason && fresh.activeSeason.runningGame);
    state = fresh;
    if (wasLive || nowLive) render();
    else { renderStandings(); renderSeasonLabel(); }
  } catch { /* transient network hiccup — retry on next tick */ }
}

// --- Boot ---

(async function boot() {
  state = await api("/api/state"); // must be set BEFORE bindEvents (render reads state)
  bindEvents();
  render();
  setInterval(refreshState, 10000);
})().catch((err) => {
  console.error(err);
  document.body.innerHTML = `<main><div class="panel"><h2>Failed to load</h2><p>${esc(err.message)}</p></div></main>`;
});
