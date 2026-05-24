# AKIS Platform — Doğrulama Boşlukları ve Kanıt Durumu

Tarih: 2026-05-23

## Mevcut Sağlık Snapshot'ı

| Katman | Durum | Detay |
|---|---|---|
| Backend typecheck | ✅ | 0 hata |
| Frontend typecheck | ✅ | 0 hata |
| Backend unit tests | ✅ | 3500/3500 pass, 760 suite |
| Frontend unit tests | ⚠️ | 1708 pass, 41 fail (localStorage mock) |
| Backend integration | ❓ | 20 test dosyası, canlı DB gerekli |
| Gate script | ✅ | `scripts/gate.sh` var |
| Smoke tests | ✅ | 6 script |
| Benchmark | ✅ | 5 problem, 2 sonuç dosyası (7 Mayıs) |

## Vaatler vs Kanıtlar

### ✅ Kanıtlanmış
1. **Scribe: fikir → spec** — 5/5 benchmark başarılı, gerçek AI
2. **Explainability surface** — benchmark'ta reasoning, confidence, narrative capture
3. **Human gate** — 5/5 pipeline awaiting_approval'a ulaşmış
4. **Critic spec review** — benchmark'ta criticSpecOutput var
5. **SSE real-time** — smoke test'ler dolaylı kanıt

### ⚠️ Kısmen Kanıtlanmış
6. **Clarifying questions** — 5/5'te "0 soru soruldu", hiç tetiklenmemiş
7. **Confidence scoring** — 5/5'te skor=92, ayrıştırma yok

### ❌ Kanıtlanmamış
8. **Proto: spec → kod → push → PR** — benchmark awaiting_approval'da duruyor
9. **Trace: test üretimi + coverage** — hiç benchmark'ta çalıştırılmamış
10. **Fix-loop recovery** — kod var, gerçek kanıt yok
11. **Multi-provider** — sadece Anthropic + mock
12. **AC coverage tracking** — kod var, rapor yok

## Kanıt Piramidi

```
                    ╱╲
                   ╱  ╲        Level 4: Gerçek kullanıcı
                  ╱ ?? ╲
                 ╱──────╲
                ╱        ╲     Level 3: Proto+Trace+Fix-loop
               ╱  ❌ YOK  ╲      gerçek AI benchmark
              ╱────────────╲
             ╱              ╲  Level 2: Scribe+Critic
            ╱   ✅ 5 problem ╲    gerçek AI benchmark
           ╱──────────────────╲
          ╱                    ╲ Level 1: Unit tests
         ╱ ✅ 3500 BE + 1708 FE ╲  typecheck + lint
        ╱──────────────────────────╲
```

## Doğrulama Planı

### Tier 1: Kritik (demo güvenliği)
- **A.** Proto + Trace e2e benchmark — en az 2 problem, gerçek GitHub PAT
- **B.** Frontend test fix — localStorage mock (~1 saat)
- **C.** Confidence calibration — belirsiz input ile skor düşüşü göster

### Tier 2: Güçlendirici
- **D.** Clarification tetikleme testi
- **E.** Critic vs manuel değerlendirme tablosu
- **F.** Integration test'leri çalıştır

### Tier 3: İsteğe bağlı
- **G.** Smoke test'leri canlıda çalıştır + screenshot arşivi
- **H.** Multi-provider sanity check
