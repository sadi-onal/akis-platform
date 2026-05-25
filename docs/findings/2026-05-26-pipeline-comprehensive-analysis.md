# Pipeline Kapsamlı Analiz Raporu — 2026-05-26

## Özet

İki pipeline çalıştırılarak sistemin end-to-end davranışı incelendi. Pipeline 1 (ilk test) 8 Critic iteration + 1 GitHub push hatası + kullanıcı override sonucu `awaiting_critic_resolution` durumunda kaldı. Pipeline 2 (fix test) Critic iterate loop sırasında Proto JSON parse hatasıyla `failed` oldu, kullanıcı retry sonrası `awaiting_push_confirm`'e ulaştı. Bilinen 5 sorunun (PR #640-642 ile fix'lenen 3'ü dahil) dışında **7 yeni bulgu** tespit edildi.

## İncelenen Pipeline'lar

| Pipeline | ID | Sonuç | Toplam AI Çağrı | Gerçek Maliyet |
|---|---|---|---|---|
| Pipeline 1 (ilk test) | `c15922ba-84fd-453f-bc7e-c3e39954158a` | `awaiting_critic_resolution` | 19 | $0.6786 |
| Pipeline 2 (fix test) | `370f1e8d-3d97-415b-8578-901900fcac02` | `awaiting_push_confirm` | 8 | $0.1973 |

---

## Yeni Bulgular

### Bulgu 1: Pipeline Metrics — Gerçek Maliyet Arasında 12x Fark (Metrics Flush Gap)

**Severity:** Critical
**Confidence:** %100

Pipeline 1 DB metrics: `estimatedCost: 0.055738 | totalTokens: 15,309`
Pipeline 1 gerçek (job_ai_calls toplamı): `estimatedCost: 0.678603 | totalTokens: 138,766`

**Kök sebep:** `flushTokenUsage()` sadece belirli stage geçişlerinde çağrılıyor (`awaiting_approval`, `proto_building`, `trace_testing`, `awaiting_push_confirm`, terminal state'ler). Ancak `awaiting_critic_resolution` stage'i bu listede yok. Iterate loop sırasında her Proto+Critic döngüsünde flush yapılmıyor — tokenler in-memory accumulator'de birikiyor ve kaybolabiliyor.

**Önerilen çözüm:**
1. `awaiting_critic_resolution` stage'ini flush listesine ekle
2. Her iterate döngüsü sonunda flush yap
3. Alternatif: her AI call sonrasında incremental flush

---

### Bulgu 2: Proto JSON Parse Hatası — Haiku'nun Karışık Newline Formatı

**Severity:** Critical
**Confidence:** %95

Backend log (Pipeline 2, iterate retry):
```
WARN: [Proto] JSON parse failed (attempt 1, len=11782): Unexpected token '\'
WARN: [Proto] JSON parse failed (attempt 2, len=10840): Unexpected token '\'
WARN: [Proto] JSON parse failed (attempt 3, len=11906): Unexpected token '\'
```

**Kök sebep:** Claude Haiku 4.5, `files` array'ini gerçek newline'larla formatlarken, `setupCommands` ve `summary` alanlarını escaped `\n` olarak yazdı (backslash + n, iki karakter, JSON string'in dışında). Bu truncation değil — yanıt 11,906 karakter ve düzgün kapanıyor ama semantically invalid JSON.

`extractJsonSafe()`, `sanitizeJsonControlChars()` ve `repairTruncatedJson()` hiçbiri bu pattern'ı handle etmiyor.

**Önerilen çözüm:** Parse zincirinde yeni bir strateji ekle: JSON string'i dışındaki literal `\n` pattern'lerini gerçek newline'a çeviren `fixEscapedWhitespace()` fonksiyonu.

---

### Bulgu 3: Iterate Loop Stagnation — Haiku Feedback'i Uygulayamıyor

**Severity:** Major
**Confidence:** %90

Pipeline 1'de 8 Critic rejection, skorlar: 62 → 65 → 62 → 68 → 62 → 62 → 65 → 65. Hiçbir iyileşme trendi yok. AC-2 (otomatik güncelleme) ve AC-6 (boş input uyarısı) 8 iterasyonda hiç çözülemedi.

**Kök sebep:** İkili sorun:
1. PR #641 ile fix'lenen AC mapping eksikliği (artık düzeltildi)
2. Haiku modeli, karmaşık AC kriterlerini implement etmekte yetersiz kalabiliyor — Claude Code üzerinden aynı iş istendiğinde daha complete sonuç veriyor (kullanıcı gözlemi)

**Önerilen çözüm:** Effort scoring'de kritik AC sayısına göre model escalation ekle — 2+ iterasyon sonrası Haiku → Sonnet upgrade.

---

### Bulgu 4: GitHub Push Hatası Scaffold Regeneration Tetikliyor

**Severity:** Major
**Confidence:** %95

Pipeline 1'de GitHub push 09:07:02'de başarısız olduğunda, pipeline mevcut dosyalarla push retry yapmak yerine sıfırdan yeni scaffold generation başlattı. $0.029 + 24 saniye gereksiz harcandı.

**Önerilen çözüm:** Push hatası durumunda, mevcut `protoOutput.files` ile push retry mekanizması ekle.

---

### Bulgu 5: AI Log Sayısı Frontend'de Gösterilmiyor

**Severity:** Minor
**Confidence:** %95

AI Logları sekmesinde toplam log sayısı badge olarak gösterilmiyor. Kullanıcı "loglar eksik" dedi ama aslında 19 log mevcuttu — sadece scroll gerekiyordu.

**Önerilen çözüm:** AI Logları tab başlığına count badge ekle (ör. `AI Logları · 19`).

---

### Bulgu 6: Cinema Proto %62 Yanıltıcı — Critic Skoru Gösteriliyor

**Severity:** Minor
**Confidence:** %90

Cinema'da Proto kolonunda %62 gösteriliyor — bu aslında Critic'in skoru, Proto'nun kendi ilerlemesi değil. Pipeline failed olduğunda bile numerik progress gösterilmeye devam ediyor.

**Önerilen çözüm:** Failed state'te numerik progress yerine failure indicator göster. Critic skoru ayrı bir etiketle belirt.

---

### Bulgu 7: Metrics retryCount Yanıltıcı

**Severity:** Info
**Confidence:** %95

`retryCount: 1` sadece kullanıcı-initiated retry'ları sayıyor, iterate loop iterasyonlarını değil. Pipeline 1'de 8 Proto + 8 Critic çağrısı yapıldı ama metrics `retryCount: 1` gösteriyor.

**Önerilen çözüm:** `iterateCount` ayrı bir metrik olarak ekle veya retryCount'u iterate'leri de kapsayacak şekilde genişlet.

---

## Bilinen ve Fix'lenmiş Sorunlar (referans)

| Issue | PR | Durum |
|---|---|---|
| #635 AC mapping eksik | #641 | ✅ Merged |
| #636 Preview paneli gizli | #640 | ✅ Merged |
| #637 Stage race condition | #642 | ✅ Merged |
| #638 Trace skip uyarısı | #644 | ✅ Merged |
| #639 Spec chip scroll | #643 | ✅ Merged |

## Token/Maliyet Analizi

| Pipeline | AI Calls | Total Tokens | Gerçek Maliyet |
|---|---|---|---|
| Pipeline 1 | 19 | 138,766 | $0.6786 |
| Pipeline 2 | 8 | 41,706 | $0.1973 |
| **Toplam** | **27** | **180,472** | **$0.8759** |

Pipeline 1'in maliyetinin %93'ü iterate loop'ta (8x Proto + 8x Critic) harcandı — skor iyileşmesi sıfıra yakındı.

## Sonuç

En kritik yeni bulgular metrics flush gap (kullanıcıya yanlış maliyet gösterilmesi) ve Haiku JSON parse hatası (yeni failure mode). Her ikisi de ayrı issue olarak açılıp fix'lenmelidir. Iterate loop stagnation'ı AC mapping fix'i (PR #641) ile kısmen çözüldü ama model escalation olmadan Haiku'nun karmaşık AC'leri çözme kapasitesi sınırlı kalabilir.
