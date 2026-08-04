import {
	createProvider,
	lazyStream,
	type Model,
	type Provider,
	type ProviderStreams,
} from "@earendil-works/pi-ai";
// Pi's extension loader exposes the built-in lazy API factories through this entry point.
import { anthropicMessagesApi, openAICompletionsApi, openAIResponsesApi } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { spawn } from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { closeSync, constants, openSync, readFileSync, writeSync } from "node:fs";
import { createServer } from "node:net";
import {
	access,
	appendFile,
	mkdir,
	readdir,
	lstat,
	open as openFile,
	readFile,
	realpath,
	rename,
	rm,
	stat,
	unlink,
	writeFile,
} from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const EXTENSION_DIR = dirname(fileURLToPath(import.meta.url));

const PROVIDER_ID = "ds4";
// Keep the historical typo for on-disk lease/state compatibility with older installs.
const MANAGED_BY = "pi-sd4-provider";

const DS4_DIR = join(homedir(), ".pi", "ds4");
const SETTINGS_FILE = join(DS4_DIR, "settings.json");
const KV_DIR = join(DS4_DIR, "kv");
const SUPPORT_DIR = join(DS4_DIR, "support");
const CLIENT_DIR = join(DS4_DIR, "clients");
const LOCK_DIR = join(DS4_DIR, "lock");
const PORT_LOCK_DIR = join(DS4_DIR, "port.lock");
const STATE_FILE = join(DS4_DIR, "server.json");
const PORT_FILE = join(DS4_DIR, "port.json");
const LOG_FILE = join(DS4_DIR, "log");
const LEASE_FILE = join(CLIENT_DIR, `${process.pid}.json`);

type Ds4Settings = Record<string, unknown>;
type ProviderProtocol = "openai-completions" | "openai-responses" | "anthropic-messages";

function settingsKeyForEnv(envName: string): string {
	const withoutPrefix = envName.replace(/^DS4_/, "").toLowerCase();
	return withoutPrefix.replace(/_([a-z])/g, (_match, char: string) => char.toUpperCase());
}

function readSettingsSync(): Ds4Settings {
	try {
		const parsed = JSON.parse(readFileSync(SETTINGS_FILE, "utf8"));
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) return parsed as Ds4Settings;
		throw new Error("settings root must be a JSON object");
	} catch (error: any) {
		if (error?.code === "ENOENT") return {};
		throw new Error(`Failed to read ${SETTINGS_FILE}: ${describeError(error)}`);
	}
}

const DS4_SETTINGS = readSettingsSync();

function settingValue(envName: string): unknown {
	if (process.env[envName] !== undefined) return process.env[envName];
	const snakeKey = envName.replace(/^DS4_/, "").toLowerCase();
	const keys = [envName, settingsKeyForEnv(envName), envName.toLowerCase(), snakeKey];
	for (const key of keys) {
		if (Object.prototype.hasOwnProperty.call(DS4_SETTINGS, key)) return DS4_SETTINGS[key];
	}
	return undefined;
}

function configString(envName: string, defaultValue?: string): string | undefined {
	const value = settingValue(envName);
	if (value === undefined || value === null) return defaultValue;
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	throw new Error(`${envName} must be a string in the environment or ${SETTINGS_FILE}`);
}

function configNumber(envName: string, defaultValue: number): number {
	const value = settingValue(envName);
	if (value === undefined || value === null || value === "") return defaultValue;
	const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
	if (!Number.isFinite(number)) throw new Error(`${envName} must be a finite number in the environment or ${SETTINGS_FILE}`);
	return number;
}

function configBoolean(envName: string, defaultValue: boolean): boolean {
	const value = settingValue(envName);
	if (value === undefined || value === null || value === "") return defaultValue;
	if (typeof value === "boolean") return value;
	if (typeof value === "number") return value !== 0;
	if (typeof value === "string") {
		if (/^(1|true|yes|on)$/i.test(value)) return true;
		if (/^(0|false|no|off)$/i.test(value)) return false;
	}
	throw new Error(`${envName} must be a boolean in the environment or ${SETTINGS_FILE}`);
}

function selectedProtocol(): ProviderProtocol {
	const raw = configString("DS4_PROTOCOL", "openai-responses")?.toLowerCase();
	switch (raw) {
		case "openai":
		case "openai-completions":
		case "chat":
		case "chat-completions":
			return "openai-completions";
		case "responses":
		case "openai-responses":
			return "openai-responses";
		case "anthropic":
		case "anthropic-messages":
		case "messages":
			return "anthropic-messages";
		default:
			throw new Error(`Invalid DS4_PROTOCOL=${raw}; expected openai, openai-responses, or anthropic`);
	}
}

const SUPPORT_REPO = configString("DS4_SUPPORT_REPO", "https://github.com/antirez/ds4")!;
const SUPPORT_BRANCH = configString("DS4_SUPPORT_BRANCH", "main")!;

const SERVER_HOST = "127.0.0.1";
const PROVIDER_API = selectedProtocol();
const SERVER_CONTEXT_TOKENS = configNumber("DS4_CONTEXT_TOKENS", 393_216);
if (!Number.isInteger(SERVER_CONTEXT_TOKENS) || SERVER_CONTEXT_TOKENS <= 0) {
	throw new Error(`DS4_CONTEXT_TOKENS must be a positive integer in the environment or ${SETTINGS_FILE}`);
}
const SERVER_BASE_ARGS = ["--kv-disk-space-mb", "8192"];

const HEARTBEAT_MS = 10_000;
const LEASE_TTL_MS = 45_000;
const LOCK_STALE_MS = 60_000;
const LOCK_TIMEOUT_MS = 30_000;
const STARTUP_LOCK_TIMEOUT_MS = 24 * 60 * 60_000;
const READY_TIMEOUT_MS = configNumber("DS4_READY_TIMEOUT_MS", 10 * 60_000);
const HTTP_CHECK_TIMEOUT_MS = 1_500;
const SHUTDOWN_GRACE_MS = 60_000;
const LOG_TAIL_BYTES = 256 * 1024;
const LOG_MAX_LINES = 2_000;
const LOG_POLL_MS = 1_000;
const WATCHDOG_POLL_MS = 2_000;
const PROGRESS_NOTIFY_MS = 750;
const PROGRESS_MAX_CHARS = 160;

type ModelKey =
	| "dsv4-flash-q2"
	| "dsv4-flash-q2q4"
	| "dsv4-flash-q4"
	| "dsv4-pro-q2"
	| "glm52-q4-xl"
	| "glm52-iq2xxs"
	| "glm52-q2"
	| "glm52-q4";

type LegacyModelQuant = "q2" | "q2-imatrix" | "q2-q4-imatrix" | "q4";

type DownloadableModel = {
	key: ModelKey;
	target: string;
	fileVariable?: string;
	shardedBaseVariable?: string;
	shardCount?: number;
	name: string;
	menuLabel: string;
	contextLimit?: number;
	maxTokens?: number;
};

const DOWNLOADABLE_MODELS: DownloadableModel[] = [
	{
		key: "dsv4-flash-q2",
		target: "ds4f-q2",
		fileVariable: "DS4F_Q2_FILE",
		name: "DeepSeek V4 Flash · Q2 imatrix",
		menuLabel: "DeepSeek V4 Flash / Q2 imatrix — about 81 GB; ≥96 GB RAM",
	},
	{
		key: "dsv4-flash-q2q4",
		target: "ds4f-q2-q4",
		fileVariable: "DS4F_Q2_Q4_FILE",
		name: "DeepSeek V4 Flash · Q2/Q4 imatrix",
		menuLabel: "DeepSeek V4 Flash / Q2-Q4 imatrix — about 98 GB; ≥128 GB RAM",
	},
	{
		key: "dsv4-flash-q4",
		target: "ds4f-q4",
		fileVariable: "DS4F_Q4_FILE",
		name: "DeepSeek V4 Flash · Q4 imatrix",
		menuLabel: "DeepSeek V4 Flash / Q4 imatrix — about 153 GB; ≥256 GB RAM",
	},
	{
		key: "dsv4-pro-q2",
		target: "pro-q2-imatrix",
		fileVariable: "PRO_Q2_IMATRIX_FILE",
		name: "DeepSeek V4 Pro · Q2 imatrix",
		menuLabel: "DeepSeek V4 Pro / Q2 imatrix — about 430 GB; ≥512 GB RAM",
	},
	{
		key: "glm52-q4-xl",
		target: "glm-unsloth-q4",
		shardedBaseVariable: "GLM_UNSLOTH_Q4_LOCAL_BASE",
		shardCount: 11,
		name: "GLM 5.2 · Unsloth Q4 XL",
		menuLabel: "GLM 5.2 / Unsloth Q4 XL — 11 shards; ≥512 GB RAM",
		contextLimit: 202_752,
		maxTokens: 164_000,
	},
	{
		key: "glm52-iq2xxs",
		target: "glm-antirez-iq2xxs",
		fileVariable: "GLM_ANTIREZ_IQ2XXS_FILE",
		name: "GLM 5.2 · IQ2 XXS",
		menuLabel: "GLM 5.2 / IQ2 XXS — about 188 GiB; ≥256 GB RAM",
		contextLimit: 202_752,
		maxTokens: 164_000,
	},
	{
		key: "glm52-q2",
		target: "glm-antirez-q2",
		fileVariable: "GLM_ANTIREZ_Q2_FILE",
		name: "GLM 5.2 · Q2",
		menuLabel: "GLM 5.2 / Q2 — about 262 GB; ≥384 GB RAM",
		contextLimit: 202_752,
		maxTokens: 164_000,
	},
	{
		key: "glm52-q4",
		target: "glm-antirez-q4",
		fileVariable: "GLM_ANTIREZ_Q4_FILE",
		name: "GLM 5.2 · Q4",
		menuLabel: "GLM 5.2 / Q4 — about 434 GB; ≥512 GB RAM",
		contextLimit: 202_752,
		maxTokens: 164_000,
	},
];

const MODELS_BY_KEY = new Map(DOWNLOADABLE_MODELS.map((model) => [model.key, model]));

type ServerEndpoint = {
	host: string;
	port: number;
	origin: string;
	apiBaseUrl: string;
};

type ServerState = {
	managedBy: string;
	pid: number;
	baseUrl: string;
	cwd: string;
	binary: string;
	args: string[];
	startedAt: number;
	startedAtIso: string;
	processStart?: string;
	host?: string;
	origin?: string;
	apiBaseUrl?: string;
	port?: number;
	modelId?: string;
	modelKey?: ModelKey;
	modelQuant?: LegacyModelQuant;
	modelPath?: string;
	kvDir?: string;
	stopping?: boolean;
	stoppingAt?: number;
	stoppingAtIso?: string;
};

type PortState = {
	managedBy: string;
	host: string;
	port: number;
	origin: string;
	apiBaseUrl: string;
	reservedByPid?: number;
	reservedByProcessStart?: string;
	serverPid?: number;
	serverProcessStart?: string;
	cwd?: string;
	updatedAt: number;
	updatedAtIso: string;
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
type LogTheme = { fg: (color: "accent" | "border" | "dim", text: string) => string };
type Component = { render(width: number): string[]; handleInput?(data: string): void; invalidate(): void };

const WATCHDOG_SCRIPT_NAME = "ds4-watchdog.sh";
const WATCHDOG_SCRIPT_CONFIG = configString("DS4_WATCHDOG_SCRIPT");
const WATCHDOG_SCRIPT = WATCHDOG_SCRIPT_CONFIG
	? resolve(WATCHDOG_SCRIPT_CONFIG)
	: join(EXTENSION_DIR, WATCHDOG_SCRIPT_NAME);

let heartbeat: ReturnType<typeof setInterval> | undefined;
let startupPromise: Promise<void> | undefined;
let startupModelKey: ModelKey | undefined;
let activeSetupChild: ChildProcess | undefined;
let resolvedRuntimeDir: string | undefined;
let runtimeCheckoutUpdated = false;
let installedModelKeys = new Set<ModelKey>();
let currentEndpoint: ServerEndpoint | undefined;
let leaseStartedAt = Date.now();
let ownProcessStart: string | undefined;
let leaseActive = false;
let watchdogStarted = false;
let runtimeDisposed = false;
let shuttingDown = false;
let providerStatusCallback: StatusCallback | undefined;
let writeSeq = 0;

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

function isValidPort(port: unknown): port is number {
	return typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65536;
}

function hostForUrl(host: string): string {
	return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function endpointForPort(port: number, host = SERVER_HOST): ServerEndpoint {
	if (!isValidPort(port)) throw new Error(`Invalid ds4-server port: ${port}`);
	const origin = `http://${hostForUrl(host)}:${port}`;
	return { host, port, origin, apiBaseUrl: `${origin}/v1` };
}

function endpointFromUrl(value: string | undefined): ServerEndpoint | undefined {
	if (!value) return undefined;
	try {
		const url = new URL(value);
		if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
		const port = Number(url.port || (url.protocol === "http:" ? 80 : 443));
		if (!isValidPort(port)) return undefined;
		return endpointForPort(port, url.hostname || SERVER_HOST);
	} catch {
		return undefined;
	}
}

function endpointFromState(state: ServerState | undefined): ServerEndpoint | undefined {
	if (!state) return undefined;
	if (isValidPort(state.port)) return endpointForPort(state.port, state.host || SERVER_HOST);
	return endpointFromUrl(state.origin) ?? endpointFromUrl(state.apiBaseUrl) ?? endpointFromUrl(state.baseUrl);
}

function endpointFromPortState(state: PortState | undefined): ServerEndpoint | undefined {
	if (!state || state.managedBy !== MANAGED_BY || !isValidPort(state.port)) return undefined;
	return endpointForPort(state.port, state.host || SERVER_HOST);
}

function currentServerEndpoint(): ServerEndpoint {
	if (!currentEndpoint) throw new Error("ds4-server endpoint was not initialized");
	return currentEndpoint;
}

function baseUrl(): string {
	return currentServerEndpoint().origin;
}

function apiBaseUrl(): string {
	return currentServerEndpoint().apiBaseUrl;
}

function providerBaseUrl(): string {
	return PROVIDER_API === "anthropic-messages" ? baseUrl() : apiBaseUrl();
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

function modelForKey(modelKey: ModelKey): DownloadableModel {
	const model = MODELS_BY_KEY.get(modelKey);
	if (!model) throw new Error(`Unknown ds4 model: ${modelKey}`);
	return model;
}

function modelKeyForModelId(modelId: string | undefined): ModelKey | undefined {
	return modelId && MODELS_BY_KEY.has(modelId as ModelKey) ? (modelId as ModelKey) : undefined;
}

function kvDirForModel(modelKey: ModelKey): string {
	if (modelKey === "dsv4-flash-q2") return join(DS4_DIR, "kv-q2-imatrix");
	if (modelKey === "dsv4-flash-q2q4") return join(DS4_DIR, "kv-q2-q4-imatrix");
	if (modelKey === "dsv4-flash-q4") return KV_DIR;
	return join(DS4_DIR, `kv-${modelKey}`);
}

function contextTokensForModel(modelKey: ModelKey): number {
	return Math.min(SERVER_CONTEXT_TOKENS, modelForKey(modelKey).contextLimit ?? SERVER_CONTEXT_TOKENS);
}

function downloadScriptMentionsTarget(script: string, target: string): boolean {
	return (
		script.includes(`${target})`) ||
		script.includes(`${target}|`) ||
		script.includes(`|${target}`) ||
		script.includes(`./download_model.sh ${target}`)
	);
}

function shellVariable(script: string, name: string): string | undefined {
	const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
	return script.match(new RegExp(`^${escaped}=["']([^"']+)["']\\s*$`, "m"))?.[1];
}

function modelDownloadDir(runtimeDir: string): string {
	return resolve(runtimeDir, process.env.DS4_GGUF_DIR || "gguf");
}

function expectedModelFiles(script: string, model: DownloadableModel): string[] {
	if (model.fileVariable) {
		const fileName = shellVariable(script, model.fileVariable);
		return fileName ? [fileName] : [];
	}
	if (model.shardedBaseVariable && model.shardCount) {
		const base = shellVariable(script, model.shardedBaseVariable);
		if (!base) return [];
		return Array.from(
			{ length: model.shardCount },
			(_unused, index) => `${base}-${String(index + 1).padStart(5, "0")}-of-${String(model.shardCount).padStart(5, "0")}.gguf`,
		);
	}
	return [];
}

async function discoverRuntimeDirForModels(): Promise<string | undefined> {
	const forced = configString("DS4_RUNTIME_DIR");
	if (forced) {
		const runtimeDir = resolve(forced);
		return (await isDs4Checkout(runtimeDir)) ? runtimeDir : undefined;
	}
	if (!(await isDs4Checkout(SUPPORT_DIR))) return undefined;
	return realpath(SUPPORT_DIR).catch(() => SUPPORT_DIR);
}

async function discoverInstalledModelKeys(runtimeDir?: string): Promise<Set<ModelKey>> {
	const installed = new Set<ModelKey>();
	runtimeDir ??= await discoverRuntimeDirForModels();
	if (!runtimeDir) return installed;

	const script = await readFile(join(runtimeDir, "download_model.sh"), "utf8").catch(() => undefined);
	if (!script) return installed;
	for (const model of DOWNLOADABLE_MODELS) {
		const files = expectedModelFiles(script, model);
		if (files.length === 0) continue;
		const present = await Promise.all(
			files.map(async (fileName) => {
				const info = await stat(join(modelDownloadDir(runtimeDir!), fileName)).catch(() => undefined);
				return !!info?.isFile() && info.size > 0;
			}),
		);
		if (present.every(Boolean)) installed.add(model.key);
	}
	return installed;
}

function serverArgsForModel(modelKey: ModelKey, modelPath: string, endpoint = currentServerEndpoint()): string[] {
	return [
		"--model",
		modelPath,
		"--host",
		endpoint.host,
		"--port",
		String(endpoint.port),
		"--ctx",
		String(contextTokensForModel(modelKey)),
		...SERVER_BASE_ARGS,
		"--kv-disk-dir",
		kvDirForModel(modelKey),
	];
}

function legacyModelKey(state: ServerState): ModelKey | undefined {
	if (state.modelId === "deepseek-v4-flash-q2-imatrix") return "dsv4-flash-q2";
	if (state.modelId === "deepseek-v4-flash-q2-q4-imatrix") return "dsv4-flash-q2q4";
	if (state.modelId === "deepseek-v4-flash-q4-imatrix") return "dsv4-flash-q4";
	if (state.modelQuant === "q2" || state.modelQuant === "q2-imatrix") return "dsv4-flash-q2";
	if (state.modelQuant === "q2-q4-imatrix") return "dsv4-flash-q2q4";
	if (state.modelQuant === "q4") return "dsv4-flash-q4";
	return undefined;
}

function serverStateMatchesModel(state: ServerState | undefined, modelKey: ModelKey): boolean {
	if (!state) return false;
	return (state.modelKey ?? modelKeyForModelId(state.modelId) ?? legacyModelKey(state)) === modelKey;
}

async function ensureDirs(): Promise<void> {
	await mkdir(CLIENT_DIR, { recursive: true });
	await mkdir(KV_DIR, { recursive: true });
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

async function processStartMatches(pid: number, expected: string | undefined): Promise<boolean> {
	if (!expected || expected === "unknown") return true;
	const currentStart = await processStart(pid);
	return !!currentStart && currentStart === expected;
}

async function isServerStateForLiveDs4(state: ServerState | undefined): Promise<boolean> {
	if (!state || state.managedBy !== MANAGED_BY || !isPidAlive(state.pid)) return false;
	if (!(await looksLikeDs4Server(state.pid))) return false;
	return processStartMatches(state.pid, state.processStart);
}

async function isPortStateUsable(state: PortState | undefined): Promise<boolean> {
	if (!endpointFromPortState(state)) return false;
	if (state?.serverPid && isPidAlive(state.serverPid) && (await looksLikeDs4Server(state.serverPid))) {
		return processStartMatches(state.serverPid, state.serverProcessStart);
	}
	if (state?.reservedByPid && isPidAlive(state.reservedByPid)) {
		return processStartMatches(state.reservedByPid, state.reservedByProcessStart);
	}
	return false;
}

async function allocateRandomPort(host = SERVER_HOST): Promise<number> {
	return new Promise((resolvePromise, reject) => {
		const server = createServer();
		let settled = false;
		const finish = (error: Error | undefined, port?: number) => {
			if (settled) return;
			settled = true;
			if (error) reject(error);
			else if (isValidPort(port)) resolvePromise(port);
			else reject(new Error("Could not allocate a random ds4-server port"));
		};

		server.unref();
		server.on("error", (error) => finish(error));
		server.listen(0, host, () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : undefined;
			server.close((error) => finish(error ?? undefined, port));
		});
	});
}

async function writePortStateForReservation(endpoint: ServerEndpoint): Promise<void> {
	const now = Date.now();
	const state: PortState = {
		managedBy: MANAGED_BY,
		host: endpoint.host,
		port: endpoint.port,
		origin: endpoint.origin,
		apiBaseUrl: endpoint.apiBaseUrl,
		reservedByPid: process.pid,
		reservedByProcessStart: await getOwnProcessStart(),
		cwd: process.cwd(),
		updatedAt: now,
		updatedAtIso: new Date(now).toISOString(),
	};
	await writeJsonAtomic(PORT_FILE, state);
}

async function writePortStateForServer(endpoint: ServerEndpoint, pid: number, serverProcessStart?: string): Promise<void> {
	const now = Date.now();
	const state: PortState = {
		managedBy: MANAGED_BY,
		host: endpoint.host,
		port: endpoint.port,
		origin: endpoint.origin,
		apiBaseUrl: endpoint.apiBaseUrl,
		reservedByPid: process.pid,
		reservedByProcessStart: await getOwnProcessStart(),
		serverPid: pid,
		serverProcessStart,
		cwd: process.cwd(),
		updatedAt: now,
		updatedAtIso: new Date(now).toISOString(),
	};
	await writeJsonAtomic(PORT_FILE, state);
}

async function resolveEndpointLocked(): Promise<ServerEndpoint> {
	if (currentEndpoint) return currentEndpoint;

	const state = await readState();
	const stateEndpoint = endpointFromState(state);
	if (stateEndpoint && (await isServerStateForLiveDs4(state))) {
		currentEndpoint = stateEndpoint;
		await writePortStateForServer(stateEndpoint, state!.pid, state!.processStart).catch(() => {});
		return currentEndpoint;
	}
	if (state?.pid) await clearState();

	const portState = await readJson<PortState>(PORT_FILE);
	const portStateEndpoint = endpointFromPortState(portState);
	if (portStateEndpoint && (await isPortStateUsable(portState))) {
		currentEndpoint = portStateEndpoint;
		return currentEndpoint;
	}
	if (portState) await removeFile(PORT_FILE).catch(() => {});

	currentEndpoint = endpointForPort(await allocateRandomPort());
	await writePortStateForReservation(currentEndpoint);
	await appendLog(`\n[${new Date().toISOString()}] reserved ds4-server endpoint ${currentEndpoint.origin} for pi pid=${process.pid}\n`);
	return currentEndpoint;
}

async function initializeEndpoint(): Promise<void> {
	await withPortLock(async () => {
		await resolveEndpointLocked();
	}, LOCK_TIMEOUT_MS);
}

function serverStateMatchesEndpoint(state: ServerState | undefined, endpoint = currentServerEndpoint()): boolean {
	const stateEndpoint = endpointFromState(state);
	return !!stateEndpoint && stateEndpoint.host === endpoint.host && stateEndpoint.port === endpoint.port;
}

async function findListeningPids(port = currentServerEndpoint().port): Promise<number[]> {
	const output = await execCapture("lsof", ["-nP", `-tiTCP:${port}`, "-sTCP:LISTEN"], 2_000);
	const pids: number[] = [];
	for (const line of (output ?? "").split(/\r?\n/)) {
		const pid = Number(line.trim());
		if (Number.isInteger(pid) && isPidAlive(pid) && !pids.includes(pid)) pids.push(pid);
	}
	return pids;
}

async function findListeningPid(port = currentServerEndpoint().port): Promise<number | undefined> {
	return (await findListeningPids(port))[0];
}

async function findListeningDs4ServerPid(): Promise<number | undefined> {
	for (const pid of await findListeningPids()) {
		if (await looksLikeDs4Server(pid)) return pid;
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

	const endpoint = currentServerEndpoint();
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
				DS4_BASE_URL: endpoint.apiBaseUrl,
				DS4_PORT: String(endpoint.port),
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

async function updateManagedSupportCheckout(runtimeDir: string, onStatus?: StatusCallback): Promise<void> {
	if (!configBoolean("DS4_AUTO_UPDATE", true)) return;
	if (!(await isDs4Checkout(runtimeDir))) return;

	// A symlink is installed for local development and belongs to its developer;
	// only update the checkout cloned and managed under ~/.pi/ds4/support.
	if ((await lstat(SUPPORT_DIR).catch(() => undefined))?.isSymbolicLink()) return;
	if (!(await stat(join(runtimeDir, ".git")).catch(() => undefined))?.isDirectory()) return;

	const before = (await execCapture("git", ["-C", runtimeDir, "rev-parse", "HEAD"], 5_000))?.trim();
	onStatus?.("checking for the latest ds4 runtime and model manifest");
	try {
		await runLogged(
			"git",
			["pull", "--ff-only", "origin", SUPPORT_BRANCH],
			runtimeDir,
			"update ds4 support checkout",
			{ onStatus, progressPrefix: "updating ds4 support checkout" },
		);
	} catch (error) {
		// Keep an already installed local runtime usable while offline. The failure
		// remains visible in the log and the next session retries the update.
		await appendLog(`[${new Date().toISOString()}] ds4 update skipped: ${describeError(error)}\n`);
		return;
	}
	const after = (await execCapture("git", ["-C", runtimeDir, "rev-parse", "HEAD"], 5_000))?.trim();
	runtimeCheckoutUpdated = !!before && !!after && before !== after;
}

async function ensureSupportCheckout(onStatus?: StatusCallback): Promise<string> {
	if (await isDs4Checkout(SUPPORT_DIR)) {
		let runtimeDir: string;
		try {
			runtimeDir = await realpath(SUPPORT_DIR);
		} catch {
			runtimeDir = SUPPORT_DIR;
		}
		await updateManagedSupportCheckout(runtimeDir, onStatus);
		return runtimeDir;
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

	const forced = configString("DS4_RUNTIME_DIR");
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
	// Let make compare the binary with the current checkout. This is cheap when
	// up to date and ensures a refreshed ds4 checkout never keeps an old server.
	onStatus?.("ensuring latest ds4-server build");
	await runLogged("make", ["ds4-server"], runtimeDir, "build ds4-server", {
		onStatus,
		progressPrefix: "building ds4-server",
	});
	await access(join(runtimeDir, "ds4-server"), constants.X_OK);
}

async function ensureModel(runtimeDir: string, modelKey: ModelKey, onStatus?: StatusCallback): Promise<string> {
	const model = modelForKey(modelKey);
	const script = await readFile(join(runtimeDir, "download_model.sh"), "utf8");
	if (!downloadScriptMentionsTarget(script, model.target)) {
		throw new Error(`The ds4 checkout does not provide the ${model.target} download target`);
	}

	onStatus?.(`ensuring ${model.target} model`);
	await runLogged("./download_model.sh", [model.target], runtimeDir, `download ${model.target} model`, {
		onStatus,
		progressPrefix: `ensuring ${model.target} model`,
	});

	const installed = await discoverInstalledModelKeys(runtimeDir);
	if (!installed.has(modelKey)) throw new Error(`${model.target} download completed without all expected model files`);

	const modelPath = join(runtimeDir, "ds4flash.gguf");
	const resolvedModelPath = await realpath(modelPath).catch(() => modelPath);
	await access(resolvedModelPath, constants.R_OK);
	return resolvedModelPath;
}

async function installedModelPath(runtimeDir: string, modelKey: ModelKey): Promise<string> {
	const model = modelForKey(modelKey);
	const script = await readFile(join(runtimeDir, "download_model.sh"), "utf8");
	const files = expectedModelFiles(script, model);
	if (files.length === 0) throw new Error(`Cannot resolve files for ${model.target}`);
	const installed = await discoverInstalledModelKeys(runtimeDir);
	if (!installed.has(modelKey)) throw new Error(`${model.name} is not downloaded; use /ds4 first`);
	return join(modelDownloadDir(runtimeDir), files[0]);
}

async function ensureRuntimeReadyLocked(
	modelKey: ModelKey,
	onStatus?: StatusCallback,
): Promise<{ runtimeDir: string; modelPath: string }> {
	const runtimeDir = await resolveRuntimeDirLocked(onStatus);
	if (runtimeDisposed || shuttingDown) return { runtimeDir, modelPath: "" };
	await ensureBuilt(runtimeDir, onStatus);
	if (runtimeDisposed || shuttingDown) return { runtimeDir, modelPath: "" };
	const modelPath = await installedModelPath(runtimeDir, modelKey);
	return { runtimeDir, modelPath };
}

async function isLockDirStale(lockDir: string): Promise<boolean> {
	const owner = await readJson<{ pid?: number; processStart?: string }>(join(lockDir, "owner.json"));
	if (owner?.pid) {
		if (!isPidAlive(owner.pid)) return true;
		if (owner.processStart && owner.processStart !== "unknown") {
			const currentStart = await processStart(owner.pid);
			if (currentStart && currentStart !== owner.processStart) return true;
		}
	}

	try {
		const info = await stat(lockDir);
		return Date.now() - info.mtimeMs > LOCK_STALE_MS;
	} catch {
		return true;
	}
}

async function withDirLock<T>(
	lockDir: string,
	name: string,
	fn: () => Promise<T>,
	timeoutMs = LOCK_TIMEOUT_MS,
	abortOnDispose = false,
): Promise<T> {
	await mkdir(DS4_DIR, { recursive: true });
	const started = Date.now();

	while (true) {
		if (abortOnDispose && (runtimeDisposed || shuttingDown)) throw new Error("ds4 startup cancelled");
		try {
			await mkdir(lockDir);
			await writeJsonAtomic(join(lockDir, "owner.json"), {
				managedBy: MANAGED_BY,
				pid: process.pid,
				processStart: await getOwnProcessStart(),
				createdAt: Date.now(),
			});
			break;
		} catch (error: any) {
			if (error?.code !== "EEXIST") throw error;
			if (await isLockDirStale(lockDir)) {
				await rm(lockDir, { recursive: true, force: true });
				continue;
			}
			if (timeoutMs > 0 && Date.now() - started > timeoutMs) {
				throw new Error(`Timed out waiting for ds4 ${name} lock at ${lockDir}`);
			}
			await sleep(100 + Math.floor(Math.random() * 150));
		}
	}

	try {
		return await fn();
	} finally {
		await rm(lockDir, { recursive: true, force: true });
	}
}

function withLock<T>(fn: () => Promise<T>, timeoutMs = LOCK_TIMEOUT_MS, abortOnDispose = false): Promise<T> {
	return withDirLock(LOCK_DIR, "lifecycle", fn, timeoutMs, abortOnDispose);
}

function withPortLock<T>(fn: () => Promise<T>, timeoutMs = LOCK_TIMEOUT_MS): Promise<T> {
	return withDirLock(PORT_LOCK_DIR, "port", fn, timeoutMs, false);
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
		const response = await fetch(`${apiBaseUrl()}/models`, { signal: controller.signal });
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

async function checkHttpReadyForModel(modelKey: ModelKey): Promise<boolean> {
	if (!(await checkHttpReady())) return false;
	const state = await readState();
	return serverStateMatchesEndpoint(state) && serverStateMatchesModel(state, modelKey);
}

async function stopServerPidLocked(pid: number, reason: string): Promise<void> {
	const previous = await readState();
	const endpoint = endpointFromState(previous) ?? currentServerEndpoint();
	const now = Date.now();
	const serverProcessStart = previous?.processStart ?? (await processStart(pid));
	await writeJsonAtomic(STATE_FILE, {
		...(previous ?? {
			managedBy: MANAGED_BY,
			pid,
			cwd: SUPPORT_DIR,
			binary: "ds4-server",
			args: [],
			startedAt: now,
			startedAtIso: new Date(now).toISOString(),
		}),
		pid,
		processStart: serverProcessStart,
		host: endpoint.host,
		port: endpoint.port,
		origin: endpoint.origin,
		apiBaseUrl: endpoint.apiBaseUrl,
		baseUrl: endpoint.apiBaseUrl,
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

async function waitForServerReady(modelKey: ModelKey, onStatus?: StatusCallback): Promise<void> {
	const started = Date.now();
	let lastStatus = 0;

	while (Date.now() - started < READY_TIMEOUT_MS) {
		if (runtimeDisposed || shuttingDown) return;
		if (await checkHttpReadyForModel(modelKey)) return;

		const state = await readState();
		if (state?.pid && !(await isServerStateForLiveDs4(state))) {
			throw new Error(`ds4-server exited before becoming ready; see ${LOG_FILE}`);
		}

		if (Date.now() - lastStatus > 10_000) {
			const elapsed = Math.round((Date.now() - started) / 1000);
			onStatus?.(`ds4-server starting (${elapsed}s)`);
			lastStatus = Date.now();
		}
		await sleep(1_000);
	}

	throw new Error(`Timed out waiting for ds4-server at ${apiBaseUrl()}; see ${LOG_FILE}`);
}

async function startServerLocked(runtimeDir: string, modelKey: ModelKey, modelPath: string): Promise<void> {
	const binary = configString("DS4_SERVER_BINARY") ?? join(runtimeDir, "ds4-server");
	try {
		await access(binary, constants.X_OK);
	} catch {
		throw new Error(`Cannot execute ds4-server at ${binary}`);
	}

	const endpoint = currentServerEndpoint();
	const listeningPid = await findListeningPid(endpoint.port);
	if (listeningPid) {
		const args = await processArgs(listeningPid);
		throw new Error(
			`Cannot start ds4-server: ${endpoint.origin} is already in use by pid ${listeningPid}${args ? ` (${args})` : ""}`,
		);
	}

	const kvDir = kvDirForModel(modelKey);
	await mkdir(kvDir, { recursive: true });
	const serverArgs = serverArgsForModel(modelKey, modelPath, endpoint);

	await appendLog(`\n[${new Date().toISOString()}] start ds4-server (${modelKey})\n$ ${[binary, ...serverArgs].map(shellQuote).join(" ")}\n`);
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
	const serverProcessStart = await processStart(childPid);
	const state: ServerState = {
		managedBy: MANAGED_BY,
		pid: childPid,
		processStart: serverProcessStart,
		host: endpoint.host,
		port: endpoint.port,
		origin: endpoint.origin,
		apiBaseUrl: endpoint.apiBaseUrl,
		baseUrl: endpoint.apiBaseUrl,
		cwd: runtimeDir,
		binary,
		args: serverArgs,
		modelId: modelKey,
		modelKey,
		modelPath,
		kvDir,
		startedAt: now,
		startedAtIso: new Date(now).toISOString(),
	};
	await writeJsonAtomic(STATE_FILE, state);
	await writePortStateForServer(endpoint, childPid, serverProcessStart).catch(() => {});
}

async function ensureServerManagedInner(modelKey: ModelKey, onStatus?: StatusCallback): Promise<void> {
	if (runtimeDisposed || shuttingDown) return;
	let stoppingPid: number | undefined;

	await withLock(async () => {
		await resolveEndpointLocked();
		await resolveRuntimeDirLocked(onStatus);
		await activateLease();
		if (runtimeDisposed || shuttingDown) return;
		await touchLease();
		await pruneLeases();

		const state = await readState();
		if (await isServerStateForLiveDs4(state)) {
			if (state!.stopping) {
				stoppingPid = state!.pid;
				return;
			}
			if (runtimeCheckoutUpdated) {
				onStatus?.("restarting ds4-server after runtime update");
				await stopServerPidLocked(state!.pid, "apply updated ds4 runtime/model manifest");
			} else if (!serverStateMatchesEndpoint(state)) {
				onStatus?.("moving ds4-server to reserved port");
				await stopServerPidLocked(state!.pid, "move ds4-server to reserved port");
			} else if (serverStateMatchesModel(state, modelKey)) {
				return;
			} else {
				onStatus?.(`switching ds4-server to ${modelKey}`);
				await stopServerPidLocked(state!.pid, `switch ds4-server to ${modelKey}`);
			}
		}

		if (state?.pid) await clearState();
		if (await checkHttpReady()) {
			const pid = await findListeningDs4ServerPid();
			if (pid) {
				onStatus?.(`switching ds4-server to ${modelKey}`);
				await stopServerPidLocked(pid, `replace unknown ds4-server with ${modelKey}`);
			}
		}
		if (runtimeDisposed || shuttingDown) return;

		const { runtimeDir, modelPath } = await ensureRuntimeReadyLocked(modelKey, onStatus);
		if (runtimeDisposed || shuttingDown) return;

		onStatus?.(`starting ds4-server (${modelKey})`);
		await startServerLocked(runtimeDir, modelKey, modelPath);
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
		return ensureServerManagedInner(modelKey, onStatus);
	}

	await waitForServerReady(modelKey, onStatus);
}

function ensureServerManaged(modelKey: ModelKey, onStatus?: StatusCallback): Promise<void> {
	if (startupPromise) {
		if (startupModelKey === modelKey) return startupPromise;
		return startupPromise.catch(() => {}).then(() => ensureServerManaged(modelKey, onStatus));
	}

	startupModelKey = modelKey;
	const promise = ensureServerManagedInner(modelKey, onStatus).finally(() => {
		if (startupPromise === promise) {
			startupPromise = undefined;
			startupModelKey = undefined;
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

async function isServerRunning(): Promise<boolean> {
	const state = await readState();
	return !!state && !state.stopping && (await isServerStateForLiveDs4(state));
}

async function stopServerManually(): Promise<boolean> {
	return withLock(async () => {
		const state = await readState();
		if (await isServerStateForLiveDs4(state)) {
			await stopServerPidLocked(state!.pid, "manual stop from /ds4");
			return true;
		}
		if (state?.pid) await clearState();

		const pid = await findListeningDs4ServerPid();
		if (!pid) return false;
		await stopServerPidLocked(pid, "manual stop from /ds4");
		return true;
	});
}

async function downloadModelManually(modelKey: ModelKey, onStatus?: StatusCallback): Promise<string> {
	return withLock(async () => {
		const runtimeDir = await resolveRuntimeDirLocked(onStatus);
		return ensureModel(runtimeDir, modelKey, onStatus);
	}, STARTUP_LOCK_TIMEOUT_MS, true);
}

async function showDs4Log(ctx: ExtensionCommandContext): Promise<void> {
	if (ctx.mode !== "tui") {
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
}

function registerDs4Command(pi: ExtensionAPI): void {
	pi.registerCommand("ds4", {
		description: "Manage the local ds4 server and models",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) return;

			const running = await isServerRunning();
			const serverAction = running ? "Stop server" : "Start server";
			const action = await ctx.ui.select("ds4", ["See log", serverAction, "Download model"]);
			if (!action) return;

			if (action === "See log") {
				await showDs4Log(ctx);
				return;
			}

			if (action === "Stop server") {
				ctx.ui.setStatus("ds4", "stopping ds4-server");
				try {
					const stopped = await stopServerManually();
					ctx.ui.notify(stopped ? "ds4-server stopped" : "ds4-server is not running", "info");
				} catch (error) {
					ctx.ui.notify(`Could not stop ds4-server: ${describeError(error)}`, "error");
				} finally {
					ctx.ui.setStatus("ds4", undefined);
				}
				return;
			}

			if (action === "Start server") {
				const available = DOWNLOADABLE_MODELS.filter((model) => installedModelKeys.has(model.key));
				if (available.length === 0) {
					ctx.ui.notify("No ds4 models are downloaded. Use /ds4 → Download model first.", "warning");
					return;
				}

				const activeModelKey =
					ctx.model?.provider === PROVIDER_ID ? modelKeyForModelId(ctx.model.id) : undefined;
				let modelKey = activeModelKey && installedModelKeys.has(activeModelKey) ? activeModelKey : undefined;
				if (!modelKey) {
					const choices = available.map((model) => ({ model, label: `${model.key} — ${model.name}` }));
					const selected = await ctx.ui.select(
						"Start ds4-server with model",
						choices.map((choice) => choice.label),
					);
					modelKey = choices.find((choice) => choice.label === selected)?.model.key;
				}
				if (!modelKey) return;

				ctx.ui.setStatus("ds4", `starting ds4-server (${modelKey})`);
				try {
					await ensureServerManaged(modelKey, (message) => ctx.ui.setStatus("ds4", message));
					await refreshDs4Provider(pi);
					ctx.ui.notify("ds4-server ready", "info");
				} catch (error) {
					ctx.ui.notify(`Could not start ds4-server: ${describeError(error)}`, "error");
				} finally {
					ctx.ui.setStatus("ds4", undefined);
				}
				return;
			}

			const choices = DOWNLOADABLE_MODELS.map((model) => ({
				model,
				label: `${model.menuLabel}${installedModelKeys.has(model.key) ? " • installed" : ""}`,
			}));
			const selected = await ctx.ui.select(
				"Download ds4 model",
				choices.map((choice) => choice.label),
			);
			const model = choices.find((choice) => choice.label === selected)?.model;
			if (!model) return;

			ctx.ui.setStatus("ds4", `preparing ${model.target} download`);
			try {
				const modelPath = await downloadModelManually(model.key, (message) => ctx.ui.setStatus("ds4", message));
				await refreshDs4Provider(pi);
				ctx.ui.notify(`Downloaded ${model.name}: ${modelPath}`, "info");
			} catch (error) {
				ctx.ui.notify(`Could not download ${model.target}: ${describeError(error)}`, "error");
			} finally {
				ctx.ui.setStatus("ds4", undefined);
			}
		},
	});
}

function modelCompat(): Model<ProviderProtocol>["compat"] {
	if (PROVIDER_API === "openai-completions") {
		return {
			supportsStore: false,
			supportsDeveloperRole: false,
			supportsReasoningEffort: true,
			supportsUsageInStreaming: true,
			maxTokensField: "max_tokens",
			supportsStrictMode: false,
			thinkingFormat: "deepseek",
			requiresReasoningContentOnAssistantMessages: true,
		};
	}
	if (PROVIDER_API === "openai-responses") {
		return { supportsDeveloperRole: false, supportsStrictMode: false };
	}
	return { supportsEagerToolInputStreaming: false };
}

function ds4Model(model: DownloadableModel): Model<ProviderProtocol> {
	const contextWindow = contextTokensForModel(model.key);
	return {
		id: model.key,
		name: model.name,
		api: PROVIDER_API,
		provider: PROVIDER_ID,
		baseUrl: providerBaseUrl(),
		reasoning: true,
		thinkingLevelMap: {
			off: "none",
			minimal: null,
			low: null,
			medium: null,
			high: "high",
			xhigh: null,
			max: "max",
		},
		input: ["text"],
		contextWindow,
		maxTokens: Math.min(model.maxTokens ?? 384_000, contextWindow),
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		compat: modelCompat(),
	};
}

function registeredDs4Models(): Model<ProviderProtocol>[] {
	return DOWNLOADABLE_MODELS.filter((model) => installedModelKeys.has(model.key)).map(ds4Model);
}

function protocolStreams(): ProviderStreams {
	switch (PROVIDER_API) {
		case "openai-completions":
			return openAICompletionsApi();
		case "openai-responses":
			return openAIResponsesApi();
		case "anthropic-messages":
			return anthropicMessagesApi();
	}
}

function managedStreams(upstream: ProviderStreams): ProviderStreams {
	const prepare = (
		model: Model<any>,
		run: () => ReturnType<ProviderStreams["stream"]>,
	) =>
		lazyStream(model, async () => {
			const modelKey = modelKeyForModelId(model.id);
			if (!modelKey || !installedModelKeys.has(modelKey)) {
				throw new Error(`ds4 model ${model.id} is not downloaded; use /ds4 first`);
			}

			const onStatus = (await checkHttpReadyForModel(modelKey)) ? undefined : providerStatusCallback;
			try {
				onStatus?.("preparing ds4-server");
				await ensureServerManaged(modelKey, onStatus);
				return run();
			} finally {
				onStatus?.(undefined);
			}
		});

	return {
		stream: (model, context, options) => prepare(model, () => upstream.stream(model, context, options)),
		streamSimple: (model, context, options) => prepare(model, () => upstream.streamSimple(model, context, options)),
	};
}

function createDs4Provider(): Provider<ProviderProtocol> {
	const configuredApiKey = configString("DS4_API_KEY", "dsv4-local");
	const provider = createProvider<ProviderProtocol>({
		id: PROVIDER_ID,
		name: "ds4.c local",
		baseUrl: providerBaseUrl(),
		auth: {
			apiKey: {
				name: "Local ds4 server",
				async resolve({ credential }) {
					return {
						auth: { apiKey: credential?.key ?? configuredApiKey },
						source: "local ds4-server",
					};
				},
			},
		},
		models: registeredDs4Models(),
		api: managedStreams(protocolStreams()),
	});

	// Local files are the catalog of record. Avoid createProvider's fetchModels
	// store so a removed GGUF cannot be resurrected from a persisted model list.
	return {
		...provider,
		getModels: registeredDs4Models,
		async refreshModels({ signal }) {
			const discovered = await discoverInstalledModelKeys();
			if (!signal?.aborted) installedModelKeys = discovered;
		},
	};
}

function registerDs4Provider(pi: ExtensionAPI): void {
	pi.registerProvider(createDs4Provider());
}

async function refreshDs4Provider(pi: ExtensionAPI): Promise<void> {
	installedModelKeys = await discoverInstalledModelKeys(resolvedRuntimeDir);
	registerDs4Provider(pi);
}

export default async function (pi: ExtensionAPI) {
	runtimeDisposed = false;
	shuttingDown = false;
	leaseStartedAt = Date.now();
	leaseActive = false;
	watchdogStarted = false;
	startupPromise = undefined;
	startupModelKey = undefined;
	activeSetupChild = undefined;
	resolvedRuntimeDir = undefined;
	runtimeCheckoutUpdated = false;
	providerStatusCallback = undefined;
	installedModelKeys = await discoverInstalledModelKeys();
	currentEndpoint = undefined;

	await initializeEndpoint();
	registerDs4Provider(pi);
	registerDs4Command(pi);

	pi.on("before_agent_start", (_event, ctx) => {
		providerStatusCallback =
			ctx.model?.provider === PROVIDER_ID ? (message) => ctx.ui.setWorkingMessage(message) : undefined;
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (providerStatusCallback) ctx.ui.setWorkingMessage();
		providerStatusCallback = undefined;
	});

	pi.on("session_shutdown", async (event, ctx) => {
		runtimeDisposed = true;
		providerStatusCallback = undefined;
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
