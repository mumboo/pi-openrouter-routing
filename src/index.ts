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

export async function fetchEndpoints(modelId: string): Promise<string[] | undefined> {
    try {
        const response = await fetch(`https://openrouter.ai/api/v1/models/${modelId}/endpoints`, {
            signal: AbortSignal.timeout(10_000),
            headers: { Accept: "application/json" },
        });
        if (!response.ok) return undefined;
        const payload = (await response.json()) as {
            data?: {
                endpoints?: Array<{ provider_name?: string; tag?: string }>;
            };
        };

        const slugs = (payload.data?.endpoints ?? [])
            .map((endpoint) => endpoint.tag?.split("/")[0] ?? endpoint.provider_name?.toLowerCase())
            .filter((slug): slug is string => Boolean(slug));
        return [...new Set(slugs)].sort();
    } catch {
        return undefined;
    }
}

const FOOTER_HINT = "↑↓ navigate • enter toggle • alt+↑↓ reorder • ctrl+a all • ctrl+x none • ctrl+r reset • ctrl+s save • esc close";

class ProviderRoutingList implements Component {
    private readonly allSlugs: string[];
    private enabledIds: string[];
    private filteredIds: string[];
    private cursor = 0;
    private readonly searchInput = new Input();
    private baseline: string;
    private pendingSave: string | null = null;
    private readonly maxVisible: number;
    private readonly footer: Text;

    onSave?: (enabled: string[]) => void;
    onCancel?: () => void;

    constructor(
        private readonly theme: Theme,
        slugs: string[],
        enabled: string[],
    ) {
        this.allSlugs = slugs;
        this.enabledIds = enabled.filter((slug) => slugs.includes(slug));
        this.filteredIds = slugs;
        this.maxVisible = Math.min(slugs.length, 15);
        this.footer = new Text("", 0, 0);
        this.baseline = JSON.stringify(this.enabledIds);
        this.refresh();
    }

    private get dirty(): boolean {
        return JSON.stringify(this.enabledIds) !== this.baseline;
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

    render(width: number): string[] {
        const lines: string[] = [];
        const start = Math.max(0, Math.min(this.cursor - Math.floor(this.maxVisible / 2), this.filteredIds.length - this.maxVisible));
        const visible = this.filteredIds.slice(Math.max(0, start), Math.max(0, start) + this.maxVisible);

        for (const slug of visible) {
            const rank = this.enabledIds.indexOf(slug);
            const isSelected = slug === this.filteredIds[this.cursor];

            const prefix = isSelected ? this.theme.fg("accent", "❯ ") : "  ";
            const marker = rank >= 0 ? this.theme.fg("accent", "[x]") : this.theme.fg("dim", "[ ]");
            const slugText = rank >= 0 ? slug : this.theme.fg("dim", slug);
            lines.push(truncateToWidth(`${prefix}${marker} ${slugText}`, width, "…"));
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
        const base = `  ${this.enabledIds.length}/${this.allSlugs.length} enabled · ${FOOTER_HINT}`;
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

        if (matchesKey(data, Key.ctrl("s"))) {
            this.pendingSave = JSON.stringify(this.enabledIds);
            this.onSave?.([...this.enabledIds]);
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

        if (matchesKey(data, Key.ctrl("r"))) {
            this.enabledIds = [...this.allSlugs];
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
        if (this.pendingSave !== null && JSON.stringify(this.enabledIds) === this.pendingSave) {
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

            const endpoints = await fetchEndpoints(modelId);
            const routing = getRouting(await readModelsJson(), modelId);
            const configured = routing?.order ?? routing?.only;

            const slugs = new Set<string>([...(routing?.only ?? []), ...configured ?? []]);
            for (const slug of endpoints ?? []) slugs.add(slug);

            if (slugs.size === 0) {
                ctx.ui.notify(`No providers found for ${modelId}`, "warning");
                return;
            }

            const allSlugs = [...slugs].sort();
            const enabled = configured ? configured.filter((slug) => slugs.has(slug)) : allSlugs;

            async function saveRouting(enabledIds: string[]): Promise<void> {
                const { allow_fallbacks: _a, only: _o, order: _r, ...preserved } = getRouting(await readModelsJson(), modelId) ?? {};
                const next = preserved as OpenRouterRouting;

                const sorted = [...enabledIds].sort();
                const allEnabled = enabledIds.length === allSlugs.length;
                const isDefaultOrder = !enabledIds.some((slug, i) => slug !== sorted[i]);

                if (enabledIds.length > 0 && !allEnabled) {
                    next.only = sorted;
                    next.allow_fallbacks = false;
                }
                if (!isDefaultOrder) next.order = enabledIds;

                const detail = next.only
                    ? `${enabledIds.length}/${allSlugs.length} providers`
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

                const list = new ProviderRoutingList(theme, allSlugs, enabled);
                list.onSave = (enabledIds) => {
                    void saveRouting(enabledIds).then(() => list.markSaved());
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
