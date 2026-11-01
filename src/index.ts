import type { ExtensionAPI, Theme } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getAgentDir } from "@earendil-works/pi-coding-agent";
import { Container, fuzzyMatch, getKeybindings, Input, Key, matchesKey, type Component, Text, truncateToWidth } from "@earendil-works/pi-tui";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

interface OpenRouterRouting {
    allow_fallbacks?: boolean;
    require_parameters?: boolean;
    data_collection?: "deny" | "allow";
    zdr?: boolean;
    enforce_distillable_text?: boolean;
    order?: string[];
    only?: string[];
    ignore?: string[];
    quantizations?: string[];
    sort?: string | { by?: string; partition?: string | null };
    max_price?: Record<string, number | string>;
}

interface ModelsJson {
    providers?: Record<string, { modelOverrides?: Record<string, { compat?: { openRouterRouting?: OpenRouterRouting } }> }>;
}

function modelsJsonPath(): string {
    return join(getAgentDir(), "models.json");
}

async function readModelsJson(): Promise<ModelsJson> {
    try {
        return JSON.parse(await readFile(modelsJsonPath(), "utf8")) as ModelsJson;
    } catch {
        return {};
    }
}

export function getRouting(config: ModelsJson, modelId: string): OpenRouterRouting | undefined {
    return config.providers?.["openrouter"]?.modelOverrides?.[modelId]?.compat?.openRouterRouting;
}

export async function writeRouting(modelId: string, routing: OpenRouterRouting | null): Promise<void> {
    const config = await readModelsJson();
    const provider = (config.providers ??= {});
    const openrouter = (provider["openrouter"] ??= {});
    const overrides = (openrouter.modelOverrides ??= {});
    const override = (overrides[modelId] ??= {});

    if (routing && Object.keys(routing).length > 0) {
        override.compat = { ...override.compat, openRouterRouting: routing };
    } else {
        delete override.compat?.openRouterRouting;
        if (override.compat && Object.keys(override.compat).length === 0) delete override.compat;
        if (Object.keys(override).length === 0) delete overrides[modelId];
    }

    await mkdir(dirname(modelsJsonPath()), { recursive: true });
    await writeFile(modelsJsonPath(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export interface ProviderInfo {
    inputPrice?: number;
    outputPrice?: number;
    cacheReadPrice?: number;
    quantizations: string[];
    uptime1d?: number;
    latencyP50?: number;
    throughputP50?: number;
}

interface PageStats {
    latencyP50?: number;
    throughputP50?: number;
}

function parsePrice(value: string | number | undefined): number | undefined {
    if (value == null) return undefined;
    const parsed = typeof value === "number" ? value : Number.parseFloat(value);
    return Number.isFinite(parsed) ? parsed : undefined;
}

function formatUsdPerMillion(rate: number): string {
    const perMillion = rate * 1_000_000;
    if (perMillion >= 100) return perMillion.toFixed(0);
    if (perMillion >= 10) return perMillion.toFixed(1);
    return perMillion.toFixed(2);
}

function parsePageStats(html: string): Record<string, PageStats> {
    const slugs: { index: number; slug: string }[] = [];
    const slugRe = /\\"provider_slug\\":\\"([^"\\]+)\\"/g;
    let match: RegExpExecArray | null;
    while ((match = slugRe.exec(html)) !== null) slugs.push({ index: match.index, slug: match[1]! });

    const stats: Record<string, PageStats> = {};
    const statsRe = /\\"stats\\":\{[^{}]*\\"p50_latency\\":([\d.]+)[^{}]*\\"p50_throughput\\":([\d.]+)[^{}]*}/g;
    while ((match = statsRe.exec(html)) !== null) {
        const latency = Number.parseFloat(match[1]!);
        const throughput = Number.parseFloat(match[2]!);
        let owner: { slug: string } | undefined;
        for (let i = slugs.length - 1; i >= 0; i--) {
            if (slugs[i]!.index < match.index) {
                owner = slugs[i]!;
                break;
            }
        }
        if (!owner) continue;
        const meta = (stats[owner.slug] ??= {});
        if (meta.latencyP50 == null && Number.isFinite(latency)) meta.latencyP50 = latency;
        if (meta.throughputP50 == null && Number.isFinite(throughput)) meta.throughputP50 = throughput;
    }
    return stats;
}

async function fetchPageStats(modelId: string): Promise<Record<string, PageStats>> {
    try {
        const response = await fetch(`https://openrouter.ai/${modelId}`, {
            signal: AbortSignal.timeout(5_000),
            headers: { Accept: "text/html" },
        });
        if (!response.ok) return {};
        return parsePageStats(await response.text());
    } catch {
        return {};
    }
}

export async function fetchProviders(modelId: string): Promise<{ slugs: string[]; info: Record<string, ProviderInfo> } | undefined> {
    try {
        const [response, pageStats] = await Promise.all([
            fetch(`https://openrouter.ai/api/v1/models/${modelId}/endpoints`, {
                signal: AbortSignal.timeout(10_000),
                headers: { Accept: "application/json" },
            }),
            fetchPageStats(modelId),
        ]);
        if (!response.ok) return undefined;
        const payload = (await response.json()) as {
            data?: {
                endpoints?: Array<{
                    provider_name?: string;
                    tag?: string;
                    pricing?: { prompt?: string | number; completion?: string | number; input_cache_read?: string | number };
                    quantization?: string;
                    uptime_last_1d?: number | null;
                }>;
            };
        };

        const info: Record<string, ProviderInfo> = {};
        for (const endpoint of payload.data?.endpoints ?? []) {
            const slug = endpoint.tag ?? endpoint.provider_name?.toLowerCase();
            if (!slug) continue;
            const meta = (info[slug] ??= { quantizations: [] });

            const inputPrice = parsePrice(endpoint.pricing?.prompt);
            const outputPrice = parsePrice(endpoint.pricing?.completion);
            const cacheReadPrice = parsePrice(endpoint.pricing?.input_cache_read);
            if (inputPrice != null) meta.inputPrice = meta.inputPrice == null ? inputPrice : Math.min(meta.inputPrice, inputPrice);
            if (outputPrice != null) meta.outputPrice = meta.outputPrice == null ? outputPrice : Math.min(meta.outputPrice, outputPrice);
            if (cacheReadPrice != null) meta.cacheReadPrice = meta.cacheReadPrice == null ? cacheReadPrice : Math.min(meta.cacheReadPrice, cacheReadPrice);

            if (endpoint.quantization && endpoint.quantization !== "unknown" && !meta.quantizations.includes(endpoint.quantization)) {
                meta.quantizations.push(endpoint.quantization);
            }

            if (endpoint.uptime_last_1d != null) {
                meta.uptime1d = meta.uptime1d == null ? endpoint.uptime_last_1d : Math.min(meta.uptime1d, endpoint.uptime_last_1d);
            }
        }
        for (const [slug, stats] of Object.entries(pageStats)) {
            const meta = info[slug];
            if (!meta) continue;
            meta.latencyP50 ??= stats.latencyP50;
            meta.throughputP50 ??= stats.throughputP50;
        }
        for (const meta of Object.values(info)) meta.quantizations.sort();

        return { slugs: Object.keys(info).sort(), info };
    } catch {
        return undefined;
    }
}

const FOOTER_HINT = "↑↓ navigate • enter toggle • alt+↑↓ reorder • ctrl+a all • ctrl+x none • ctrl+f fallbacks • ctrl+s save • esc close";

class ProviderRoutingList implements Component {
    private readonly allSlugs: string[];
    private enabledIds: string[];
    private filteredIds: string[];
    private cursor = 0;
    private readonly searchInput = new Input();
    private readonly labelWidth: number;
    private allowFallbacks: boolean;
    private baseline: string;
    private pendingSave: string | null = null;
    private readonly maxVisible: number;
    private readonly footer: Text;

    onSave?: (enabled: string[], allowFallbacks: boolean) => void;
    onCancel?: () => void;

    constructor(
        private readonly theme: Theme,
        slugs: string[],
        enabled: string[],
        allowFallbacks: boolean,
        private readonly info: Record<string, ProviderInfo>,
    ) {
        this.allSlugs = slugs;
        this.enabledIds = enabled.filter((slug) => slugs.includes(slug));
        this.labelWidth = Math.max(...slugs.map((slug) => slug.length), 0);
        this.allowFallbacks = allowFallbacks;
        this.filteredIds = slugs;
        this.maxVisible = Math.min(slugs.length, 15);
        this.footer = new Text("", 0, 0);
        this.baseline = this.state;
        this.refresh();
    }

    private get state(): string {
        return JSON.stringify([this.enabledIds, this.allowFallbacks]);
    }

    private get dirty(): boolean {
        return this.state !== this.baseline;
    }

    getSearchInput(): Input {
        return this.searchInput;
    }

    getFooter(): Text {
        return this.footer;
    }

    private sortedIds(): string[] {
        const disabled = this.allSlugs
            .filter((slug) => !this.enabledIds.includes(slug))
            .sort((a, b) => a.localeCompare(b));
        return [...this.enabledIds, ...disabled];
    }

    private metaText(slug: string): string {
        const meta = this.info[slug];
        if (!meta) return "";
        const parts: string[] = [];
        if (meta.inputPrice != null || meta.outputPrice != null) {
            const input = meta.inputPrice != null ? formatUsdPerMillion(meta.inputPrice) : "?";
            const output = meta.outputPrice != null ? formatUsdPerMillion(meta.outputPrice) : "?";
            parts.push(`$${input}/$${output}/1M`);
        }
        if (meta.cacheReadPrice != null) parts.push(`$${formatUsdPerMillion(meta.cacheReadPrice)} cache/1M`);
        const quants = meta.quantizations.filter((quant) => !slug.includes(quant));
        if (quants.length > 0) parts.push(quants.join(","));
        if (meta.uptime1d != null) parts.push(`${meta.uptime1d.toFixed(0)}%`);
        if (meta.latencyP50 != null) parts.push(`${Math.round(meta.latencyP50)}ms`);
        if (meta.throughputP50 != null) parts.push(`${Math.round(meta.throughputP50)} tok/s`);
        return parts.length > 0 ? this.theme.fg("dim", `  ${parts.join(" · ")}`) : "";
    }

    render(width: number): string[] {
        const lines: string[] = [];
        const start = Math.max(0, Math.min(this.cursor - Math.floor(this.maxVisible / 2), this.filteredIds.length - this.maxVisible));
        const visible = this.filteredIds.slice(Math.max(0, start), Math.max(0, start) + this.maxVisible);

        for (const slug of visible) {
            const rank = this.enabledIds.indexOf(slug);
            const isSelected = slug === this.filteredIds[this.cursor];

            const prefix = isSelected ? this.theme.fg("accent", "❯ ") : "  ";
            const marker = rank >= 0 ? this.theme.fg("accent", "[x]") : this.theme.fg("dim", "[ ]");
            const label = slug.padEnd(this.labelWidth);
            const slugText = rank >= 0 ? label : this.theme.fg("dim", label);
            lines.push(truncateToWidth(`${prefix}${marker} ${slugText}${this.metaText(slug)}`, width, "…"));
        }
        if (this.filteredIds.length > this.maxVisible) {
            lines.push(this.theme.fg("dim", `  (${this.cursor + 1}/${this.filteredIds.length})`));
        }
        return lines;
    }

    invalidate(): void {}

    private refresh(): void {
        const query = this.searchInput.getValue();
        const sorted = this.sortedIds();
        this.filteredIds = query ? sorted.filter((slug) => fuzzyMatch(query, slug).matches) : sorted;
        this.cursor = Math.min(this.cursor, Math.max(0, this.filteredIds.length - 1));
        const base = `  ${this.enabledIds.length}/${this.allSlugs.length} enabled · fallbacks ${this.allowFallbacks ? "on" : "off"} · ${FOOTER_HINT}`;
        this.footer.setText(
            this.dirty
                ? this.theme.fg("dim", `${base} `) + this.theme.fg("warning", "(unsaved)")
                : this.theme.fg("dim", base),
        );
    }

    private moveCursor(delta: 1 | -1): void {
        if (this.filteredIds.length === 0) return;
        this.cursor = (this.cursor + delta + this.filteredIds.length) % this.filteredIds.length;
    }

    handleInput(data: string): void {
        const kb = getKeybindings();

        if (matchesKey(data, "up")) {
            this.moveCursor(-1);
            return;
        }
        if (matchesKey(data, "down")) {
            this.moveCursor(1);
            return;
        }

        const reorderUp = kb.matches(data, "app.models.reorderUp");
        const reorderDown = kb.matches(data, "app.models.reorderDown");
        if (reorderUp || reorderDown) {
            this.reorder(reorderUp ? -1 : 1);
            return;
        }

        if (matchesKey(data, "return")) {
            const slug = this.filteredIds[this.cursor];
            if (slug) {
                const index = this.enabledIds.indexOf(slug);
                if (index >= 0) this.enabledIds.splice(index, 1);
                else this.enabledIds.push(slug);
                this.refresh();
            }
            return;
        }

        if (matchesKey(data, Key.ctrl("f"))) {
            this.allowFallbacks = !this.allowFallbacks;
            this.refresh();
            return;
        }

        if (matchesKey(data, Key.ctrl("s"))) {
            this.pendingSave = this.state;
            this.onSave?.([...this.enabledIds], this.allowFallbacks);
            return;
        }

        if (matchesKey(data, Key.ctrl("a"))) {
            this.enabledIds = [...this.allSlugs];
            this.refresh();
            return;
        }

        if (matchesKey(data, Key.ctrl("x"))) {
            this.enabledIds = [];
            this.refresh();
            return;
        }

        if (matchesKey(data, "escape")) {
            this.onCancel?.();
            return;
        }

        this.searchInput.handleInput(data);
        this.refresh();
    }

    markSaved(): void {
        if (this.pendingSave !== null && this.state === this.pendingSave) {
            this.baseline = this.pendingSave;
            this.pendingSave = null;
            this.refresh();
        }
    }

    private reorder(delta: -1 | 1): void {
        const slug = this.filteredIds[this.cursor];
        const index = this.enabledIds.indexOf(slug);
        const target = index + delta;
        if (index < 0 || target < 0 || target >= this.enabledIds.length) return;
        [this.enabledIds[index], this.enabledIds[target]] = [this.enabledIds[target]!, this.enabledIds[index]!];
        this.cursor += delta;
        this.refresh();
    }
}

export default function (pi: ExtensionAPI) {
    pi.registerCommand("routing", {
        description: "Configure OpenRouter provider routing for the current model (persisted to models.json)",
        handler: async (_args, ctx) => {
            if (ctx.mode !== "tui") {
                ctx.ui.notify("/routing requires interactive mode", "warning");
                return;
            }

            if (ctx.model?.provider !== "openrouter") {
                ctx.ui.notify("Switch to an OpenRouter model first", "warning");
                return;
            }
            const modelId = ctx.model.id.replace(/^openrouter\//, "");
            const theme = ctx.ui.theme;

            const fetched = await fetchProviders(modelId);
            const routing = getRouting(await readModelsJson(), modelId);
            const configured = routing?.order ?? routing?.only;

            const slugs = new Set<string>([...(routing?.only ?? []), ...configured ?? [], ...(fetched?.slugs ?? [])]);

            if (slugs.size === 0) {
                ctx.ui.notify(`No providers found for ${modelId}`, "warning");
                return;
            }

            const allSlugs = [...slugs].sort();
            const enabled = configured ? configured.filter((slug) => slugs.has(slug)) : allSlugs;

            async function saveRouting(enabledIds: string[], allowFallbacks: boolean): Promise<void> {
                const { allow_fallbacks: _a, only: _o, order: _r, ...preserved } = getRouting(await readModelsJson(), modelId) ?? {};
                const next = preserved as OpenRouterRouting;

                const sorted = [...enabledIds].sort();
                const allEnabled = enabledIds.length === allSlugs.length;
                const isDefaultOrder = !enabledIds.some((slug, i) => slug !== sorted[i]);

                if (enabledIds.length > 0 && !allEnabled) {
                    next.only = sorted;
                    next.allow_fallbacks = allowFallbacks;
                }
                if (!isDefaultOrder) next.order = enabledIds;

                const detail = next.only
                    ? `${enabledIds.length}/${allSlugs.length} providers${allowFallbacks ? ", fallbacks allowed" : ""}`
                    : next.order
                        ? `${enabledIds.length}/${allSlugs.length} providers, priority set`
                        : "default";

                try {
                    await writeRouting(modelId, Object.keys(next).length > 0 ? next : null);
                    await ctx.modelRegistry.refresh();
                    let rebound = false;
                    if (ctx.model?.provider === "openrouter" && ctx.model.id === modelId) {
                        const fresh = ctx.modelRegistry.find("openrouter", modelId);
                        if (fresh) {
                            rebound = await pi.setModel(fresh);
                        }
                    }
                    ctx.ui.notify(`Routing saved (${detail})`, "info");
                } catch (error) {
                    ctx.ui.notify(`Failed to save: ${error instanceof Error ? error.message : String(error)}`, "error");
                }
            }

            await ctx.ui.custom<null>((tui, _theme, _kb, done) => {
                const container = new Container();
                container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
                container.addChild(new Text(theme.fg("accent", theme.bold(`Provider routing — ${modelId}`)), 1, 0));

                const list = new ProviderRoutingList(theme, allSlugs, enabled, routing?.allow_fallbacks ?? false, fetched?.info ?? {});
                list.onSave = (enabledIds, allowFallbacks) => {
                    void saveRouting(enabledIds, allowFallbacks).then(() => list.markSaved());
                };
                list.onCancel = () => done(null);
                container.addChild(list.getSearchInput());
                container.addChild(list);
                container.addChild(list.getFooter());

                return {
                    render: (width: number) => container.render(width),
                    invalidate: () => container.invalidate(),
                    handleInput: (data: string) => {
                        list.handleInput(data);
                        tui.requestRender();
                    },
                };
            });
        },
    });
}
