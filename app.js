// ===================== CONFIG =====================
// Replace these with your jsonbin.io values
const JSONBIN_BIN_ID = "YOUR_BIN_ID_HERE";          // e.g. "66a1b2c3d4e5f6789012345"
const JSONBIN_ACCESS_KEY = "YOUR_ACCESS_KEY_HERE";  // X-Access-Key with Read + Update
const JSONBIN_BASE = "https://api.jsonbin.io/v3/b";

// Admin password (simple protection for writes). Change this!
const ADMIN_PASSWORD = "chessadmin";

// ==================================================

let players = [];
let settings = {};
let matches = [];          // from bin
let schedule = [];         // generated full schedule (matches with result=null if not played)
let currentTab = "standings";
let sortCol = "score";
let sortDir = -1;          // -1 desc
let isAdmin = false;

// ---------- Utils ----------
function $(sel) { return document.querySelector(sel); }
function $$(sel) { return document.querySelectorAll(sel); }

function uid() {
  return "m" + Math.random().toString(36).slice(2, 10);
}

function expectedScore(ra, rb) {
  return 1 / (1 + Math.pow(10, (rb - ra) / 400));
}

function computeElo(playersMap, orderedMatches) {
  // playersMap: id -> {elo, ...}
  const elos = {};
  players.forEach(p => elos[p.id] = settings.initialElo);

  orderedMatches.forEach(m => {
    if (!m.result) return;
    const ra = elos[m.white];
    const rb = elos[m.black];
    const ea = expectedScore(ra, rb);
    const eb = 1 - ea;
    let sa = 0.5, sb = 0.5;
    if (m.result === "1-0") { sa = 1; sb = 0; }
    else if (m.result === "0-1") { sa = 0; sb = 1; }
    const k = settings.kFactor;
    elos[m.white] = Math.round(ra + k * (sa - ea));
    elos[m.black] = Math.round(rb + k * (sb - eb));
  });
  return elos;
}

// ---------- Double Round-Robin Generator (Berger / Circle method) ----------
function generateDoubleRoundRobin(playerIds) {
  const n = playerIds.length;
  if (n % 2 !== 0) {
    // For odd we would add a bye; here we assume even
    console.warn("Odd number of players – bye support not fully implemented");
  }
  const rounds = [];
  // Create list: fix first player, rotate the rest
  let arr = [...playerIds];
  const half = n / 2;
  const totalRoundsPerCycle = n - 1;

  // First cycle
  for (let r = 0; r < totalRoundsPerCycle; r++) {
    const pairings = [];
    for (let i = 0; i < half; i++) {
      const a = arr[i];
      const b = arr[n - 1 - i];
      // Color: alternate based on round and position for balance
      // Simple rule: for first cycle, lower index white on even boards in even rounds etc.
      // Better: standard Berger colors
      let white, black;
      if (r % 2 === 0) {
        white = a; black = b;
      } else {
        white = b; black = a;
      }
      // Special for fixed player color flip every round
      if (i === 0 && r % 2 === 1) {
        white = a; black = b;
      }
      pairings.push({
        id: uid(),
        round: r + 1,
        cycle: 1,
        board: i + 1,
        white,
        black,
        result: null,
        playedDate: null
      });
    }
    rounds.push(pairings);
    // Rotate: keep arr[0] fixed, rotate others clockwise
    const fixed = arr[0];
    const rest = arr.slice(1);
    rest.unshift(rest.pop());
    arr = [fixed, ...rest];
  }

  // Second cycle: reverse colors, rounds continue
  const second = [];
  for (let r = 0; r < totalRoundsPerCycle; r++) {
    const pairings = rounds[r].map(p => ({
      id: uid(),
      round: totalRoundsPerCycle + r + 1,
      cycle: 2,
      board: p.board,
      white: p.black,   // reverse colors
      black: p.white,
      result: null,
      playedDate: null
    }));
    second.push(pairings);
  }

  // Flatten
  const all = [];
  rounds.forEach(rr => all.push(...rr));
  second.forEach(rr => all.push(...rr));
  return all;
}

// ---------- Data Loading ----------
async function loadLocalData() {
  const [pRes, sRes] = await Promise.all([
    fetch("data/players.json"),
    fetch("data/settings.json")
  ]);
  const pData = await pRes.json();
  const sData = await sRes.json();
  players = pData.players;
  settings = sData;
}

async function loadMatches() {
  if (JSONBIN_BIN_ID === "YOUR_BIN_ID_HERE") {
    console.warn("jsonbin not configured – using empty matches");
    matches = [];
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
    matches = data.record?.matches || data.matches || [];
  } catch (e) {
    console.error("Failed to load matches:", e);
    matches = [];
    showStatus("Could not load matches from jsonbin. Using empty schedule.", "err");
  }
}

async function saveMatches() {
  if (JSONBIN_BIN_ID === "YOUR_BIN_ID_HERE") {
    showStatus("jsonbin not configured. Changes are local only (refresh loses them).", "info");
    return false;
  }
  if (!isAdmin) {
    showStatus("Admin login required to save.", "err");
    return false;
  }
  try {
    const body = {
      matches,
      meta: {
        lastUpdated: new Date().toISOString(),
        version: (matches.length || 0) + 1
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

// Merge: start from generated schedule, overlay results from bin by white+black+round or id
function buildSchedule() {
  const playerIds = players.map(p => p.id);
  const generated = generateDoubleRoundRobin(playerIds);

  // Index existing matches for quick lookup (by round + white + black)
  const key = (m) => `${m.round}|${m.white}|${m.black}`;
  const existing = {};
  matches.forEach(m => {
    existing[key(m)] = m;
  });

  schedule = generated.map(g => {
    const found = existing[key(g)];
    if (found) {
      return { ...g, id: found.id || g.id, result: found.result, playedDate: found.playedDate };
    }
    return g;
  });

  // Also keep any extra matches that might exist (shouldn't)
  return schedule;
}

// ---------- Standings ----------
function computeStandings() {
  const ordered = [...schedule]
    .filter(m => m.result)
    .sort((a, b) => a.round - b.round || a.board - b.board);

  const elos = computeElo({}, ordered);

  const stats = {};
  players.forEach(p => {
    stats[p.id] = {
      id: p.id,
      name: p.name,
      games: 0,
      wins: 0,
      draws: 0,
      losses: 0,
      score: 0,
      elo: elos[p.id] || settings.initialElo,
      delta: (elos[p.id] || settings.initialElo) - settings.initialElo,
      opponents: [],
      buchholz: 0
    };
  });

  schedule.forEach(m => {
    if (!m.result) return;
    const w = stats[m.white];
    const b = stats[m.black];
    if (!w || !b) return;
    w.games++; b.games++;
    w.opponents.push(m.black);
    b.opponents.push(m.white);

    if (m.result === "1-0") {
      w.wins++; w.score += 1;
      b.losses++;
    } else if (m.result === "0-1") {
      b.wins++; b.score += 1;
      w.losses++;
    } else {
      w.draws++; b.draws++;
      w.score += 0.5; b.score += 0.5;
    }
  });

  // Simple Buchholz (sum of opponents' scores)
  Object.values(stats).forEach(s => {
    s.buchholz = s.opponents.reduce((sum, oid) => sum + (stats[oid]?.score || 0), 0);
  });

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

// ---------- Rendering ----------
function showStatus(msg, type = "info") {
  const el = $("#status");
  if (!el) return;
  el.textContent = msg;
  el.className = `status ${type}`;
  el.classList.remove("hidden");
  setTimeout(() => el.classList.add("hidden"), 4000);
}

function renderHeader() {
  const played = schedule.filter(m => m.result).length;
  const total = schedule.length;
  const pct = total ? Math.round((played / total) * 100) : 0;
  $("#tournament-title").textContent = settings.tournamentName || "Double Round Robin";
  $("#progress-text").textContent = `${played} / ${total} games (${pct}%)`;
  $("#progress-fill").style.width = pct + "%";
  $("#time-control").textContent = settings.timeControl || "10+10";
  $("#k-factor").textContent = "K=" + (settings.kFactor || 32);
}

function renderStandings() {
  const list = computeStandings();
  const tbody = $("#standings-body");
  tbody.innerHTML = "";

  list.forEach((s, i) => {
    const rank = i + 1;
    const rankClass = rank === 1 ? "rank-1" : rank === 2 ? "rank-2" : rank === 3 ? "rank-3" : "";
    const deltaClass = s.delta > 0 ? "delta-pos" : s.delta < 0 ? "delta-neg" : "delta-zero";
    const deltaStr = (s.delta > 0 ? "+" : "") + s.delta;

    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td class="rank ${rankClass}">${rank}</td>
      <td>${s.name}</td>
      <td>${s.games}</td>
      <td class="score">${s.score.toFixed(1)}</td>
      <td>${s.wins}-${s.draws}-${s.losses}</td>
      <td class="elo">${s.elo}</td>
      <td class="${deltaClass}">${deltaStr}</td>
      <td>${s.buchholz.toFixed(1)}</td>
    `;
    tbody.appendChild(tr);
  });

  // Stats cards
  const top = list[0];
  $("#stat-leader").textContent = top ? top.name : "–";
  $("#stat-played").textContent = schedule.filter(m => m.result).length;
  $("#stat-total").textContent = schedule.length;
  const avgElo = list.length ? Math.round(list.reduce((a, b) => a + b.elo, 0) / list.length) : 1200;
  $("#stat-avg-elo").textContent = avgElo;
}

function renderSchedule() {
  const container = $("#schedule-container");
  container.innerHTML = "";

  const byRound = {};
  schedule.forEach(m => {
    if (!byRound[m.round]) byRound[m.round] = [];
    byRound[m.round].push(m);
  });

  const rounds = Object.keys(byRound).map(Number).sort((a, b) => a - b);

  rounds.forEach(r => {
    const games = byRound[r].sort((a, b) => a.board - b.board);
    const played = games.filter(g => g.result).length;
    const section = document.createElement("div");
    section.className = "round-section card";
    section.innerHTML = `
      <div class="round-header">
        <div class="round-title">Round ${r} ${r > 7 ? "(Cycle 2)" : "(Cycle 1)"}</div>
        <div class="round-status">${played}/${games.length} completed</div>
      </div>
    `;
    games.forEach(g => {
      const wName = players.find(p => p.id === g.white)?.name || g.white;
      const bName = players.find(p => p.id === g.black)?.name || g.black;
      let badgeClass = "result-null";
      let badgeText = "–";
      if (g.result === "1-0") { badgeClass = "result-1-0"; badgeText = "1-0"; }
      else if (g.result === "0-1") { badgeClass = "result-0-1"; badgeText = "0-1"; }
      else if (g.result === "1/2-1/2") { badgeClass = "result-1-2"; badgeText = "½-½"; }

      const row = document.createElement("div");
      row.className = "game-row";
      row.dataset.id = g.id;
      row.innerHTML = `
        <span class="board-num">#${g.board}</span>
        <span class="player-name player-white">${wName}</span>
        <span class="vs">vs</span>
        <span class="player-name player-black">${bName}</span>
        <span class="result-badge ${badgeClass}">${badgeText}</span>
      `;
      row.addEventListener("click", () => openResultModal(g));
      section.appendChild(row);
    });
    container.appendChild(section);
  });
}

function renderEnterForm() {
  const roundSelect = $("#enter-round");
  const gameSelect = $("#enter-game");
  roundSelect.innerHTML = "";
  const rounds = [...new Set(schedule.map(m => m.round))].sort((a, b) => a - b);
  rounds.forEach(r => {
    const opt = document.createElement("option");
    opt.value = r;
    opt.textContent = `Round ${r}`;
    roundSelect.appendChild(opt);
  });

  function populateGames() {
    const r = Number(roundSelect.value);
    gameSelect.innerHTML = "";
    schedule.filter(m => m.round === r).sort((a, b) => a.board - b.board).forEach(g => {
      const w = players.find(p => p.id === g.white)?.name || g.white;
      const b = players.find(p => p.id === g.black)?.name || g.black;
      const opt = document.createElement("option");
      opt.value = g.id;
      opt.textContent = `#${g.board}: ${w} vs ${b}` + (g.result ? ` [${g.result}]` : "");
      gameSelect.appendChild(opt);
    });
  }
  roundSelect.onchange = populateGames;
  populateGames();
}

function openResultModal(game) {
  const modal = $("#result-modal");
  const wName = players.find(p => p.id === game.white)?.name || game.white;
  const bName = players.find(p => p.id === game.black)?.name || game.black;
  $("#modal-title").textContent = `Round ${game.round} · Board ${game.board}`;
  $("#modal-players").textContent = `${wName} (White) vs ${bName} (Black)`;
  $("#modal-result").value = game.result || "";
  modal.dataset.gameId = game.id;
  modal.classList.remove("hidden");
}

function closeModal() {
  $("#result-modal").classList.add("hidden");
}

async function saveResultFromModal() {
  const id = $("#result-modal").dataset.gameId;
  const result = $("#modal-result").value || null;
  const game = schedule.find(m => m.id === id);
  if (!game) return;

  game.result = result === "" ? null : result;
  game.playedDate = result ? new Date().toISOString().slice(0, 10) : null;

  // Update matches array (source of truth for bin)
  const idx = matches.findIndex(m => m.round === game.round && m.white === game.white && m.black === game.black);
  if (idx >= 0) {
    if (result) {
      matches[idx] = { ...matches[idx], result, playedDate: game.playedDate };
    } else {
      matches.splice(idx, 1);
    }
  } else if (result) {
    matches.push({
      id: game.id,
      white: game.white,
      black: game.black,
      round: game.round,
      board: game.board,
      result,
      playedDate: game.playedDate
    });
  }

  closeModal();
  renderAll();
  await saveMatches();
}

// ---------- Tabs ----------
function switchTab(tab) {
  currentTab = tab;
  $$(".tab-btn").forEach(b => b.classList.toggle("active", b.dataset.tab === tab));
  $$(".tab-content").forEach(c => c.classList.add("hidden"));
  $(`#tab-${tab}`).classList.remove("hidden");

  if (tab === "standings") renderStandings();
  if (tab === "schedule") renderSchedule();
  if (tab === "enter") renderEnterForm();
}

// ---------- Admin ----------
function tryLogin() {
  const pw = prompt("Enter admin password to enable saving results:");
  if (pw === ADMIN_PASSWORD) {
    isAdmin = true;
    showStatus("Admin mode enabled. You can now save results.", "ok");
    $("#admin-status").textContent = "Admin ✓";
    $("#admin-status").style.color = "var(--accent)";
  } else if (pw !== null) {
    showStatus("Wrong password", "err");
  }
}

// ---------- Init ----------
async function init() {
  $("#loading").classList.remove("hidden");
  try {
    await loadLocalData();
    await loadMatches();
    buildSchedule();
    renderHeader();
    renderStandings();
    switchTab("standings");

    // Event listeners
    $$(".tab-btn").forEach(btn => {
      btn.addEventListener("click", () => switchTab(btn.dataset.tab));
    });

    $("#login-btn").addEventListener("click", tryLogin);
    $("#modal-save").addEventListener("click", saveResultFromModal);
    $("#modal-cancel").addEventListener("click", closeModal);
    $("#modal-clear").addEventListener("click", () => {
      $("#modal-result").value = "";
    });

    // Sort headers
    $$("#standings-table th[data-sort]").forEach(th => {
      th.addEventListener("click", () => {
        const col = th.dataset.sort;
        if (sortCol === col) sortDir *= -1;
        else { sortCol = col; sortDir = -1; }
        renderStandings();
      });
    });

    // Enter form save
    $("#enter-save").addEventListener("click", async () => {
      const id = $("#enter-game").value;
      const result = $("#enter-result").value || null;
      const game = schedule.find(m => m.id === id);
      if (!game) return;
      game.result = result === "" ? null : result;
      game.playedDate = result ? new Date().toISOString().slice(0, 10) : null;

      const idx = matches.findIndex(m => m.round === game.round && m.white === game.white && m.black === game.black);
      if (idx >= 0) {
        if (result) matches[idx] = { ...matches[idx], result, playedDate: game.playedDate };
        else matches.splice(idx, 1);
      } else if (result) {
        matches.push({
          id: game.id, white: game.white, black: game.black,
          round: game.round, board: game.board, result, playedDate: game.playedDate
        });
      }
      renderAll();
      await saveMatches();
    });

  } catch (e) {
    console.error(e);
    showStatus("Init error: " + e.message, "err");
  } finally {
    $("#loading").classList.add("hidden");
    $("#app").classList.remove("hidden");
  }
}

function renderAll() {
  renderHeader();
  if (currentTab === "standings") renderStandings();
  if (currentTab === "schedule") renderSchedule();
  if (currentTab === "enter") renderEnterForm();
}

document.addEventListener("DOMContentLoaded", init);
