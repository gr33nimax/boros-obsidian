import { App, TFile, TFolder, TAbstractFile, normalizePath } from 'obsidian';

// ─────────────────────────────────────────────────────────────────────
//  Интерфейсы
// ─────────────────────────────────────────────────────────────────────

export interface ValidationError {
    /** Путь к файлу, содержащему невалидную ссылку */
    path: string;
    /** Текст ссылки [[link]] */
    link: string;
    /** Тип ошибки */
    type: 'broken' | 'mismatch' | 'encoding';
    /** Предложение по исправлению */
    suggestion: string;
}

// ─────────────────────────────────────────────────────────────────────
//  VaultService
// ─────────────────────────────────────────────────────────────────────

export class VaultService {
    /** Кэш путей: basename (нижний регистр) → массив полных путей */
    private pathCache: Map<string, string[]> = new Map();
    /** Набор всех путей для быстрого lookup */
    private pathSet: Set<string> = new Set();
    /** mtime последней полной перестройки кэша */
    private cacheBuiltAt: number = 0;
    /** mtime файлов на момент последней валидации (для инкрементальности) */
    private validatedMtimes: Map<string, number> = new Map();

    constructor(private app: App) { }

    // ═══════════════════════════════════════════════════════════════════
    //  Кэш путей
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Перестроить кэш путей ко всем .md файлам.
     * Вызывается лениво при первом обращении или явно из плагина.
     */
    buildPathCache(): void {
        this.pathCache.clear();
        this.pathSet.clear();

        const files = this.app.vault.getMarkdownFiles();
        for (const file of files) {
            this.indexFile(file);
        }

        this.cacheBuiltAt = Date.now();
    }

    private indexFile(file: TFile): void {
        const key = file.basename.toLowerCase();
        const paths = this.pathCache.get(key) || [];
        if (!paths.includes(file.path)) {
            paths.push(file.path);
        }
        this.pathCache.set(key, paths);
        this.pathSet.add(file.path);
    }

    private ensureCacheBuilt(): void {
        if (this.pathCache.size === 0) {
            this.buildPathCache();
        }
    }

    /**
     * Поиск файла по basename (регистронезависимый).
     * Возвращает массив путей (может быть > 1 при дубликатах).
     */
    findByBasename(basename: string): string[] {
        this.ensureCacheBuilt();
        return this.pathCache.get(basename.toLowerCase()) || [];
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Чтение / Запись / Добавление
    // ═══════════════════════════════════════════════════════════════════

    /** Все пути .md файлов */
    async getNotePaths(): Promise<string[]> {
        return this.app.vault.getMarkdownFiles().map(f => f.path);
    }

    /** Прочитать заметку по пути */
    async readNote(path: string): Promise<string> {
        const file = this.getFileByPath(path);
        if (!file) throw new Error(`Файл не найден: ${path}`);
        return await this.app.vault.read(file);
    }

    /** Прочитать TFile напрямую */
    async readFile(file: TFile): Promise<string> {
        return await this.app.vault.read(file);
    }

    /** Записать (создать или обновить) заметку по пути */
    async writeNote(path: string, content: string): Promise<void> {
        await this.writeFile(path, content);
    }

    /** Записать файл, вернуть TFile */
    async writeFile(path: string, content: string): Promise<TFile> {
        const normalizedPath = normalizePath(path);
        await this.ensureFolderExists(normalizedPath.split('/').slice(0, -1).join('/'));

        const existingFile = this.app.vault.getAbstractFileByPath(normalizedPath);
        if (existingFile instanceof TFile) {
            await this.app.vault.modify(existingFile, content);
            return existingFile;
        } else {
            const created = await this.app.vault.create(normalizedPath, content);
            this.indexFile(created);
            return created;
        }
    }

    /** Дописать текст в конец файла */
    async appendToFile(file: TFile, content: string): Promise<void> {
        const currentContent = await this.app.vault.read(file);
        await this.app.vault.modify(file, currentContent + '\n' + content);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Перемещение
    // ═══════════════════════════════════════════════════════════════════

    /** Переместить заметку (по путям) */
    async moveNote(source: string, target: string): Promise<void> {
        const file = this.getFileByPath(source);
        if (!file) throw new Error(`Исходный файл не найден: ${source}`);
        await this.moveFile(file, target);
    }

    /** Переместить TFile */
    async moveFile(file: TFile, newPath: string): Promise<TFile> {
        const normalizedNew = normalizePath(newPath);
        await this.ensureFolderExists(normalizedNew.split('/').slice(0, -1).join('/'));

        // Удалить из кэша старый путь
        this.pathSet.delete(file.path);

        await this.app.fileManager.renameFile(file, normalizedNew);

        const moved = this.app.vault.getAbstractFileByPath(normalizedNew);
        if (moved instanceof TFile) {
            this.indexFile(moved);
            return moved;
        }
        return file; // fallback
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Поиск и навигация
    // ═══════════════════════════════════════════════════════════════════

    getFileByPath(path: string): TFile | null {
        const f = this.app.vault.getAbstractFileByPath(normalizePath(path));
        return f instanceof TFile ? f : null;
    }

    getFilesByFolder(folderPath: string): TFile[] {
        const folder = this.app.vault.getAbstractFileByPath(normalizePath(folderPath));
        if (folder instanceof TFolder) {
            return folder.children.filter((f): f is TFile => f instanceof TFile);
        }
        return [];
    }

    getAllMarkdownFiles(): TFile[] {
        return this.app.vault.getMarkdownFiles();
    }

    exists(path: string): boolean {
        return !!this.app.vault.getAbstractFileByPath(normalizePath(path));
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Папки
    // ═══════════════════════════════════════════════════════════════════

    /** Рекурсивное создание папки (алиас для агентов) */
    async ensureFolderExists(folderPath: string): Promise<void> {
        return this.ensureFolder(folderPath);
    }

    async ensureFolder(folderPath: string): Promise<void> {
        if (!folderPath) return;
        const normalized = normalizePath(folderPath);
        if (this.app.vault.getAbstractFileByPath(normalized)) return;

        const parts = normalized.split('/');
        let current = '';
        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            if (!this.app.vault.getAbstractFileByPath(current)) {
                await this.app.vault.createFolder(current);
            }
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Инициализация структуры хранилища
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Создаёт структуру папок при первом запуске.
     * Маркер: .obsidian/.shadow-initialized
     */
    async initializeStructure(structure: {
        inbox: string; reflections: string; profiles: string; archive: string;
    }): Promise<boolean> {
        const markerPath = normalizePath(`${this.app.vault.configDir}/.shadow-initialized`);

        if (await this.app.vault.adapter.exists(markerPath)) {
            return false; // Уже инициализировано
        }

        const folders = [
            structure.inbox,
            structure.reflections,
            structure.profiles,
            `${structure.profiles}/EmotionalPatterns`,
            `${structure.profiles}/BehavioralPatterns`,
            `${structure.profiles}/EnergyCycles`,
            structure.archive,
        ];

        for (const folder of folders) {
            await this.ensureFolder(folder);
        }

        // README файлы
        const readmes: Record<string, string> = {
            [structure.inbox]: '# Входящие\n\nСюда помещайте сырые записи, дневник, мысли. Плагин «Тень» анализирует их и создаёт рефлексии.',
            [structure.reflections]: '# Рефлексии\n\nЗдесь хранятся результаты анализа ваших записей — психологические разборы, инсайты и связи.',
            [structure.profiles]: '# Профили\n\nДолгосрочные психологические паттерны, выявленные из ваших записей.\n\n- **EmotionalPatterns/** — эмоциональные паттерны\n- **BehavioralPatterns/** — поведенческие паттерны\n- **EnergyCycles/** — энергетические циклы',
            [structure.archive]: '# Архив\n\nОригиналы обработанных записей, организованные по датам.',
        };

        for (const [folder, content] of Object.entries(readmes)) {
            const readmePath = `${folder}/README.md`;
            if (!this.exists(readmePath)) {
                await this.writeFile(readmePath, content);
            }
        }

        // Записываем маркер
        await this.app.vault.adapter.write(markerPath, JSON.stringify({
            createdAt: new Date().toISOString(),
            structure
        }));

        return true;
    }

    /**
     * Генерирует описание структуры хранилища для системных промптов.
     */
    getVaultDescription(structure: {
        inbox: string; reflections: string; profiles: string; archive: string;
    }): string {
        const files = this.app.vault.getMarkdownFiles();

        const count = (prefix: string) => files.filter(f => f.path.startsWith(prefix)).length;

        const inboxCount = count(structure.inbox);
        const reflCount = count(structure.reflections);
        const profCount = count(structure.profiles);
        const archCount = count(structure.archive);
        const totalCount = files.length;

        return [
            `Ты работаешь в Obsidian-хранилище с ${totalCount} заметками.`,
            `Структура папок:`,
            `- «${structure.inbox}» — входящие записи, дневник (${inboxCount} файлов)`,
            `- «${structure.reflections}» — рефлексии и анализ (${reflCount} файлов)`,
            `- «${structure.profiles}» — долгосрочные профили: EmotionalPatterns, BehavioralPatterns, EnergyCycles (${profCount} файлов)`,
            `- «${structure.archive}» — архив обработанных записей (${archCount} файлов)`,
            `Формат ссылок: [[Имя]] (без расширения .md). Все имена файлов на кириллице.`,
        ].join('\n');
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Валидация ссылок
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Полная валидация всех [[ссылок]] в хранилище.
     * Инкрементальная: проверяет только файлы, изменённые после последней валидации.
     * Для полной пересканировки вызовите с force = true.
     */
    async validateLinks(force: boolean = false): Promise<ValidationError[]> {
        this.buildPathCache(); // Обновляем кэш перед валидацией

        const errors: ValidationError[] = [];
        const files = this.app.vault.getMarkdownFiles();

        for (const file of files) {
            // Инкрементальность: пропускаем неизменённые файлы
            if (!force) {
                const lastValidated = this.validatedMtimes.get(file.path);
                if (lastValidated && file.stat.mtime <= lastValidated) continue;
            }

            const content = await this.app.vault.read(file);
            const fileErrors = this.validateFileLinks(file.path, content);
            errors.push(...fileErrors);

            this.validatedMtimes.set(file.path, file.stat.mtime);
        }

        return errors;
    }

    /**
     * Валидация ссылок в одном файле (для внутреннего использования и агентов).
     * Принимает содержимое как строку — перегрузка для обратной совместимости.
     */
    validateFileLinks(filePath: string, content: string): ValidationError[] {
        this.ensureCacheBuilt();

        const linkRegex = /\[\[([^\]|#]+?)(?:[|#][^\]]*?)?\]\]/g;
        const errors: ValidationError[] = [];
        let match: RegExpExecArray | null;

        while ((match = linkRegex.exec(content)) !== null) {
            const rawLink = match[1].trim();

            // ── 1. Проверка существования ──
            const resolved = this.app.metadataCache.getFirstLinkpathDest(rawLink, filePath);

            if (!resolved) {
                // Файл не найден — пробуем предложить
                const suggestion = this.suggestFix(rawLink);
                errors.push({
                    path: filePath,
                    link: rawLink,
                    type: 'broken',
                    suggestion
                });
                continue;
            }

            // ── 2. Проверка ё/е (encoding) ──
            if (this.hasYoMismatch(rawLink, resolved.basename)) {
                errors.push({
                    path: filePath,
                    link: rawLink,
                    type: 'encoding',
                    suggestion: `Проверьте «ё»/«е»: ссылка «${rawLink}» → файл «${resolved.basename}»`
                });
            }

            // ── 3. Проверка точного совпадения регистра ──
            if (rawLink !== resolved.basename && rawLink.toLowerCase() === resolved.basename.toLowerCase()) {
                errors.push({
                    path: filePath,
                    link: rawLink,
                    type: 'mismatch',
                    suggestion: `Регистр не совпадает: «${rawLink}» → «${resolved.basename}»`
                });
            }
        }

        return errors;
    }

    /**
     * Проверка на несоответствие ё/е между ссылкой и именем файла.
     */
    private hasYoMismatch(link: string, filename: string): boolean {
        const normalizeYo = (s: string) => s.replace(/ё/g, 'е').replace(/Ё/g, 'Е');
        const linkNorm = normalizeYo(link);
        const fileNorm = normalizeYo(filename);

        // Если после нормализации совпадают, но до нормализации — нет
        return linkNorm === fileNorm && link !== filename;
    }

    /**
     * Попытка предложить исправление для сломанной ссылки.
     */
    private suggestFix(brokenLink: string): string {
        const normalizedLink = brokenLink.toLowerCase().replace(/ё/g, 'е').replace(/Ё/g, 'Е');

        // Поиск по нормализованному имени
        for (const [cachedKey, paths] of this.pathCache.entries()) {
            const normalizedKey = cachedKey.replace(/ё/g, 'е').replace(/Ё/g, 'Е');
            if (normalizedKey === normalizedLink && paths.length > 0) {
                const basename = paths[0].split('/').pop()?.replace('.md', '') || paths[0];
                return `Возможно, вы имели в виду: [[${basename}]]`;
            }
        }

        // Нечёткий поиск (Levenshtein ≤ 2)
        let bestMatch = '';
        let bestDist = 3; // Порог

        for (const [cachedKey, paths] of this.pathCache.entries()) {
            const dist = this.levenshtein(normalizedLink, cachedKey);
            if (dist < bestDist) {
                bestDist = dist;
                const basename = paths[0].split('/').pop()?.replace('.md', '') || paths[0];
                bestMatch = basename;
            }
        }

        if (bestMatch) {
            return `Возможно, вы имели в виду: [[${bestMatch}]]`;
        }

        return 'Файл не найден. Создайте заметку или исправьте ссылку.';
    }

    /**
     * Расстояние Левенштейна между двумя строками (для нечёткого поиска).
     */
    private levenshtein(a: string, b: string): number {
        const m = a.length;
        const n = b.length;
        if (m === 0) return n;
        if (n === 0) return m;

        const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
        for (let i = 0; i <= m; i++) dp[i][0] = i;
        for (let j = 0; j <= n; j++) dp[0][j] = j;

        for (let i = 1; i <= m; i++) {
            for (let j = 1; j <= n; j++) {
                const cost = a[i - 1] === b[j - 1] ? 0 : 1;
                dp[i][j] = Math.min(
                    dp[i - 1][j] + 1,
                    dp[i][j - 1] + 1,
                    dp[i - 1][j - 1] + cost
                );
            }
        }
        return dp[m][n];
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Нормализация имён файлов
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Нормализация имени файла:
     * - Удаление недопустимых символов (/ \ : * ? " < > |)
     * - Нормализация пробелов
     * - Обработка ё → е (опционально, для поиска)
     */
    normalizeFilename(name: string, replaceYo: boolean = false): string {
        let result = name
            .replace(/[\/\\:*?"<>|]/g, '')  // Недопустимые символы
            .replace(/\s+/g, ' ')           // Множественные пробелы → один
            .trim();

        if (replaceYo) {
            result = result.replace(/ё/g, 'е').replace(/Ё/g, 'Е');
        }

        return result;
    }

    /** Обратная совместимость: алиас для sanitizeFilename */
    sanitizeFilename(name: string): string {
        return this.normalizeFilename(name, false);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Генерация уникальных имён
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Генерирует уникальное имя файла в указанной папке.
     * Добавляет числовой суффикс при конфликте.
     */
    async generateUniqueFilename(base: string, folder: string): Promise<string> {
        const safeName = this.normalizeFilename(base);
        const basePath = normalizePath(`${folder}/${safeName}.md`);

        if (!this.exists(basePath)) return `${safeName}.md`;

        let counter = 1;
        while (this.exists(normalizePath(`${folder}/${safeName} (${counter}).md`))) {
            counter++;
        }
        return `${safeName} (${counter}).md`;
    }

    /** Обратная совместимость */
    uniquePath(desiredPath: string): string {
        let path = normalizePath(desiredPath);
        if (!this.exists(path)) return path;

        const ext = path.endsWith('.md') ? '.md' : '';
        const base = ext ? path.slice(0, -ext.length) : path;
        let counter = 1;
        while (this.exists(`${base} (${counter})${ext}`)) {
            counter++;
        }
        return `${base} (${counter})${ext}`;
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Утилиты для дат
    // ═══════════════════════════════════════════════════════════════════

    /**
     * Извлекает дату из YAML frontmatter.
     * Ищет поле `date:` в формате YYYY-MM-DD.
     * Если не находит — возвращает сегодняшнюю дату.
     */
    extractDateFromYaml(content: string): string {
        const yamlMatch = content.match(/^---\s*\n([\s\S]*?)\n---/);
        if (yamlMatch) {
            const dateMatch = yamlMatch[1].match(/date:\s*['"]?(\d{4}-\d{2}-\d{2})['"]?/);
            if (dateMatch) return dateMatch[1];
        }
        return this.todayString();
    }

    todayString(): string {
        const d = new Date();
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    }
}
