import { Notice } from 'obsidian';
import { LLMProvider, ChatMessage, LLMResponse, LLMProviderConfig } from './LLMProvider';
import { FreeQwenProvider } from './providers/FreeQwenProvider';
import { OpenAIProvider } from './providers/OpenAIProvider';
import { LocalProvider } from './providers/LocalProvider';
import { SHADOW_PROMPTS } from './prompts';

// ─────────────────────────────────────────────────────────────────────
//  Настройки плагина
// ─────────────────────────────────────────────────────────────────────

export type LLMProviderType = 'freeqwen' | 'openai' | 'local';
export type EmbeddingMode = 'builtin' | 'endpoint';

export interface ShadowSettings {
    // LLM
    llmProvider: LLMProviderType;
    llmApiUrl: string;
    llmApiKey: string;
    llmModel: string;
    // Embeddings
    embeddingMode: EmbeddingMode;
    embeddingModel: string;
    embeddingEndpointUrl: string;
    embeddingEndpointKey: string;
    // Vault
    vaultStructure: {
        inbox: string;
        reflections: string;
        profiles: string;
        archive: string;
    };
    validateLinksOnOperation: boolean;
}

// ─────────────────────────────────────────────────────────────────────
//  Типы ответов ИИ
// ─────────────────────────────────────────────────────────────────────

export interface ProfileSuggestion {
    category: 'EmotionalPatterns' | 'BehavioralPatterns' | 'EnergyCycles' | 'CognitiveDistortions';
    filename: string;
    contentTemplate: string;
}

export interface AnalysisResult {
    thought: string;
    suggestedTitle: string;
    insights: string[];
    profiles: ProfileSuggestion[];
    mood_score: number;
    core_emotions: string[];
}

export interface LinkSuggestion {
    link: string;
    reason: string;
}

// Re-export для обратной совместимости
export type { ChatMessage } from './LLMProvider';

// ─────────────────────────────────────────────────────────────────────
//  ShadowAI — оркестратор, использует LLMProvider
// ─────────────────────────────────────────────────────────────────────

export class ShadowAI {
    private provider: LLMProvider;
    private settings: ShadowSettings;

    // Контекст чата (только для FreeQwen)
    private chatContextId?: string;
    private chatParentId?: string;

    // Описание структуры хранилища (заполняется из VaultService)
    private vaultDescription: string = '';

    constructor(settings: ShadowSettings) {
        this.settings = settings;
        this.provider = this.createProvider(settings);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Управление провайдером
    // ═══════════════════════════════════════════════════════════════════

    private createProvider(settings: ShadowSettings): LLMProvider {
        const config: LLMProviderConfig = {
            apiUrl: settings.llmApiUrl,
            apiKey: settings.llmApiKey,
            model: settings.llmModel
        };

        switch (settings.llmProvider) {
            case 'freeqwen':
                return new FreeQwenProvider(config);
            case 'openai':
                return new OpenAIProvider(config);
            case 'local':
                return new LocalProvider(config);
            default:
                return new OpenAIProvider(config);
        }
    }

    /** Пересоздать провайдера при смене настроек */
    updateSettings(settings: ShadowSettings): void {
        this.settings = settings;
        this.provider = this.createProvider(settings);
    }

    /** Обновить только API-ключ */
    updateApiKey(key: string): void {
        this.settings.llmApiKey = key;
        this.provider.updateConfig({
            apiUrl: this.settings.llmApiUrl,
            apiKey: key,
            model: this.settings.llmModel
        });
    }

    /** Задать описание структуры хранилища для промптов */
    setVaultDescription(desc: string): void {
        this.vaultDescription = desc;
    }

    /** Проверить подключение */
    async testConnection(): Promise<boolean> {
        return this.provider.testConnection();
    }

    /** Имя текущего провайдера */
    get providerName(): string {
        return this.provider.name;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Агентские методы (one-shot, без контекста)
    // ═══════════════════════════════════════════════════════════════════

    /** Полный анализ заметки */
    async analyzeNote(content: string): Promise<AnalysisResult> {
        const systemPrompt = this.withVaultContext(SHADOW_PROMPTS.ANALYSIS);
        const messages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: content }
        ];

        const response = await this.provider.complete(messages);
        return this.parseJsonResponse<AnalysisResult>(response.content);
    }

    /** Поиск связей между заметками */
    async findLinks(content: string, existingNotes: string[]): Promise<LinkSuggestion[]> {
        const systemPrompt = this.withVaultContext(SHADOW_PROMPTS.LINKING);
        const userContent = `Список существующих заметок:\n${existingNotes.join('\n')}\n\nТекущая заметка:\n${content}`;

        const messages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userContent }
        ];

        const response = await this.provider.complete(messages);
        return this.parseJsonResponse<LinkSuggestion[]>(response.content);
    }

    /** Разбор на психологические профили */
    async decomposeToProfiles(content: string): Promise<ProfileSuggestion[]> {
        const systemPrompt = this.withVaultContext(SHADOW_PROMPTS.PROFILING);
        const messages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: content }
        ];

        const response = await this.provider.complete(messages);
        return this.parseJsonResponse<ProfileSuggestion[]>(response.content);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Чат (с контекстом)
    // ═══════════════════════════════════════════════════════════════════

    /** Диалог с Тенью */
    async chat(query: string, context: string, history: ChatMessage[]): Promise<string> {
        const systemPrompt = this.withVaultContext(
            `${SHADOW_PROMPTS.CHAT}\n\nКОНТЕКСТ ЗАМЕТКИ:\n${context}`
        );

        const messages: ChatMessage[] = [
            { role: 'system', content: systemPrompt },
            ...history,
            { role: 'user', content: query }
        ];

        // Передаём chatContext только для FreeQwen
        const chatCtx = this.settings.llmProvider === 'freeqwen'
            ? { chatId: this.chatContextId, parentId: this.chatParentId }
            : undefined;

        const response = await this.provider.complete(messages, undefined, chatCtx);

        // Сохраняем контекст для FreeQwen
        if (response.chatId) this.chatContextId = response.chatId;
        if (response.parentId) this.chatParentId = response.parentId;

        return response.content || 'Тень молчит...';
    }

    /** Сброс контекста чата */
    resetContext(): void {
        this.chatContextId = undefined;
        this.chatParentId = undefined;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Утилиты
    // ═══════════════════════════════════════════════════════════════════

    private withVaultContext(prompt: string): string {
        if (!this.vaultDescription) return prompt;
        return `СТРУКТУРА ХРАНИЛИЩА:\n${this.vaultDescription}\n\n${prompt}`;
    }

    private parseJsonResponse<T>(content: string): T {
        try {
            const jsonStr = content.replace(/```json/g, '').replace(/```/g, '').trim();
            return JSON.parse(jsonStr) as T;
        } catch (e: unknown) {
            console.error('JSON Parsing Error. Raw content:', content);
            const msg = e instanceof Error ? e.message : String(e);
            throw new Error(`Ошибка парсинга ответа от ИИ: ${msg}. Проверьте консоль.`);
        }
    }
}
