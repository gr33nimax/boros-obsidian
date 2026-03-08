import { BaseLLMProvider, ChatMessage, LLMProviderConfig, LLMResponse } from '../LLMProvider';

/**
 * Local провайдер — для Ollama, LM Studio, text-generation-webui.
 * Особенности:
 * - Без авторизации (или опциональный ключ)
 * - URL по умолчанию: http://localhost:11434/v1/chat/completions
 */
export class LocalProvider extends BaseLLMProvider {
    readonly name = 'Local Endpoint';

    async complete(
        messages: ChatMessage[],
        model?: string,
        _chatContext?: { chatId?: string; parentId?: string }
    ): Promise<LLMResponse> {
        await this.waitLimit();

        const url = this.buildUrl();
        const headers: Record<string, string> = {};

        // Опциональная авторизация (некоторые UIs требуют)
        if (this.config.apiKey) {
            headers['Authorization'] = `Bearer ${this.config.apiKey}`;
        }

        const data = await this.httpPost(url, headers, {
            model: model || this.config.model || 'llama3',
            messages
        });

        return { content: this.extractContent(data) };
    }

    private buildUrl(): string {
        const base = (this.config.apiUrl || 'http://localhost:11434').replace(/\/+$/, '');
        if (base.endsWith('/chat/completions')) return base;
        if (base.endsWith('/v1')) return `${base}/chat/completions`;
        // Ollama по умолчанию: /v1/chat/completions
        return `${base}/v1/chat/completions`;
    }
}
