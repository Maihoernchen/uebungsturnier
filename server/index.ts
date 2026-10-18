import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express, { type NextFunction, type Request, type Response } from "express";
import Database from "better-sqlite3";

type Role = "athlete" | "coach" | "referee" | "provider";
type AuthenticatedRequest = Request & {
  identity?: { userId: number; profileId: number; role: Role };
};

const root = path.dirname(fileURLToPath(import.meta.url));
const db = new Database(path.join(root, "..", "tournament.sqlite"));
db.pragma("foreign_keys = ON");
db.pragma("journal_mode = WAL");
db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY,
    email TEXT NOT NULL UNIQUE COLLATE NOCASE,
    password_hash TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS clubs (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE COLLATE NOCASE
  );
  CREATE TABLE IF NOT EXISTS profiles (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    role TEXT NOT NULL CHECK (role IN ('athlete', 'coach', 'referee', 'provider')),
    display_name TEXT NOT NULL,
    club_id INTEGER REFERENCES clubs(id),
    UNIQUE (user_id, role)
  );
  CREATE TABLE IF NOT EXISTS tournaments (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    provider_profile_id INTEGER NOT NULL REFERENCES profiles(id),
    active_round INTEGER NOT NULL DEFAULT 1 CHECK (active_round > 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  );
  CREATE TABLE IF NOT EXISTS tournament_athletes (
    tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    profile_id INTEGER NOT NULL REFERENCES profiles(id),
    PRIMARY KEY (tournament_id, profile_id)
  );
  CREATE TABLE IF NOT EXISTS tournament_staff (
    tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    profile_id INTEGER NOT NULL REFERENCES profiles(id),
    role TEXT NOT NULL CHECK (role IN ('coach', 'referee')),
    PRIMARY KEY (tournament_id, profile_id)
  );
  CREATE TABLE IF NOT EXISTS challenges (
    id INTEGER PRIMARY KEY,
    tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    round INTEGER NOT NULL,
    challenger_id INTEGER NOT NULL REFERENCES profiles(id),
    challenged_id INTEGER NOT NULL REFERENCES profiles(id),
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'declined')),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (challenger_id <> challenged_id)
  );
  CREATE TABLE IF NOT EXISTS matches (
    id INTEGER PRIMARY KEY,
    tournament_id INTEGER NOT NULL REFERENCES tournaments(id) ON DELETE CASCADE,
    round INTEGER NOT NULL,
    red_athlete_id INTEGER NOT NULL REFERENCES profiles(id),
    blue_athlete_id INTEGER NOT NULL REFERENCES profiles(id),
    challenge_id INTEGER NOT NULL UNIQUE REFERENCES challenges(id),
    position INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued'
      CHECK (status IN ('queued', 'blocked', 'in_progress', 'completed')),
    red_score INTEGER NOT NULL DEFAULT 0,
    blue_score INTEGER NOT NULL DEFAULT 0,
    elapsed_seconds INTEGER NOT NULL DEFAULT 0,
    winner_id INTEGER REFERENCES profiles(id),
    win_reason TEXT,
    reason_detail TEXT,
    vetoed_by INTEGER REFERENCES profiles(id),
    updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CHECK (red_athlete_id <> blue_athlete_id),
    CHECK (winner_id IS NULL OR winner_id IN (red_athlete_id, blue_athlete_id))
  );
  CREATE INDEX IF NOT EXISTS matches_round_order
    ON matches(tournament_id, round, position);
`);

const app = express();
app.use(express.json({ limit: "32kb" }));
app.use(
  "/scoreboard",
  express.static(path.join(root, "..", "simplescoreboard"), { fallthrough: false }),
);

app.get("/api/clubs", (_req: Request, res: Response) => {
  res.json(db.prepare("SELECT id, name FROM clubs ORDER BY name").all());
});

const tokenSecret = process.env.SESSION_SECRET;
if (process.env.NODE_ENV === "production" && (!tokenSecret || tokenSecret.length < 32)) {
  throw new Error("Set SESSION_SECRET to a random value of at least 32 characters in production.");
}
const secret = tokenSecret ?? "development-only-secret-change-me";

function makeToken(identity: { userId: number; profileId: number; role: Role }): string {
  const payload = Buffer.from(
    JSON.stringify({ ...identity, expiresAt: Date.now() + 7 * 24 * 60 * 60 * 1000 }),
  ).toString("base64url");
  const signature = crypto.createHmac("sha256", secret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const token = req.get("authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) {
    res.status(401).json({ error: "Sign in to continue." });
    return;
  }
  const [payload, suppliedSignature] = token.split(".");
  if (!payload || !suppliedSignature) {
    res.status(401).json({ error: "Invalid session." });
    return;
  }
  const expected = crypto.createHmac("sha256", secret).update(payload).digest();
  let actual: Buffer;
  try {
    actual = Buffer.from(suppliedSignature, "base64url");
  } catch {
    res.status(401).json({ error: "Invalid session." });
    return;
  }
  if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) {
    res.status(401).json({ error: "Invalid session." });
    return;
  }
  try {
    const identity = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as {
      userId: number;
      profileId: number;
      role: Role;
      expiresAt: number;
    };
    if (identity.expiresAt <= Date.now()) {
      res.status(401).json({ error: "Your session expired. Sign in again." });
      return;
    }
    req.identity = identity;
    next();
  } catch {
    res.status(401).json({ error: "Invalid session." });
  }
}

function requireRole(...roles: Role[]) {
  return (req: AuthenticatedRequest, res: Response, next: NextFunction): void => {
    if (!req.identity || !roles.includes(req.identity.role)) {
      res.status(403).json({ error: "Your profile is not permitted to do that." });
      return;
    }
    next();
  };
}

function profileFor(userId: number, role: Role) {
  return db
    .prepare("SELECT id, role, display_name AS displayName, club_id AS clubId FROM profiles WHERE user_id = ? AND role = ?")
    .get(userId, role) as
    | { id: number; role: Role; displayName: string; clubId: number | null }
    | undefined;
}

function passwordHash(password: string, salt = crypto.randomBytes(16).toString("hex")) {
  const hash = crypto.scryptSync(password, salt, 64).toString("hex");
  return { salt, hash };
}

function verifyPassword(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const candidate = Buffer.from(passwordHash(password, salt).hash, "hex");
  const expected = Buffer.from(hash, "hex");
  return candidate.length === expected.length && crypto.timingSafeEqual(candidate, expected);
}

function sendError(res: Response, error: unknown): void {
  if (error instanceof Error && error.message.startsWith("VALIDATION:")) {
    res.status(400).json({ error: error.message.slice("VALIDATION:".length) });
    return;
  }
  if (error instanceof Error && /UNIQUE constraint failed/.test(error.message)) {
    res.status(409).json({ error: "That record already exists." });
    return;
  }
  console.error(error);
  res.status(500).json({ error: "The server could not complete the request." });
}

function requireTournamentAccess(
  tournamentId: number,
  identity: NonNullable<AuthenticatedRequest["identity"]>,
): boolean {
  if (
    db
      .prepare("SELECT 1 FROM tournaments WHERE id = ? AND provider_profile_id = ?")
      .get(tournamentId, identity.profileId)
  ) {
    return true;
  }
  const table = identity.role === "athlete" ? "tournament_athletes" : "tournament_staff";
  return Boolean(
    db.prepare(`SELECT 1 FROM ${table} WHERE tournament_id = ? AND profile_id = ?`).get(
      tournamentId,
      identity.profileId,
    ),
  );
}

app.post("/api/auth/register", (req: Request, res: Response) => {
  try {
    const { email, password, displayName, role, clubName } = req.body as {
      email?: string;
      password?: string;
      displayName?: string;
      role?: Role;
      clubName?: string;
    };
    if (
      typeof email !== "string" ||
      typeof password !== "string" ||
      typeof displayName !== "string" ||
      !email.trim() ||
      password.length < 10 ||
      password.length > 1024 ||
      !displayName.trim() ||
      (clubName !== undefined && typeof clubName !== "string")
    ) {
      throw new Error("VALIDATION:Provide a name, email, and password of at least 10 characters.");
    }
    if (!role || !["athlete", "coach", "referee", "provider"].includes(role)) {
      throw new Error("VALIDATION:Choose a valid profile type.");
    }
    const normalizedEmail = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail)) {
      throw new Error("VALIDATION:Enter a valid email address.");
    }
    const passwordParts = passwordHash(password);
    const createAccount = db.transaction(() => {
      const user = db
        .prepare("INSERT INTO users (email, password_hash) VALUES (?, ?)")
        .run(normalizedEmail, `${passwordParts.salt}:${passwordParts.hash}`);
      let clubId: number | null = null;
      if (role === "coach" && !clubName?.trim()) {
        throw new Error("VALIDATION:Coaches must register their club name.");
      }
      if (role === "coach" && clubName?.trim()) {
        db.prepare("INSERT OR IGNORE INTO clubs (name) VALUES (?)").run(clubName.trim());
        const club = db.prepare("SELECT id FROM clubs WHERE name = ?").get(clubName.trim()) as
          | { id: number }
          | undefined;
        if (!club) throw new Error("Could not find or create the selected club.");
        clubId = club.id;
      } else if (role === "athlete" && clubName?.trim()) {
        const club = db.prepare("SELECT id FROM clubs WHERE name = ?").get(clubName.trim()) as
          | { id: number }
          | undefined;
        if (!club) {
          throw new Error("VALIDATION:That club was not found. Ask your coach for its registered name.");
        }
        clubId = club.id;
      }
      const profile = db
        .prepare("INSERT INTO profiles (user_id, role, display_name, club_id) VALUES (?, ?, ?, ?)")
        .run(Number(user.lastInsertRowid), role, displayName.trim(), clubId);
      return { userId: Number(user.lastInsertRowid), profileId: Number(profile.lastInsertRowid) };
    });
    const identity = { ...createAccount(), role };
    res.status(201).json({ token: makeToken(identity), profile: { ...identity, displayName: displayName.trim() } });
  } catch (error) {
    sendError(res, error);
  }
});

app.post("/api/auth/login", (req: Request, res: Response) => {
  const { email, password, role } = req.body as { email?: string; password?: string; role?: Role };
  if (
    typeof email !== "string" ||
    typeof password !== "string" ||
    !role ||
    !["athlete", "coach", "referee", "provider"].includes(role)
  ) {
    res.status(400).json({ error: "Email, password, and profile type are required." });
    return;
  }
  const user = db.prepare("SELECT id, password_hash FROM users WHERE email = ?").get(email.trim()) as
    | { id: number; password_hash: string }
    | undefined;
  const profile = user && profileFor(user.id, role);
  if (!user || !profile || !verifyPassword(password, user.password_hash)) {
    res.status(401).json({ error: "Email, password, or profile type is incorrect." });
    return;
  }
  res.json({
    token: makeToken({ userId: user.id, profileId: profile.id, role }),
    profile: { userId: user.id, profileId: profile.id, role, displayName: profile.displayName },
  });
});

app.get("/api/me", requireAuth, (req: AuthenticatedRequest, res: Response) => {
  const profile = db
    .prepare("SELECT display_name AS displayName, role, club_id AS clubId FROM profiles WHERE id = ?")
    .get(req.identity!.profileId);
  res.json({ ...profile, profileId: req.identity!.profileId });
});

app.get("/api/tournaments", requireAuth, (req: AuthenticatedRequest, res: Response) => {
  const identity = req.identity!;
  const tournaments =
    identity.role === "provider"
      ? db.prepare(`
          SELECT id, name, active_round AS activeRound, created_at AS createdAt
          FROM tournaments WHERE provider_profile_id = ? ORDER BY id DESC
        `).all(identity.profileId)
      : identity.role === "athlete"
        ? db.prepare(`
            SELECT t.id, t.name, t.active_round AS activeRound, t.created_at AS createdAt,
              CASE WHEN a.profile_id IS NULL THEN 0 ELSE 1 END AS joined
            FROM tournaments t LEFT JOIN tournament_athletes a
              ON a.tournament_id = t.id AND a.profile_id = ?
            ORDER BY t.id DESC
          `).all(identity.profileId)
        : db.prepare(`
            SELECT t.id, t.name, t.active_round AS activeRound, t.created_at AS createdAt
            FROM tournaments t JOIN tournament_staff s ON s.tournament_id = t.id
            WHERE s.profile_id = ? ORDER BY t.id DESC
          `).all(identity.profileId);
  res.json(tournaments);
});

app.post(
  "/api/tournaments",
  requireAuth,
  requireRole("provider"),
  (req: AuthenticatedRequest, res: Response) => {
    const submittedName = (req.body as { name?: unknown }).name;
    if (typeof submittedName !== "string" || !submittedName.trim()) {
      res.status(400).json({ error: "Tournament name is required." });
      return;
    }
    const name = submittedName.trim();
    const result = db
      .prepare("INSERT INTO tournaments (name, provider_profile_id) VALUES (?, ?)")
      .run(name, req.identity!.profileId);
    res.status(201).json({ id: Number(result.lastInsertRowid), name, activeRound: 1 });
  },
);

app.post(
  "/api/tournaments/:id/join",
  requireAuth,
  requireRole("athlete"),
  (req: AuthenticatedRequest, res: Response) => {
    if (
      db.prepare("SELECT 1 FROM tournament_athletes WHERE tournament_id = ? AND profile_id = ?").get(
        Number(req.params.id),
        req.identity!.profileId,
      )
    ) {
      res.status(409).json({ error: "Your profile is already registered for this tournament." });
      return;
    }
    const result = db
      .prepare("INSERT INTO tournament_athletes (tournament_id, profile_id) SELECT id, ? FROM tournaments WHERE id = ?")
      .run(req.identity!.profileId, Number(req.params.id));
    if (!result.changes) {
      res.status(404).json({ error: "Tournament not found." });
      return;
    }
    res.status(201).json({ joined: true });
  },
);

app.post(
  "/api/tournaments/:id/staff",
  requireAuth,
  requireRole("provider"),
  (req: AuthenticatedRequest, res: Response) => {
    const { profileId, role } = req.body as { profileId?: number; role?: Role };
    if (!Number.isInteger(profileId) || !profileId || !["coach", "referee"].includes(role ?? "")) {
      res.status(400).json({ error: "Choose a coach or referee profile to permit." });
      return;
    }
    const profile = db.prepare("SELECT role FROM profiles WHERE id = ?").get(profileId) as
      | { role: Role }
      | undefined;
    if (!profile || profile.role !== role) {
      res.status(404).json({ error: "No matching coach or referee profile was found." });
      return;
    }
    if (
      db.prepare("SELECT 1 FROM tournament_staff WHERE tournament_id = ? AND profile_id = ?").get(
        Number(req.params.id),
        profileId,
      )
    ) {
      res.status(409).json({ error: "This profile already has tournament access." });
      return;
    }
    const result = db.prepare(`
      INSERT INTO tournament_staff (tournament_id, profile_id, role)
      SELECT id, ?, ? FROM tournaments WHERE id = ? AND provider_profile_id = ?
    `).run(profileId, role, Number(req.params.id), req.identity!.profileId);
    if (!result.changes) {
      res.status(404).json({ error: "Tournament not found." });
      return;
    }
    res.status(201).json({ permitted: true });
  },
);

app.patch(
  "/api/tournaments/:id/round",
  requireAuth,
  requireRole("provider"),
  (req: AuthenticatedRequest, res: Response) => {
    const round = Number((req.body as { round?: number }).round);
    if (!Number.isInteger(round) || round < 1) {
      res.status(400).json({ error: "Round must be a positive whole number." });
      return;
    }
    const result = db
      .prepare("UPDATE tournaments SET active_round = ? WHERE id = ? AND provider_profile_id = ?")
      .run(round, Number(req.params.id), req.identity!.profileId);
    if (!result.changes) {
      res.status(404).json({ error: "Tournament not found." });
      return;
    }
    db.prepare(`
      UPDATE challenges SET status = 'declined'
      WHERE tournament_id = ? AND status = 'pending' AND round <> ?
    `).run(Number(req.params.id), round);
    res.json({ activeRound: round });
  },
);

app.get("/api/tournaments/:id/data", requireAuth, (req: AuthenticatedRequest, res: Response) => {
  const id = Number(req.params.id);
  const identity = req.identity!;
  const tournament = db
    .prepare("SELECT id, name, active_round AS activeRound, provider_profile_id AS providerProfileId FROM tournaments WHERE id = ?")
    .get(id) as { id: number; name: string; activeRound: number; providerProfileId: number } | undefined;
  if (!tournament) {
    res.status(404).json({ error: "Tournament not found." });
    return;
  }
  if (!requireTournamentAccess(id, identity)) {
    res.status(403).json({ error: "The tournament provider has not given your profile access." });
    return;
  }
  const athletes = db.prepare(`
    SELECT p.id, p.display_name AS displayName, c.name AS club
    FROM tournament_athletes a JOIN profiles p ON p.id = a.profile_id
    LEFT JOIN clubs c ON c.id = p.club_id
    WHERE a.tournament_id = ? ORDER BY p.display_name
  `).all(id);
  const challenges = db.prepare(`
    SELECT c.id, c.round, c.status, c.challenger_id AS challengerId,
      c.challenged_id AS challengedId, a.display_name AS challenger,
      b.display_name AS challenged
    FROM challenges c JOIN profiles a ON a.id = c.challenger_id
    JOIN profiles b ON b.id = c.challenged_id
    WHERE c.tournament_id = ? ORDER BY c.id DESC
  `).all(id);
  const matches = db.prepare(`
    SELECT m.id, m.round, m.position, m.status, m.red_athlete_id AS redAthleteId,
      m.blue_athlete_id AS blueAthleteId, red.display_name AS red,
      blue.display_name AS blue, m.red_score AS redScore, m.blue_score AS blueScore,
      m.elapsed_seconds AS elapsedSeconds, m.winner_id AS winnerId,
      winner.display_name AS winner, m.win_reason AS winReason,
      m.reason_detail AS reasonDetail, m.vetoed_by AS vetoedBy
    FROM matches m JOIN profiles red ON red.id = m.red_athlete_id
    JOIN profiles blue ON blue.id = m.blue_athlete_id
    LEFT JOIN profiles winner ON winner.id = m.winner_id
    WHERE m.tournament_id = ? ORDER BY m.round DESC, m.position, m.id
  `).all(id);
  const staff =
    identity.profileId === tournament.providerProfileId
      ? db.prepare(`
          SELECT p.id AS profileId, p.display_name AS displayName, s.role
          FROM tournament_staff s JOIN profiles p ON p.id = s.profile_id
          WHERE s.tournament_id = ? ORDER BY s.role, p.display_name
        `).all(id)
      : [];
  res.json({ tournament, athletes, challenges, matches, staff, myProfileId: identity.profileId, myRole: identity.role });
});

app.post(
  "/api/tournaments/:id/challenges",
  requireAuth,
  requireRole("athlete"),
  (req: AuthenticatedRequest, res: Response) => {
    const opponentId = Number((req.body as { opponentId?: number }).opponentId);
    const tournamentId = Number(req.params.id);
    const tournament = db.prepare("SELECT active_round FROM tournaments WHERE id = ?").get(tournamentId) as
      | { active_round: number }
      | undefined;
    if (
      !tournament ||
      !db.prepare("SELECT 1 FROM tournament_athletes WHERE tournament_id = ? AND profile_id = ?").get(
        tournamentId,
        req.identity!.profileId,
      ) ||
      !db.prepare("SELECT 1 FROM tournament_athletes WHERE tournament_id = ? AND profile_id = ?").get(
        tournamentId,
        opponentId,
      )
    ) {
      res.status(403).json({ error: "Both athletes must be registered in this tournament." });
      return;
    }
    if (opponentId === req.identity!.profileId) {
      res.status(400).json({ error: "You cannot challenge yourself." });
      return;
    }
    const result = db.prepare(`
      INSERT INTO challenges (tournament_id, round, challenger_id, challenged_id)
      VALUES (?, ?, ?, ?)
    `).run(tournamentId, tournament.active_round, req.identity!.profileId, opponentId);
    res.status(201).json({ id: Number(result.lastInsertRowid), round: tournament.active_round });
  },
);

app.post(
  "/api/challenges/:id/accept",
  requireAuth,
  requireRole("athlete"),
  (req: AuthenticatedRequest, res: Response) => {
    try {
      const accept = db.transaction(() => {
        const challenge = db.prepare(`
          SELECT c.*, t.active_round FROM challenges c JOIN tournaments t ON t.id = c.tournament_id
          WHERE c.id = ?
        `).get(Number(req.params.id)) as
          | {
              id: number; tournament_id: number; round: number; challenger_id: number;
              challenged_id: number; status: string; active_round: number;
            }
          | undefined;
        if (!challenge || challenge.challenged_id !== req.identity!.profileId || challenge.status !== "pending") {
          throw new Error("VALIDATION:This challenge is no longer available to your profile.");
        }
        if (challenge.round !== challenge.active_round) {
          throw new Error("VALIDATION:This challenge belongs to a round that is no longer active.");
        }
        const alreadyMatched = db.prepare(`
          SELECT 1 FROM matches WHERE tournament_id = ? AND round = ?
            AND (red_athlete_id IN (?, ?) OR blue_athlete_id IN (?, ?))
        `).get(
          challenge.tournament_id,
          challenge.round,
          challenge.challenger_id,
          challenge.challenged_id,
          challenge.challenger_id,
          challenge.challenged_id,
        );
        if (alreadyMatched) {
          throw new Error("VALIDATION:One of these athletes already has a match in this round.");
        }
        const position = db.prepare(
          "SELECT COALESCE(MAX(position), 0) + 1 AS next FROM matches WHERE tournament_id = ? AND round = ?",
        ).get(challenge.tournament_id, challenge.round) as { next: number };
        db.prepare("UPDATE challenges SET status = 'accepted' WHERE id = ?").run(challenge.id);
        const match = db.prepare(`
          INSERT INTO matches (tournament_id, round, red_athlete_id, blue_athlete_id, challenge_id, position)
          VALUES (?, ?, ?, ?, ?, ?)
        `).run(
          challenge.tournament_id,
          challenge.round,
          challenge.challenger_id,
          challenge.challenged_id,
          challenge.id,
          position.next,
        );
        db.prepare(`
          UPDATE challenges SET status = 'declined'
          WHERE tournament_id = ? AND round = ? AND status = 'pending'
            AND id <> ? AND (challenger_id IN (?, ?) OR challenged_id IN (?, ?))
        `).run(
          challenge.tournament_id,
          challenge.round,
          challenge.id,
          challenge.challenger_id,
          challenge.challenged_id,
          challenge.challenger_id,
          challenge.challenged_id,
        );
        return Number(match.lastInsertRowid);
      });
      res.status(201).json({ matchId: accept() });
    } catch (error) {
      sendError(res, error);
    }
  },
);

app.post(
  "/api/challenges/:id/decline",
  requireAuth,
  requireRole("athlete"),
  (req: AuthenticatedRequest, res: Response) => {
    const result = db.prepare(`
      UPDATE challenges SET status = 'declined'
      WHERE id = ? AND challenged_id = ? AND status = 'pending'
    `).run(Number(req.params.id), req.identity!.profileId);
    if (!result.changes) {
      res.status(404).json({ error: "Pending challenge not found." });
      return;
    }
    res.json({ declined: true });
  },
);

app.patch(
  "/api/matches/:id/order",
  requireAuth,
  requireRole("provider"),
  (req: AuthenticatedRequest, res: Response) => {
    const position = Number((req.body as { position?: number }).position);
    const matchId = Number(req.params.id);
    if (!Number.isInteger(position) || position < 1) {
      res.status(400).json({ error: "Position must be a positive whole number." });
      return;
    }
    const reorder = db.transaction(() => {
      const match = db.prepare(`
        SELECT m.tournament_id, m.round, m.position FROM matches m
        JOIN tournaments t ON t.id = m.tournament_id AND t.provider_profile_id = ?
        WHERE m.id = ? AND m.status IN ('queued', 'blocked')
      `).get(req.identity!.profileId, matchId) as
        | { tournament_id: number; round: number; position: number }
        | undefined;
      if (!match) return false;
      const other = db.prepare(`
        SELECT id FROM matches
        WHERE tournament_id = ? AND round = ? AND position = ?
          AND status IN ('queued', 'blocked') AND id <> ?
      `).get(match.tournament_id, match.round, position, matchId) as { id: number } | undefined;
      if (other) {
        db.prepare("UPDATE matches SET position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
          .run(match.position, other.id);
      }
      db.prepare("UPDATE matches SET position = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?")
        .run(position, matchId);
      return true;
    });
    if (!reorder()) {
      res.status(404).json({ error: "An editable match was not found." });
      return;
    }
    res.json({ position });
  },
);

app.post(
  "/api/matches/:id/veto",
  requireAuth,
  requireRole("coach"),
  (req: AuthenticatedRequest, res: Response) => {
    const matchId = Number(req.params.id);
    const coach = db.prepare("SELECT club_id FROM profiles WHERE id = ?").get(req.identity!.profileId) as
      | { club_id: number | null }
      | undefined;
    const match = db.prepare(`
      SELECT m.status, m.tournament_id, m.red_athlete_id, m.blue_athlete_id
      FROM matches m JOIN tournament_staff s ON s.tournament_id = m.tournament_id
        AND s.profile_id = ? AND s.role = 'coach'
      WHERE m.id = ?
    `).get(req.identity!.profileId, matchId) as
      | { status: string; tournament_id: number; red_athlete_id: number; blue_athlete_id: number }
      | undefined;
    if (!coach?.club_id || !match) {
      res.status(403).json({ error: "You need provider permission and a club profile to veto matches." });
      return;
    }
    if (match.status !== "queued" && match.status !== "blocked") {
      res.status(409).json({ error: "A started or completed match cannot be vetoed." });
      return;
    }
    const athleteFromClub = db.prepare(`
      SELECT 1 FROM profiles WHERE id IN (?, ?) AND club_id = ?
    `).get(match.red_athlete_id, match.blue_athlete_id, coach.club_id);
    if (!athleteFromClub) {
      res.status(403).json({ error: "You can only veto a match involving an athlete from your club." });
      return;
    }
    db.prepare(`
      UPDATE matches SET status = 'blocked', vetoed_by = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?
    `).run(req.identity!.profileId, matchId);
    res.json({ vetoed: true });
  },
);

function authorizedReferee(matchId: number, identity: NonNullable<AuthenticatedRequest["identity"]>) {
  return Boolean(
    db.prepare(`
      SELECT 1 FROM matches m
      JOIN tournament_staff s ON s.tournament_id = m.tournament_id
        AND s.profile_id = ? AND s.role = 'referee'
      WHERE m.id = ?
    `).get(identity.profileId, matchId),
  );
}

app.post(
  "/api/matches/:id/start",
  requireAuth,
  requireRole("referee"),
  (req: AuthenticatedRequest, res: Response) => {
    const matchId = Number(req.params.id);
    if (!authorizedReferee(matchId, req.identity!)) {
      res.status(403).json({ error: "The tournament provider has not permitted you to referee this match." });
      return;
    }
    const result = db.prepare(`
      UPDATE matches SET status = 'in_progress', updated_at = CURRENT_TIMESTAMP
      WHERE id = ? AND status = 'queued'
    `).run(matchId);
    if (!result.changes) {
      res.status(409).json({ error: "Only a queued match can be started." });
      return;
    }
    res.json({ started: true });
  },
);

app.post(
  "/api/matches/:id/score",
  requireAuth,
  requireRole("referee"),
  (req: AuthenticatedRequest, res: Response) => {
    const matchId = Number(req.params.id);
    const { redScore, blueScore, elapsedSeconds } = req.body as {
      redScore?: number; blueScore?: number; elapsedSeconds?: number;
    };
    if (!authorizedReferee(matchId, req.identity!)) {
      res.status(403).json({ error: "The tournament provider has not permitted you to referee this match." });
      return;
    }
    if (![redScore, blueScore, elapsedSeconds].every((value) => Number.isInteger(value) && Number(value) >= 0)) {
      res.status(400).json({ error: "Scoreboard values must be non-negative whole numbers." });
      return;
    }
    const result = db.prepare(`
      UPDATE matches SET red_score = ?, blue_score = ?, elapsed_seconds = ?,
        updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'in_progress'
    `).run(redScore, blueScore, elapsedSeconds, matchId);
    if (!result.changes) {
      res.status(409).json({ error: "Scores can only be recorded for a match in progress." });
      return;
    }
    res.json({ saved: true });
  },
);

app.post(
  "/api/matches/:id/result",
  requireAuth,
  requireRole("referee"),
  (req: AuthenticatedRequest, res: Response) => {
    const matchId = Number(req.params.id);
    const { winnerId, reason, detail, redScore, blueScore, elapsedSeconds } = req.body as {
      winnerId?: number; reason?: string; detail?: string;
      redScore?: number; blueScore?: number; elapsedSeconds?: number;
    };
    const allowedReasons = ["pin", "technical_fall", "decision", "forfeit", "disqualification", "injury", "other"];
    if (!authorizedReferee(matchId, req.identity!)) {
      res.status(403).json({ error: "The tournament provider has not permitted you to referee this match." });
      return;
    }
    if (
      !Number.isInteger(winnerId) ||
      !winnerId ||
      !reason ||
      !allowedReasons.includes(reason) ||
      (detail !== undefined && (typeof detail !== "string" || detail.length > 250)) ||
      ![redScore, blueScore, elapsedSeconds].every((value) => Number.isInteger(value) && Number(value) >= 0)
    ) {
      res.status(400).json({ error: "Provide a permitted referee, winner, win reason, and valid final score." });
      return;
    }
    const match = db.prepare(`
      SELECT red_athlete_id, blue_athlete_id FROM matches WHERE id = ? AND status = 'in_progress'
    `).get(matchId) as { red_athlete_id: number; blue_athlete_id: number } | undefined;
    if (!match || ![match.red_athlete_id, match.blue_athlete_id].includes(winnerId)) {
      res.status(409).json({ error: "The winner must be one of the athletes in an active match." });
      return;
    }
    const result = db.prepare(`
      UPDATE matches SET red_score = ?, blue_score = ?, elapsed_seconds = ?,
        winner_id = ?, win_reason = ?, reason_detail = ?, status = 'completed',
        updated_at = CURRENT_TIMESTAMP WHERE id = ? AND status = 'in_progress'
    `).run(
      redScore, blueScore, elapsedSeconds, winnerId, reason, detail?.trim() || null, matchId,
    );
    if (!result.changes) {
      res.status(409).json({ error: "This match has already been finalized." });
      return;
    }
    res.json({ recorded: true });
  },
);

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (error instanceof Error && "status" in error && Number(error.status) === 404) {
    res.status(404).json({ error: "Requested resource not found." });
    return;
  }
  console.error(error);
  res.status(500).json({ error: "The server could not complete the request." });
});

const dist = path.join(root, "..", "dist");
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get("*", (_req, res) => res.sendFile(path.join(dist, "index.html")));
}

const port = Number(process.env.PORT ?? 3000);
app.listen(port, () => console.log(`Matline server listening on http://localhost:${port}`));
