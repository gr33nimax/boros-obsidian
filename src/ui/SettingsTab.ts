import { App, PluginSettingTab, Setting, Notice } from 'obsidian';
import type ShadowPlugin from '../../main';
import { EMBEDDING_MODELS } from '../services/EmbeddingService';

export class ShadowSettingTab extends PluginSettingTab {
    plugin: ShadowPlugin;

    constructor(app: App, plugin: ShadowPlugin) {
        super(app, plugin);
        this.plugin = plugin;
    }

    display(): void {
        const { containerEl } = this;
        containerEl.empty();
        containerEl.addClass('shadow-settings');

        // ═══════════════════════════════════════════════════════════════
        //  СЕКЦИЯ: LLM Провайдер
        // ═══════════════════════════════════════════════════════════════

        containerEl.createEl('h2', { text: '🧠 LLM Провайдер' });

        new Setting(containerEl)
            .setName('Тип провайдера')
            .setDesc('FreeQwenAPI (прокси), OpenAI-совместимый или локальный endpoint')
            .addDropdown(dd => dd
                .addOption('freeqwen', 'FreeQwenAPI (прокси)')
                .addOption('openai', 'OpenAI-compatible')
                .addOption('local', 'Local (Ollama / LM Studio)')
                .setValue(this.plugin.settings.llmProvider)
                .onChange(async (val: string) => {
                    this.plugin.settings.llmProvider = val as any;
                    await this.plugin.saveSettings();
                    this.plugin.reinitServices();
                    this.display(); // Перерисовка для обновления полей
                })
            );

        // URL
        const urlPlaceholder = this.plugin.settings.llmProvider === 'local'
            ? 'http://localhost:11434'
            : this.plugin.settings.llmProvider === 'freeqwen'
                ? 'http://localhost:3264/api'
                : 'https://api.openai.com';

        new Setting(containerEl)
            .setName('URL сервера')
            .setDesc('Базовый URL API (без /chat)')
            .addText(text => text
                .setPlaceholder(urlPlaceholder)
                .setValue(this.plugin.settings.llmApiUrl)
                .onChange(async (val: string) => {
                    this.plugin.settings.llmApiUrl = val;
                    await this.plugin.saveSettings();
                })
            );

        // API Key
        if (this.plugin.settings.llmProvider === 'openai') {
            new Setting(containerEl)
                .setName('API ключ')
                .setDesc('Ключ хранится зашифрованно в .obsidian/shadow.json')
                .addText(text => text
                    .setPlaceholder('sk-...')
                    .setValue(this.plugin.settings.llmApiKey ? '••••••••' : '')
                    .onChange(async (val: string) => {
                        if (val && !val.startsWith('•')) {
                            await this.plugin.saveSecretKey(val);
                        }
                    })
                );
        } else {
            new Setting(containerEl)
                .setName('API ключ (опционально)')
                .setDesc(this.plugin.settings.llmProvider === 'freeqwen'
                    ? 'Локальный прокси обычно не требует ключа'
                    : 'Некоторые локальные серверы требуют авторизацию')
                .addText(text => text
                    .setPlaceholder('Оставьте пустым если не нужно')
                    .setValue(this.plugin.settings.llmApiKey ? '••••••••' : '')
                    .onChange(async (val: string) => {
                        if (val && !val.startsWith('•')) {
                            await this.plugin.saveSecretKey(val);
                        }
                    })
                );
        }

        // Модель
        const modelPlaceholder = this.plugin.settings.llmProvider === 'local'
            ? 'llama3'
            : this.plugin.settings.llmProvider === 'freeqwen'
                ? 'qwen-plus'
                : 'gpt-4o-mini';

        new Setting(containerEl)
            .setName('Модель')
            .setDesc('Имя модели LLM')
            .addText(text => text
                .setPlaceholder(modelPlaceholder)
                .setValue(this.plugin.settings.llmModel)
                .onChange(async (val: string) => {
                    this.plugin.settings.llmModel = val;
                    await this.plugin.saveSettings();
                })
            );

        // Тест
        new Setting(containerEl)
            .setName('Проверка подключения')
            .addButton(btn => btn
                .setButtonText('Проверить')
                .onClick(async () => {
                    btn.setDisabled(true);
                    btn.setButtonText('Проверяю...');
                    try {
                        const ok = await this.plugin.shadowAI.testConnection();
                        new Notice(ok ? '✅ Подключение работает!' : '❌ Нет ответа от сервера');
                    } catch (e: any) {
                        new Notice(`❌ Ошибка: ${e.message}`);
                    } finally {
                        btn.setDisabled(false);
                        btn.setButtonText('Проверить');
                    }
                })
            );

        // ═══════════════════════════════════════════════════════════════
        //  СЕКЦИЯ: Эмбеддинги
        // ═══════════════════════════════════════════════════════════════

        containerEl.createEl('h2', { text: '🔍 Семантический поиск' });

        new Setting(containerEl)
            .setName('Режим эмбеддингов')
            .setDesc('Встроенная модель или внешний endpoint')
            .addDropdown(dd => dd
                .addOption('builtin', 'Встроенная модель (transformers.js)')
                .addOption('endpoint', 'Внешний endpoint (API)')
                .setValue(this.plugin.settings.embeddingMode)
                .onChange(async (val: string) => {
                    this.plugin.settings.embeddingMode = val as any;
                    await this.plugin.saveSettings();
                    this.plugin.reinitEmbeddings();
                    this.display();
                })
            );

        if (this.plugin.settings.embeddingMode === 'builtin') {
            // Выбор модели
            new Setting(containerEl)
                .setName('Модель эмбеддингов')
                .setDesc('Загружается при первом использовании')
                .addDropdown(dd => {
                    for (const m of EMBEDDING_MODELS) {
                        dd.addOption(m.id, `${m.label} (${m.size})`);
                    }
                    dd.setValue(this.plugin.settings.embeddingModel)
                        .onChange(async (val: string) => {
                            this.plugin.settings.embeddingModel = val;
                            await this.plugin.saveSettings();
                            this.plugin.reinitEmbeddings();
                        });
                });

            // Статус индексации
            const indexCount = this.plugin.embeddingService.indexedCount;
            new Setting(containerEl)
                .setName('Индексация')
                .setDesc(`Проиндексировано файлов: ${indexCount}`)
                .addButton(btn => btn
                    .setButtonText('Переиндексировать')
                    .onClick(async () => {
                        btn.setDisabled(true);
                        btn.setButtonText('Индексация...');
                        new Notice('Запущена переиндексация хранилища...');
                        await this.plugin.embeddingService.clearCache();
                        await this.plugin.embeddingService.indexVault();
                        new Notice(`✅ Индексация завершена (${this.plugin.embeddingService.indexedCount} файлов)`);
                        btn.setDisabled(false);
                        btn.setButtonText('Переиндексировать');
                        this.display();
                    })
                );
        } else {
            // Внешний endpoint
            new Setting(containerEl)
                .setName('URL endpoint')
                .setDesc('Пример: http://localhost:11434 или https://api.openai.com')
                .addText(text => text
                    .setPlaceholder('http://localhost:11434')
                    .setValue(this.plugin.settings.embeddingEndpointUrl)
                    .onChange(async (val: string) => {
                        this.plugin.settings.embeddingEndpointUrl = val;
                        await this.plugin.saveSettings();
                        this.plugin.reinitEmbeddings();
                    })
                );

            new Setting(containerEl)
                .setName('API ключ (эмбеддинги)')
                .setDesc('Оставьте пустым для локального сервера')
                .addText(text => text
                    .setPlaceholder('sk-...')
                    .setValue(this.plugin.settings.embeddingEndpointKey)
                    .onChange(async (val: string) => {
                        this.plugin.settings.embeddingEndpointKey = val;
                        await this.plugin.saveSettings();
                        this.plugin.reinitEmbeddings();
                    })
                );
        }

        // ═══════════════════════════════════════════════════════════════
        //  СЕКЦИЯ: Структура
        // ═══════════════════════════════════════════════════════════════

        containerEl.createEl('h2', { text: '📁 Структура хранилища' });

        const folderConfigs = [
            { key: 'inbox' as const, name: 'Входящие', desc: 'Папка для свежих записей', default: 'inbox' },
            { key: 'reflections' as const, name: 'Рефлексии', desc: 'Результаты анализа', default: '10_Reflections' },
            { key: 'profiles' as const, name: 'Профили', desc: 'Долгосрочные паттерны', default: '20_Profiles' },
            { key: 'archive' as const, name: 'Архив', desc: 'Оригиналы обработанных записей', default: '99_Archive' },
        ];

        for (const fc of folderConfigs) {
            const folderExists = this.app.vault.getAbstractFileByPath(
                this.plugin.settings.vaultStructure[fc.key] || fc.default
            );

            new Setting(containerEl)
                .setName(`${fc.name} ${folderExists ? '✅' : '❌'}`)
                .setDesc(fc.desc)
                .addText(text => text
                    .setPlaceholder(fc.default)
                    .setValue(this.plugin.settings.vaultStructure[fc.key])
                    .onChange(async (val: string) => {
                        this.plugin.settings.vaultStructure[fc.key] = val || fc.default;
                        await this.plugin.saveSettings();
                        this.display();
                    })
                );
        }

        // ═══════════════════════════════════════════════════════════════
        //  СЕКЦИЯ: Поведение
        // ═══════════════════════════════════════════════════════════════

        containerEl.createEl('h2', { text: '⚙️ Поведение' });

        new Setting(containerEl)
            .setName('Валидация ссылок')
            .setDesc('Проверять целостность [[ссылок]] при операциях')
            .addToggle(toggle => toggle
                .setValue(this.plugin.settings.validateLinksOnOperation)
                .onChange(async (val: boolean) => {
                    this.plugin.settings.validateLinksOnOperation = val;
                    await this.plugin.saveSettings();
                })
            );

        // ═══════════════════════════════════════════════════════════════
        //  Предупреждение
        // ═══════════════════════════════════════════════════════════════

        const warning = containerEl.createDiv({ cls: 'shadow-security-warning' });
        warning.innerHTML = `
            🔒 <b>Безопасность:</b> API-ключ шифруется (AES-256-GCM) и хранится в
            <code>.obsidian/shadow.json</code>. Он не попадает в data.json.
        `;
    }
}
