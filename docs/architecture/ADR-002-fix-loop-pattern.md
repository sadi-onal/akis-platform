# ADR-002: Fix Loop Pattern (Self-Healing Pipeline)

## Status
Kabul Edildi -- 2026-04-14

## Context
AKIS pipeline'inda Trace agent test yazdiktan sonra, testlerin basarisiz olmasi durumunda
pipeline tamamen fail oluyor veya `completed_partial` durumuna geciyor. Bu durum:

1. **Kullanici deneyimini bozar:** Kullanici "fix loop" yerine yeniden baslatmak zorunda kalir.
2. **Israf:** Proto'nun urettigi tum kod ve Trace'in yazdigi testler kaybolur.
3. **Otomasyon eksikligi:** Pipeline "test fail --> duzelt --> tekrar test" dongusunu otomatize etmiyor.

Arastirma kaynaklari bu probleme "self-healing" veya "fix loop" olarak yaklasir:
- LLMloop (ICSME 2025): LLM-based iterative code repair -- test failure feedback ile kod duzeltme
- Reflexion: LLM self-reflection ile hata duzeltme -- onceki hatalari ogrenme
- StrongDM: Holdout testing + iterative repair cycle

Mevcut durumda AKIS'te retry mekanizmasi var (max 3, backoff) ama bu sadece API hatalarini
tekrar deniyor. Test failure'larini analyze edip kodu duzeltme kapasitesi yok.

## Decision
Trace test failure sonrasi Proto'yu tekrar cagiran bir **Fix Loop** implement edilecek.

### Uygulama Detaylari

**Fix Loop Flow:**
```
Trace tests fail
    |
    v
Analyze failure (hangi testler, neden?)
    |
    v
Proto fix iteration 1 (temperature=0)
    |
    v
Trace re-test
    |
    v (fail?)
Proto fix iteration 2 (temperature=0.1)
    |
    v
Trace re-test
    |
    v (fail?)
Proto fix iteration 3 (temperature=0.2)
    |
    v
Trace re-test
    |
    v (fail?)
completed_partial (max iteration reached)
```

**Temperature Escalation:**
| Iterasyon | Temperature | Strateji |
|-----------|-------------|----------|
| 1 | 0 | Ayni deterministik yaklasim, test feedback ile |
| 2 | 0.1 | Hafif cesitlilik -- farkli cozum yolu denemesi |
| 3 | 0.2 | Daha fazla cesitlilik -- yaratici cozum arayisi |

**Prensip:** Her iterasyonda temperature 0.1 artar. Bu, ayni hataya ayni cozumle
yaklasma dongusunu kirar. Temperature 0'da model belirleyici, 0.2'de yeterince cesitli.
0.3+ riskli -- halusinasyon riski artar.

**Fix Loop Inputs:**
- Basarisiz test dosyalari ve hata mesajlari
- Proto'nun orijinal scaffold'u
- Orijinal spec (acceptance criteria)
- Onceki fix denemelerinin sonuclari (Reflexion pattern)

**Yeni FSM State'leri:**
- `fix_loop_iteration_1`
- `fix_loop_iteration_2`
- `fix_loop_iteration_3`

**Cikis Kosullari:**
1. Tum testler geciyor --> `completed`
2. Max iterasyon (3) asildi --> `completed_partial`
3. Stage timeout (10 dk) --> `failed` (retryable)

## Consequences

### Artilari
- Pipeline self-healing kapasitesi kazanir
- Kullanici muedahalesi olmadan hata duzeltme
- Tez icin guclu "iterative verification" narrative
- Basari orani artisi: fail --> partial yerine fail --> fix --> success
- Temperature escalation ile farkli cozum stratejileri denenir

### Eksileri
- Pipeline suresi uzar (her iterasyon ~1-2 dk)
- API maliyeti artar (Proto + Trace tekrar cagrilir)
- Sonsuz dongu riski (max 3 ile sinirlandirildi)
- Fix'in yeni bug'lar getirme riski (regression)
- Karmasiklik artar (3 yeni FSM state)

### Trade-off'lar
- Hiz vs. otomatik fix: Max 3 iterasyon ~6 dk ekler, ama manuel fix gerekliligi ortadan kalkar
- Maliyet vs. basari orani: 3x API call, ama pipeline completion rate olculebilir sekilde artar
- Temperature vs. guvenilirlik: 0.2 hala guvenli, 0.3+ halusinasyon riskli
- Reflexion feedback vs. context window: Onceki hata bilgisi context'e eklenir, window dolabilir

## References
- **LLMloop (ICSME 2025)**: LLM-based iterative code repair with test feedback
- **Reflexion**: LLM self-reflection -- learning from previous errors to improve next attempt
- **StrongDM**: Holdout testing with iterative repair cycle
- **METR 2025**: Evaluation framework -- iterative improvement metrics for AI agents
- **Temperature research**: Optimal temperature ranges for code generation (0-0.2 for repair tasks)
