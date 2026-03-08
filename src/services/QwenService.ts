import { requestUrl, Notice } from 'obsidian';
import { SHADOW_PROMPTS } from './prompts';

export interface ShadowSettings {
    apiUrl: string;
    apiKey: string;
    vaultStructure: {
        inbox: string;
        reflections: string;
        profiles: string;
        archive: string;
    };
    validateLinksOnOperation: boolean;
    useLocalEmbeddings: boolean;
}

export interface ProfileSuggestion {
    category: 'EmotionalPatterns' | 'BehavioralPatterns' | 'EnergyCycles';
    filename: string;
    contentTemplate: string;
}

export interface AnalysisResult {
    thought: string;
    suggestedTitle: string;
    insights: string[];
    profiles: ProfileSuggestion[];
}

export interface LinkSuggestion {
    link: string;
    reason: string;
}

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export class QwenService {
    private lastRequestTime: number = 0;

    // Контекст v2 — только для чата, агентские задачи одноразовые
    private chatContextId?: string;
    private chatParentId?: string;

    constructor(private settings: ShadowSettings) { }

    /**
     * Задержка 1с между запросами (rate-limit прокси)
     */
    private async waitLimit() {
        const now = Date.now();
        const timeSinceLast = now - this.lastRequestTime;
        if (timeSinceLast < 1000) {
            await new Promise(resolve => setTimeout(resolve, 1000 - timeSinceLast));
        }
        this.lastRequestTime = Date.now();
    }

    /**
     * Формирует URL для API-запроса.
     * apiUrl может быть:
     *   - базовый: `http://localhost:3264/api`
     *   - полный:  `http://localhost:3264/api/chat/completions`
     * Если apiUrl уже заканчивается на /chat/completions — используем как есть.
     */
    private buildUrl(): string {
        const base = this.settings.apiUrl.replace(/\/+$/, ''); // убираем trailing slash
        if (base.endsWith('/chat/completions')) {
            return base;
        }
        return `${base}/chat/completions`;
    }

    /**
     * Единый метод запроса к API.
     * @param messages — массив сообщений OpenAI-формата
     * @param model — имя модели
     * @param chatContext — передавать/сохранять chatId+parentId (только для чата)
     */
    private async callApi(
        messages: ChatMessage[],
        model: string = 'qwen-plus',
        chatContext: boolean = false
    ): Promise<any> {
        await this.waitLimit();

        if (!this.settings.apiKey) {
            throw new Error('API ключ не задан. Проверьте настройки плагина.');
        }

        const body: any = {
            model,
            messages
        };

        // Передаём контекст v2 ТОЛЬКО для чата
        if (chatContext) {
            if (this.chatContextId) body.chatId = this.chatContextId;
            if (this.chatParentId) body.parentId = this.chatParentId;
        }

        try {
            const response = await requestUrl({
                url: this.buildUrl(),
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${this.settings.apiKey}`
                },
                body: JSON.stringify(body)
            });

            if (response.status !== 200) {
                throw new Error(`API ошибка (${response.status}): ${response.text}`);
            }

            const data = response.json;

            // Сохраняем контекст v2 ТОЛЬКО для чата
            if (chatContext) {
                if (data.chatId) this.chatContextId = data.chatId;
                if (data.parentId) this.chatParentId = data.parentId;
            }

            return data;
        } catch (error: unknown) {
            console.error('Shadow QwenService Error:', error);
            throw error;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Агентские методы (one-shot, без контекста)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Глубокий анализ заметки → AnalysisResult
     */
    async analyzeNote(content: string): Promise<AnalysisResult> {
        const messages: ChatMessage[] = [
            { role: 'system', content: SHADOW_PROMPTS.ANALYSIS },
            { role: 'user', content: content }
        ];

        const data = await this.callApi(messages, 'qwen-plus', false);
        const reply = data.choices?.[0]?.message?.content;

        return this.parseJsonResponse<AnalysisResult>(reply);
    }

    /**
     * Поиск ассоциативных связей → LinkSuggestion[]
     */
    async findLinks(content: string, existingNotes: string[]): Promise<LinkSuggestion[]> {
        const contextPrompt = `Список существующих заметок:\n${existingNotes.join('\n')}\n\nТекущая заметка:\n${content}`;
        const messages: ChatMessage[] = [
            { role: 'system', content: SHADOW_PROMPTS.LINKING },
            { role: 'user', content: contextPrompt }
        ];

        const data = await this.callApi(messages, 'qwen-plus', false);
        const reply = data.choices?.[0]?.message?.content;

        return this.parseJsonResponse<LinkSuggestion[]>(reply);
    }

    /**
     * Разбор на психологические профили → ProfileSuggestion[]
     */
    async decomposeToProfiles(content: string): Promise<ProfileSuggestion[]> {
        const messages: ChatMessage[] = [
            { role: 'system', content: SHADOW_PROMPTS.PROFILING },
            { role: 'user', content: content }
        ];

        const data = await this.callApi(messages, 'qwen-plus', false);
        const reply = data.choices?.[0]?.message?.content;

        return this.parseJsonResponse<ProfileSuggestion[]>(reply);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Чат (с контекстом v2)
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Диалог с Тенью — использует chatId/parentId для цепочки сообщений
     */
    async chat(query: string, context: string, history: ChatMessage[]): Promise<string> {
        const messages: ChatMessage[] = [
            { role: 'system', content: `${SHADOW_PROMPTS.CHAT}\n\nКОНТЕКСТ ЗАМЕТКИ:\n${context}` },
            ...history,
            { role: 'user', content: query }
        ];

        // chatContext: true — сохраняем и передаём chatId/parentId
        const data = await this.callApi(messages, 'qwen-max', true);
        return data.choices?.[0]?.message?.content || 'Тень молчит...';
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Утилиты
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Валидация JSON ответа от LLM
     */
    private parseJsonResponse<T>(content: string): T {
        try {
            // Очистка от markdown блоков
            const jsonStr = content.replace(/```json/g, '').replace(/```/g, '').trim();
            return JSON.parse(jsonStr) as T;
        } catch (e: unknown) {
            console.error('JSON Parsing Error. Raw content:', content);
            const msg = e instanceof Error ? e.message : String(e);
            throw new Error(`Ошибка парсинга ответа от ИИ: ${msg}. Проверьте консоль.`);
        }
    }

    updateSettings(settings: ShadowSettings) {
        this.settings = settings;
    }

    updateApiKey(key: string) {
        this.settings.apiKey = key;
    }

    /** Сброс контекста чата (новый диалог) */
    resetContext() {
        this.chatContextId = undefined;
        this.chatParentId = undefined;
    }
}
