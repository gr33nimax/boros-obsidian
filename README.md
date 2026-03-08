# ♾️ Boros for Obsidian
*The Ouroboros of Self-Knowledge. AI-powered Psychological Reflection Plugin.*

**Boros** (formerly Shadow) is a deep reflection and note-analysis plugin for [Obsidian](https://obsidian.md). It acts as an impartial, empathetic AI analyst living directly within your personal vault. 

It takes your raw, chaotic *"inbox"* thoughts, analyzes them for emotional patterns and cognitive distortions, and weaves them into structured psychological profiles—helping you see the hidden architecture of your psyche without data leaving your control.

---

## ✨ Core Features
*   **🧠 Deep Psychoanalysis:** Converts raw vent-notes into structured "Reflections" highlighting core insights, mood scores (1-10), and dominant emotions.
*   **👤 Automated Psychological Profiling:** Boros automatically detects recurring `BehavioralPatterns`, `EmotionalPatterns`, `EnergyCycles`, and `CognitiveDistortions` (e.g., Catastrophizing, Mind Reading) and builds dedicated profile dossiers for them.
*   **🔗 Semantic Link Building:** Understands your entire vault (via vector embeddings) and suggests profound psychological connections between seemingly unrelated notes.
*   **🛡️ 100% Privacy-First:** Supports multiple LLM Providers: FreeQwen, OpenAI, or completely local models via LM Studio / Ollama. Your deepest thoughts never have to leave your machine.
*   **💬 RAG Chat:** An empathetic Chat interface that "remembers" your past reflections and connects the dots as you converse.

## 🚀 Installation 
*(Currently in Beta)*

The easiest way to install Boros right now is via the [BRAT](https://github.com/TfTHacker/obsidian42-brat) plugin:
1. Open Obsidian Settings -> Community Plugins. Enable community plugins.
2. Search for and install **Obsidian42 - BRAT**.
3. Open BRAT settings -> Add Beta plugin -> Paste the URL of this repository.
4. Enable **Boros** in your Community Plugins list.

*Manual Installation:*
1. Download the latest release (`main.js`, `manifest.json`, `styles.css`) from the Releases page.
2. Put them in your vault's `.obsidian/plugins/boros-obsidian/` folder.
3. Reload Obsidian.

## ⚙️ Setup & Workflow
1. Go to **Settings -> Boros**.
2. Select your AI Provider (FreeQwen, OpenAI, or LocalEndpoint).
3. If using an external API, paste your API Key. (Keys are safely encrypted locally).
4. Go to any chaotic brain-dump note in your inbox.
5. Command Palette (or context menu): `Boros: Анализ заметки`.
6. Watch as Boros extracts the core message, writes a YAML block (`mood_score`, `core_emotions`), archives the original, and updates your psychological profiles folder!

## ⚠️ Disclaimer
**Boros is not a substitute for professional mental health care or therapy.** It is an automated journaling and self-reflection tool. The AI can hallucinate or misinterpret texts. Always consult a licensed therapist for mental health concerns.

## 🤝 Support
If you find Boros helpful in your journey of personal growth, consider supporting its active development!
https://boosty.to/mrgreenier/
