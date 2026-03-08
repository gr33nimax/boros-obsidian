import { BaseLLMProvider, ChatMessage, LLMProviderConfig, LLMResponse } from '../LLMProvider';

/**
 * OpenAI-compatible провайдер.
 * Работает с: OpenAI, DeepSeek, Together, Groq, Mistral и др.
 * Формат: стандартный /v1/chat/completions
 */
export class OpenAIProvider extends BaseLLMProvider {
    readonly name = 'OpenAI-compatible';

    async complete(
        messages: ChatMessage[],
        model?: string,
        _chatContext?: { chatId?: string; parentId?: string }
    ): Promise<LLMResponse> {
        await this.waitLimit();

        if (!this.config.apiKey) {
            throw new Error('API ключ не задан. Проверьте настройки плагина.');
        }

        const url = this.buildUrl();
        const data = await this.httpPost(url, {
            'Authorization': `Bearer ${this.config.apiKey}`
        }, {
            model: model || this.config.model || 'gpt-4o-mini',
            messages
        });

        return { content: this.extractContent(data) };
    }

    private buildUrl(): string {
        const base = this.config.apiUrl.replace(/\/+$/, '');
        if (base.endsWith('/chat/completions')) return base;
        if (base.endsWith('/v1')) return `${base}/chat/completions`;
        return `${base}/v1/chat/completions`;
    }
}
