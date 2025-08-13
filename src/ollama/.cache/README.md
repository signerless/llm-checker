# Ollama Models Cache - STATIC DATABASE

## ⚠️ IMPORTANT: Static Database with Pre-Classified Categories

This directory contains a **static, pre-loaded database** of 177 Ollama models with complete category classifications.

### Current Status:
- **177 models** with real size data from Ollama Hub
- **Pre-classified categories**: coding, creative, reasoning, multimodal, embeddings, chat, safety, general
- **No automatic updates** - this is intentionally static for stability

### If You Need to Update the Database in the Future:

1. **Run database update process** (re-enable update functionality)
2. **🚨 CRITICAL: RE-ADD CATEGORIES** after update:
   - Run `node src/utils/model-classifier.js` on all new models
   - Apply classification rules to new entries
   - Update cache with category data
3. **Test all use-case filters**:
   - `--use-case coding`
   - `--use-case creative` 
   - `--use-case reasoning`
   - `--use-case multimodal`
   - `--use-case embeddings`
   - `--use-case talking`
4. **Verify category detection** works for all 7 use cases

### Files:
- `ollama-detailed-models.json` - Main cache with 177 models + categories
- `README.md` - This documentation

---
**Note**: The database update functionality was intentionally removed to maintain stability and keep the current categorization system intact.