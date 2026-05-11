import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { closeSync, constants, openSync, writeSync } from "node:fs";
import {
	access,
	appendFile,
	mkdir,
	readdir,
	open as openFile,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { homedir, totalmem } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

const PROVIDER_ID = "ds4";
const MODEL_ID = "deepseek-v4-flash";
const Q2_IMATRIX_MODEL_ID = "deepseek-v4-flash-q2-imatrix";
// Keep the historical typo for on-disk lease/state compatibility with older installs.
const MANAGED_BY = "pi-sd4-provider";

const DS4_DIR = join(homedir(), ".pi", "ds4");
const KV_DIR = join(DS4_DIR, "kv");
const SUPPORT_DIR = join(DS4_DIR, "support");
const CLIENT_DIR = join(DS4_DIR, "clients");
const LOCK_DIR = join(DS4_DIR, "lock");
const STATE_FILE = join(DS4_DIR, "server.json");
const LOG_FILE = join(DS4_DIR, "log");
const LEASE_FILE = join(CLIENT_DIR, `${process.pid}.json`);

const SUPPORT_REPO = process.env.DS4_SUPPORT_REPO ?? "https://github.com/antirez/ds4";
const SUPPORT_BRANCH = process.env.DS4_SUPPORT_BRANCH ?? "main";

const BASE_URL = "http://127.0.0.1:8000";
const API_BASE_URL = `${BASE_URL}/v1`;
const SERVER_BASE_ARGS = ["--ctx", "100000", "--sessions", "4", "--kv-disk-space-mb", "8192"];

const HEARTBEAT_MS = 10_000;
const LEASE_TTL_MS = 45_000;
const LOCK_STALE_MS = 60_000;
const LOCK_TIMEOUT_MS = 30_000;
const STARTUP_LOCK_TIMEOUT_MS = 24 * 60 * 60_000;
const READY_TIMEOUT_MS = Number(process.env.DS4_READY_TIMEOUT_MS ?? 10 * 60_000);
const HTTP_CHECK_TIMEOUT_MS = 1_500;
const SHUTDOWN_GRACE_MS = 60_000;
const LOG_TAIL_BYTES = 256 * 1024;
const LOG_MAX_LINES = 2_000;
const LOG_POLL_MS = 1_000;
const WATCHDOG_POLL_MS = 2_000;
const PROGRESS_NOTIFY_MS = 750;
const PROGRESS_MAX_CHARS = 160;

type ModelQuant = "q2" | "q2-imatrix" | "q4";

type ServerState = {
	managedBy: string;
	pid: number;
	baseUrl: string;
	cwd: string;
	binary: string;
	args: string[];
	startedAt: number;
	startedAtIso: string;
	modelId?: string;
	modelQuant?: ModelQuant;
	modelPath?: string;
	kvDir?: string;
	stopping?: boolean;
	stoppingAt?: number;
	stoppingAtIso?: string;
};

type Lease = {
	managedBy: string;
	usesDs4: true;
	pid: number;
	processStart: string;
	cwd: string;
	startedAt: number;
	updatedAt: number;
	updatedAtIso: string;
};

type StatusCallback = (message: string | undefined) => void;
type RunLoggedOptions = { onStatus?: StatusCallback; progressPrefix?: string };

type LogTui = { terminal: { rows: number }; requestRender: (force?: boolean) => void };
type LogTheme = { fg: (color: string, text: string) => string };
type Component = { render(width: number): string[]; handleInput?(data: string): void; invalidate(): void };

const WATCHDOG_SCRIPT_NAME = "ds4-watchdog.sh";
const WATCHDOG_SCRIPT = process.env.DS4_WATCHDOG_SCRIPT
	? resolve(process.env.DS4_WATCHDOG_SCRIPT)
	: join(EXTENSION_DIR, WATCHDOG_SCRIPT_NAME);

let heartbeat: ReturnType<typeof setInterval> | undefined;
let startupPromise: Promise<void> | undefined;
let startupModelQuant: ModelQuant | undefined;
let activeSetupChild: ChildProcess | undefined;
let resolvedRuntimeDir: string | undefined;
let leaseStartedAt = Date.now();
let ownProcessStart: string | undefined;
let leaseActive = false;
let watchdogStarted = false;
let runtimeDisposed = false;
let shuttingDown = false;
let writeSeq = 0;
let cachedTools: unknown[] | undefined;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function describeError(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isLockTimeout(error: unknown): boolean {
	return describeError(error).includes("Timed out waiting for ds4 lifecycle lock");
}

function isPidAlive(pid: unknown): pid is number {
	if (typeof pid !== "number" || !Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (error: any) {
		return error?.code === "EPERM";
	}
}

function shellQuote(value: string): string {
	return /^[A-Za-z0-9_./:=+-]+$/.test(value) ? value : `'${value.replace(/'/g, `'\\''`)}'`;
}

function isKey(data: string, key: "escape" | "up" | "down" | "home" | "end" | "pageUp" | "pageDown"): boolean {
	switch (key) {
		case "escape":
			return data === "\x1b";
		case "up":
			return data === "\x1b[A" || data === "\x1bOA";
		case "down":
			return data === "\x1b[B" || data === "\x1bOB";
		case "home":
			return data === "\x1b[H" || data === "\x1bOH" || data === "\x1b[1~";
		case "end":
			return data === "\x1b[F" || data === "\x1bOF" || data === "\x1b[4~";
		case "pageUp":
			return data === "\x1b[5~";
		case "pageDown":
			return data === "\x1b[6~";
	}
}

const ANSI_RE = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07]*(?:\x07|\x1b\\)|_[^\x07]*(?:\x07|\x1b\\))/g;

function stripAnsi(value: string): string {
	return value.replace(ANSI_RE, "");
}

function truncateText(value: string, width: number, ellipsis = "", pad = false): string {
	if (width <= 0) return "";
	let text = stripAnsi(value);
	if (text.length > width) {
		const suffix = ellipsis.length < width ? ellipsis : "";
		text = text.slice(0, width - suffix.length) + suffix;
	}
	return pad ? text + " ".repeat(Math.max(0, width - text.length)) : text;
}

function selectedDefaultModelQuant(): ModelQuant {
	const forced = process.env.DS4_MODEL_QUANT?.toLowerCase();
	if (forced === "q2" || forced === "q2-imatrix" || forced === "q4") return forced;
	if (forced) throw new Error(`Invalid DS4_MODEL_QUANT=${forced}; expected q2, q2-imatrix or q4`);

	const ramGb = totalmem() / 1_000_000_000;
	if (ramGb >= 256) return "q4";
	if (ramGb >= 128) return "q2";
	throw new Error(
		`DeepSeek V4 Flash requires at least 128 GB RAM for the q2 model; detected ${ramGb.toFixed(1)} GB`,
	);
}

function modelQuantForModelId(modelId: string | undefined): ModelQuant | undefined {
	if (modelId === Q2_IMATRIX_MODEL_ID) return "q2-imatrix";
	if (modelId === MODEL_ID) return selectedDefaultModelQuant();
	return undefined;
}

function modelIdForQuant(modelQuant: ModelQuant): string {
	return modelQuant === "q2-imatrix" ? Q2_IMATRIX_MODEL_ID : MODEL_ID;
}

function kvDirForQuant(modelQuant: ModelQuant): string {
	return modelQuant === "q2-imatrix" ? join(DS4_DIR, "kv-q2-imatrix") : KV_DIR;
}

function serverArgsForModel(modelQuant: ModelQuant, modelPath: string): string[] {
	return ["--model", modelPath, ...SERVER_BASE_ARGS, "--kv-disk-dir", kvDirForQuant(modelQuant)];
}

function serverStateMatchesQuant(state: ServerState | undefined, modelQuant: ModelQuant): boolean {
	if (!state) return false;
	if (state.modelQuant) return state.modelQuant === modelQuant;
	// Older pi-ds4 installs did not record the quant. Treat them as matching the
	// historical default model, but never as the explicit q2-imatrix choice.
	return modelQuant !== "q2-imatrix";
}

async function ensureDirs(): Promise<void> {
	await mkdir(CLIENT_DIR, { recursive: true });
	await mkdir(KV_DIR, { recursive: true });
	await mkdir(kvDirForQuant("q2-imatrix"), { recursive: true });
}

async function readJson<T>(file: string): Promise<T | undefined> {
	try {
		return JSON.parse(await readFile(file, "utf8")) as T;
	} catch {
		return undefined;
	}
}

async function writeJsonAtomic(file: string, data: unknown): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	const tmp = `${file}.${process.pid}.${Date.now()}.${++writeSeq}.tmp`;
	await writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, "utf8");
	await rename(tmp, file);
}

async function removeFile(file: string): Promise<void> {
	try {
		await unlink(file);
	} catch (error: any) {
		if (error?.code !== "ENOENT") throw error;
	}
}

async function appendLog(text: string): Promise<void> {
	await mkdir(DS4_DIR, { recursive: true });
	await appendFile(LOG_FILE, text, "utf8");
}

function formatBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
	return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

async function readLogTail(): Promise<string[]> {
	try {
		const info = await stat(LOG_FILE);
		if (!info.isFile()) return [`${LOG_FILE} exists but is not a file`];

		const bytes = Math.min(info.size, LOG_TAIL_BYTES);
		const buffer = Buffer.alloc(bytes);
		const file = await openFile(LOG_FILE, "r");
		try {
			await file.read(buffer, 0, bytes, info.size - bytes);
		} finally {
			await file.close();
		}

		let text = stripAnsi(buffer.toString("utf8")).replace(/\r\n/g, "\n").replace(/\r/g, "\n");
		if (info.size > bytes) {
			const firstNewline = text.indexOf("\n");
			if (firstNewline >= 0) text = text.slice(firstNewline + 1);
			text = `[showing last ${formatBytes(bytes)} of ${formatBytes(info.size)} from ${LOG_FILE}]\n${text}`;
		}

		const lines = text.split("\n");
		if (lines.at(-1) === "") lines.pop();
		return lines.slice(-LOG_MAX_LINES);
	} catch (error: any) {
		if (error?.code === "ENOENT") return [`No ds4 log yet: ${LOG_FILE}`];
		return [`Failed to read ${LOG_FILE}: ${describeError(error)}`];
	}
}

class Ds4LogViewer implements Component {
	private lines: string[] = [];
	private scrollFromBottom = 0;
	private timer: ReturnType<typeof setInterval> | undefined;
	private version = 0;
	private cachedWidth = 0;
	private cachedRows = 0;
	private cachedVersion = -1;
	private cachedScroll = -1;
	private cachedLines: string[] = [];

	constructor(
		private tui: LogTui,
		private theme: LogTheme,
		private done: () => void,
	) {
		void this.refresh();
		this.timer = setInterval(() => void this.refresh(), LOG_POLL_MS);
		this.timer.unref?.();
	}

	private async refresh(): Promise<void> {
		const wasFollowing = this.scrollFromBottom === 0;
		this.lines = await readLogTail();
		this.version++;
		if (wasFollowing) this.scrollFromBottom = 0;
		this.invalidate();
		this.tui.requestRender();
	}

	private viewportHeight(): number {
		return Math.max(8, Math.min(40, this.tui.terminal.rows - 6));
	}

	private bodyHeight(): number {
		return Math.max(1, this.viewportHeight() - 4);
	}

	private clampScroll(): void {
		this.scrollFromBottom = Math.max(0, Math.min(this.scrollFromBottom, Math.max(0, this.lines.length - this.bodyHeight())));
	}

	handleInput(data: string): void {
		const page = Math.max(1, this.bodyHeight() - 2);
		if (isKey(data, "escape") || data === "q") {
			this.done();
			return;
		}
		if (isKey(data, "up") || data === "k") this.scrollFromBottom++;
		else if (isKey(data, "down") || data === "j") this.scrollFromBottom--;
		else if (isKey(data, "home")) this.scrollFromBottom = this.lines.length;
		else if (isKey(data, "end")) this.scrollFromBottom = 0;
		else if (isKey(data, "pageUp") || data === "b") this.scrollFromBottom += page;
		else if (isKey(data, "pageDown") || data === "f") this.scrollFromBottom -= page;
		else return;

		this.clampScroll();
		this.invalidate();
		this.tui.requestRender();
	}

	private borderLine(left: string, fill: string, right: string, width: number, title?: string): string {
		const innerWidth = Math.max(0, width - 2);
		let inner = this.theme.fg("border", fill.repeat(innerWidth));
		if (title) {
			const rawTitle = truncateText(` ${title} `, innerWidth);
			const fillWidth = Math.max(0, innerWidth - rawTitle.length);
			inner = this.theme.fg("accent", rawTitle) + this.theme.fg("border", fill.repeat(fillWidth));
		}
		return this.theme.fg("border", left) + inner + this.theme.fg("border", right);
	}

	private row(text: string, width: number, color?: (value: string) => string): string {
		const innerWidth = Math.max(0, width - 4);
		const content = truncateText(text.replace(/\t/g, "   "), innerWidth, "", true);
		return this.theme.fg("border", "│") + " " + (color ? color(content) : content) + " " + this.theme.fg("border", "│");
	}

	render(width: number): string[] {
		const height = this.viewportHeight();
		if (
			this.cachedWidth === width &&
			this.cachedRows === height &&
			this.cachedVersion === this.version &&
			this.cachedScroll === this.scrollFromBottom
		) {
			return this.cachedLines;
		}

		this.clampScroll();
		const bodyHeight = this.bodyHeight();
		const start = Math.max(0, this.lines.length - bodyHeight - this.scrollFromBottom);
		const visible = this.lines.slice(start, start + bodyHeight);
		while (visible.length < bodyHeight) visible.unshift("");

		const state = this.scrollFromBottom === 0 ? "live" : `${this.scrollFromBottom} lines up`;
		const title = `ds4 log • ${state}`;
		const help = `↑↓ scroll • Pg page • End live • q/Esc close • ${LOG_FILE}`;
		const lines = [
			this.borderLine("╭", "─", "╮", width, title),
			...visible.map((line) => this.row(line, width)),
			this.row(help, width, (value) => this.theme.fg("dim", value)),
			this.borderLine("╰", "─", "╯", width),
		];

		this.cachedWidth = width;
		this.cachedRows = height;
		this.cachedVersion = this.version;
		this.cachedScroll = this.scrollFromBottom;
		this.cachedLines = lines;
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = 0;
	}

	dispose(): void {
		if (this.timer) {
			clearInterval(this.timer);
			this.timer = undefined;
		}
	}
}

async function execCapture(command: string, args: string[], timeoutMs = 2_000): Promise<string | undefined> {
	return new Promise((resolvePromise) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		let child: ChildProcess;

		const finish = (value: string | undefined) => {
			if (settled) return;
			settled = true;
			clearTimeout(timeout);
			resolvePromise(value);
		};

		const timeout = setTimeout(() => {
			try {
				child?.kill("SIGTERM");
			} catch {}
			finish(undefined);
		}, timeoutMs);
		timeout.unref?.();

		try {
			child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
		} catch {
			finish(undefined);
			return;
		}

		child.stdout?.setEncoding("utf8");
		child.stderr?.setEncoding("utf8");
		child.stdout?.on("data", (chunk) => (stdout += chunk));
		child.stderr?.on("data", (chunk) => (stderr += chunk));
		child.on("error", () => finish(undefined));
		child.on("close", (code) => finish(code === 0 ? stdout : stdout || stderr || undefined));
	});
}

async function processArgs(pid: number): Promise<string | undefined> {
	return (await execCapture("ps", ["-p", String(pid), "-o", "args="], 2_000))?.trim();
}

async function processStart(pid: number): Promise<string | undefined> {
	return (await execCapture("ps", ["-p", String(pid), "-o", "lstart="], 2_000))?.trim() || undefined;
}

async function getOwnProcessStart(): Promise<string> {
	ownProcessStart ??= (await processStart(process.pid)) ?? "unknown";
	return ownProcessStart;
}

async function isLeaseForLiveProcess(lease: Lease | undefined): Promise<boolean> {
	if (!lease || lease.managedBy !== MANAGED_BY || lease.usesDs4 !== true) return false;
	if (!isPidAlive(lease.pid)) return false;
	if (!lease.processStart) return false;
	const currentStart = await processStart(lease.pid);
	return currentStart === lease.processStart;
}

async function looksLikeDs4Server(pid: number): Promise<boolean> {
	const args = await processArgs(pid);
	return !!args && /(^|[/\s])ds4-server(\s|$)/.test(args);
}

async function findListeningDs4ServerPid(): Promise<number | undefined> {
	const output = await execCapture("lsof", ["-nP", "-tiTCP:8000", "-sTCP:LISTEN"], 2_000);
	for (const line of (output ?? "").split(/\r?\n/)) {
		const pid = Number(line.trim());
		if (Number.isInteger(pid) && isPidAlive(pid) && (await looksLikeDs4Server(pid))) return pid;
	}
	return undefined;
}

async function resolveWatchdogScript(): Promise<string> {
	try {
		await access(WATCHDOG_SCRIPT, constants.F_OK);
		return WATCHDOG_SCRIPT;
	} catch {
		throw new Error(`Cannot find bundled ${WATCHDOG_SCRIPT_NAME} at ${WATCHDOG_SCRIPT}`);
	}
}

async function cleanupLegacyWatchdogStateFiles(): Promise<void> {
	const entries = await readdir(DS4_DIR).catch(() => [] as string[]);
	await Promise.all(
		entries
			.filter((entry) => /^watchdog(?:-\d+)?\.json$/.test(entry))
			.map((entry) => removeFile(join(DS4_DIR, entry)).catch(() => {})),
	);
}

async function cleanupOldNodeWatchdogs(): Promise<void> {
	const output = await execCapture("ps", ["axww", "-o", "pid=,args="], 2_000);
	for (const line of (output ?? "").split(/\r?\n/)) {
		const match = line.trim().match(/^(\d+)\s+(.*)$/);
		if (!match) continue;
		const pid = Number(match[1]);
		const args = match[2] ?? "";
		if (pid === process.pid || !args.includes("node -e") || !args.includes("ds4-watchdog")) continue;
		try {
			process.kill(pid, "SIGTERM");
			await appendLog(`[${new Date().toISOString()}] stopped old node ds4-watchdog pid=${pid}\n`);
		} catch {}
	}
	await cleanupLegacyWatchdogStateFiles();
}

async function hasRunningWatchdog(): Promise<boolean> {
	const output = await execCapture("ps", ["axww", "-o", "pid=,args="], 2_000);
	const invocation = `${WATCHDOG_SCRIPT_NAME} ${DS4_DIR}`;
	for (const line of (output ?? "").split(/\r?\n/)) {
		const match = line.trim().match(/^(\d+)\s+(.*)$/);
		if (!match) continue;
		const pid = Number(match[1]);
		const args = match[2] ?? "";
		if (pid !== process.pid && args.includes(invocation)) return true;
	}
	return false;
}

async function ensureWatchdog(): Promise<void> {
	if (watchdogStarted) return;
	await mkdir(DS4_DIR, { recursive: true });
	await cleanupOldNodeWatchdogs();
	const watchdogScript = await resolveWatchdogScript();

	if (await hasRunningWatchdog()) {
		watchdogStarted = true;
		return;
	}

	const logFd = openSync(LOG_FILE, "a");
	try {
		const child = spawn("/bin/sh", [watchdogScript, DS4_DIR], {
			detached: true,
			stdio: ["ignore", logFd, logFd],
			env: {
				...process.env,
				DS4_DIR,
				DS4_CLIENT_DIR: CLIENT_DIR,
				DS4_STATE_FILE: STATE_FILE,
				DS4_LOG_FILE: LOG_FILE,
				DS4_BASE_URL: API_BASE_URL,
				DS4_LEASE_TTL_S: String(Math.ceil(LEASE_TTL_MS / 1000)),
				DS4_WATCHDOG_POLL_S: String(Math.max(1, Math.ceil(WATCHDOG_POLL_MS / 1000))),
				DS4_SHUTDOWN_GRACE_S: String(Math.ceil(SHUTDOWN_GRACE_MS / 1000)),
			},
		});
		child.unref();
		watchdogStarted = true;
	} finally {
		closeSync(logFd);
	}
}

async function writeAdoptedServerStateLocked(pid: number): Promise<void> {
	const args = await processArgs(pid);
	const now = Date.now();
	const binary = args?.split(/\s+/, 1)[0] || "ds4-server";
	const state: ServerState = {
		managedBy: MANAGED_BY,
		pid,
		baseUrl: API_BASE_URL,
		cwd: SUPPORT_DIR,
		binary,
		args: args ? [args] : [],
		startedAt: now,
		startedAtIso: new Date(now).toISOString(),
	};
	await writeJsonAtomic(STATE_FILE, state);
	await appendLog(`\n[${new Date().toISOString()}] adopted existing ds4-server pid=${pid}\n`);
}

function formatCurlProgress(line: string): string | undefined {
	const fields = line.trim().split(/\s+/);
	if (fields.length < 12) return undefined;
	if (!/^\d+(?:\.\d+)?$/.test(fields[0]) || !/^\d+(?:\.\d+)?$/.test(fields[2])) return undefined;

	const total = fields[1];
	const percent = fields[2];
	const received = fields[3];
	const left = fields[10];
	const speed = fields[11];
	if (!total || !received) return undefined;

	const details = [`${percent}%`];
	if (speed && speed !== "0") details.push(`${speed}/s`);
	if (left && left !== "--:--:--") details.push(`${left} left`);
	return `${received} / ${total} (${details.join(", ")})`;
}

function compactProgressLine(rawLine: string): string | undefined {
	let line = stripAnsi(rawLine)
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (!line) return undefined;
	if (/^% Total\b/.test(line) || /^Dload\s+Upload\b/.test(line)) return undefined;

	line = formatCurlProgress(line) ?? line;
	if (line.length > PROGRESS_MAX_CHARS) line = `${line.slice(0, PROGRESS_MAX_CHARS - 1)}…`;
	return line;
}

function createProgressReporter(prefix: string, onStatus?: StatusCallback) {
	let lineBuffer = "";
	let latest: string | undefined;
	let emitted: string | undefined;
	let lastEmit = 0;

	const maybeEmit = (force = false) => {
		if (!onStatus || !latest || latest === emitted) return;
		const now = Date.now();
		if (!force && now - lastEmit < PROGRESS_NOTIFY_MS) return;
		emitted = latest;
		lastEmit = now;
		onStatus(`${prefix}: ${latest}`);
	};

	const processLine = (line: string) => {
		const progress = compactProgressLine(line);
		if (!progress) return;
		latest = progress;
		maybeEmit(false);
	};

	const onChunk = (chunk: Buffer | string) => {
		const text = chunk.toString();
		let start = 0;
		for (let i = 0; i < text.length; i++) {
			const ch = text[i];
			if (ch !== "\r" && ch !== "\n") continue;
			processLine(lineBuffer + text.slice(start, i));
			lineBuffer = "";
			if (ch === "\r" && text[i + 1] === "\n") i++;
			start = i + 1;
		}
		lineBuffer += text.slice(start);

		// Some progress renderers (notably tqdm / huggingface-cli) write "\r" before
		// the replacement text instead of after it.  If we wait for the next CR we are
		// always one update behind, and if no next update arrives the UI is stuck on
		// the previous human line ("Downloading ...").  Treat the current unterminated
		// buffer as the latest progress too, but keep buffering it for the final line.
		if (lineBuffer) processLine(lineBuffer);

		if (lineBuffer.length > 4096) {
			lineBuffer = "";
		}
	};

	const flush = () => {
		if (lineBuffer) {
			processLine(lineBuffer);
			lineBuffer = "";
		}
		maybeEmit(true);
	};

	return { onChunk, flush };
}

async function runLogged(command: string, args: string[], cwd: string, label: string, options: RunLoggedOptions = {}): Promise<void> {
	if (runtimeDisposed || shuttingDown) throw new Error(`${label} cancelled`);

	await appendLog(`\n[${new Date().toISOString()}] ${label}\n$ ${[command, ...args].map(shellQuote).join(" ")}\n`);

	const logFd = openSync(LOG_FILE, "a");
	const progress = options.progressPrefix ? createProgressReporter(options.progressPrefix, options.onStatus) : undefined;
	let closed = false;
	const writeLogChunk = (chunk: Buffer | string) => {
		if (closed) return;
		try {
			if (typeof chunk === "string") writeSync(logFd, chunk);
			else writeSync(logFd, chunk);
		} catch {}
	};
	const closeLog = () => {
		if (!closed) {
			closed = true;
			closeSync(logFd);
		}
	};

	await new Promise<void>((resolvePromise, reject) => {
		let child: ChildProcess;
		try {
			child = spawn(command, args, {
				cwd,
				detached: process.platform !== "win32",
				stdio: ["ignore", "pipe", "pipe"],
				env: process.env,
			});
		} catch (error) {
			progress?.flush();
			closeLog();
			reject(error);
			return;
		}

		activeSetupChild = child;
		const handleOutput = (chunk: Buffer) => {
			writeLogChunk(chunk);
			progress?.onChunk(chunk);
		};
		child.stdout?.on("data", handleOutput);
		child.stderr?.on("data", handleOutput);

		const finish = (error?: Error) => {
			if (activeSetupChild === child) activeSetupChild = undefined;
			progress?.flush();
			closeLog();
			if (error) reject(error);
			else resolvePromise();
		};

		child.on("error", (error) => finish(error));
		child.on("close", (code, signal) => {
			if (runtimeDisposed || shuttingDown) {
				finish(new Error(`${label} cancelled`));
			} else if (code === 0) {
				finish();
			} else {
				finish(new Error(`${label} failed (${signal ? `signal ${signal}` : `exit ${code}`}); see ${LOG_FILE}`));
			}
		});
	});
}

function killActiveSetupChild(): void {
	const child = activeSetupChild;
	if (!child?.pid) return;
	try {
		process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGTERM");
	} catch {}
}

async function isDs4Checkout(dir: string): Promise<boolean> {
	try {
		await Promise.all([
			access(join(dir, "download_model.sh"), constants.F_OK),
			access(join(dir, "Makefile"), constants.F_OK),
			access(join(dir, "ds4_server.c"), constants.F_OK),
		]);
		return true;
	} catch {
		return false;
	}
}

async function ensureSupportCheckout(onStatus?: StatusCallback): Promise<string> {
	if (await isDs4Checkout(SUPPORT_DIR)) {
		try {
			return await realpath(SUPPORT_DIR);
		} catch {
			return SUPPORT_DIR;
		}
	}

	try {
		await stat(SUPPORT_DIR);
		throw new Error(`${SUPPORT_DIR} exists but does not look like a ds4 checkout`);
	} catch (error: any) {
		if (error?.code !== "ENOENT") throw error;
	}

	onStatus?.("cloning ds4 support checkout");
	await mkdir(DS4_DIR, { recursive: true });
	await runLogged(
		"git",
		["clone", "--progress", "--branch", SUPPORT_BRANCH, "--single-branch", "--depth", "1", SUPPORT_REPO, SUPPORT_DIR],
		DS4_DIR,
		"clone ds4 support checkout",
		{ onStatus, progressPrefix: "cloning ds4 support checkout" },
	);

	if (!(await isDs4Checkout(SUPPORT_DIR))) {
		throw new Error(`Cloned ${SUPPORT_REPO} but ${SUPPORT_DIR} does not look like a ds4 checkout`);
	}
	return SUPPORT_DIR;
}

async function resolveRuntimeDirLocked(onStatus?: StatusCallback): Promise<string> {
	if (resolvedRuntimeDir) return resolvedRuntimeDir;

	const forced = process.env.DS4_RUNTIME_DIR;
	if (forced) {
		const dir = resolve(forced);
		if (!(await isDs4Checkout(dir))) throw new Error(`DS4_RUNTIME_DIR=${dir} is not a ds4 checkout`);
		resolvedRuntimeDir = dir;
		return dir;
	}

	resolvedRuntimeDir = await ensureSupportCheckout(onStatus);
	return resolvedRuntimeDir;
}

async function ensureBuilt(runtimeDir: string, onStatus?: StatusCallback): Promise<void> {
	try {
		await access(join(runtimeDir, "ds4-server"), constants.X_OK);
		return;
	} catch {}

	onStatus?.("building ds4-server");
	await runLogged("make", ["ds4-server"], runtimeDir, "build ds4-server", {
		onStatus,
		progressPrefix: "building ds4-server",
	});
	await access(join(runtimeDir, "ds4-server"), constants.X_OK);
}

async function ensureModel(runtimeDir: string, modelQuant: ModelQuant, onStatus?: StatusCallback): Promise<string> {
	onStatus?.(`ensuring ${modelQuant} model`);
	await runLogged("./download_model.sh", [modelQuant], runtimeDir, `download ${modelQuant} model`, {
		onStatus,
		progressPrefix: `ensuring ${modelQuant} model`,
	});

	const modelPath = join(runtimeDir, "ds4flash.gguf");
	const resolvedModelPath = await realpath(modelPath).catch(() => modelPath);
	await access(resolvedModelPath, constants.R_OK);
	return resolvedModelPath;
}

async function ensureRuntimeReadyLocked(
	modelQuant: ModelQuant,
	onStatus?: StatusCallback,
): Promise<{ runtimeDir: string; modelPath: string }> {
	const runtimeDir = await resolveRuntimeDirLocked(onStatus);
	if (runtimeDisposed || shuttingDown) return { runtimeDir, modelPath: join(runtimeDir, "ds4flash.gguf") };
	await ensureBuilt(runtimeDir, onStatus);
	if (runtimeDisposed || shuttingDown) return { runtimeDir, modelPath: join(runtimeDir, "ds4flash.gguf") };
	const modelPath = await ensureModel(runtimeDir, modelQuant, onStatus);
	return { runtimeDir, modelPath };
}

async function isLockStale(): Promise<boolean> {
	const owner = await readJson<{ pid?: number; processStart?: string }>(join(LOCK_DIR, "owner.json"));
	if (owner?.pid) {
		if (!isPidAlive(owner.pid)) return true;
		if (owner.processStart) {
			const currentStart = await processStart(owner.pid);
			if (currentStart && currentStart !== owner.processStart) return true;
		}
	}

	try {
		const info = await stat(LOCK_DIR);
		return Date.now() - info.mtimeMs > LOCK_STALE_MS;
	} catch {
		return true;
	}
}

async function withLock<T>(fn: () => Promise<T>, timeoutMs = LOCK_TIMEOUT_MS, abortOnDispose = false): Promise<T> {
	await mkdir(DS4_DIR, { recursive: true });
	const started = Date.now();

	while (true) {
		if (abortOnDispose && (runtimeDisposed || shuttingDown)) throw new Error("ds4 startup cancelled");
		try {
			await mkdir(LOCK_DIR);
			await writeJsonAtomic(join(LOCK_DIR, "owner.json"), {
				managedBy: MANAGED_BY,
				pid: process.pid,
				processStart: await getOwnProcessStart(),
				createdAt: Date.now(),
			});
			break;
		} catch (error: any) {
			if (error?.code !== "EEXIST") throw error;
			if (await isLockStale()) {
				await rm(LOCK_DIR, { recursive: true, force: true });
				continue;
			}
			if (timeoutMs > 0 && Date.now() - started > timeoutMs) {
				throw new Error(`Timed out waiting for ds4 lifecycle lock at ${LOCK_DIR}`);
			}
			await sleep(100 + Math.floor(Math.random() * 150));
		}
	}

	try {
		return await fn();
	} finally {
		await rm(LOCK_DIR, { recursive: true, force: true });
	}
}

async function touchLease(): Promise<void> {
	const now = Date.now();
	const lease: Lease = {
		managedBy: MANAGED_BY,
		usesDs4: true,
		pid: process.pid,
		processStart: await getOwnProcessStart(),
		cwd: process.cwd(),
		startedAt: leaseStartedAt,
		updatedAt: now,
		updatedAtIso: new Date(now).toISOString(),
	};
	await writeJsonAtomic(LEASE_FILE, lease);
}

function startHeartbeat(): void {
	if (heartbeat) clearInterval(heartbeat);
	heartbeat = setInterval(() => {
		void touchLease().catch(() => {});
	}, HEARTBEAT_MS);
	heartbeat.unref?.();
}

function stopHeartbeat(): void {
	if (heartbeat) {
		clearInterval(heartbeat);
		heartbeat = undefined;
	}
}

async function pruneLeases(): Promise<void> {
	await mkdir(CLIENT_DIR, { recursive: true });
	const entries = await readdir(CLIENT_DIR).catch(() => [] as string[]);
	const now = Date.now();

	for (const entry of entries) {
		if (!entry.endsWith(".json")) continue;
		const file = join(CLIENT_DIR, entry);
		const [lease, info] = await Promise.all([readJson<Lease>(file), stat(file).catch(() => undefined)]);
		const staleByAge = !info || now - info.mtimeMs > LEASE_TTL_MS;
		const staleByProcess = !(await isLeaseForLiveProcess(lease));
		if (staleByAge || staleByProcess) await removeFile(file);
	}
}

async function activateLease(): Promise<void> {
	await ensureDirs();
	await touchLease();
	leaseActive = true;
	await pruneLeases();
	await ensureWatchdog();
	startHeartbeat();
}

async function removeOwnLease(): Promise<void> {
	await removeFile(LEASE_FILE);
	leaseActive = false;
}

async function readState(): Promise<ServerState | undefined> {
	return readJson<ServerState>(STATE_FILE);
}

async function clearState(): Promise<void> {
	await removeFile(STATE_FILE);
}

async function checkHttpReady(): Promise<boolean> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), HTTP_CHECK_TIMEOUT_MS);
	try {
		const response = await fetch(`${API_BASE_URL}/models`, { signal: controller.signal });
		return response.ok;
	} catch {
		return false;
	} finally {
		clearTimeout(timeout);
	}
}

async function waitForPidExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isPidAlive(pid)) return true;
		await sleep(500);
	}
	return !isPidAlive(pid);
}

async function checkHttpReadyForQuant(modelQuant: ModelQuant): Promise<boolean> {
	if (!(await checkHttpReady())) return false;
	return serverStateMatchesQuant(await readState(), modelQuant);
}

async function stopServerPidLocked(pid: number, reason: string): Promise<void> {
	const previous = await readState();
	const now = Date.now();
	await writeJsonAtomic(STATE_FILE, {
		...(previous ?? {
			managedBy: MANAGED_BY,
			pid,
			baseUrl: API_BASE_URL,
			cwd: SUPPORT_DIR,
			binary: "ds4-server",
			args: [],
			startedAt: now,
			startedAtIso: new Date(now).toISOString(),
		}),
		pid,
		stopping: true,
		stoppingAt: now,
		stoppingAtIso: new Date(now).toISOString(),
	});

	await appendLog(`\n[${new Date().toISOString()}] ${reason}; stopping ds4-server pid=${pid}\n`);
	try {
		process.kill(pid, "SIGTERM");
	} catch (error: any) {
		if (error?.code !== "ESRCH") throw error;
	}

	if (!(await waitForPidExit(pid, SHUTDOWN_GRACE_MS))) {
		await appendLog(`[${new Date().toISOString()}] ds4-server pid=${pid} still alive; sending SIGKILL\n`);
		try {
			process.kill(pid, "SIGKILL");
		} catch {}
		await waitForPidExit(pid, 5_000);
	}

	if (isPidAlive(pid)) throw new Error(`ds4-server pid ${pid} did not exit`);
	await clearState();
	await appendLog(`[${new Date().toISOString()}] ds4-server pid=${pid} stopped\n`);
}

async function waitForServerReady(modelQuant: ModelQuant, onStatus?: StatusCallback): Promise<void> {
	const started = Date.now();
	let lastStatus = 0;

	while (Date.now() - started < READY_TIMEOUT_MS) {
		if (runtimeDisposed || shuttingDown) return;
		if (await checkHttpReadyForQuant(modelQuant)) return;

		const state = await readState();
		if (state?.pid && !isPidAlive(state.pid)) {
			throw new Error(`ds4-server exited before becoming ready; see ${LOG_FILE}`);
		}

		if (Date.now() - lastStatus > 10_000) {
			const elapsed = Math.round((Date.now() - started) / 1000);
			onStatus?.(`ds4-server starting (${elapsed}s)`);
			lastStatus = Date.now();
		}
		await sleep(1_000);
	}

	throw new Error(`Timed out waiting for ds4-server at ${API_BASE_URL}; see ${LOG_FILE}`);
}

async function startServerLocked(runtimeDir: string, modelQuant: ModelQuant, modelPath: string): Promise<void> {
	const binary = process.env.DS4_SERVER_BINARY ?? join(runtimeDir, "ds4-server");
	try {
		await access(binary, constants.X_OK);
	} catch {
		throw new Error(`Cannot execute ds4-server at ${binary}`);
	}

	const kvDir = kvDirForQuant(modelQuant);
	await mkdir(kvDir, { recursive: true });
	const serverArgs = serverArgsForModel(modelQuant, modelPath);

	await appendLog(`\n[${new Date().toISOString()}] start ds4-server (${modelQuant})\n$ ${[binary, ...serverArgs].map(shellQuote).join(" ")}\n`);
	const logFd = openSync(LOG_FILE, "a");
	let childPid: number | undefined;
	try {
		const child = spawn(binary, serverArgs, {
			cwd: runtimeDir,
			detached: true,
			stdio: ["ignore", logFd, logFd],
			env: process.env,
		});
		child.unref();
		childPid = child.pid;
	} finally {
		closeSync(logFd);
	}

	if (!childPid) throw new Error("Failed to start ds4-server: no child PID");

	const now = Date.now();
	const state: ServerState = {
		managedBy: MANAGED_BY,
		pid: childPid,
		baseUrl: API_BASE_URL,
		cwd: runtimeDir,
		binary,
		args: serverArgs,
		modelId: modelIdForQuant(modelQuant),
		modelQuant,
		modelPath,
		kvDir,
		startedAt: now,
		startedAtIso: new Date(now).toISOString(),
	};
	await writeJsonAtomic(STATE_FILE, state);
}

async function ensureServerManagedInner(modelQuant: ModelQuant, onStatus?: StatusCallback): Promise<void> {
	if (runtimeDisposed || shuttingDown) return;
	let stoppingPid: number | undefined;

	await withLock(async () => {
		await resolveRuntimeDirLocked(onStatus);
		await activateLease();
		if (runtimeDisposed || shuttingDown) return;
		await touchLease();
		await pruneLeases();

		const state = await readState();
		if (state?.pid && isPidAlive(state.pid) && (await looksLikeDs4Server(state.pid))) {
			if (state.stopping) {
				stoppingPid = state.pid;
				return;
			}
			if (serverStateMatchesQuant(state, modelQuant)) return;
			onStatus?.(`switching ds4-server to ${modelQuant} model`);
			await stopServerPidLocked(state.pid, `switch ds4-server to ${modelQuant}`);
		}

		if (state?.pid) await clearState();
		if (await checkHttpReady()) {
			const pid = await findListeningDs4ServerPid();
			if (pid) {
				if (modelQuant === "q2-imatrix") {
					onStatus?.("switching ds4-server to q2-imatrix model");
					await stopServerPidLocked(pid, "replace unknown ds4-server with q2-imatrix");
				} else {
					await writeAdoptedServerStateLocked(pid);
					return;
				}
			}
		}
		if (runtimeDisposed || shuttingDown) return;

		const { runtimeDir, modelPath } = await ensureRuntimeReadyLocked(modelQuant, onStatus);
		if (runtimeDisposed || shuttingDown) return;

		onStatus?.(`starting ds4-server (${modelQuant})`);
		await startServerLocked(runtimeDir, modelQuant, modelPath);
	}, STARTUP_LOCK_TIMEOUT_MS, true);

	if (runtimeDisposed || shuttingDown) return;

	if (stoppingPid) {
		onStatus?.("waiting for previous ds4-server shutdown");
		if (!(await waitForPidExit(stoppingPid, SHUTDOWN_GRACE_MS))) {
			throw new Error(`Previous ds4-server pid ${stoppingPid} did not exit`);
		}
		await withLock(async () => {
			const state = await readState();
			if (state?.pid === stoppingPid && !isPidAlive(stoppingPid)) await clearState();
		}, LOCK_TIMEOUT_MS);
		return ensureServerManagedInner(modelQuant, onStatus);
	}

	await waitForServerReady(modelQuant, onStatus);
}

function ensureServerManaged(modelQuant: ModelQuant, onStatus?: StatusCallback): Promise<void> {
	if (startupPromise) {
		if (startupModelQuant === modelQuant) return startupPromise;
		return startupPromise.catch(() => {}).then(() => ensureServerManaged(modelQuant, onStatus));
	}

	startupModelQuant = modelQuant;
	const promise = ensureServerManagedInner(modelQuant, onStatus).finally(() => {
		if (startupPromise === promise) {
			startupPromise = undefined;
			startupModelQuant = undefined;
		}
	});
	startupPromise = promise;
	return promise;
}

async function stopServerIfUnused(): Promise<void> {
	// The watchdog owns lease refcounting and server shutdown.  Keep /quit fast:
	// removing our lease is enough for it to stop ds4-server when nobody else is using it.
	await removeOwnLease();
}

function registerDs4Command(pi: ExtensionAPI): void {
	pi.registerCommand("ds4", {
		description: "Show the live ds4-server log",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(`ds4 log: ${LOG_FILE}`, "info");
				return;
			}

			let viewer: Ds4LogViewer | undefined;
			try {
				await ctx.ui.custom<void>(
					(tui, theme, _keybindings, done) => {
						viewer = new Ds4LogViewer(tui, theme, done);
						return viewer;
					},
					{
						overlay: true,
						overlayOptions: {
							width: "90%",
							minWidth: 60,
							maxHeight: "85%",
							anchor: "center",
							margin: 1,
						},
					},
				);
			} finally {
				viewer?.dispose();
			}
		},
	});
}

function ds4Model(id: string, name: string) {
	return {
		id,
		name,
		reasoning: true,
		thinkingLevelMap: {
			minimal: "low",
			low: "low",
			medium: "medium",
			high: "high",
			xhigh: "xhigh",
		},
		input: ["text"],
		contextWindow: 100000,
		maxTokens: 384000,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	};
}

function registerDs4Provider(pi: ExtensionAPI): void {
	const compat = {
		supportsStore: false,
		supportsDeveloperRole: false,
		supportsReasoningEffort: true,
		supportsUsageInStreaming: true,
		maxTokensField: "max_tokens",
		supportsStrictMode: false,
		thinkingFormat: "deepseek",
		requiresReasoningContentOnAssistantMessages: true,
		sendSessionAffinityHeaders: true,
	};
	pi.registerProvider(PROVIDER_ID, {
		name: "ds4.c local",
		baseUrl: API_BASE_URL,
		api: "openai-completions",
		apiKey: "dsv4-local",
		compat,
		models: [
			ds4Model(MODEL_ID, "DeepSeek V4 Flash (ds4.c local)"),
			ds4Model(Q2_IMATRIX_MODEL_ID, "DeepSeek V4 Flash q2 imatrix (ds4.c local)"),
		],
	} as any);
}

export default function (pi: ExtensionAPI) {
	runtimeDisposed = false;
	shuttingDown = false;
	leaseStartedAt = Date.now();
	leaseActive = false;
	watchdogStarted = false;
	startupPromise = undefined;
	startupModelQuant = undefined;
	activeSetupChild = undefined;
	resolvedRuntimeDir = undefined;

	registerDs4Provider(pi);
	registerDs4Command(pi);

	pi.on("before_provider_request", async (_event, ctx) => {
		if (ctx.model?.provider !== PROVIDER_ID) return;
		let modelQuant: ModelQuant | undefined;
		try {
			modelQuant = modelQuantForModelId(ctx.model?.id);
		} catch (error) {
			ctx.ui.notify(`ds4-server startup failed: ${describeError(error)}`, "error");
			throw error;
		}
		if (!modelQuant) return;

		// Cache tools from real requests so warmup can include them.
		// Tool schemas are injected into the system prompt during tokenization —
		// without matching tools, warmup creates an incompatible checkpoint.
		const payloadTools = (_event as any).payload?.tools;
		if (Array.isArray(payloadTools) && payloadTools.length > 0) {
			cachedTools = payloadTools;
		}

		const alreadyReady = await checkHttpReadyForQuant(modelQuant);
		let lastNotification: string | undefined;
		const notifyStatus: StatusCallback | undefined = alreadyReady
			? undefined
			: (message) => {
					if (!message || message === lastNotification) return;
					if (/^ds4-server starting \(\d+s\)$/.test(message)) return;
					lastNotification = message;
					ctx.ui.notify(message, "info");
				};

		try {
			notifyStatus?.("preparing ds4-server");
			await ensureServerManaged(modelQuant, notifyStatus);
			if (!alreadyReady) ctx.ui.notify("ds4-server ready", "info");
		} catch (error) {
			ctx.ui.notify(`ds4-server startup failed: ${describeError(error)}`, "error");
			throw error;
		}

		// Show prefill progress if the pool slot is cold (no cached prefix).
		// This fires in the background — before_provider_request returns
		// immediately and the actual HTTP request blocks on prefill.
		const sessionId = ctx.sessionManager.getSessionId();
		try {
			const poolRes = await fetch(`${BASE_URL}/v1/pool`, { signal: AbortSignal.timeout(1000) });
			if (poolRes.ok) {
				const pool = await poolRes.json() as any;
				const mySlot = pool.slots?.find((s: any) => s.session_id === sessionId);
				// Start progress polling if no slot yet (queued), empty slot, or
				// slot from template clone that still needs significant prefill.
				const needsProgress = !mySlot || mySlot.pos === 0 ||
					(mySlot.pos > 0 && mySlot.pos < 35000);
				if (needsProgress) {
					const totalEstimate = 38000; // typical pi prompt size
					let cancelled = false;
					let wasQueued = false;
					const timer = setInterval(async () => {
						try {
							const r = await fetch(`${BASE_URL}/v1/pool`, { signal: AbortSignal.timeout(1000) });
							if (!r.ok) return;
							const p = await r.json() as any;
							const slot = p.slots?.find((s: any) => s.session_id === sessionId);
							if (!slot) {
								// No slot assigned yet — request is queued behind another
								wasQueued = true;
								const queueArr = (p.queue ?? []) as string[];
								const total = queueArr.length || (p.queued ?? 0) as number;
								const myPos = queueArr.indexOf(sessionId);
								const posStr = total > 0
									? ` (pos ${myPos >= 0 ? myPos + 1 : total}/${total})`
									: "";
								ctx.ui.notify(`queued${posStr} — waiting for another session to finish`, "info");
								return;
							}
							if (slot.pos >= totalEstimate - 2048) {
								clearInterval(timer);
								cancelled = true;
								return;
							}
							const pct = Math.min(99, Math.round((slot.pos / totalEstimate) * 100));
							ctx.ui.notify(`prefilling context: ${pct}% (${slot.pos} tokens)`, "info");
						} catch {}
					}, 3000);
					(timer as any).unref?.();
					// Auto-cancel after 5 minutes
					setTimeout(() => { if (!cancelled) clearInterval(timer); }, 300_000).unref?.();
				}
			}
		} catch {}

		// When the user aborts (Esc), kill the ds4 worker immediately so queued
		// requests can proceed.  Without this, the worker continues prefilling
		// the cancelled request until it tries to write the response.
		const signal = ctx.signal;
		if (signal) {
			const onAbort = async () => {
				try {
					const r = await fetch(`${BASE_URL}/v1/pool`, { signal: AbortSignal.timeout(1000) });
					if (!r.ok) return;
					const pool = await r.json() as any;
					const mySlot = pool.slots?.find((s: any) => s.session_id === sessionId);
					if (mySlot !== undefined) {
						await fetch(`${BASE_URL}/v1/pool/${mySlot.slot}`, {
							method: "DELETE",
							signal: AbortSignal.timeout(2000),
						});
					}
				} catch {}
			};
			if (signal.aborted) {
				onAbort();
			} else {
				signal.addEventListener("abort", onAbort, { once: true });
			}
		}
	});

	pi.on("session_compact", async (_event, ctx) => {
		if (ctx.model?.provider !== PROVIDER_ID || ctx.model?.id !== MODEL_ID) return;

		// After compaction, the session's messages are shorter.  Fire a warmup
		// so ds4-server rebuilds its KV cache to the compacted prompt before the
		// user's next message arrives.  This avoids a full cold prefill on the
		// next real request (which would otherwise take 10-30s at 10K-30K tokens).
		//
		// CRITICAL: Include tools in the warmup body.  Tool schemas are injected
		// into the system prompt during tokenization.  Without tools, the warmup
		// creates a checkpoint that's token-incompatible with real requests,
		// destroying the existing valid checkpoint and forcing a full cold prefill
		// on the next real request.
		const sessionId = ctx.sessionManager.getSessionId();
		const sessionContext = ctx.sessionManager.buildSessionContext();
		if (!sessionContext.messages.length) return;

		// Build a minimal chat request with the post-compaction messages.
		// The warmup endpoint parses this like a normal /v1/chat/completions
		// request but only runs prefill (no generation).
		const messages = sessionContext.messages.map((msg: any) => {
			if (msg.role === "user" || msg.role === "assistant" || msg.role === "system") {
				return { role: msg.role, content: typeof msg.content === "string" ? msg.content : JSON.stringify(msg.content) };
			}
			return { role: msg.role, content: msg.content };
		});

		// Use cached tools from the last real request (byte-identical to what
		// the provider saw, ensuring tokenization matches).
		const body: Record<string, unknown> = { model: MODEL_ID, messages };
		if (cachedTools && cachedTools.length > 0) {
			body.tools = cachedTools;
		}

		try {
			await fetch(`${BASE_URL}/v1/warmup`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-Session-Id": sessionId,
				},
				body: JSON.stringify(body),
				signal: AbortSignal.timeout(5_000),
			});
		} catch {
			// Best-effort — warmup failure is not critical.
		}
	});

	pi.on("session_shutdown", async (event, ctx) => {
		runtimeDisposed = true;
		stopHeartbeat();
		killActiveSetupChild();

		try {
			if (startupPromise) await Promise.race([startupPromise.catch(() => {}), sleep(5_000)]);
		} catch {}

		// Session switches and /reload immediately create another extension instance
		// in the same pi process. Keep the lease for those hand-offs.
		if (event.reason !== "quit") return;

		shuttingDown = true;
		try {
			await stopServerIfUnused();
		} catch (error) {
			if (!isLockTimeout(error)) ctx.ui.notify(`ds4-server shutdown failed: ${describeError(error)}`, "error");
		}
	});
}
