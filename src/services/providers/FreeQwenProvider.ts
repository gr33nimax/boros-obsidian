import { BaseLLMProvider, ChatMessage, LLMProviderConfig, LLMResponse } from '../LLMProvider';
import { requestUrl } from 'obsidian';

/**
 * FreeQwenAPI — прокси-провайдер.
 * Особенности:
 * - chatId/parentId для цепочки контекста
 * - Rate-limit 1 запрос/сек
 * - Поддерживает два формата: /api/chat (нативный) и /api/chat/completions (OpenAI)
 * - API-ключ опционален (локальный прокси не требует)
 */
export class FreeQwenProvider extends BaseLLMProvider {
    readonly name = 'FreeQwenAPI';

    constructor(config: LLMProviderConfig) {
        super(config);
        this.minInterval = 1000; // 1 запрос в секунду — ограничение прокси
    }

    async complete(
        messages: ChatMessage[],
        model?: string,
        chatContext?: { chatId?: string; parentId?: string }
    ): Promise<LLMResponse> {
        await this.waitLimit();

        const url = this.buildUrl();
        const isOpenAI = url.endsWith('/completions');
        
        const body: any = {
            model: model || this.config.model || 'qwen-plus',
        };

        if (isOpenAI) {
            body.messages = messages;
        } else {
            // Собираем текст последнего user-сообщения для нативного формата
            const lastUserMsg = [...messages].reverse().find(m => m.role === 'user');
            body.message = lastUserMsg?.content || '';
        }

        // Передаём контекст v2 если есть
        if (chatContext?.chatId) body.chatId = chatContext.chatId;
        if (chatContext?.parentId) body.parentId = chatContext.parentId;

        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (this.config.apiKey) {
            headers['Authorization'] = `Bearer ${this.config.apiKey}`;
        }

        const data = await this.httpPost(url, headers, body);

        // Ответ может прийти в разных форматах
        const content = data?.response
            || data?.choices?.[0]?.message?.content
            || data?.content
            || '';

        return {
            content,
            chatId: data.chatId,
            parentId: data.parentId
        };
    }

    /**
     * Проверка подключения — GET /api/status
     */
    async testConnection(): Promise<boolean> {
        if (!this.config.apiUrl) throw new Error('API URL не задан');
        try {
            const base = this.config.apiUrl.replace(/\/+$/, '');
            const statusUrl = base.endsWith('/api') ? `${base}/status` : `${base}/api/status`;
            const response = await requestUrl({ url: statusUrl, method: 'GET' });
            if (response.status === 200) return true;
        } catch {
            // Игнорируем и идем в фолбэк
        }
        
        // Фолбэк: пробуем отправить тестовое сообщение
        return super.testConnection();
    }

    /**
     * apiUrl может быть:
     *   - базовый: `http://localhost:3264/api`
     *   - полный:  `http://localhost:3264/api/chat`
     */
    private buildUrl(): string {
        if (!this.config.apiUrl) throw new Error('API URL не задан');
        const base = this.config.apiUrl.replace(/\/+$/, '');
        if (base.endsWith('/chat') || base.endsWith('/chat/completions')) return base;
        return `${base}/chat/completions`;
    }
}
