import { App, Plugin, TFile, TAbstractFile, Notice, WorkspaceLeaf, Menu } from 'obsidian';
import { AnalyzerAgent } from './src/agents/AnalyzerAgent';
import { ChatView, VIEW_TYPE_SHADOW_CHAT } from './src/ui/ChatView';
import { ShadowSettingTab } from './src/ui/SettingsTab';
import { ShadowAI, ShadowSettings, LinkSuggestion, ProfileSuggestion } from './src/services/ShadowAI';
import { EmbeddingService } from './src/services/EmbeddingService';
import { VaultService } from './src/services/VaultService';

// ─────────────────────────────────────────────────────────────────────
//  Настройки по умолчанию
// ─────────────────────────────────────────────────────────────────────

const DEFAULT_SETTINGS: ShadowSettings = {
    llmProvider: 'freeqwen',
    llmApiUrl: '',
    llmApiKey: '',
    llmModel: 'qwen-plus',
    embeddingMode: 'builtin',
    embeddingModel: 'Xenova/multilingual-e5-small',
    embeddingEndpointUrl: '',
    embeddingEndpointKey: '',
    vaultStructure: {
        inbox: 'inbox',
        reflections: '10_Reflections',
        profiles: '20_Profiles',
        archive: '99_Archive'
    },
    validateLinksOnOperation: true
};

// ─────────────────────────────────────────────────────────────────────
//  Плагин
// ─────────────────────────────────────────────────────────────────────

export default class ShadowPlugin extends Plugin {
    settings!: ShadowSettings;
    shadowAI!: ShadowAI;
    embeddingService!: EmbeddingService;
    vaultService!: VaultService;
    analyzerAgent!: AnalyzerAgent;

    async onload() {
        console.log('Инициациализация плагина «Boros»...');

        await this.loadSettings();
        await this.loadSecretKey();

        // Инициализация сервисов
        this.vaultService = new VaultService(this.app);
        this.shadowAI = new ShadowAI(this.settings);
        this.embeddingService = new EmbeddingService(this.app);
        this.analyzerAgent = new AnalyzerAgent(this.shadowAI, this.vaultService, this.settings);

        // Конфигурация эмбеддингов
        this.reinitEmbeddings();

        // Инициализация структуры хранилища (при первом запуске)
        const wasCreated = await this.vaultService.initializeStructure(this.settings.vaultStructure);
        if (wasCreated) {
            new Notice('📁 Boros: структура хранилища создана!');
        }

        // Обновить описание хранилища для ИИ
        this.updateVaultDescription();

        // Индексация хранилища
        this.embeddingService.indexVault();

        // ── Регистрация вида чата ──
        this.registerView(
            VIEW_TYPE_SHADOW_CHAT,
            (leaf: WorkspaceLeaf) => new ChatView(leaf, this)
        );

        // ═══════════════════════════════════════════════════════════════
        //  КОНТЕКСТНОЕ МЕНЮ (основной UI)
        // ═══════════════════════════════════════════════════════════════

        this.registerEvent(
            this.app.workspace.on('file-menu', (menu: Menu, file: TAbstractFile) => {
                if (!(file instanceof TFile) || file.extension !== 'md') return;

                menu.addSeparator();

                menu.addItem((item) => {
                    item.setTitle('∞ Boros: Анализ')
                        .setIcon('infinity')
                        .onClick(() => this.runAgentTask(file, 'analyze'));
                });

                menu.addItem((item) => {
                    item.setTitle('🔗 Boros: Связи')
                        .setIcon('link')
                        .onClick(() => this.runAgentTask(file, 'links'));
                });

                menu.addItem((item) => {
                    item.setTitle('👤 Boros: Профили')
                        .setIcon('users')
                        .onClick(() => this.runAgentTask(file, 'profiles'));
                });

                menu.addItem((item) => {
                    item.setTitle('💬 Boros: Чат по заметке')
                        .setIcon('messages-square')
                        .onClick(async () => {
                            await this.activateView();
                            // ChatView подхватит активную заметку автоматически
                        });
                });
            })
        );

        // ═══════════════════════════════════════════════════════════════
        //  КОМАНДЫ (опциональные хоткеи)
        // ═══════════════════════════════════════════════════════════════

        this.addCommand({
            id: 'boros-analyze-note',
            name: 'Анализ заметки',
            checkCallback: (checking: boolean) => {
                const file = this.app.workspace.getActiveFile();
                if (file) {
                    if (!checking) this.runAgentTask(file, 'analyze');
                    return true;
                }
                return false;
            }
        });

        this.addCommand({
            id: 'boros-build-links',
            name: 'Построение связей',
            checkCallback: (checking: boolean) => {
                const file = this.app.workspace.getActiveFile();
                if (file) {
                    if (!checking) this.runAgentTask(file, 'links');
                    return true;
                }
                return false;
            }
        });

        this.addCommand({
            id: 'boros-decompose-profiles',
            name: 'Разбор на профили',
            checkCallback: (checking: boolean) => {
                const file = this.app.workspace.getActiveFile();
                if (file) {
                    if (!checking) this.runAgentTask(file, 'profiles');
                    return true;
                }
                return false;
            }
        });

        this.addCommand({
            id: 'boros-open-chat',
            name: 'Открыть чат с Boros',
            callback: () => this.activateView()
        });

        // ═══════════════════════════════════════════════════════════════
        //  FILE WATCHER — автоматическое обновление индекса
        // ═══════════════════════════════════════════════════════════════

        this.registerEvent(
            this.app.vault.on('create', async (file: TAbstractFile) => {
                if (file instanceof TFile && file.extension === 'md') {
                    try {
                        const content = await this.app.vault.cachedRead(file);
                        await this.embeddingService.indexFile(file.path, content, file.stat.mtime);
                        await this.embeddingService.flushCache();
                    } catch { /* не критично */ }
                    this.updateVaultDescription();
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('modify', async (file: TAbstractFile) => {
                if (file instanceof TFile && file.extension === 'md') {
                    try {
                        const content = await this.app.vault.cachedRead(file);
                        await this.embeddingService.indexFile(file.path, content, file.stat.mtime);
                        await this.embeddingService.flushCache();
                    } catch { /* не критично */ }
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('delete', (file: TAbstractFile) => {
                if (file instanceof TFile && file.extension === 'md') {
                    this.embeddingService.removeFromIndex(file.path);
                    this.embeddingService.flushCache();
                    this.updateVaultDescription();
                }
            })
        );

        this.registerEvent(
            this.app.vault.on('rename', async (file: TAbstractFile, oldPath: string) => {
                if (file instanceof TFile && file.extension === 'md') {
                    this.embeddingService.renamePath(oldPath, file.path);
                    await this.embeddingService.flushCache();
                    this.vaultService.buildPathCache();
                    this.updateVaultDescription();
                }
            })
        );

        // ═══════════════════════════════════════════════════════════════
        //  Настройки
        // ═══════════════════════════════════════════════════════════════

        this.addSettingTab(new ShadowSettingTab(this.app, this));

        console.log('Плагин «Boros» запущен');
    }

    async onunload() {
        console.log('Выгрузка плагина «Boros»');
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Публичные методы для SettingsTab
    // ═══════════════════════════════════════════════════════════════════

    /** Пересоздать LLM провайдер при смене настроек */
    reinitServices(): void {
        this.shadowAI.updateSettings(this.settings);
        this.analyzerAgent = new AnalyzerAgent(this.shadowAI, this.vaultService, this.settings);
        this.updateVaultDescription();
    }

    /** Переконфигурировать эмбеддинги */
    reinitEmbeddings(): void {
        this.embeddingService.configure({
            mode: this.settings.embeddingMode,
            builtinModelId: this.settings.embeddingModel,
            endpointUrl: this.settings.embeddingEndpointUrl,
            endpointKey: this.settings.embeddingEndpointKey,
        });
    }

    /** Обновить описание хранилища для промптов */
    private updateVaultDescription(): void {
        const desc = this.vaultService.getVaultDescription(this.settings.vaultStructure);
        this.shadowAI.setVaultDescription(desc);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Активация чата
    // ═══════════════════════════════════════════════════════════════════

    async activateView() {
        const { workspace } = this.app;
        let leaf = workspace.getLeavesOfType(VIEW_TYPE_SHADOW_CHAT)[0];

        if (!leaf) {
            const rightLeaf = workspace.getRightLeaf(false);
            if (rightLeaf) {
                await rightLeaf.setViewState({ type: VIEW_TYPE_SHADOW_CHAT, active: true });
                leaf = rightLeaf;
            }
        }

        if (leaf) {
            workspace.revealLeaf(leaf);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Агентские задачи
    // ═══════════════════════════════════════════════════════════════════

    private async runAgentTask(file: TFile, task: 'analyze' | 'links' | 'profiles') {
        try {
            const taskLabel = task === 'analyze' ? 'анализ' : task === 'links' ? 'поиск связей' : 'разбор профилей';
            new Notice(`∞ Boros: ${taskLabel}...`);

            switch (task) {
                case 'analyze':
                    await this.analyzerAgent.process(file);
                    return;
                case 'links':
                    await this.runLinkBuilding(file);
                    return;
                case 'profiles':
                    await this.runProfileDecomposition(file);
                    return;
            }
        } catch (error: any) {
            console.error(`Shadow Error (${task}):`, error);
            new Notice(`❌ Ошибка Boros: ${error.message || 'см. консоль'}`);
        }
    }

    private async runLinkBuilding(file: TFile) {
        const content = await this.vaultService.readFile(file);
        const existingNotes = this.vaultService.getAllMarkdownFiles().map(f => f.basename);
        const suggestions: LinkSuggestion[] = await this.shadowAI.findLinks(content, existingNotes);

        if (suggestions.length === 0) {
            new Notice('Boros: связи не найдены');
            return;
        }

        const linkBlock = [
            '',
            '## Связи (Boros)',
            '',
            ...suggestions.map(s => `- [[${s.link}]]: ${s.reason}`),
            ''
        ].join('\n');

        await this.vaultService.appendToFile(file, linkBlock);
        new Notice(`✅ Добавлено связей: ${suggestions.length}`);
    }

    private async runProfileDecomposition(file: TFile) {
        const content = await this.vaultService.readFile(file);
        const profiles: ProfileSuggestion[] = await this.shadowAI.decomposeToProfiles(content);

        if (profiles.length === 0) {
            new Notice('Boros: профили не обнаружены');
            return;
        }

        const profilesBase = this.settings.vaultStructure.profiles || '20_Profiles';

        for (const profile of profiles) {
            const filename = this.vaultService.sanitizeFilename(profile.filename);
            const profilePath = `${profilesBase}/${profile.category}/${filename}.md`;

            if (this.vaultService.exists(profilePath)) {
                const existingFile = this.vaultService.getFileByPath(profilePath);
                if (existingFile) {
                    const entry = `\n\n---\n### Из [[${file.basename}]]\n${profile.contentTemplate}`;
                    await this.vaultService.appendToFile(existingFile, entry);
                }
            } else {
                const newContent = [
                    `# ${filename}`,
                    '',
                    `> Категория: ${profile.category}`,
                    '',
                    '## Описание',
                    '',
                    profile.contentTemplate,
                    '',
                    '## Источники',
                    '',
                    `- [[${file.basename}]]`,
                    ''
                ].join('\n');
                await this.vaultService.writeFile(profilePath, newContent);
            }
        }

        new Notice(`✅ Профилей обработано: ${profiles.length}`);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Настройки и секреты
    // ═══════════════════════════════════════════════════════════════════

    async loadSettings() {
        this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
        this.settings.llmApiKey = ''; // ключ загружается отдельно
    }

    async saveSettings() {
        const { llmApiKey, ...safeSettings } = this.settings;
        await this.saveData(safeSettings);
    }

    async loadSecretKey() {
        const secretPath = `${this.app.vault.configDir}/shadow.json`;
        try {
            if (await this.app.vault.adapter.exists(secretPath)) {
                const content = await this.app.vault.adapter.read(secretPath);
                const stored = JSON.parse(content);

                if (stored.encrypted && stored.iv && stored.salt) {
                    this.settings.llmApiKey = await this.decryptKey(stored);
                } else {
                    this.settings.llmApiKey = stored.apiKey || '';
                    if (this.settings.llmApiKey) {
                        await this.saveSecretKey(this.settings.llmApiKey);
                    }
                }
            }
        } catch (e) {
            console.warn('Не удалось загрузить shadow.json', e);
        }
    }

    async saveSecretKey(key: string) {
        this.settings.llmApiKey = key;
        const secretPath = `${this.app.vault.configDir}/shadow.json`;

        try {
            const encrypted = await this.encryptKey(key);
            await this.app.vault.adapter.write(secretPath, JSON.stringify(encrypted, null, 2));
        } catch {
            await this.app.vault.adapter.write(secretPath, JSON.stringify({ apiKey: key }, null, 2));
        }

        if (this.shadowAI) {
            this.shadowAI.updateApiKey(key);
        }
    }

    // ── Web Crypto ────────────────────────────────────────────────────

    private async deriveKey(salt: Uint8Array): Promise<CryptoKey> {
        const encoder = new TextEncoder();
        const passphrase = `shadow-${this.app.vault.getName()}-key`;
        const keyMaterial = await crypto.subtle.importKey(
            'raw', encoder.encode(passphrase), 'PBKDF2', false, ['deriveKey']
        );
        return crypto.subtle.deriveKey(
            { name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' },
            keyMaterial,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    }

    private async encryptKey(plaintext: string): Promise<Record<string, string>> {
        const encoder = new TextEncoder();
        const salt = crypto.getRandomValues(new Uint8Array(16));
        const iv = crypto.getRandomValues(new Uint8Array(12));
        const key = await this.deriveKey(salt);
        const ciphertext = await crypto.subtle.encrypt(
            { name: 'AES-GCM', iv }, key, encoder.encode(plaintext)
        );
        return {
            encrypted: this.bufToBase64(new Uint8Array(ciphertext)),
            iv: this.bufToBase64(iv),
            salt: this.bufToBase64(salt)
        };
    }

    private async decryptKey(stored: { encrypted: string; iv: string; salt: string }): Promise<string> {
        const decoder = new TextDecoder();
        const salt = this.base64ToBuf(stored.salt);
        const iv = this.base64ToBuf(stored.iv);
        const ciphertext = this.base64ToBuf(stored.encrypted);
        const key = await this.deriveKey(salt);
        const plainBuffer = await crypto.subtle.decrypt(
            { name: 'AES-GCM', iv }, key, ciphertext
        );
        return decoder.decode(plainBuffer);
    }

    private bufToBase64(buf: Uint8Array): string {
        let binary = '';
        for (let i = 0; i < buf.length; i++) binary += String.fromCharCode(buf[i]);
        return btoa(binary);
    }

    private base64ToBuf(b64: string): Uint8Array {
        const binary = atob(b64);
        const buf = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i++) buf[i] = binary.charCodeAt(i);
        return buf;
    }
}
