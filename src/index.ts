import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

type FastModeState = {
	fast: boolean;
	updatedAt: number;
};

type MutablePayload = Record<string, unknown>;

type FastModeMeta = {
	fastMode?: boolean;
	serviceTier?: string;
	baseCost?: Usage["cost"];
};

const STATE_TYPE = "openai-fast-mode-state";
const STATUS_KEY = "openai-fast-mode";
const PRIORITY_SERVICE_TIER = "priority";
const STANDARD_SERVICE_TIER = "default";
const FAST_COST_MULTIPLIER = 2;
const MESSAGE_META_KEY = "__piOpenAIFastMode";

function isRecord(value: unknown): value is MutablePayload {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalizeArg(args: string): string {
	return args.trim().toLowerCase();
}

function restoreFastMode(ctx: ExtensionContext): boolean {
	let restored = false;

	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== STATE_TYPE) continue;
		const data = entry.data as Partial<FastModeState> | undefined;
		if (typeof data?.fast === "boolean") {
			restored = data.fast;
		}
	}

	return restored;
}

function isOpenAIGptModel(model: ExtensionContext["model"]): boolean {
	if (!model) return false;

	const provider = model.provider.toLowerCase();
	const id = model.id.toLowerCase();
	const api = String(model.api).toLowerCase();
	const baseUrl = model.baseUrl?.toLowerCase() ?? "";

	const isBuiltinOpenAIProvider =
		provider === "openai" || provider === "openai-codex" || provider === "azure-openai-responses";

	const isOpenAICompatibleApi =
		api === "openai-responses" || api === "openai-codex-responses" || api === "openai-completions";

	const looksLikeOpenAIEndpoint =
		baseUrl.includes("api.openai.com") ||
		baseUrl.includes("chatgpt.com/backend-api") ||
		baseUrl.includes("openai.azure.com") ||
		baseUrl.includes("cognitiveservices.azure.com");

	const looksLikeGpt = id.includes("gpt");

	return looksLikeGpt && (isBuiltinOpenAIProvider || (isOpenAICompatibleApi && looksLikeOpenAIEndpoint));
}

function modelLooksOpenAIGpt(ctx: ExtensionContext): boolean {
	return isOpenAIGptModel(ctx.model);
}

function desiredServiceTier(fastMode: boolean): string {
	return fastMode ? PRIORITY_SERVICE_TIER : STANDARD_SERVICE_TIER;
}

function updateStatus(ctx: ExtensionContext, fastMode: boolean): void {
	const label = fastMode ? "fast on" : "fast off";
	const color = fastMode ? "success" : "dim";
	ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg(color, label));
}

function persistFastMode(pi: ExtensionAPI, fastMode: boolean): void {
	pi.appendEntry<FastModeState>(STATE_TYPE, {
		fast: fastMode,
		updatedAt: Date.now(),
	});
}

function cloneCost(cost: Usage["cost"]): Usage["cost"] {
	return {
		input: cost.input,
		output: cost.output,
		cacheRead: cost.cacheRead,
		cacheWrite: cost.cacheWrite,
		total: cost.total,
	};
}

function multiplyCost(cost: Usage["cost"], multiplier: number): Usage["cost"] {
	return {
		input: cost.input * multiplier,
		output: cost.output * multiplier,
		cacheRead: cost.cacheRead * multiplier,
		cacheWrite: cost.cacheWrite * multiplier,
		total: cost.total * multiplier,
	};
}

function getFastModeMeta(message: AssistantMessage): FastModeMeta | undefined {
	const maybeMeta = (message as AssistantMessage & Record<string, unknown>)[MESSAGE_META_KEY];
	return isRecord(maybeMeta) ? (maybeMeta as FastModeMeta) : undefined;
}

function withFastModeMeta(message: AssistantMessage, meta: FastModeMeta): AssistantMessage {
	return {
		...message,
		[MESSAGE_META_KEY]: meta,
	} as AssistantMessage;
}

function isAssistantMessageForOpenAIGpt(message: AssistantMessage, ctx: ExtensionContext): boolean {
	const registryModel = ctx.modelRegistry.find(message.provider, message.model);
	if (registryModel && isOpenAIGptModel(registryModel)) return true;

	const provider = message.provider.toLowerCase();
	const id = message.model.toLowerCase();
	const api = String(message.api).toLowerCase();

	return (
		id.includes("gpt") &&
		(provider === "openai" ||
			provider === "openai-codex" ||
			provider === "azure-openai-responses" ||
			api === "openai-responses" ||
			api === "openai-codex-responses" ||
			api === "openai-completions")
	);
}

function calculateStandardCost(message: AssistantMessage, ctx: ExtensionContext): Usage["cost"] | undefined {
	const model = ctx.modelRegistry.find(message.provider, message.model);
	if (!model) return undefined;

	const cost = {
		input: (model.cost.input / 1_000_000) * message.usage.input,
		output: (model.cost.output / 1_000_000) * message.usage.output,
		cacheRead: (model.cost.cacheRead / 1_000_000) * message.usage.cacheRead,
		cacheWrite: (model.cost.cacheWrite / 1_000_000) * message.usage.cacheWrite,
		total: 0,
	};
	cost.total = cost.input + cost.output + cost.cacheRead + cost.cacheWrite;
	return cost;
}

function applyFastModePricing(
	message: AssistantMessage,
	ctx: ExtensionContext,
	fastMode: boolean,
): AssistantMessage | undefined {
	if (!fastMode) return undefined;
	if (!isAssistantMessageForOpenAIGpt(message, ctx)) return undefined;

	const existingMeta = getFastModeMeta(message);
	const baseCost = calculateStandardCost(message, ctx) ?? existingMeta?.baseCost ?? cloneCost(message.usage.cost);
	const adjustedCost = multiplyCost(baseCost, FAST_COST_MULTIPLIER);

	return withFastModeMeta(
		{
			...message,
			usage: {
				...message.usage,
				cost: adjustedCost,
			},
		},
		{
			fastMode: true,
			serviceTier: PRIORITY_SERVICE_TIER,
			baseCost,
		},
	);
}

export default function openAIFastMode(pi: ExtensionAPI) {
	let fastMode = false;

	function setFastMode(ctx: ExtensionContext, next: boolean, persist: boolean): void {
		fastMode = next;
		if (persist) persistFastMode(pi, fastMode);
		updateStatus(ctx, fastMode);
	}

	pi.registerCommand("fast", {
		description: "Toggle OpenAI GPT service_tier priority/default fast mode",
		handler: async (args, ctx) => {
			const arg = normalizeArg(args);

			if (arg === "" || arg === "toggle") {
				setFastMode(ctx, !fastMode, true);
			} else if (arg === "on" || arg === "true" || arg === "1" || arg === "priority") {
				setFastMode(ctx, true, true);
			} else if (arg === "off" || arg === "false" || arg === "0" || arg === "standard" || arg === "default") {
				setFastMode(ctx, false, true);
			} else if (arg !== "status") {
				ctx.ui.notify("Usage: /fast [on|off|status]", "warning");
				return;
			}

			const tier = desiredServiceTier(fastMode);
			const target = modelLooksOpenAIGpt(ctx)
				? `current model (${ctx.model?.provider}/${ctx.model?.id})`
				: "future OpenAI GPT requests";
			ctx.ui.notify(
				`${fastMode ? "Fast on" : "Fast off"}: service_tier=${tier}, displayed price x${fastMode ? FAST_COST_MULTIPLIER : 1} for ${target}.`,
				"info",
			);
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		setFastMode(ctx, restoreFastMode(ctx), false);
	});

	pi.on("session_tree", async (_event, ctx) => {
		setFastMode(ctx, restoreFastMode(ctx), false);
	});

	pi.on("model_select", async (_event, ctx) => {
		updateStatus(ctx, fastMode);
	});

	pi.on("before_provider_request", (event, ctx) => {
		if (!modelLooksOpenAIGpt(ctx)) return undefined;
		if (!isRecord(event.payload)) return undefined;

		return {
			...event.payload,
			service_tier: desiredServiceTier(fastMode),
		};
	});

	pi.on("message_end", (event, ctx) => {
		if (event.message.role !== "assistant") return undefined;

		const adjustedMessage = applyFastModePricing(event.message, ctx, fastMode);
		if (!adjustedMessage) return undefined;

		return { message: adjustedMessage };
	});
}
