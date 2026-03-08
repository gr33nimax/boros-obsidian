import { requestUrl } from 'obsidian';

// ─────────────────────────────────────────────────────────────────────
//  Типы
// ─────────────────────────────────────────────────────────────────────

export interface ChatMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface LLMResponse {
    content: string;
    chatId?: string;
    parentId?: string;
}

export interface LLMProviderConfig {
    apiUrl: string;
    apiKey: string;
    model: string;
}

// ─────────────────────────────────────────────────────────────────────
//  Интерфейс провайдера
// ─────────────────────────────────────────────────────────────────────

export interface LLMProvider {
    /** Имя провайдера для UI */
    readonly name: string;

    /**
     * Отправить запрос к LLM.
     * @param messages — массив сообщений
     * @param model — имя модели (переопределяет default)
     * @param chatContext — контекст чата (chatId/parentId для FreeQwen)
     */
    complete(
        messages: ChatMessage[],
        model?: string,
        chatContext?: { chatId?: string; parentId?: string }
    ): Promise<LLMResponse>;

    /** Проверка подключения */
    testConnection(): Promise<boolean>;

    /** Обновить конфигурацию */
    updateConfig(config: LLMProviderConfig): void;
}

// ─────────────────────────────────────────────────────────────────────
//  Базовый класс с общей логикой
// ─────────────────────────────────────────────────────────────────────

export abstract class BaseLLMProvider implements LLMProvider {
    abstract readonly name: string;

    protected config: LLMProviderConfig;
    protected lastRequestTime: number = 0;
    protected minInterval: number = 0; // мс между запросами (0 = без ограничений)

    constructor(config: LLMProviderConfig) {
        this.updateConfig(config);
    }

    updateConfig(config: LLMProviderConfig): void {
        this.config = { ...config };
        if (this.config.apiUrl && !this.config.apiUrl.startsWith('http')) {
            this.config.apiUrl = 'http://' + this.config.apiUrl;
        }
    }

    abstract complete(
        messages: ChatMessage[],
        model?: string,
        chatContext?: { chatId?: string; parentId?: string }
    ): Promise<LLMResponse>;

    async testConnection(): Promise<boolean> {
        try {
            const response = await this.complete(
                [{ role: 'user', content: 'Ответь одним словом: работает.' }],
                undefined,
                undefined
            );
            return !!response.content && response.content.length > 0;
        } catch {
            return false;
        }
    }

    /** Задержка для rate-limiting */
    protected async waitLimit(): Promise<void> {
        if (this.minInterval <= 0) return;
        const now = Date.now();
        const elapsed = now - this.lastRequestTime;
        if (elapsed < this.minInterval) {
            await new Promise(resolve => setTimeout(resolve, this.minInterval - elapsed));
        }
        this.lastRequestTime = Date.now();
    }

    /** Стандартный HTTP-запрос через Obsidian API */
    protected async httpPost(url: string, headers: Record<string, string>, body: any): Promise<any> {
        const response = await requestUrl({
            url,
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...headers },
            body: JSON.stringify(body)
        });

        if (response.status !== 200) {
            throw new Error(`API ошибка (${response.status}): ${response.text}`);
        }

        return response.json;
    }

    /** Извлечь текст ответа из стандартного OpenAI формата */
    protected extractContent(data: any): string {
        return data?.choices?.[0]?.message?.content || '';
    }
}
