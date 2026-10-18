type Role = "athlete" | "coach" | "referee" | "provider";
type Profile = { profileId: number; role: Role; displayName: string };
type Tournament = { id: number; name: string; activeRound: number };
type Scoreboard = {
  players: {
    red: () => { score: number; increaseScore: (score: number) => void };
    blue: () => { score: number; increaseScore: (score: number) => void };
  };
  timer: { minutes: number; seconds: number; tick: () => void };
};
type TournamentData = {
  tournament: Tournament & { providerProfileId: number };
  athletes: { id: number; displayName: string; club: string | null }[];
  challenges: {
    id: number; round: number; status: string; challengerId: number;
    challengedId: number; challenger: string; challenged: string;
  }[];
  matches: {
    id: number; round: number; position: number; status: string;
    redAthleteId: number; blueAthleteId: number; red: string; blue: string;
    redScore: number; blueScore: number; elapsedSeconds: number;
    winnerId: number | null; winner: string | null; winReason: string | null;
    reasonDetail: string | null;
  }[];
  staff: { profileId: number; displayName: string; role: Role }[];
  myProfileId: number;
  myRole: Role;
};

const app = document.querySelector<HTMLDivElement>("#app")!;
const tokenKey = "matline-token";
let token = localStorage.getItem(tokenKey);
let profile: Profile | null = null;
let selectedTournament: Tournament | null = null;
let scoreboardFrame: HTMLIFrameElement | null = null;
let activeMatch: TournamentData["matches"][number] | null = null;
let scoreSaveQueue: Promise<unknown> = Promise.resolve();
const hookedScoreboards = new WeakSet<object>();
let tournamentRefreshTimer: number | null = null;

async function api<T>(url: string, options: RequestInit = {}): Promise<T> {
  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const body = (await response.json().catch(() => ({}))) as T & { error?: string };
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status}).`);
  return body;
}

function escapeHtml(value: string | null | undefined): string {
  return (value ?? "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[character]!);
}

function setMessage(message: string, isError = false): void {
  const element = document.querySelector<HTMLElement>("#message");
  if (element) {
    element.textContent = message;
    element.className = isError ? "message error" : "message";
  }
}

function renderAuth(): void {
  app.innerHTML = `
    <main class="auth-layout">
      <section class="brand-panel">
        <a class="brand" href="/">MATLINE<span>.</span></a>
        <div class="brand-copy">
          <p class="eyebrow">WRESTLING, IN SYNC</p>
          <h1>Every round.<br><em>One place.</em></h1>
          <p>Find your next match, keep the bout moving, and share every result live.</p>
        </div>
        <div class="mat-mark" aria-hidden="true"><span>01</span><span>02</span><span>03</span></div>
        <p class="brand-foot">A clear corner for every tournament.</p>
      </section>
      <section class="auth-panel">
        <div class="auth-card">
          <p class="eyebrow">YOUR TOURNAMENT DESK</p>
          <h2>Welcome to Matline</h2>
          <p class="muted">Sign in or create your profile to get started.</p>
          <div class="tab-row">
            <button type="button" class="tab active" data-auth-tab="login">Sign in</button>
            <button type="button" class="tab" data-auth-tab="register">Create profile</button>
          </div>
          <form id="auth-form">
            <div id="register-fields" class="hidden">
              <label>Display name<input name="displayName" autocomplete="name" /></label>
              <label>Club name <span class="muted">(coaches)</span><input name="clubName" /></label>
            </div>
            <label>Email<input name="email" type="email" autocomplete="email" required /></label>
            <label>Password<input name="password" type="password" minlength="10" autocomplete="current-password" required /></label>
            <label>Profile type
              <select name="role" required>
                <option value="athlete">Athlete</option>
                <option value="coach">Coach</option>
                <option value="referee">Referee</option>
                <option value="provider">Tournament provider</option>
              </select>
            </label>
            <button class="button primary full" type="submit">Sign in <span>→</span></button>
          </form>
          <p id="message" class="message" role="status"></p>
        </div>
      </section>
    </main>`;
  let mode: "login" | "register" = "login";
  const registerFields = document.querySelector("#register-fields")!;
  const form = document.querySelector<HTMLFormElement>("#auth-form")!;
  document.querySelectorAll<HTMLButtonElement>("[data-auth-tab]").forEach((button) => {
    button.addEventListener("click", () => {
      mode = button.dataset.authTab as "login" | "register";
      document.querySelectorAll(".tab").forEach((tab) => tab.classList.toggle("active", tab === button));
      registerFields.classList.toggle("hidden", mode !== "register");
      form.querySelector<HTMLButtonElement>('[type="submit"]')!.innerHTML =
        mode === "login" ? 'Sign in <span>→</span>' : 'Create profile <span>→</span>';
    });
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(form).entries());
    try {
      const response = await api<{ token: string; profile: Profile }>(
        `/api/auth/${mode === "login" ? "login" : "register"}`,
        { method: "POST", body: JSON.stringify(fields) },
      );
      token = response.token;
      localStorage.setItem(tokenKey, token);
      profile = response.profile;
      await renderDashboard();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Unable to sign in.", true);
    }
  });
}

async function renderDashboard(): Promise<void> {
  if (tournamentRefreshTimer !== null) {
    window.clearInterval(tournamentRefreshTimer);
    tournamentRefreshTimer = null;
  }
  try {
    if (!profile) profile = (await api<Profile & { profileId: number }>("/api/me")) as Profile;
    const tournaments = await api<(Tournament & { joined?: boolean })[]>("/api/tournaments");
    const options = tournaments.map((t) => `
      <button class="tournament-option ${selectedTournament?.id === t.id ? "selected" : ""}"
        data-tournament="${t.id}">
        <span><strong>${escapeHtml(t.name)}</strong><small>ID ${t.id} · Round ${t.activeRound}</small></span><span>${t.joined === false ? "Join" : "↗"}</span>
      </button>`).join("");
    app.innerHTML = `
      <header class="topbar">
        <a class="brand dark" href="/">MATLINE<span>.</span></a>
        <div class="user-menu"><span class="avatar">${escapeHtml(profile.displayName.charAt(0).toUpperCase())}</span>
          <span><strong>${escapeHtml(profile.displayName)}</strong><small>${escapeHtml(profile.role)} · ID ${profile.profileId}</small></span>
          <button id="sign-out" class="text-button">Sign out</button>
        </div>
      </header>
      <main class="workspace">
        <aside class="sidebar">
          <div class="side-heading"><div><p class="eyebrow">YOUR SPACE</p><h2>Tournaments</h2></div><span class="count">${tournaments.length}</span></div>
          <div class="tournament-list">${options || '<p class="muted empty">No tournaments yet.</p>'}</div>
          ${profile.role === "provider" ? `<form id="create-tournament" class="inline-form">
            <input name="name" placeholder="New tournament name" required />
            <button class="button primary" aria-label="Create tournament">+</button>
          </form>` : ""}
          ${profile.role === "athlete" ? `<form id="join-tournament" class="inline-form">
            <input name="id" type="number" min="1" placeholder="Tournament ID" required />
            <button class="button secondary">Join</button>
          </form>` : ""}
          <div class="side-note"><span class="signal"></span> Your tournament data syncs with the server.</div>
        </aside>
        <section id="content" class="content">
          ${selectedTournament ? '<p class="muted">Loading tournament…</p>' : `
            <div class="welcome-card"><p class="eyebrow">WELCOME TO YOUR CORNER</p>
              <h1>Make every<br><em>match count.</em></h1>
              <p>Select a tournament to see its round, challenges, and match queue.</p>
            </div>`}
          <p id="message" class="message" role="status"></p>
        </section>
      </main>`;
    document.querySelector("#sign-out")!.addEventListener("click", () => {
      if (tournamentRefreshTimer !== null) {
        window.clearInterval(tournamentRefreshTimer);
        tournamentRefreshTimer = null;
      }
      localStorage.removeItem(tokenKey);
      token = null;
      profile = null;
      selectedTournament = null;
      renderAuth();
    });
    document.querySelectorAll<HTMLButtonElement>("[data-tournament]").forEach((button) => {
      button.addEventListener("click", () => {
        const item = tournaments.find((t) => t.id === Number(button.dataset.tournament));
        if (item && item.joined !== false) {
          selectedTournament = item;
          void renderDashboard();
        } else if (item) {
          void runAction(async () => {
            await api(`/api/tournaments/${item.id}/join`, { method: "POST" });
            selectedTournament = item;
            await renderDashboard();
          });
        }
      });
    });
    document.querySelector("#create-tournament")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      try {
        selectedTournament = await api<Tournament>("/api/tournaments", {
          method: "POST", body: JSON.stringify(Object.fromEntries(new FormData(form).entries())),
        });
        await renderDashboard();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Could not create tournament.", true);
      }
    });
    document.querySelector("#join-tournament")?.addEventListener("submit", async (event) => {
      event.preventDefault();
      const form = event.currentTarget as HTMLFormElement;
      const id = new FormData(form).get("id");
      try {
        await api(`/api/tournaments/${id}/join`, { method: "POST" });
        selectedTournament = await api<Tournament>(`/api/tournaments/${id}/data`).then((data) => data.tournament);
        await renderDashboard();
      } catch (error) {
        setMessage(error instanceof Error ? error.message : "Could not join tournament.", true);
      }
    });
    if (selectedTournament) await renderTournament(selectedTournament.id);
  } catch (error) {
    if (error instanceof Error && /401|session/i.test(error.message)) {
      localStorage.removeItem(tokenKey);
      token = null;
      profile = null;
      renderAuth();
      return;
    }
    app.innerHTML = `<main class="fatal"><p class="eyebrow">CONNECTION ISSUE</p><h1>We couldn't load your tournaments.</h1><p>${escapeHtml(error instanceof Error ? error.message : "Please try again.")}</p><button id="retry" class="button primary">Try again</button></main>`;
    document.querySelector("#retry")?.addEventListener("click", () => void renderDashboard());
  }
}

function fmtTime(seconds: number): string {
  return `${Math.floor(seconds / 60).toString().padStart(2, "0")}:${(seconds % 60).toString().padStart(2, "0")}`;
}

async function renderTournament(id: number): Promise<void> {
  if (tournamentRefreshTimer !== null) {
    window.clearInterval(tournamentRefreshTimer);
    tournamentRefreshTimer = null;
  }
  const data = await api<TournamentData>(`/api/tournaments/${id}/data`);
  const content = document.querySelector<HTMLElement>("#content");
  if (!content) return;
  const pending = data.challenges.filter((challenge) =>
    challenge.status === "pending" &&
    (challenge.challengedId === data.myProfileId || data.myRole === "provider"),
  );
  const challengeOptions = data.athletes
    .filter((athlete) => athlete.id !== data.myProfileId)
    .map((athlete) => `<option value="${athlete.id}">${escapeHtml(athlete.displayName)}${athlete.club ? ` · ${escapeHtml(athlete.club)}` : ""}</option>`)
    .join("");
  const matches = data.matches.filter((match) => match.round === data.tournament.activeRound);
  content.innerHTML = `
    <div class="page-heading">
      <div><p class="eyebrow">ROUND ${data.tournament.activeRound} · LIVE TOURNAMENT</p>
        <h1>${escapeHtml(data.tournament.name)}</h1></div>
      <span class="live-pill"><span class="signal"></span> ACTIVE</span>
    </div>
    <div class="metric-row">
      <article class="metric"><span>ROSTER</span><strong>${data.athletes.length.toString().padStart(2, "0")}</strong><small>athletes</small></article>
      <article class="metric"><span>ROUND QUEUE</span><strong>${matches.length.toString().padStart(2, "0")}</strong><small>matches</small></article>
      <article class="metric"><span>CHALLENGES</span><strong>${pending.length.toString().padStart(2, "0")}</strong><small>awaiting response</small></article>
    </div>
    ${data.myRole === "provider" ? `
      <section class="panel provider-panel">
        <div><p class="eyebrow">PROVIDER CONTROLS</p><h2>Run the next round</h2>
          <p class="muted">Change the active round or give a coach/referee access to this tournament.</p></div>
        <div class="provider-actions">
          <form id="round-form" class="inline-form"><input name="round" type="number" min="1" value="${data.tournament.activeRound}" required /><button class="button secondary">Set round</button></form>
          <form id="staff-form" class="inline-form">
            <input name="profileId" type="number" min="1" placeholder="Profile ID" required />
            <select name="role"><option value="coach">Coach</option><option value="referee">Referee</option></select>
            <button class="button secondary">Grant access</button>
          </form>
          ${data.staff.map((member) => `<span class="staff-chip">${escapeHtml(member.displayName)} · ${escapeHtml(member.role)}</span>`).join("")}
        </div>
      </section>` : ""}
    <div class="section-grid">
      <section class="panel">
        <div class="panel-heading"><div><p class="eyebrow">ON THE MAT</p><h2>Match queue</h2></div><span class="count">${matches.length}</span></div>
        <div class="match-list">${matches.length ? matches.map((match) => `
          <article class="match-card ${match.status === "blocked" ? "is-blocked" : ""}">
            <div class="match-order"><span>${String(match.position).padStart(2, "0")}</span><small>MAT</small></div>
            <div class="match-versus"><span>${escapeHtml(match.red)}</span><b>VS</b><span>${escapeHtml(match.blue)}</span></div>
            <div class="match-score">${match.status === "in_progress" || match.status === "completed" ? `${match.redScore} : ${match.blueScore} · ${fmtTime(match.elapsedSeconds)}` : escapeHtml(match.status === "blocked" ? "vetoed" : match.status)}</div>
            <div class="match-buttons">
              ${data.myRole === "provider" && (match.status === "queued" || match.status === "blocked") ? `<button class="icon-button" data-order="${match.id}" data-position="${match.position - 1}" aria-label="Move match earlier" ${match.position <= 1 ? "disabled" : ""}>↑</button><button class="icon-button" data-order="${match.id}" data-position="${match.position + 1}" aria-label="Move match later">↓</button>` : ""}
              ${data.myRole === "coach" && match.status === "queued" ? `<button class="text-button" data-veto="${match.id}">Veto</button>` : ""}
              ${data.myRole === "coach" && match.status === "blocked" ? '<span class="result-label">vetoed</span>' : ""}
              ${data.myRole === "referee" && match.status === "queued" ? `<button class="button primary small-button" data-start="${match.id}">Start bout</button>` : ""}
              ${data.myRole === "referee" && match.status === "in_progress" ? `<button class="button primary small-button" data-score="${match.id}">Open scoreboard</button>` : ""}
              ${match.status === "completed" ? `<span class="result-label">${escapeHtml(match.winner ?? "")} · ${escapeHtml(match.winReason)}</span>` : ""}
            </div>
          </article>`).join("") : '<p class="muted empty">Accepted challenges appear here.</p>'}</div>
      </section>
      <section class="panel challenge-panel">
        <div class="panel-heading"><div><p class="eyebrow">MAKE YOUR MOVE</p><h2>Challenges</h2></div><span class="count">${pending.length}</span></div>
        ${data.myRole === "athlete" ? `<form id="challenge-form" class="challenge-form">
          <label for="opponent">Challenge an athlete</label>
          <div class="inline-form"><select id="opponent" name="opponentId" required><option value="">Select an opponent</option>${challengeOptions}</select><button class="button primary">Send</button></div>
        </form>` : ""}
        <div class="challenge-list">${pending.length ? pending.map((challenge) => `
          <article class="challenge-card"><div><strong>${escapeHtml(challenge.challenger)}</strong><span>challenges</span><strong>${escapeHtml(challenge.challenged)}</strong><small>Round ${challenge.round}</small></div>
            ${data.myRole === "athlete" && challenge.challengedId === data.myProfileId ? `<div class="challenge-actions"><button class="button primary small-button" data-accept="${challenge.id}">Accept</button><button class="text-button" data-decline="${challenge.id}">Decline</button></div>` : ""}
          </article>`).join("") : '<p class="muted empty">No open challenges.</p>'}</div>
      </section>
    </div>
    <section class="panel roster-panel"><div class="panel-heading"><div><p class="eyebrow">TOURNAMENT ENTRIES</p><h2>Athlete roster</h2></div><span class="count">${data.athletes.length}</span></div>
      <div class="roster-list">${data.athletes.map((athlete) => `<span><i>${escapeHtml(athlete.displayName.charAt(0).toUpperCase())}</i>${escapeHtml(athlete.displayName)}<small>${escapeHtml(athlete.club || "Independent")}</small></span>`).join("") || '<p class="muted">No athletes have joined yet.</p>'}</div>
    </section>
    <div id="scoreboard-modal" class="modal hidden" role="dialog" aria-modal="true" aria-label="Record match result">
      <div class="modal-card"><button id="close-scoreboard" class="modal-close" aria-label="Close">×</button>
        <p class="eyebrow">LIVE BOUT · MATLINE SCOREBOARD</p><h2 id="scoreboard-title">Score the match</h2>
        <div class="scoreboard-frame-wrap"><iframe id="scoreboard-frame" title="Wrestling scoreboard" src="/scoreboard/index.html"></iframe></div>
        <form id="result-form" class="result-form">
          <label>Winner<select name="winnerId" id="winner-select" required></select></label>
          <label>Win reason<select name="reason" required>
            <option value="pin">Pin</option><option value="technical_fall">Technical fall</option>
            <option value="decision">Decision</option><option value="forfeit">Forfeit</option>
            <option value="disqualification">Disqualification</option><option value="injury">Injury</option><option value="other">Other</option>
          </select></label>
          <label>Notes <span class="muted">(optional)</span><input name="detail" maxlength="250" /></label>
          <button class="button primary full">Finalize result</button>
        </form>
      </div>
    </div>
    <p id="message" class="message" role="status"></p>`;

  document.querySelector("#round-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const round = new FormData(event.currentTarget as HTMLFormElement).get("round");
    await runAction(async () => {
      await api(`/api/tournaments/${id}/round`, { method: "PATCH", body: JSON.stringify({ round: Number(round) }) });
      await renderTournament(id);
    });
  });
  document.querySelector("#staff-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const fields = Object.fromEntries(new FormData(event.currentTarget as HTMLFormElement).entries());
    await runAction(async () => {
      await api(`/api/tournaments/${id}/staff`, { method: "POST", body: JSON.stringify({ ...fields, profileId: Number(fields.profileId) }) });
      await renderTournament(id);
    });
  });
  document.querySelector("#challenge-form")?.addEventListener("submit", async (event) => {
    event.preventDefault();
    const opponentId = Number(new FormData(event.currentTarget as HTMLFormElement).get("opponentId"));
    await runAction(async () => {
      await api(`/api/tournaments/${id}/challenges`, { method: "POST", body: JSON.stringify({ opponentId }) });
      await renderTournament(id);
    });
  });
  document.querySelectorAll<HTMLElement>("[data-accept]").forEach((button) => button.addEventListener("click", () =>
    void runAction(async () => {
      await api(`/api/challenges/${button.dataset.accept}/accept`, { method: "POST" });
      await renderTournament(id);
    }),
  ));
  document.querySelectorAll<HTMLElement>("[data-decline]").forEach((button) => button.addEventListener("click", () =>
    void runAction(async () => {
      await api(`/api/challenges/${button.dataset.decline}/decline`, { method: "POST" });
      await renderTournament(id);
    }),
  ));
  document.querySelectorAll<HTMLElement>("[data-order]").forEach((button) => button.addEventListener("click", () =>
    void runAction(async () => {
      await api(`/api/matches/${button.dataset.order}/order`, {
        method: "PATCH", body: JSON.stringify({ position: Number(button.dataset.position) }),
      });
      await renderTournament(id);
    }),
  ));
  document.querySelectorAll<HTMLElement>("[data-veto]").forEach((button) => button.addEventListener("click", () =>
    void runAction(async () => {
      await api(`/api/matches/${button.dataset.veto}/veto`, { method: "POST" });
      await renderTournament(id);
    }),
  ));
  document.querySelectorAll<HTMLElement>("[data-start]").forEach((button) => button.addEventListener("click", () =>
    void runAction(async () => {
      await api(`/api/matches/${button.dataset.start}/start`, { method: "POST" });
      await renderTournament(id);
    }),
  ));
  document.querySelectorAll<HTMLElement>("[data-score]").forEach((button) => button.addEventListener("click", () => {
    activeMatch = data.matches.find((match) => match.id === Number(button.dataset.score)) ?? null;
    if (activeMatch) void openScoreboard(activeMatch);
  }));
  document.querySelector("#close-scoreboard")?.addEventListener("click", closeScoreboard);
  document.querySelector("#scoreboard-modal")?.addEventListener("click", (event) => {
    if (event.target === event.currentTarget) closeScoreboard();
  });
  tournamentRefreshTimer = window.setInterval(() => {
    const modal = document.querySelector<HTMLElement>("#scoreboard-modal");
    const focused = document.activeElement;
    if (modal && !modal.classList.contains("hidden")) return;
    if (
      focused instanceof HTMLElement &&
      content.contains(focused) &&
      focused.matches("input, select, textarea")
    ) return;
    const scrollPosition = window.scrollY;
    void renderTournament(id)
      .then(() => window.scrollTo({ top: scrollPosition }))
      .catch((error: unknown) => {
        setMessage(error instanceof Error ? `Live refresh failed: ${error.message}` : "Live refresh failed.", true);
      });
  }, 5000);
}

async function runAction(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    setMessage(error instanceof Error ? error.message : "The action could not be completed.", true);
  }
}

function readScoreboard(): { redScore: number; blueScore: number; elapsedSeconds: number; red: string; blue: string } {
  const frame = scoreboardFrame?.contentWindow;
  if (!frame) throw new Error("The scoreboard is unavailable.");
  const board = getScoreboard();
  const minutes = board.timer.minutes;
  const seconds = board.timer.seconds;
  return {
    redScore: board.players.red().score,
    blueScore: board.players.blue().score,
    elapsedSeconds: minutes * 60 + seconds,
    red: frame.document.querySelector<HTMLInputElement>("input.name-label.red")?.value ?? "",
    blue: frame.document.querySelector<HTMLInputElement>("input.name-label.blue")?.value ?? "",
  };
}

function getScoreboard(): Scoreboard {
  const frame = scoreboardFrame?.contentWindow;
  if (!frame) throw new Error("The scoreboard is unavailable.");
  try {
    return frame.eval("scoreboard") as Scoreboard;
  } catch {
    throw new Error("The scoreboard could not be connected.");
  }
}

function hookScoreboard(): void {
  if (!scoreboardFrame?.contentWindow || !activeMatch) return;
  const frame = scoreboardFrame.contentWindow;
  const scoreboard = getScoreboard();
  scoreboard.players.red().score = activeMatch.redScore;
  scoreboard.players.blue().score = activeMatch.blueScore;
  scoreboard.timer.minutes = Math.floor(activeMatch.elapsedSeconds / 60);
  scoreboard.timer.seconds = activeMatch.elapsedSeconds % 60;
  frame.document.querySelector<HTMLElement>(".score-label.red")!.textContent =
    String(activeMatch.redScore).padStart(2, "0");
  frame.document.querySelector<HTMLElement>(".score-label.blue")!.textContent =
    String(activeMatch.blueScore).padStart(2, "0");
  frame.document.querySelector<HTMLElement>(".timer")!.textContent = fmtTime(activeMatch.elapsedSeconds);
  frame.document.querySelector<HTMLInputElement>(".name-label.red")!.value = activeMatch.red;
  frame.document.querySelector<HTMLInputElement>(".name-label.blue")!.value = activeMatch.blue;
  if (hookedScoreboards.has(scoreboard)) return;
  hookedScoreboards.add(scoreboard);
  const persist = () => {
    if (!activeMatch) return;
    const matchId = activeMatch.id;
    const current = readScoreboard();
    scoreSaveQueue = scoreSaveQueue.then(async () => {
      await api(`/api/matches/${matchId}/score`, {
        method: "POST",
        body: JSON.stringify({
          redScore: current.redScore, blueScore: current.blueScore, elapsedSeconds: current.elapsedSeconds,
        }),
      });
    }).catch((error: unknown) => {
      setMessage(error instanceof Error ? `Score save failed: ${error.message}` : "Score save failed.", true);
    });
  };
  for (const player of [scoreboard.players.red(), scoreboard.players.blue()]) {
    const original = player.increaseScore;
    player.increaseScore = (score: number) => {
      original.call(player, Math.max(-player.score, score));
      persist();
    };
  }
  const originalTick = scoreboard.timer.tick;
  scoreboard.timer.tick = () => {
    originalTick.call(scoreboard.timer);
    persist();
  };
}

async function openScoreboard(match: TournamentData["matches"][number]): Promise<void> {
  activeMatch = match;
  scoreboardFrame = document.querySelector<HTMLIFrameElement>("#scoreboard-frame");
  const modal = document.querySelector<HTMLElement>("#scoreboard-modal")!;
  document.querySelector("#scoreboard-title")!.textContent = `${match.red} vs ${match.blue}`;
  const winner = document.querySelector<HTMLSelectElement>("#winner-select")!;
  winner.innerHTML = `<option value="${match.redAthleteId}">${escapeHtml(match.red)}</option><option value="${match.blueAthleteId}">${escapeHtml(match.blue)}</option>`;
  modal.classList.remove("hidden");
  scoreboardFrame!.addEventListener("load", hookScoreboard, { once: true });
  if (scoreboardFrame!.contentDocument?.readyState === "complete") hookScoreboard();
  document.querySelector<HTMLFormElement>("#result-form")!.onsubmit = async (event) => {
    event.preventDefault();
    if (!activeMatch) return;
    try {
      await scoreSaveQueue;
      const score = readScoreboard();
      const fields = Object.fromEntries(new FormData(event.currentTarget as HTMLFormElement).entries());
      await api(`/api/matches/${activeMatch.id}/result`, {
        method: "POST",
        body: JSON.stringify({
          ...fields, winnerId: Number(fields.winnerId),
          redScore: score.redScore, blueScore: score.blueScore, elapsedSeconds: score.elapsedSeconds,
        }),
      });
      closeScoreboard();
      if (selectedTournament) await renderTournament(selectedTournament.id);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not record the result.", true);
    }
  };
}

function closeScoreboard(): void {
  document.querySelector("#scoreboard-modal")?.classList.add("hidden");
  scoreboardFrame = null;
  activeMatch = null;
}

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch((error: unknown) => {
      console.error("Service worker registration failed.", error);
    });
  });
}

if (token) void renderDashboard();
else renderAuth();
