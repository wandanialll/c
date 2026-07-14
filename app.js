// ===================== CONFIG =====================
// Replace these with your jsonbin.io values
const JSONBIN_BIN_ID = "6a561a0cf5f4af5e298d030b";          // e.g. "66a1b2c3d4e5f6789012345"
const JSONBIN_ACCESS_KEY = "$2a$10$hJpj7P4R4ZhgWxDdP3x76ubEg99upVUxanYYNmKKRtNKdmrWmyJbe";  // X-Access-Key with Read + Update
const JSONBIN_BASE = "https://api.jsonbin.io/v3/b";

// Admin password (simple protection for writes). Change this!
const ADMIN_PASSWORD = "chessadmin";

// ==================================================

let players = [];
let settings = {};
let pairings = [];       // source of truth from bin: array of match objects
let isAdmin = false;
let currentTab = "standings";
let sortCol = "score";
let sortDir = -1;

// ---------- Utils ----------
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

function uid() {
  return "m" + Math.random().toString(36).slice(2, 11);
}

function expectedScore(ra, rb) {
  return 1 / (1 + Math.pow(10, (rb - ra) / 400));
}

// Normalize pair key so order doesn't matter
function pairKey(id1, id2) {
  return [id1, id2].sort().join("|");
}

// ---------- Generate all unique pairings (handles odd/even perfectly) ----------
function generateAllPairings(playerIds) {
  const result = [];
  for (let i = 0; i < playerIds.length; i++) {
    for (let j = i + 1; j < playerIds.length; j++) {
      const a = playerIds[i];
      const b = playerIds[j];
      result.push({
        id: uid(),
        playerA: a,
        playerB: b,
        // Two games / sets: colors swapped
        games: [
          { white: a, black: b, result: null, playedDate: null },
          { white: b, black: a, result: null, playedDate: null }
        ]
      });
    }
  }
  return result;
}

// ---------- Elo + Stats ----------
function computeEloAndStats() {
  // Flatten completed games in storage order
  const orderedGames = [];
  pairings.forEach(p => {
    p.games.forEach(g => {
      if (g.result) {
        orderedGames.push({
          white: g.white,
          black: g.black,
          result: g.result
        });
      }
    });
  });

  const elos = {};
  players.forEach(p => elos[p.id] = settings.initialElo || 1200);

  orderedGames.forEach(g => {
    const ra = elos[g.white];
    const rb = elos[g.black];
    const ea = expectedScore(ra, rb);
    let sa = 0.5;
    if (g.result === "1-0") sa = 1;
    else if (g.result === "0-1") sa = 0;
    const k = settings.kFactor || 32;
    elos[g.white] = Math.round(ra + k * (sa - ea));
    elos[g.black] = Math.round(rb + k * ((1 - sa) - (1 - ea)));
  });

  const stats = {};
  players.forEach(p => {
    stats[p.id] = {
      id: p.id,
      name: p.name,
      games: 0,
      matches: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      score: 0,
      elo: elos[p.id],
      delta: elos[p.id] - (settings.initialElo || 1200),
      opponents: new Set(),
      buchholz: 0
    };
  });

  pairings.forEach(p => {
    let matchHasResult = false;
    p.games.forEach(g => {
      if (!g.result) return;
      matchHasResult = true;
      const w = stats[g.white];
      const b = stats[g.black];
      if (!w || !b) return;
      w.games++; b.games++;
      w.opponents.add(g.black);
      b.opponents.add(g.white);

      if (g.result === "1-0") {
        w.wins++; w.score += 1;
        b.losses++;
      } else if (g.result === "0-1") {
        b.wins++; b.score += 1;
        w.losses++;
      } else {
        w.draws++; b.draws++;
        w.score += 0.5; b.score += 0.5;
      }
    });
    if (matchHasResult) {
      if (stats[p.playerA]) stats[p.playerA].matches++;
      if (stats[p.playerB]) stats[p.playerB].matches++;
    }
  });

  Object.values(stats).forEach(s => {
    s.opponents = Array.from(s.opponents);
    s.buchholz = s.opponents.reduce((sum, oid) => sum + (stats[oid]?.score || 0), 0);
  });

  return { stats, elos };
}

// ---------- Data Loading ----------
async function loadLocalData() {
  const [pRes, sRes] = await Promise.all([
    fetch("data/players.json"),
    fetch("data/settings.json")
  ]);
  players = (await pRes.json()).players;
  settings = await sRes.json();
}

async function loadPairings() {
  if (JSONBIN_BIN_ID === "YOUR_BIN_ID_HERE") {
    console.warn("jsonbin not configured – starting empty");
    pairings = [];
    return;
  }
  try {
    const res = await fetch(`${JSONBIN_BASE}/${JSONBIN_BIN_ID}/latest`, {
      headers: {
        "X-Access-Key": JSONBIN_ACCESS_KEY,
        "X-Bin-Meta": "false"
      }
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const record = data.record || data;
    pairings = record.pairings || record.matches || [];
  } catch (e) {
    console.error("Failed to load:", e);
    pairings = [];
    showStatus("Could not load from jsonbin. Starting empty.", "err");
  }
}

async function savePairings() {
  if (JSONBIN_BIN_ID === "YOUR_BIN_ID_HERE") {
    showStatus("jsonbin not configured. Changes local only.", "info");
    return false;
  }
  if (!isAdmin) {
    showStatus("Admin login required to save.", "err");
    return false;
  }
  try {
    const body = {
      pairings,
      meta: {
        lastUpdated: new Date().toISOString(),
        version: Date.now()
      }
    };
    const res = await fetch(`${JSONBIN_BASE}/${JSONBIN_BIN_ID}`, {
      method: "PUT",
      headers: {
        "Content-Type": "application/json",
        "X-Access-Key": JSONBIN_ACCESS_KEY,
        "X-Bin-Versioning": "false"
      },
      body: JSON.stringify(body)
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    showStatus("Saved successfully!", "ok");
    return true;
  } catch (e) {
    console.error(e);
    showStatus("Save failed: " + e.message, "err");
    return false;
  }
}

// Merge generated + saved results (works for any N, even or odd)
function ensurePairings() {
  const playerIds = players.map(p => p.id);
  const generated = generateAllPairings(playerIds);

  const savedMap = {};
  pairings.forEach(p => {
    const key = pairKey(p.playerA || p.white || "", p.playerB || p.black || "");
    if (key.includes("|")) savedMap[key] = p;
  });

  const newPairings = generated.map(g => {
    const key = pairKey(g.playerA, g.playerB);
    const saved = savedMap[key];
    if (saved && saved.games && Array.isArray(saved.games)) {
      const games = [
        { white: g.playerA, black: g.playerB, result: null, playedDate: null },
        { white: g.playerB, black: g.playerA, result: null, playedDate: null }
      ];
      saved.games.forEach(sg => {
        const idx = games.findIndex(x => x.white === sg.white && x.black === sg.black);
        if (idx >= 0) {
          games[idx].result = sg.result || null;
          games[idx].playedDate = sg.playedDate || null;
        }
      });
      return {
        id: saved.id || g.id,
        playerA: g.playerA,
        playerB: g.playerB,
        games
      };
    }
    return g;
  });

  pairings = newPairings;
  return pairings;
}

// ---------- Rendering ----------
function showStatus(msg, type = "info") {
  const el = $("#status");
  if (!el) return;
  el.textContent = msg;
  el.className = `status ${type}`;
  el.classList.remove("hidden");
  clearTimeout(showStatus._t);
  showStatus._t = setTimeout(() => el.classList.add("hidden"), 4500);
}

function renderHeader() {
  const totalPossibleGames = pairings.length * 2;
  let played = 0;
  pairings.forEach(p => p.games.forEach(g => { if (g.result) played++; }));
  const pct = totalPossibleGames ? Math.round((played / totalPossibleGames) * 100) : 0;

  $("#tournament-title").textContent = settings.tournamentName || "Match Round Robin";
  $("#progress-text").textContent = `${played} / ${totalPossibleGames} games (${pct}%)`;
  $("#progress-fill").style.width = pct + "%";
  $("#time-control").textContent = settings.timeControl || "10+10";
  $("#k-factor").textContent = "K=" + (settings.kFactor || 32);
  const pc = $("#player-count");
  if (pc) pc.textContent = players.length + " players";
}

function getSortedStandings() {
  const { stats } = computeEloAndStats();
  let list = Object.values(stats);

  list.sort((a, b) => {
    if (sortCol === "score") return (b.score - a.score) || (b.buchholz - a.buchholz) || (b.elo - a.elo);
    if (sortCol === "elo") return b.elo - a.elo;
    if (sortCol === "games") return b.games - a.games;
    if (sortCol === "name") return a.name.localeCompare(b.name);
    return b.score - a.score;
  });
  if (sortDir === 1) list.reverse();
  return list;
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderStandings() {
  const list = getSortedStandings();
  const tbody = $("#standings-body");
  if (!tbody) return;
  tbody.innerHTML = "";

  list.forEach((s, i) => {
    const rank = i + 1;
    const rankClass = rank === 1 ? "rank-1" : rank === 2 ? "rank-2" : rank === 3 ? "rank-3" : "";
    const deltaClass = s.delta > 0 ? "delta-pos" : s.delta < 0 ? "delta-neg" : "delta-zero";
    const deltaStr = (s.delta > 0 ? "+" : "") + s.delta;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="rank ${rankClass}">${rank}</td>
      <td>${escapeHtml(s.name)}</td>
      <td>${s.games}</td>
      <td class="score">${s.score.toFixed(1)}</td>
      <td>${s.wins}-${s.draws}-${s.losses}</td>
      <td class="elo">${s.elo}</td>
      <td class="${deltaClass}">${deltaStr}</td>
      <td>${s.buchholz.toFixed(1)}</td>
    `;
    tbody.appendChild(tr);
  });

  const top = list[0];
  const leaderEl = $("#stat-leader");
  if (leaderEl) leaderEl.textContent = top ? top.name : "–";
  let played = 0;
  pairings.forEach(p => p.games.forEach(g => { if (g.result) played++; }));
  const playedEl = $("#stat-played");
  if (playedEl) playedEl.textContent = played;
  const totalEl = $("#stat-total");
  if (totalEl) totalEl.textContent = pairings.length * 2;
  const avgElo = list.length ? Math.round(list.reduce((a, b) => a + b.elo, 0) / list.length) : 1200;
  const avgEl = $("#stat-avg-elo");
  if (avgEl) avgEl.textContent = avgElo;
}

function getName(id) {
  return players.find(p => p.id === id)?.name || id;
}

function renderPairingsList() {
  const container = $("#pairings-container");
  if (!container) return;
  container.innerHTML = "";

  const sorted = [...pairings].sort((a, b) => {
    const aDone = a.games.filter(g => g.result).length;
    const bDone = b.games.filter(g => g.result).length;
    if (aDone !== bDone) return aDone - bDone; // incomplete first
    return (getName(a.playerA) + getName(a.playerB)).localeCompare(getName(b.playerA) + getName(b.playerB));
  });

  sorted.forEach(p => {
    const aName = getName(p.playerA);
    const bName = getName(p.playerB);
    const done = p.games.filter(g => g.result).length;
    const statusText = done === 2 ? "Complete" : done === 1 ? "1/2 games" : "Not started";
    const statusClass = done === 2 ? "complete" : done === 1 ? "partial" : "pending";

    const card = document.createElement("div");
    card.className = "card pairing-card";
    card.innerHTML = `
      <div class="pairing-header">
        <div class="pairing-names">${escapeHtml(aName)} <span class="vs">vs</span> ${escapeHtml(bName)}</div>
        <span class="pairing-status ${statusClass}">${statusText}</span>
      </div>
      <div class="games-list">
        ${p.games.map((g, idx) => {
          const wName = getName(g.white);
          const bName2 = getName(g.black);
          let badgeClass = "result-null";
          let badgeText = "–";
          if (g.result === "1-0") { badgeClass = "result-1-0"; badgeText = "1-0"; }
          else if (g.result === "0-1") { badgeClass = "result-0-1"; badgeText = "0-1"; }
          else if (g.result === "1/2-1/2") { badgeClass = "result-1-2"; badgeText = "½-½"; }

          return `
            <div class="game-row" data-pairing-id="${p.id}" data-game-idx="${idx}">
              <span class="player-name player-white">${escapeHtml(wName)}</span>
              <span class="vs">vs</span>
              <span class="player-name player-black">${escapeHtml(bName2)}</span>
              <span class="result-badge ${badgeClass}">${badgeText}</span>
            </div>
          `;
        }).join("")}
      </div>
    `;
    card.querySelectorAll(".game-row").forEach(row => {
      row.addEventListener("click", () => {
        openResultModal(row.dataset.pairingId, Number(row.dataset.gameIdx));
      });
    });
    container.appendChild(card);
  });
}

function renderEnterForm() {
  const sel1 = $("#enter-p1");
  const sel2 = $("#enter-p2");
  if (!sel1 || !sel2) return;
  sel1.innerHTML = "";
  sel2.innerHTML = "";

  players.forEach(p => {
    const o1 = document.createElement("option");
    o1.value = p.id; o1.textContent = p.name;
    sel1.appendChild(o1);
    const o2 = document.createElement("option");
    o2.value = p.id; o2.textContent = p.name;
    sel2.appendChild(o2);
  });

  if (players.length > 1) {
    sel1.value = players[0].id;
    sel2.value = players[1].id;
  }

  updateEnterPreview();
  sel1.onchange = updateEnterPreview;
  sel2.onchange = updateEnterPreview;
}

function updateEnterPreview() {
  const p1 = $("#enter-p1")?.value;
  const p2 = $("#enter-p2")?.value;
  const preview = $("#enter-preview");
  const saveBtn = $("#enter-save");
  if (!preview || !saveBtn) return;

  if (!p1 || !p2 || p1 === p2) {
    preview.innerHTML = `<p class="hint">Select two different players.</p>`;
    saveBtn.disabled = true;
    return;
  }

  let pairing = pairings.find(p => pairKey(p.playerA, p.playerB) === pairKey(p1, p2));
  if (!pairing) {
    pairing = {
      id: uid(),
      playerA: p1,
      playerB: p2,
      games: [
        { white: p1, black: p2, result: null, playedDate: null },
        { white: p2, black: p1, result: null, playedDate: null }
      ]
    };
  }

  const g1 = pairing.games.find(g => g.white === p1 && g.black === p2) || { result: null };
  const g2 = pairing.games.find(g => g.white === p2 && g.black === p1) || { result: null };

  preview.innerHTML = `
    <div class="enter-games">
      <div class="form-group">
        <label><strong>${escapeHtml(getName(p1))}</strong> (White) vs <strong>${escapeHtml(getName(p2))}</strong> (Black)</label>
        <select id="result-g1">
          <option value="">— Not played —</option>
          <option value="1-0" ${g1.result === "1-0" ? "selected" : ""}>1-0 (White wins)</option>
          <option value="0-1" ${g1.result === "0-1" ? "selected" : ""}>0-1 (Black wins)</option>
          <option value="1/2-1/2" ${g1.result === "1/2-1/2" ? "selected" : ""}>½-½ (Draw)</option>
        </select>
      </div>
      <div class="form-group">
        <label><strong>${escapeHtml(getName(p2))}</strong> (White) vs <strong>${escapeHtml(getName(p1))}</strong> (Black)</label>
        <select id="result-g2">
          <option value="">— Not played —</option>
          <option value="1-0" ${g2.result === "1-0" ? "selected" : ""}>1-0 (White wins)</option>
          <option value="0-1" ${g2.result === "0-1" ? "selected" : ""}>0-1 (Black wins)</option>
          <option value="1/2-1/2" ${g2.result === "1/2-1/2" ? "selected" : ""}>½-½ (Draw)</option>
        </select>
      </div>
    </div>
  `;
  saveBtn.disabled = false;
  saveBtn.dataset.p1 = p1;
  saveBtn.dataset.p2 = p2;
}

async function saveEnterForm() {
  const btn = $("#enter-save");
  const p1 = btn?.dataset.p1;
  const p2 = btn?.dataset.p2;
  if (!p1 || !p2) return;

  let pairing = pairings.find(p => pairKey(p.playerA, p.playerB) === pairKey(p1, p2));
  if (!pairing) {
    pairing = {
      id: uid(),
      playerA: p1,
      playerB: p2,
      games: [
        { white: p1, black: p2, result: null, playedDate: null },
        { white: p2, black: p1, result: null, playedDate: null }
      ]
    };
    pairings.push(pairing);
  }

  // Make sure both game directions exist
  let g1 = pairing.games.find(g => g.white === p1 && g.black === p2);
  let g2 = pairing.games.find(g => g.white === p2 && g.black === p1);
  if (!g1) {
    g1 = { white: p1, black: p2, result: null, playedDate: null };
    pairing.games.push(g1);
  }
  if (!g2) {
    g2 = { white: p2, black: p1, result: null, playedDate: null };
    pairing.games.push(g2);
  }

  const r1 = $("#result-g1")?.value || null;
  const r2 = $("#result-g2")?.value || null;

  g1.result = r1 === "" ? null : r1;
  g1.playedDate = g1.result ? new Date().toISOString().slice(0, 10) : null;
  g2.result = r2 === "" ? null : r2;
  g2.playedDate = g2.result ? new Date().toISOString().slice(0, 10) : null;

  // Keep only the two games
  pairing.games = [g1, g2];

  renderAll();
  await savePairings();
}

// Modal (single game)
function openResultModal(pairingId, gameIdx) {
  const pairing = pairings.find(p => p.id === pairingId);
  if (!pairing) return;
  const game = pairing.games[gameIdx];
  if (!game) return;

  const modal = $("#result-modal");
  $("#modal-title").textContent = "Edit Game Result";
  $("#modal-players").textContent = `${getName(game.white)} (White) vs ${getName(game.black)} (Black)`;
  $("#modal-result").value = game.result || "";
  modal.dataset.pairingId = pairingId;
  modal.dataset.gameIdx = gameIdx;
  modal.classList.remove("hidden");
}

function closeModal() {
  $("#result-modal")?.classList.add("hidden");
}

async function saveResultFromModal() {
  const pairingId = $("#result-modal").dataset.pairingId;
  const gameIdx = Number($("#result-modal").dataset.gameIdx);
  const result = $("#modal-result").value || null;

  const pairing = pairings.find(p => p.id === pairingId);
  if (!pairing || !pairing.games[gameIdx]) return;

  pairing.games[gameIdx].result = result === "" ? null : result;
  pairing.games[gameIdx].playedDate = result ? new Date().toISOString().slice(0, 10) : null;

  closeModal();
  renderAll();
  await savePairings();
}

// ---------- Tabs & Admin ----------
function switchTab(tab) {
  currentTab = tab;
  $$(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  $$(".tab-content").forEach(c => c.classList.add("hidden"));
  const el = $(`#tab-${tab}`);
  if (el) el.classList.remove("hidden");

  if (tab === "standings") renderStandings();
  if (tab === "pairings") renderPairingsList();
  if (tab === "enter") renderEnterForm();
}

function tryLogin() {
  const pw = prompt("Enter admin password to enable saving results:");
  if (pw === ADMIN_PASSWORD) {
    isAdmin = true;
    showStatus("Admin mode enabled. You can now save results.", "ok");
    const st = $("#admin-status");
    if (st) {
      st.textContent = "Admin ✓";
      st.style.color = "var(--accent)";
    }
  } else if (pw !== null) {
    showStatus("Wrong password", "err");
  }
}

// ---------- Init ----------
async function init() {
  $("#loading")?.classList.remove("hidden");
  try {
    await loadLocalData();
    await loadPairings();
    ensurePairings();
    renderHeader();
    renderStandings();
    switchTab("standings");

    $$(".tab-btn").forEach(btn => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    $("#login-btn")?.addEventListener("click", tryLogin);
    $("#modal-save")?.addEventListener("click", saveResultFromModal);
    $("#modal-cancel")?.addEventListener("click", closeModal);
    $("#modal-clear")?.addEventListener("click", () => { $("#modal-result").value = ""; });

    $$("#standings-table th[data-sort]").forEach(th => {
      th.addEventListener("click", () => {
        const col = th.dataset.sort;
        if (sortCol === col) sortDir *= -1;
        else { sortCol = col; sortDir = -1; }
        renderStandings();
      });
    });

    $("#enter-save")?.addEventListener("click", saveEnterForm);

  } catch (e) {
    console.error(e);
    showStatus("Init error: " + e.message, "err");
  } finally {
    $("#loading")?.classList.add("hidden");
    $("#app")?.classList.remove("hidden");
  }
}

function renderAll() {
  renderHeader();
  if (currentTab === "standings") renderStandings();
  if (currentTab === "pairings") renderPairingsList();
  if (currentTab === "enter") renderEnterForm();
}

document.addEventListener("DOMContentLoaded", init);
