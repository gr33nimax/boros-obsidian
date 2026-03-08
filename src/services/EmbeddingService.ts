import { App, TFile, normalizePath, Notice, requestUrl } from 'obsidian';

// ─────────────────────────────────────────────────────────────────────
//  Типы
// ─────────────────────────────────────────────────────────────────────

export interface SearchResult {
    path: string;
    contentPreview: string;
    score: number;
    category: string;
}

interface EmbeddingCacheEntry {
    hash: string;
    mtime: number;
    embedding: number[];
    preview: string;
}

interface EmbeddingCache {
    [path: string]: EmbeddingCacheEntry;
}

export type EmbeddingModelId =
    | 'Xenova/multilingual-e5-small'
    | 'Xenova/paraphrase-multilingual-mpnet-base-v2'
    | 'Xenova/multilingual-e5-large';

export const EMBEDDING_MODELS: { id: EmbeddingModelId; label: string; size: string }[] = [
    { id: 'Xenova/multilingual-e5-small', label: 'E5 Small (мультиязычная)', size: '~130 MB' },
    { id: 'Xenova/paraphrase-multilingual-mpnet-base-v2', label: 'MPNet Base v2 (лучшее качество)', size: '~1 GB' },
    { id: 'Xenova/multilingual-e5-large', label: 'E5 Large (максимальная точность)', size: '~2.2 GB' },
];

export type EmbeddingMode = 'builtin' | 'endpoint';

// ─────────────────────────────────────────────────────────────────────
//  EmbeddingService
// ─────────────────────────────────────────────────────────────────────

export class EmbeddingService {
    private pipeline: any = null;
    private cache: EmbeddingCache = {};
    private cachePath: string;
    private isModelLoading: boolean = false;
    private isReady: boolean = false;

    // Настройки
    private mode: EmbeddingMode = 'builtin';
    private builtinModelId: EmbeddingModelId = 'Xenova/multilingual-e5-small';
    private endpointUrl: string = '';
    private endpointKey: string = '';

    constructor(private app: App) {
        this.cachePath = normalizePath(`${this.app.vault.configDir}/.shadow-embeddings.json`);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Конфигурация
    // ═══════════════════════════════════════════════════════════════════

    configure(opts: {
        mode: EmbeddingMode;
        builtinModelId?: string;
        endpointUrl?: string;
        endpointKey?: string;
    }): void {
        const modeChanged = this.mode !== opts.mode;
        const modelChanged = opts.builtinModelId && this.builtinModelId !== opts.builtinModelId;

        this.mode = opts.mode;
        if (opts.builtinModelId) this.builtinModelId = opts.builtinModelId as EmbeddingModelId;
        if (opts.endpointUrl !== undefined) this.endpointUrl = opts.endpointUrl;
        if (opts.endpointKey !== undefined) this.endpointKey = opts.endpointKey;

        // При смене модели/режима сбрасываем готовность
        if (modeChanged || modelChanged) {
            this.pipeline = null;
            this.isReady = false;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Инициализация встроенной модели
    // ═══════════════════════════════════════════════════════════════════

    async initModel(): Promise<boolean> {
        if (this.mode === 'endpoint') {
            this.isReady = !!this.endpointUrl;
            return this.isReady;
        }

        if (this.pipeline || this.isModelLoading) return !!this.pipeline;

        this.isModelLoading = true;
        const modelInfo = EMBEDDING_MODELS.find(m => m.id === this.builtinModelId);
        new Notice(`Загрузка модели эмбеддингов: ${modelInfo?.label || this.builtinModelId} (${modelInfo?.size})...`, 8000);

        try {
            // Динамический импорт transformers.js
            // @ts-ignore
            const { pipeline, env } = await import('@huggingface/transformers');

            // Настраиваем кеширование моделей и отключаем Node-бекенд 
            // так как в Obsidian onnxruntime-node нормально не работает
            env.useBrowserCache = true;
            env.allowLocalModels = false;
            if (env.backends && env.backends.onnx && env.backends.onnx.wasm) {
                // Указываем путь к wasm файлам (иначе возможна ошибка TypeError: Cannot read properties of undefined (reading 'create'))
                env.backends.onnx.wasm.wasmPaths = 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.17.1/dist/';
                env.backends.onnx.wasm.numThreads = 1;
            }

            this.pipeline = await pipeline('feature-extraction', this.builtinModelId, {
                dtype: 'q8',
            });

            this.isReady = true;
            new Notice('✅ Модель эмбеддингов загружена');
            console.log(`Shadow: Модель ${this.builtinModelId} загружена`);
            return true;
        } catch (error) {
            console.error('Shadow: Ошибка загрузки модели:', error);
            new Notice('❌ Не удалось загрузить модель эмбеддингов. Будет использован текстовый поиск.', 6000);
            this.isReady = false;
            return false;
        } finally {
            this.isModelLoading = false;
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Индексация
    // ═══════════════════════════════════════════════════════════════════

    async indexVault(): Promise<void> {
        await this.loadCache();
        await this.initModel();

        const files = this.app.vault.getMarkdownFiles();
        let updated = 0;

        for (const file of files) {
            if (await this.shouldUpdateIndex(file)) {
                try {
                    const content = await this.app.vault.cachedRead(file);
                    await this.indexFile(file.path, content, file.stat.mtime);
                    updated++;
                } catch (e) {
                    console.warn(`Shadow: не удалось индексировать ${file.path}`, e);
                }
            }
        }

        // Удаляем из кэша файлы, которых больше нет
        const filePaths = new Set(files.map(f => f.path));
        for (const cachedPath of Object.keys(this.cache)) {
            if (!filePaths.has(cachedPath)) {
                delete this.cache[cachedPath];
                updated++;
            }
        }

        if (updated > 0) {
            await this.saveCache();
            console.log(`Shadow: Индексация завершена. Обновлено: ${updated}`);
        }
    }

    /** Проиндексировать один файл */
    async indexFile(path: string, content: string, mtime: number = Date.now()): Promise<void> {
        const clean = this.preprocessText(content);
        const hash = await this.getContentHash(clean);
        const preview = clean.slice(0, 500);

        // Если хеш не изменился — пропускаем
        const cached = this.cache[path];
        if (cached && cached.hash === hash) return;

        let embedding: number[] = [];
        if (this.isReady) {
            try {
                const vec = await this.getEmbedding(clean);
                embedding = Array.from(vec);
            } catch (e) {
                console.warn(`Shadow: эмбеддинг не создан для ${path}`, e);
            }
        }

        this.cache[path] = { hash, mtime, embedding, preview };
    }

    /** Удалить файл из индекса */
    removeFromIndex(path: string): void {
        if (this.cache[path]) {
            delete this.cache[path];
        }
    }

    /** Обновить путь при переименовании */
    renamePath(oldPath: string, newPath: string): void {
        if (this.cache[oldPath]) {
            this.cache[newPath] = this.cache[oldPath];
            delete this.cache[oldPath];
        }
    }

    /** Сохранить кэш на диск */
    async flushCache(): Promise<void> {
        await this.saveCache();
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Поиск
    // ═══════════════════════════════════════════════════════════════════

    async search(query: string, limit: number = 5): Promise<SearchResult[]> {
        if (!this.isReady || (!this.pipeline && this.mode === 'builtin')) {
            return this.keywordSearch(query, limit);
        }

        try {
            const queryVec = await this.getEmbedding(this.preprocessText(query));
            const results: SearchResult[] = [];

            for (const [path, data] of Object.entries(this.cache)) {
                if (data.embedding.length === 0) continue;

                const score = this.cosineSimilarity(queryVec, new Float32Array(data.embedding));
                results.push({
                    path,
                    score,
                    contentPreview: data.preview || '',
                    category: this.categorizeByPath(path)
                });
            }

            return results
                .sort((a, b) => b.score - a.score)
                .slice(0, limit);
        } catch (e) {
            console.error('Shadow: семантический поиск не удался, переход на keywords', e);
            return this.keywordSearch(query, limit);
        }
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Получение эмбеддинга
    // ═══════════════════════════════════════════════════════════════════

    private async getEmbedding(text: string): Promise<Float32Array> {
        if (this.mode === 'endpoint') {
            return this.getEndpointEmbedding(text);
        }
        return this.getBuiltinEmbedding(text);
    }

    private async getBuiltinEmbedding(text: string): Promise<Float32Array> {
        if (!this.pipeline) throw new Error('Model not initialized');

        // E5 модели ожидают префикс
        const prefix = text.length < 200 ? 'query: ' : 'passage: ';
        const inputText = prefix + text.slice(0, 512); // Ограничиваем длину

        const output = await this.pipeline(inputText, {
            pooling: 'mean',
            normalize: true
        });

        return new Float32Array(output.data);
    }

    private async getEndpointEmbedding(text: string): Promise<Float32Array> {
        if (!this.endpointUrl) throw new Error('Endpoint URL не задан');

        const headers: Record<string, string> = {
            'Content-Type': 'application/json'
        };
        if (this.endpointKey) {
            headers['Authorization'] = `Bearer ${this.endpointKey}`;
        }

        const response = await requestUrl({
            url: this.endpointUrl.replace(/\/+$/, '') + '/v1/embeddings',
            method: 'POST',
            headers,
            body: JSON.stringify({
                input: text.slice(0, 2048),
                model: 'text-embedding-3-small'
            })
        });

        if (response.status !== 200) {
            throw new Error(`Embedding API error (${response.status})`);
        }

        const data = response.json;
        return new Float32Array(data?.data?.[0]?.embedding || []);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Keyword fallback
    // ═══════════════════════════════════════════════════════════════════

    private async keywordSearch(query: string, limit: number): Promise<SearchResult[]> {
        const words = this.preprocessText(query).toLowerCase().split(/\s+/).filter(w => w.length > 2);
        if (words.length === 0) return [];

        const results: SearchResult[] = [];

        for (const [path, data] of Object.entries(this.cache)) {
            const fileName = path.split('/').pop()?.replace('.md', '').toLowerCase() || '';
            const lowerPreview = (data.preview || '').toLowerCase();

            const nameHits = words.filter(w => fileName.includes(w)).length;
            const contentHits = words.filter(w => lowerPreview.includes(w)).length;
            const totalHits = nameHits * 2 + contentHits;

            if (totalHits > 0) {
                // Извлекаем сниппет
                let snippet = '';
                const firstWord = words.find(w => lowerPreview.includes(w));
                if (firstWord) {
                    const idx = lowerPreview.indexOf(firstWord);
                    const start = Math.max(0, idx - 60);
                    const end = Math.min(data.preview.length, idx + 100);
                    snippet = (start > 0 ? '…' : '') + data.preview.slice(start, end).trim() + (end < data.preview.length ? '…' : '');
                }

                results.push({
                    path,
                    score: Math.min(totalHits / (words.length * 3), 1.0),
                    contentPreview: snippet || `Файл: ${fileName}`,
                    category: this.categorizeByPath(path)
                });
            }
        }

        return results.sort((a, b) => b.score - a.score).slice(0, limit);
    }

    // ═══════════════════════════════════════════════════════════════════
    //  Утилиты
    // ═══════════════════════════════════════════════════════════════════

    private categorizeByPath(path: string): string {
        if (path.includes('Profiles') || path.includes('20_')) return 'Profile';
        if (path.includes('Reflections') || path.includes('10_')) return 'Reflection';
        if (path.includes('Archive') || path.includes('99_')) return 'Archive';
        return 'Note';
    }

    private preprocessText(text: string): string {
        return text
            .replace(/^---[\s\S]*?---\n*/, '')
            .replace(/ё/g, 'е')
            .replace(/Ё/g, 'Е')
            .trim();
    }

    private cosineSimilarity(a: Float32Array, b: Float32Array): number {
        if (a.length !== b.length) return 0;
        let dot = 0, normA = 0, normB = 0;
        for (let i = 0; i < a.length; i++) {
            dot += a[i] * b[i];
            normA += a[i] * a[i];
            normB += b[i] * b[i];
        }
        const denom = Math.sqrt(normA) * Math.sqrt(normB);
        return denom === 0 ? 0 : dot / denom;
    }

    private async shouldUpdateIndex(file: TFile): Promise<boolean> {
        const cached = this.cache[file.path];
        if (!cached) return true;
        return file.stat.mtime > cached.mtime;
    }

    private async getContentHash(text: string): Promise<string> {
        const msgUint8 = new TextEncoder().encode(text);
        const hashBuffer = await crypto.subtle.digest('SHA-256', msgUint8);
        const hashArray = Array.from(new Uint8Array(hashBuffer));
        return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
    }

    private async loadCache(): Promise<void> {
        try {
            if (await this.app.vault.adapter.exists(this.cachePath)) {
                const content = await this.app.vault.adapter.read(this.cachePath);
                this.cache = JSON.parse(content);
            }
        } catch (e) {
            console.warn('Shadow: не удалось загрузить кэш эмбеддингов', e);
        }
    }

    private async saveCache(): Promise<void> {
        try {
            await this.app.vault.adapter.write(this.cachePath, JSON.stringify(this.cache));
        } catch (e) {
            console.warn('Shadow: не удалось сохранить кэш эмбеддингов', e);
        }
    }

    /** Полная очистка кэша */
    async clearCache(): Promise<void> {
        this.cache = {};
        try {
            if (await this.app.vault.adapter.exists(this.cachePath)) {
                await this.app.vault.adapter.remove(this.cachePath);
            }
        } catch (e) {
            console.warn('Shadow: ошибка очистки кэша', e);
        }
    }

    /** Количество проиндексированных файлов */
    get indexedCount(): number {
        return Object.keys(this.cache).length;
    }
}
