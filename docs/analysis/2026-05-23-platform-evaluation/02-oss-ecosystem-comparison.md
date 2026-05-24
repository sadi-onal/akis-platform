# AKIS Platform — OSS Ekosistemi Karşılaştırması

Tarih: 2026-05-23

## Rakip Kategorileri

### Kategori 1: Terminal/IDE Agent'ları (Developer Araçları)

| Proje | Stars | BYO Key | Self-Host | Verification | Non-Dev UX |
|---|---|---|---|---|---|
| OpenHands | 72K | ✓ | ✓ (Docker) | ✗ | Zayıf |
| Aider | 35K+ | ✓ | ✓ | ✗ | ✗ |
| OpenCode | yüksek | ✓ (75+) | ✓ | ✗ | ✗ |
| SWE-agent | 19K | ✓ | ✓ | ✗ | ✗ |
| Cline | yüksek | ✓ | ✓ | ✗ | Orta |

AKIS ile yanlış kıyas — bunlar developer araçları.

### Kategori 2: Multi-Agent Pipeline'lar (En Yakın Rakipler)

| Proje | Yapı | Quality Gates | Explainability | Non-Dev |
|---|---|---|---|---|
| AICOM | 12 agent, 5 gate, 61K LOC Python | ✓ | ? | ? |
| MetaGPT | PM→Arch→Eng | Kısmen | ✗ | ✗ |
| Ontheia | MCP-native, pgvector, RBAC | ? | ? | Orta |

### Kategori 3: OSS App Builder'lar (Non-Dev Target)

| Proje | Stars | BYO Key | Verification | Self-Host |
|---|---|---|---|---|
| Dyad | 20K | ✓ | Security scan | ✓ |
| Bolt.diy | yüksek | ✓ | ✗ | ✓ |
| Forge | yeni | ✓ (BYOK) | ✗ | ✓ |

### Commercial (subscription-based)

| Ürün | Fiyat/ay | Target |
|---|---|---|
| Claude Pro/Max | $20-200 | Developer |
| Cursor Pro | $20-200 | Developer |
| Lovable | $20+ | Non-dev founder |
| Bolt.new | $20+ | Teknik founder |
| Replit Agent | $25+ | Genel |

## AKIS'in Unique Kombinasyonu

Hiçbir rakipte bir arada olmayan:
- Verification chain (Critic + Trace + AC coverage)
- Per-stage explainability surface
- Human-in-the-loop formal gates
- Non-developer web UI
- Türkçe-native i18n
- Skills (core/opt + token-aware)
- MCP-first (GitHub + Jira)
- Self-hostable + BYO-API-key

## Niş Tanımı

"Doğrulanabilirlik" → OpenHands, Aider, Cline elendi
"Şeffaflık" → hepsi elendi (explainability yok)
"Teknik olmayan" → SWE-agent, Aider, OpenCode elendi
"Self-hosted" → Lovable, Bolt.new elendi

Niş dar ama boş.

## Tercih Edilebilirlik Dokunuşları (Öncelik Matrisi)

### Düşük efor, yüksek etki
1. Docker tek-komut kurulum (`docker compose up` = çalışır)
2. Multi-provider gerçek desteği (Ollama dahil)
3. README + 2-dakika demo GIF/video

### Orta efor, güçlü diferansiyasyon
4. Verification chain benchmark sayfası (kanıt)
5. Pipeline template kütüphanesi
6. GitHub App OAuth entegrasyonu

### Yüksek efor, stratejik
7. Ücretsiz hosted tier
8. Plugin/MCP marketplace
9. Collaborative pipeline
10. Learning loop (gerçek feedback)
