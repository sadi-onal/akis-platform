# Q4 Kalibrasyon Analizi (N=1 rater × 5 spec)
Rater dir: `/Users/omeryasironal/Projects/akis-platform/docs/dogfooding/q4-responses`
Baseline:  `/Users/omeryasironal/Projects/akis-platform/docs/dogfooding/results-baseline-2026-05-07T11-32-30-706Z.json`
Files:     q4-rubric-self-claude-2026-05-11.json

## 3.7.1 — Spec başına manuel skor vs Critic skoru

| Spec | Critic skoru | Manuel ort | Manuel SD | Δ (Manuel − Critic) | Yön |
|------|--------------|------------|-----------|---------------------|-----|
| todo-001 | 82% | 86.7% | — | 4.7 | uyumlu |
| calc-002 | 68% | 85.0% | — | 17.0 | manuel daha cömert |
| currency-003 | 68% | 81.7% | — | 13.7 | manuel daha cömert |
| blog-004 | 82% | 78.3% | — | -3.7 | uyumlu |
| qr-005 | 82% | 85.0% | — | 3.0 | uyumlu |

## 3.7.2 — Korelasyon (Pearson r)

- **n (spec çiftleri):** 5
- **Pearson r:** -0.000 (negatif zayıf/yok)
- **Yorum (THESIS_FOCUS § 3 Q4):** Korelasyon yok: Critic skor ve insan yargısı bağımsız. Bu bir kalibrasyon sorunu.

> N=5 küçük; Pearson r anlamlılık testi anlamlı sonuç vermez. "Small-N illustrative correlation" olarak raporlanır.

## 3.7.3 — Scatter (ASCII gösterim)

```
       0%        25%        50%        75%       100%  manuel mean
100% |                                                    
90% |                                                    
80% |                                        4   +       
70% |                                          3 2       
60% |                                                    
50% |                                                    
40% |                                                    
30% |                                                    
20% |                                                    
10% |                                                    
  0% |                                                    
     +---------------------------------------------------
       0%        25%        50%        75%       100%  manuel mean
       (y ekseni = Critic skoru)
```

Noktalar: 1=todo-001, 2=calc-002, 3=currency-003, 4=blog-004, 5=qr-005

## 3.7.4 — Sapma analizi

- **Uyumlu (|Δ| < 5pt):** 3/5 — todo-001, blog-004, qr-005
- **Manuel cömert (Δ ≥ +5pt; Critic gereksiz sert):** 2 — calc-002 (+17.0), currency-003 (+13.7)
- **Manuel sert (Δ ≤ −5pt; Critic gereksiz cömert):** 0 — —

### Onay kararı uyumu (Critic approved vs manual ≥80% eşiği)

| Spec | Critic kararı | Manuel %≥80? | Uyum |
|------|---------------|--------------|------|
| todo-001 | onaylandı | evet | ✓ |
| calc-002 | reddedildi | evet | ✗ |
| currency-003 | reddedildi | evet | ✗ |
| blog-004 | onaylandı | hayır | ✗ |
| qr-005 | onaylandı | evet | ✓ |

Karar uyumu: 2/5 = 40%

## 3.7.5 — Rater notları (niteliksel)

- **self-claude-pilot (genel):** N=1 (tek puanlayıcı) pilot örneği. Tezin § 3.7 kalibrasyon bölümünde 'illustrative baseline' olarak kullanılabilir; istatistiksel anlamlılık için N≥3 önerilir. Critic'in 68/82 ikili dağılımı vs benim 78-87% daralma şu temel soruyu açıyor: 'Critic'in 68 verdiği specler gerçekten kötü mü, yoksa Critic'in rubric'i farklı bir eksende mi hassas?'
- **self-claude-pilot → todo-001:** MVP yerinde; out-of-scope listesi net (sunucu sync, kategori, düzenleme yok). Non-dev anlaşılabilirlik: 'nonFunctional' jargon + Stack: HTML+CSS+JS tipik kullanıcıyı zorlayabilir, ama spec gövdesi büyük ölçüde Türkçe ve somut.
- **self-claude-pilot → calc-002:** 10 AC bir hesap makinesi için biraz fazla; orijinal fikirde yer almayan 'geçersiz operatör sırası' eklendi (over-spec). Fidelity yüksek çünkü 4 işlem + klavye/buton + sıfıra bölme hatası birebir karşılanmış.
- **self-claude-pilot → currency-003:** Sabit kur ile gerçek-kullanıcı faydası sınırlı (orijinal fikirde böyle istenmiş). Sadakat çok iyi: 'Gerçek API entegrasyonu' kapsam-dışı listesine açıkça yazılmış.
- **self-claude-pilot → blog-004:** Yararı düşük çünkü 'kullanıcı = blog okuyucu' soyut, gerçek tüketici developer. Non-dev anlaşılabilirlik bu spec'in zayıf noktası: 'endpoint', 'JSON object', 'Content-Type', 'stateless' yoğun. Ama MVP disiplini örnek niteliğinde: 2 endpoint, 4 AC, çok temiz scope.
- **self-claude-pilot → qr-005:** Pratik tool; spec içeriği güçlü. 'Yapay zeka API kullanılmayacak' non-functional kısıtı non-dev için kafa karıştırıcı (neden bahsediyor?). QR kütüphanesi ihtiyacı feasibility'yi 10'dan 9'a çekiyor.

---
*Generated 2026-05-11T12:23:52.984Z — N raters: 1, n specs paired: 5.*
