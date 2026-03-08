import { TFile, Notice } from 'obsidian';
import { ShadowAI, AnalysisResult, ProfileSuggestion, ShadowSettings } from '../services/ShadowAI';
import { VaultService } from '../services/VaultService';

/**
 * AnalyzerAgent — основной агент плагина «Тень».
 * Превращает сырую заметку из inbox/ в структурированную рефлексию,
 * архивирует оригинал и обновляет профили.
 */
export class AnalyzerAgent {
    constructor(
        private qwen: ShadowAI,
        private vault: VaultService,
        private settings: ShadowSettings
    ) { }

    /**
     * Полный цикл обработки заметки:
     * 1. Чтение → 2. Анализ → 3. Рефлексия → 4. Архивация → 5. Профили → 6. Уведомление
     */
    async process(file: TFile): Promise<void> {
        // ═══ ШАГ 1: Чтение содержимого ══════════════════════════════
        const content = await this.vault.readFile(file);
        const originalName = file.basename;     // без .md
        const originalPath = file.path;

        // ═══ ШАГ 2: Вызов AI-анализа ════════════════════════════════
        let analysis: AnalysisResult;
        try {
            analysis = await this.qwen.analyzeNote(content);
        } catch (error: any) {
            throw new Error(`Ошибка анализа заметки «${originalName}»: ${error.message}`);
        }

        // ═══ ШАГ 3: Создание рефлексии ══════════════════════════════
        const noteDate = this.vault.extractDateFromYaml(content);
        const archiveDateFolder = noteDate;  // YYYY-MM-DD

        // Валидация и очистка имени
        const rawTitle = analysis.suggestedTitle || `Ref - ${originalName}`;
        const safeTitle = this.vault.sanitizeFilename(rawTitle);
        const reflectionsFolder = this.settings.vaultStructure.reflections || '10_Reflections';
        const archiveFolder = this.settings.vaultStructure.archive || '99_Archive';

        // Путь к архивному файлу (для ссылки в рефлексии)
        const archivePath = `${archiveFolder}/${archiveDateFolder}/${originalName}.md`;
        const archiveLinkName = `${archiveFolder}/${archiveDateFolder}/${originalName}`;

        // Формируем содержимое рефлексии
        const reflectionContent = this.buildReflectionContent(
            analysis,
            archiveLinkName,
            noteDate
        );

        // Генерируем уникальный путь (чтобы избежать конфликтов)
        const desiredPath = `${reflectionsFolder}/${safeTitle}.md`;
        const finalPath = this.vault.uniquePath(desiredPath);

        // Валидация ссылок в сгенерированном контенте
        const linkErrors = this.vault.validateFileLinks(finalPath, reflectionContent);
        if (linkErrors.length > 0) {
            const brokenLinks = linkErrors.map(e => e.link).join(', ');
            console.warn(`Shadow: обнаружены невалидные ссылки: ${brokenLinks}`);
            // Не блокируем процесс — ссылки могут быть на ещё не созданные файлы
        }

        await this.vault.writeFile(finalPath, reflectionContent);

        // ═══ ШАГ 4: Архивация оригинала ════════════════════════════
        // ВАЖНО: Если перемещение не удалось — не теряем оригинал
        try {
            await this.vault.moveFile(file, archivePath);
        } catch (moveError: any) {
            console.error(`Shadow: не удалось переместить в архив: ${moveError.message}`);
            new Notice(`⚠️ Рефлексия создана, но оригинал не перемещён в архив.`);
            // Не бросаем ошибку — рефлексия уже создана, это не критично
        }

        // ═══ ШАГ 5: Обновление профилей ═════════════════════════════
        if (analysis.profiles && analysis.profiles.length > 0) {
            await this.processProfiles(analysis.profiles, originalName);
        }

        // ═══ ШАГ 6: Уведомление ═════════════════════════════════════
        const createdTitle = finalPath.split('/').pop()?.replace('.md', '') || safeTitle;
        new Notice(`✅ Рефлексия создана: ${createdTitle}`);
    }

    // ─────────────────────────────────────────────────────────────────
    //  Построение содержимого рефлексии
    // ─────────────────────────────────────────────────────────────────

    private buildReflectionContent(
        analysis: AnalysisResult,
        archiveLinkName: string,
        noteDate: string
    ): string {
        const lines: string[] = [];

        // YAML Frontmatter (Properties)
        lines.push('---');
        if (analysis.mood_score !== undefined) {
            lines.push(`mood_score: ${analysis.mood_score}`);
        }
        if (analysis.core_emotions && analysis.core_emotions.length > 0) {
            lines.push(`core_emotions: [${analysis.core_emotions.join(', ')}]`);
        }
        lines.push('---');
        lines.push('');

        // Ссылка на оригинал в архиве
        lines.push(`> 📦 Архив: [[${archiveLinkName}]]`);
        lines.push('');

        // Психологический разбор
        lines.push('## Психологический разбор');
        lines.push('');
        lines.push(analysis.thought);
        lines.push('');

        // Инсайты
        lines.push('## Инсайт');
        lines.push('');
        if (analysis.insights && analysis.insights.length > 0) {
            for (const insight of analysis.insights) {
                lines.push(`- ${noteDate}: ${insight}`);
            }
        } else {
            lines.push(`- ${noteDate}: Нет явных инсайтов`);
        }
        lines.push('');

        // Сверх-связи (из профилей, если есть)
        lines.push('## Сверх-связи');
        lines.push('');
        if (analysis.profiles && analysis.profiles.length > 0) {
            const profileLinks = analysis.profiles
                .map(p => `[[${p.filename}]]`)
                .join(' ');
            lines.push(profileLinks);
        } else {
            lines.push('_Связи не обнаружены_');
        }
        lines.push('');

        return lines.join('\n');
    }

    // ─────────────────────────────────────────────────────────────────
    //  Обработка профилей
    // ─────────────────────────────────────────────────────────────────

    private async processProfiles(
        profiles: ProfileSuggestion[],
        sourceNoteName: string
    ): Promise<void> {
        const profilesBase = this.settings.vaultStructure.profiles || '20_Profiles';

        for (const profile of profiles) {
            const category = profile.category; // EmotionalPatterns | BehavioralPatterns | EnergyCycles
            const filename = this.vault.sanitizeFilename(profile.filename);
            const profilePath = `${profilesBase}/${category}/${filename}.md`;

            if (this.vault.exists(profilePath)) {
                // ── Обновление существующего профиля ──
                const existingFile = this.vault.getFileByPath(profilePath);
                if (existingFile) {
                    const sourceEntry = `\n\n---\n### Из [[${sourceNoteName}]]\n${profile.contentTemplate}`;
                    await this.vault.appendToFile(existingFile, sourceEntry);
                }
            } else {
                // ── Новый профиль по шаблону ──
                const newContent = this.buildProfileTemplate(
                    filename,
                    category,
                    profile.contentTemplate,
                    sourceNoteName
                );
                await this.vault.writeFile(profilePath, newContent);
            }
        }
    }

    private buildProfileTemplate(
        title: string,
        category: string,
        content: string,
        sourceNoteName: string
    ): string {
        const categoryLabels: Record<string, string> = {
            'EmotionalPatterns': 'Эмоциональные паттерны',
            'BehavioralPatterns': 'Поведенческие паттерны',
            'EnergyCycles': 'Энергетические циклы',
            'CognitiveDistortions': 'Когнитивные искажения'
        };

        return [
            `# ${title}`,
            '',
            `> Категория: ${categoryLabels[category] || category}`,
            '',
            '## Описание',
            '',
            content,
            '',
            '## Источники',
            '',
            `- [[${sourceNoteName}]]`,
            ''
        ].join('\n');
    }
}
