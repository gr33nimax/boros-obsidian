import { ItemView, WorkspaceLeaf, Notice, Modal, Setting, normalizePath } from 'obsidian';
import type ShadowPlugin from '../../main';
import type { ChatMessage } from '../services/ShadowAI';
import type { SearchResult } from '../services/EmbeddingService';

export const VIEW_TYPE_SHADOW_CHAT = 'shadow-chat-view';

// ─────────────────────────────────────────────────────────────────────
//  Интерфейсы
// ─────────────────────────────────────────────────────────────────────

interface ChatEntry {
    role: 'user' | 'assistant';
    content: string;
    timestamp: number;
}

// ─────────────────────────────────────────────────────────────────────
//  ChatView — основной вид в правой панели
// ─────────────────────────────────────────────────────────────────────

export class ChatView extends ItemView {
    plugin: ShadowPlugin;

    private messageListEl!: HTMLElement;
    private inputEl!: HTMLTextAreaElement;
    private sendBtnEl!: HTMLButtonElement;
    private loaderEl!: HTMLElement;

    private history: ChatEntry[] = [];
    private isLoading: boolean = false;
    private historyPath: string;

    constructor(leaf: WorkspaceLeaf, plugin: ShadowPlugin) {
        super(leaf);
        this.plugin = plugin;
        this.historyPath = normalizePath(`${this.app.vault.configDir}/.shadow-chat-history.json`);
    }

    getViewType(): string {
        return VIEW_TYPE_SHADOW_CHAT;
    }

    getDisplayText(): string {
        return 'Чат «Тень»';
    }

    getIcon(): string {
        return 'brain';
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Жизненный цикл
    // ═══════════════════════════════════════════════════════════════════

    async onOpen() {
        const container = this.contentEl;
        container.empty();
        container.addClass('shadow-chat-container');

        // ── Заголовок ──
        const header = container.createDiv({ cls: 'shadow-chat-header' });
        header.createEl('h3', { text: 'Тень' });

        const clearBtn = header.createEl('button', {
            cls: 'shadow-header-btn',
            attr: { 'aria-label': 'Очистить историю' }
        });
        clearBtn.textContent = '🗑';
        clearBtn.addEventListener('click', () => this.clearHistory());

        // ── Список сообщений ──
        this.messageListEl = container.createDiv({ cls: 'shadow-message-list' });

        // ── Индикатор загрузки ──
        this.loaderEl = container.createDiv({ cls: 'shadow-loader' });
        this.loaderEl.createSpan({ cls: 'shadow-loader-dot' });
        this.loaderEl.createSpan({ cls: 'shadow-loader-dot' });
        this.loaderEl.createSpan({ cls: 'shadow-loader-dot' });
        this.loaderEl.style.display = 'none';

        // ── Область ввода ──
        const inputContainer = container.createDiv({ cls: 'shadow-input-container' });

        this.inputEl = inputContainer.createEl('textarea', {
            attr: {
                placeholder: 'О чём ты думаешь? Расскажи о своём состоянии...',
                rows: '2'
            }
        });

        this.inputEl.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                this.handleSend();
            }
        });

        this.sendBtnEl = inputContainer.createEl('button', {
            cls: 'shadow-send-btn',
            text: '→'
        });
        this.sendBtnEl.addEventListener('click', () => this.handleSend());

        // ── Загрузка истории ──
        await this.loadHistory();

        if (this.history.length === 0) {
            this.renderMessage('assistant', 'Я — твоя Тень. О чём мы сегодня поговорим?', false);
        } else {
            for (const entry of this.history) {
                this.renderMessage(entry.role, entry.content, false);
            }
        }

        this.scrollToBottom();
    }

    async onClose() {
        await this.saveHistory();
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Отправка сообщения
    // ═══════════════════════════════════════════════════════════════════

    private async handleSend() {
        const text = this.inputEl.value.trim();
        if (!text || this.isLoading) return;

        // Сохраняем историю ДО добавления текущего сообщения для API
        const apiHistory: ChatMessage[] = this.history
            .slice(-10)
            .map(e => ({
                role: e.role === 'user' ? 'user' as const : 'assistant' as const,
                content: e.content
            }));

        // Отображаем сообщение пользователя
        this.renderMessage('user', text);
        this.inputEl.value = '';
        this.inputEl.focus();

        this.setLoading(true);

        try {
            // ── 1. Семантический поиск для контекста ──
            let contextBlock = '';
            try {
                const searchResults = await this.plugin.embeddingService.search(text, 7);
                if (searchResults.length > 0) {
                    contextBlock = this.buildContext(searchResults);
                }
            } catch (searchErr) {
                console.warn('Shadow: поиск контекста не удался', searchErr);
            }

            // ── 2. Контекст активной заметки ──
            const activeFile = this.app.workspace.getActiveFile();
            let activeNoteContext = '';
            if (activeFile) {
                const noteContent = await this.app.vault.read(activeFile);
                activeNoteContext = `\n\nАКТИВНАЯ ЗАМЕТКА «${activeFile.basename}»:\n${noteContent.slice(0, 1500)}`;
            }

            // ── 3. Антигаллюцинационная инструкция ──
            const fullContext = `${contextBlock}${activeNoteContext}\n\nВАЖНО: Отвечай только на основе предоставленного контекста. Если информации недостаточно — скажи об этом честно. Не выдумывай факты.`;

            // ── 4. Запрос к ShadowAI ──
            const response = await this.plugin.shadowAI.chat(text, fullContext, apiHistory);

            // ── 5. Отображаем ответ ──
            this.renderMessage('assistant', response);

        } catch (error: any) {
            console.error('Shadow Chat Error:', error);
            new Notice('Ошибка связи с Тенью');
            this.renderMessage('assistant', `Я не могу сейчас ответить. (${error.message || 'Ошибка сети'})`);
        } finally {
            this.setLoading(false);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Рендеринг сообщений
    // ═══════════════════════════════════════════════════════════════════

    private renderMessage(role: 'user' | 'assistant', text: string, addToHistory: boolean = true) {
        const wrapper = this.messageListEl.createDiv({ cls: 'shadow-msg-wrapper' });

        const msgDiv = wrapper.createDiv({
            cls: `shadow-message shadow-message-${role === 'user' ? 'user' : 'ai'}`
        });

        this.renderTextWithLinks(msgDiv, text);

        // Кнопка «Интегрировать как инсайт» для ответов ИИ
        if (role === 'assistant' && text.length > 20) {
            const actionsDiv = wrapper.createDiv({ cls: 'shadow-msg-actions' });
            const insightBtn = actionsDiv.createEl('button', {
                cls: 'shadow-insight-btn',
                text: '💡 Интегрировать как инсайт'
            });
            insightBtn.addEventListener('click', () => {
                new InsightModal(this.app, this.plugin, text).open();
            });
        }

        if (addToHistory) {
            this.history.push({ role, content: text, timestamp: Date.now() });
            this.saveHistory();
        }

        this.scrollToBottom();
    }

    /**
     * Рендерит текст с [[ссылками]] → кликабельные internal-link
     */
    private renderTextWithLinks(container: HTMLElement, text: string) {
        const linkRegex = /\[\[([^\]]+?)\]\]/g;
        let lastIndex = 0;
        let match: RegExpExecArray | null;

        while ((match = linkRegex.exec(text)) !== null) {
            if (match.index > lastIndex) {
                container.appendText(text.slice(lastIndex, match.index));
            }

            const linkName = match[1];
            const displayName = linkName.includes('|') ? linkName.split('|')[1] : linkName;
            const targetName = linkName.includes('|') ? linkName.split('|')[0] : linkName;

            const linkEl = container.createEl('a', {
                cls: 'internal-link',
                text: displayName,
                attr: { 'data-href': targetName }
            });

            this.registerDomEvent(linkEl, 'click', (evt: MouseEvent) => {
                evt.preventDefault();
                this.app.workspace.openLinkText(targetName, '', evt.ctrlKey || evt.metaKey);
            });

            lastIndex = match.index + match[0].length;
        }

        if (lastIndex < text.length) {
            container.appendText(text.slice(lastIndex));
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Контекст из семантического поиска — с превью
    // ═══════════════════════════════════════════════════════════════════

    private buildContext(results: SearchResult[]): string {
        const lines: string[] = ['КОНТЕКСТ ИЗ ХРАНИЛИЩА:'];
        for (const r of results) {
            const name = r.path.split('/').pop()?.replace('.md', '') || r.path;
            const preview = r.contentPreview
                ? `\n  Превью: ${r.contentPreview.slice(0, 200)}`
                : '';
            lines.push(`- [[${name}]] (${r.category}, релевантность: ${(r.score * 100).toFixed(0)}%)${preview}`);
        }
        return lines.join('\n');
    }

    // ═══════════════════════════════════════════════════════════════════
    //  UI-хелперы
    // ═══════════════════════════════════════════════════════════════════

    private setLoading(state: boolean) {
        this.isLoading = state;
        this.loaderEl.style.display = state ? 'flex' : 'none';
        this.sendBtnEl.disabled = state;
        this.inputEl.disabled = state;
        this.sendBtnEl.textContent = state ? '⏳' : '→';
    }

    private scrollToBottom() {
        requestAnimationFrame(() => {
            this.messageListEl.scrollTop = this.messageListEl.scrollHeight;
        });
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Персистентность
    // ═══════════════════════════════════════════════════════════════════

    private async loadHistory() {
        try {
            if (await this.app.vault.adapter.exists(this.historyPath)) {
                const content = await this.app.vault.adapter.read(this.historyPath);
                const data = JSON.parse(content);
                if (Array.isArray(data)) {
                    this.history = data.slice(-100);
                }
            }
        } catch (e) {
            console.warn('Shadow: не удалось загрузить историю чата', e);
        }
    }

    private async saveHistory() {
        try {
            const toSave = this.history.slice(-200);
            await this.app.vault.adapter.write(
                this.historyPath,
                JSON.stringify(toSave, null, 2)
            );
        } catch (e) {
            console.warn('Shadow: не удалось сохранить историю чата', e);
        }
    }

    private async clearHistory() {
        this.history = [];
        this.messageListEl.empty();
        await this.saveHistory();
        this.plugin.shadowAI.resetContext();
        this.renderMessage('assistant', 'История очищена. О чём поговорим?', false);
        new Notice('История чата Тени очищена');
    }
}

// ─────────────────────────────────────────────────────────────────────
//  InsightModal — интеграция ответа ИИ как инсайта
// ─────────────────────────────────────────────────────────────────────

class InsightModal extends Modal {
    private plugin: ShadowPlugin;
    private insightText: string;

    constructor(app: any, plugin: ShadowPlugin, insightText: string) {
        super(app);
        this.plugin = plugin;
        this.insightText = insightText;
    }

    onOpen() {
        const { contentEl } = this;
        contentEl.empty();
        contentEl.addClass('shadow-insight-modal');

        contentEl.createEl('h2', { text: '💡 Интегрировать инсайт' });
        contentEl.createEl('p', {
            text: 'Отредактируйте текст и выберите, куда сохранить.',
            cls: 'shadow-insight-hint'
        });

        // ── Текстовое поле ──
        const textArea = contentEl.createEl('textarea', {
            cls: 'shadow-insight-textarea',
            attr: { rows: '8' }
        });
        textArea.value = this.insightText;

        // ── Имя файла ──
        let fileName = `Ref - Инсайт ${new Date().toISOString().slice(0, 10)}`;
        new Setting(contentEl)
            .setName('Имя рефлексии')
            .addText((text: any) => text
                .setValue(fileName)
                .onChange((val: string) => { fileName = val; })
            );

        // ── Действие ──
        let targetAction: 'new_reflection' | 'update_profile' | 'append_existing' = 'new_reflection';
        new Setting(contentEl)
            .setName('Действие')
            .addDropdown((dd: any) => dd
                .addOption('new_reflection', 'Создать новую рефлексию')
                .addOption('update_profile', 'Добавить в профиль')
                .addOption('append_existing', 'Дописать в существующую заметку')
                .setValue(targetAction)
                .onChange((val: string) => {
                    targetAction = val as any;
                })
            );

        // ── Кнопки ──
        const btnContainer = contentEl.createDiv({ cls: 'shadow-modal-buttons' });

        const saveBtn = btnContainer.createEl('button', {
            cls: 'shadow-save-btn',
            text: 'Сохранить'
        });
        saveBtn.addEventListener('click', async () => {
            const finalText = textArea.value.trim();
            if (!finalText) {
                new Notice('Текст инсайта пуст');
                return;
            }

            try {
                if (targetAction === 'new_reflection') {
                    await this.saveAsReflection(fileName, finalText);
                } else if (targetAction === 'update_profile') {
                    await this.appendToProfile(finalText);
                } else {
                    await this.appendToExisting(finalText);
                }
                this.close();
            } catch (err: any) {
                new Notice(`Ошибка сохранения: ${err.message}`);
            }
        });

        const cancelBtn = btnContainer.createEl('button', {
            cls: 'shadow-cancel-btn',
            text: 'Отмена'
        });
        cancelBtn.addEventListener('click', () => this.close());
    }

    private async saveAsReflection(title: string, content: string) {
        const safeName = this.plugin.vaultService.sanitizeFilename(title);
        const folder = this.plugin.settings.vaultStructure.reflections || '10_Reflections';
        const desiredPath = `${folder}/${safeName}.md`;
        const finalPath = this.plugin.vaultService.uniquePath(desiredPath);

        const today = this.plugin.vaultService.todayString();
        const fullContent = [
            `# ${safeName}`,
            '',
            '## Инсайт',
            '',
            `- ${today}: ${content}`,
            ''
        ].join('\n');

        await this.plugin.vaultService.writeFile(finalPath, fullContent);
        new Notice(`✅ Рефлексия сохранена: ${safeName}`);
    }

    private async appendToProfile(content: string) {
        const profilesBase = this.plugin.settings.vaultStructure.profiles || '20_Profiles';
        const profilePath = `${profilesBase}/EmotionalPatterns/Инсайты из чата.md`;

        const today = this.plugin.vaultService.todayString();
        const entry = `\n- ${today}: ${content}`;

        if (this.plugin.vaultService.exists(profilePath)) {
            const file = this.plugin.vaultService.getFileByPath(profilePath);
            if (file) {
                await this.plugin.vaultService.appendToFile(file, entry);
            }
        } else {
            const newContent = [
                '# Инсайты из чата',
                '',
                '> Категория: Эмоциональные паттерны',
                '',
                '## Записи',
                '',
                `- ${today}: ${content}`,
                ''
            ].join('\n');
            await this.plugin.vaultService.writeFile(profilePath, newContent);
        }

        new Notice('✅ Инсайт добавлен в профиль');
    }

    private async appendToExisting(content: string) {
        // Дописать в текущую активную заметку
        const activeFile = this.app.workspace.getActiveFile();
        if (!activeFile) {
            new Notice('Нет активной заметки для дополнения');
            return;
        }

        const today = this.plugin.vaultService.todayString();
        const entry = `\n\n---\n### Инсайт от ${today}\n${content}`;

        await this.plugin.vaultService.appendToFile(activeFile, entry);
        new Notice(`✅ Инсайт добавлен в «${activeFile.basename}»`);
    }

    onClose() {
        this.contentEl.empty();
    }
}
