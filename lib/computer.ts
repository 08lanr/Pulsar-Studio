// This computer (decision 2026-09-24, "two computers, one database"). Two
// people run their own Studio against the one live database, so what is
// true of one computer only — its name and id, the films folder Studio reads
// and cuts into, the Python that runs the pipeline, whether it copies the
// films it imported to the cloud — lives in `.studio-computer.json` beside
// package.json (gitignored), never in the shared database: a path on one
// computer means nothing on the other.
//
// The file is written by the "This computer" card (lib/computer-setup.ts)
// and created with a fresh id the first time Studio reads it. What it names
// is laid over process.env once per process (`ensureComputerSettings`, next
// to the scheduler's boot hook), so every reader of WORKSPACE_ROOT and
// STUDIO_PIPELINE_PYTHON keeps reading the environment as before: a value in
// the file wins, and clearing it brings back what the server environment
// said (`baseline`). STUDIO_COMPUTER_FILE names another file, or `off` (the
// test runner): then nothing is read or written and the computer is a fixed
// id derived from the host name, so tests and the e2e server stay stable.
//
// A film run belongs to the computer that started it (`settings.computer`,
// stamped by createRun): its film folder, strips and review pictures are on
// that disk only, so only that computer's worker drives it and only there
// can a person decide on it (`runIsHere`).

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { conflict } from "@/lib/data/errors";

export type Env = Record<string, string | undefined>;

/** Who a computer is, as a run and the screens name it. */
export type Computer = { id: string; name: string };

/** The file's shape. Every key but the id and the name is optional; null and absent mean the same. */
export type ComputerFile = Computer & {
  /** The pipeline's projects/ folder on this computer (WORKSPACE_ROOT). */
  films_folder?: string | null;
  /** The interpreter the pipeline's scripts run under (STUDIO_PIPELINE_PYTHON), when `python` on PATH is not it. */
  python?: string | null;
  /** Copy the films imported here to the Supabase bucket (lib/cloud-copy.ts); off until someone turns it on. */
  cloud_copy?: boolean;
  updated_at?: string;
};

export const COMPUTER_FILE = ".studio-computer.json";
export const COMPUTER_ID = /^cmp_[0-9a-f]{16}$/;
export const COMPUTER_NAME_MAX = 60;

/** The env keys the file lays over process.env, and the file key each comes from. */
const OVERLAY = [
  ["films_folder", "WORKSPACE_ROOT"],
  ["python", "STUDIO_PIPELINE_PYTHON"],
] as const;

type Store = { file?: ComputerFile | null; path?: string | null; baseline?: Env; applied?: boolean };

function store(): Store {
  const g = globalThis as unknown as { __studioComputer?: Store };
  if (!g.__studioComputer) g.__studioComputer = {};
  return g.__studioComputer;
}

/** For tests: forget the cached file, the baseline and the applied flag. */
export function resetComputerForTests(): void {
  const g = globalThis as unknown as { __studioComputer?: Store };
  g.__studioComputer = {};
}

/** The file's path, or null when STUDIO_COMPUTER_FILE is `off`. */
export function computerFilePath(env: Env = process.env): string | null {
  const configured = env.STUDIO_COMPUTER_FILE?.trim();
  if (configured === "off") return null;
  return configured ? path.resolve(process.cwd(), configured) : path.join(process.cwd(), COMPUTER_FILE);
}

/** The host name without a Mac's `.local`, as a first name for the computer. */
export function defaultComputerName(): string {
  const host = os.hostname().replace(/\.local$/i, "").trim();
  return (host || "This computer").slice(0, COMPUTER_NAME_MAX);
}

function newId(): string {
  return `cmp_${randomBytes(8).toString("hex")}`;
}

/** The fixed computer of a disabled file: the same on every read of one host. */
function hostComputer(): ComputerFile {
  const hash = createHash("sha256").update(os.hostname()).digest("hex").slice(0, 16);
  return { id: `cmp_${hash}`, name: defaultComputerName() };
}

function cleanName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const name = raw.replace(/\s+/g, " ").trim().slice(0, COMPUTER_NAME_MAX);
  return name || null;
}

function parseFile(text: string): ComputerFile | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const o = raw as Record<string, unknown>;
  if (typeof o.id !== "string" || !COMPUTER_ID.test(o.id)) return null;
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return {
    id: o.id,
    name: cleanName(o.name) ?? defaultComputerName(),
    films_folder: str(o.films_folder),
    python: str(o.python),
    cloud_copy: o.cloud_copy === true,
    updated_at: typeof o.updated_at === "string" ? o.updated_at : undefined,
  };
}

function writeFile(file: string, value: ComputerFile): void {
  mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tmp, file);
}

/**
 * The file as it is: read once per process and kept, created with a new id
 * when missing (or unreadable: a file without a valid id is replaced, its
 * other keys dropped, since a second computer with the same id is exactly
 * what the id prevents). A disabled file is the host's fixed computer.
 */
export function readComputerFile(env: Env = process.env): ComputerFile {
  const s = store();
  const file = computerFilePath(env);
  if (s.file && s.path === file) return s.file;
  let value: ComputerFile;
  if (!file) {
    value = hostComputer();
  } else {
    const parsed = existsSync(file) ? parseFile(readFileSync(file, "utf8")) : null;
    if (parsed) value = parsed;
    else {
      value = { id: newId(), name: defaultComputerName(), updated_at: new Date().toISOString() };
      writeFile(file, value);
    }
  }
  s.file = value;
  s.path = file;
  return value;
}

/** This computer's id and name. */
export function thisComputer(env: Env = process.env): Computer {
  const f = readComputerFile(env);
  return { id: f.id, name: f.name };
}

export type ComputerPatch = Partial<Pick<ComputerFile, "name" | "films_folder" | "python" | "cloud_copy">>;

/**
 * Change the file (the card's actions): the name is trimmed and capped, a
 * null path clears the key (the server environment's value comes back).
 * Refused when the file is disabled. Re-applies the overlay at once.
 */
export function saveComputer(patch: ComputerPatch, env: Env = process.env): ComputerFile {
  const file = computerFilePath(env);
  if (!file) throw conflict("This server does not keep settings for the computer.");
  const current = readComputerFile(env);
  const next: ComputerFile = { ...current, updated_at: new Date().toISOString() };
  if (patch.name !== undefined) next.name = cleanName(patch.name) ?? current.name;
  if (patch.films_folder !== undefined) next.films_folder = patch.films_folder?.trim() || null;
  if (patch.python !== undefined) next.python = patch.python?.trim() || null;
  if (patch.cloud_copy !== undefined) next.cloud_copy = patch.cloud_copy === true;
  writeFile(file, next);
  const s = store();
  s.file = next;
  s.path = file;
  applyComputerSettings(env);
  return next;
}

/** What the server environment said before the file was laid over it (captured on the first apply). */
export function baselineEnv(env: Env = process.env): Env {
  const s = store();
  if (!s.baseline) s.baseline = Object.fromEntries(OVERLAY.map(([, k]) => [k, env[k]]));
  return s.baseline;
}

/** Lay the file over the environment: a value in the file wins; a cleared one gives the baseline back. */
export function applyComputerSettings(env: Env = process.env): void {
  if (!computerFilePath(env)) {
    // A disabled file names nothing: the environment is left exactly as it is.
    store().applied = true;
    return;
  }
  const base = baselineEnv(env);
  const file = readComputerFile(env);
  for (const [key, envKey] of OVERLAY) {
    const v = (file[key] as string | null | undefined)?.trim() || base[envKey]?.trim();
    if (v) env[envKey] = v;
    else delete env[envKey];
  }
  store().applied = true;
}

/** Once per process, from the first request (next to ensureScheduler) and the worker script. Never throws. */
export function ensureComputerSettings(): void {
  if (store().applied) return;
  try {
    applyComputerSettings();
  } catch (e) {
    store().applied = true;
    console.error(`[computer] could not read ${COMPUTER_FILE}: ${(e as Error).message}`);
  }
}

/** Where the films folder in force came from: this computer's file, the server environment, or nowhere. */
export function filmsFolderSource(env: Env = process.env): "computer" | "server" | null {
  if (readComputerFile(env).films_folder) return "computer";
  return baselineEnv(env).WORKSPACE_ROOT?.trim() ? "server" : null;
}

// ---- runs ------------------------------------------------------------------------------------------------------

/** The computer a run was started on (`settings.computer`), or null for a run from before 2026-09-24. */
export function runComputerOf(run: { settings?: { computer?: unknown } | null }): Computer | null {
  const c = run.settings?.computer;
  if (!c || typeof c !== "object" || Array.isArray(c)) return null;
  const o = c as Record<string, unknown>;
  if (typeof o.id !== "string" || !COMPUTER_ID.test(o.id)) return null;
  return { id: o.id, name: cleanName(o.name) ?? o.id };
}

/**
 * True when this computer may drive and decide on the run: it was started
 * here; or it names no computer (a run from before the stamp) and is either
 * still queued or its film folder is on this disk — a run whose folder
 * another computer holds is never driven here, where the folder is missing.
 */
export function runIsHere(
  run: { settings?: { computer?: unknown } | null; bucket: string; slug: string; stage: string },
  filmRoot: string | null,
  me: Computer = thisComputer(),
): boolean {
  const owner = runComputerOf(run);
  if (owner) return owner.id === me.id;
  if (run.stage === "queued") return true;
  return !!filmRoot && existsSync(path.join(filmRoot, run.bucket, run.slug));
}
