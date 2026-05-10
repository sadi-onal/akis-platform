# 01 — Gereksinim Tanımı (Requirements)

**Status:** ✅ Onaylandı — 2026-05-09 (kullanıcı sözel onayı + revizyonlar uygulandı)
**Önceki bağlam:** [`00-README.md`](./00-README.md)
**Kapsam:** Bakkal akışı + chat Q&A + intent detection. Auxiliary ekranlar (settings, integrations, dashboard) bu PDP'de tanımlanmaz, mevcut hâlleriyle kalır.

> **Yazım disiplini:** Her gereksinim ölçülebilir. FR'ler "neyi yapar", NFR'ler "ne kalitede yapar" sorusuna cevap. Her gereksinim ID'lidir; `04-quality.md` test stratejisini bu ID'lerden türetir, `05-findings.md` bu ID'lerle gap analizine bağlanır.

---

## 1. Persona ve değer önerisi

**Bakkal:** yazılım geliştirici olmayan, dijital yetkinliği orta seviye, kendi işine yönelik küçük yazılım üretmek isteyen kullanıcı. Tipik kullanım sırası:
1. AKIS'e fikrini yazar (1-2 cümle)
2. AKIS'in sorularını cevaplar (Likert/multiple choice)
3. Üretilen plan'ı görür, onaylar
4. Sonuç: çalıştırılmaya hazır kod + testler + dokümantasyon. **Çalışma yeri tek seçeneğe kilitli değil:**
   - **Kendi bilgisayarında** — `install.sh` / `setup.sh` ve adım adım Türkçe README ile tek komutla başlatılabilir
   - **Bir sunucuda** — opsiyonel `Dockerfile` + `docker-compose.yml` ile kuruluma hazır
   - **GitHub deposunda** — kullanıcının kendi adına açılan repo'da kayıtlı (default kayıt yeri, çalışma yeri değil)

**Değer önerisi (THESIS_FOCUS bağlı):** Bakkal "AI bana yazılım yazsın" diyebileceği başka araçlar var; AKIS'in farkı **kalite-güveni** — her aşamada Critic'in adversarial review'ı + Trace'in test/coverage çıktısı + Regression report ile **"bu çalışır mı, gerçekten?"** sorusu kanıtlanmış olarak cevaplanır.

---

## 2. Functional Requirements (FR)

### FR-1 — Hesap & Kimlik

| ID | Gereksinim | Kabul kriterleri |
|---|---|---|
| FR-1.1 | Email + parola ile signup | Email format kontrolü; parola ≥ 8 karakter; doğrulama mail (prod) / DB-active (dev) |
| FR-1.2 | Email + parola ile login | Yanlış girişte spesifik hata mesajı; rate limit |
| FR-1.3 | Google sosyal login | OAuth flow, mevcut entegrasyon korunur |
| FR-1.4 | GitHub sosyal login | OAuth flow, mevcut entegrasyon korunur |
| FR-1.5 | Logout | Cookie/session temizliği; sidebar/state reset |

### FR-2 — Onboarding & GitHub bağlantısı

| ID | Gereksinim | Kabul kriterleri |
|---|---|---|
| FR-2.1 | İlk girişte sohbet ekranına yönlendirme | `/chat` rotası; modal yok (eski upfront modal kaldırıldı) |
| FR-2.2 | JIT GitHub gate — fikri yaz, gönder, GitHub bağlı değilse gate açılır | Fikir sessionStorage'da korunur; gate Türkçe + 3 izin bullet'ı + fikri quote'lu gösterir |
| FR-2.3 | OAuth dönüşü sonrası fikir auto-resume | `?github=connected` paramı + toast + pipeline otomatik tetiklenir; kullanıcı tekrar fikri yazmaz |
| FR-2.4 | "Vazgeç" — gate kapanır, pipeline tetiklenmez | sessionStorage temizlenir; kullanıcı `/chat` boş hâline döner |
| FR-2.5 | Settings → Integrations'tan kalıcı bağlama/koparma | Mevcut sayfa korunur, JIT gate ile çelişmez |

### FR-3 — Scribe (fikir → spec)

| ID | Gereksinim | Kabul kriterleri |
|---|---|---|
| FR-3.1 | Fikri analiz eder; belirsizse 3-5 multiple-choice clarification sorusu üretir | Sorular Türkçe; her soruda gerekçe + 3-4 seçenek |
| FR-3.2 | Cevap sayacı anlık | Seçim yapılınca sayaç güncellenir, "ileri" zorunlu değil |
| FR-3.3 | Tüm cevaplar alınınca structured spec üretir | userStories[], problemStatement, technicalConstraints |
| FR-3.4 | Spec'ten human-readable plan card oluşur | Özellikler listesi + teknik seçimler + tahmini dosya sayısı + test bayrağı |
| FR-3.5 | Plan card status: `active` (kullanıcı henüz onaylamadı) | `critic_reviewing_spec` aşamasında bile `active` kalır |

### FR-4 — Critic (adversarial review)

| ID | Gereksinim | Kabul kriterleri |
|---|---|---|
| FR-4.1 | Spec'i 6 boyutta inceler: completeness, ambiguity, testability, consistency, spec_compliance, security | Her boyut için skor + finding listesi |
| FR-4.2 | Critic running olduğunda UI'da "Critic" kimliği görünür | Rose accent (cinema rose ring + "Critic" label, "Scribe" değil) |
| FR-4.3 | Critic onaylasa bile plan card kullanıcı onayı bekler | Onayla/İptal butonları görünür kalır |
| FR-4.4 | Findings kullanıcıya gösterilir (Açıklama tab) | Severity chip + category icon + Türkçe açıklama + öneri |
| FR-4.5 | Code review (Proto sonrası) aynı 6-boyut review | Proto output'u için ayrı findings seti |

### FR-5 — Onay & geri bildirim

| ID | Gereksinim | Kabul kriterleri |
|---|---|---|
| FR-5.1 | Onayla butonu → spec approved → Proto tetiklenir | Çift-tıklama koruması (in-flight ref) |
| FR-5.2 | İptal butonu → spec rejected → kullanıcı revize edebilir | Spec versiyon arttırılır, Scribe revise tetiklenir |
| FR-5.3 | Düzeltme isteği — kullanıcı clarification veya plan'a yazabilir | Notlar Scribe'a iletilir, yeni spec versiyonu üretilir |

### FR-6 — Proto (spec → kod)

| ID | Gereksinim | Kabul kriterleri |
|---|---|---|
| FR-6.1 | Yeni GitHub deposu açar (kullanıcı adına, OAuth token ile) | Repo isimlendirme: spec title'dan sanitize |
| FR-6.2 | Scaffold dosyalarını push eder | Asgari: package.json, README, src/ klasörü |
| FR-6.3 | Branch yapısı: `main` + ilk PR opsiyonel | Mevcut akış korunur |
| FR-6.4 | Hata durumunda kullanıcıya bakkal-dilinde mesaj | "Depo açılamadı" + tekrar dene butonu |
| FR-6.5 | Scaffold'a otomatik **`install.sh`** (veya stack'e uygun `setup.sh`) eklenir | Tek komutla bağımlılıklar kurulur + dev sunucusu başlar; macOS + Linux + WSL test edilir |
| FR-6.6 | Scaffold'a Türkçe **README — "Kendi bilgisayarında çalıştır"** ve **"Sunucuya kur"** bölümleri eklenir | Bakkal-language adımlar; her komut yorumlu ("bu komut şunu yapar") |
| FR-6.7 | Stack uygunsa **`Dockerfile` + `docker-compose.yml`** üretilir (opsiyonel, kullanıcı seçimine bağlı) | Compose tek komutla ayağa kalkar; default değer "üret" — bakkal "istemiyorum" demediği sürece üretilir |
| FR-6.8 | Scaffold'da **çevresel değişken örneği** (`.env.example`) ve **port/secret yönergesi** | README'de "şu portu açın", "bu secret'ı şuradan alın" yönlendirmesi |

### FR-7 — Trace (kod → test)

| ID | Gereksinim | Kabul kriterleri |
|---|---|---|
| FR-7.1 | Spec acceptance criteria'larından BDD/Gherkin senaryolar üretir | feature dosyaları + scenario sayısı |
| FR-7.2 | Playwright e2e testleri yazar | Repo'ya commit |
| FR-7.3 | Coverage matrix üretir (criteria → test eşleşmesi) | covered + uncovered listeleri |
| FR-7.4 | Trace skip edilebilir (kullanıcı opsiyonu) | Toggle UI; pipeline `completed_partial` ile biter |

### FR-8 — Pipeline detayı (rail)

| ID | Gereksinim | Kabul kriterleri |
|---|---|---|
| FR-8.1 | "Akış" sekmesi — 4-kolon cinema (Scribe / Critic / Proto / Trace) | Her stage: pending / active / complete state |
| FR-8.2 | "Açıklama" sekmesi — per-stage AgentReasoning kartları | Decision + reasoning + assumptions + confidence + findings |
| FR-8.3 | "Regresyon" sekmesi — iteration confidence report | Baseline coverage + files changed + fix loop runs + bakkalSummary |
| FR-8.4 | Tüm sekmeler kullanıcı tarafından scroll edilebilir | Rail body içinde dikey scroll, viewport'tan taşmaz |
| FR-8.5 | Rail collapsed hâlinde mini stage dots | 4 nokta, renkli + state'e göre pulse |
| FR-8.6 | Pipeline tamamlandığında rail erişilebilir kalır | "completed + zero activities" durumunda rail tab'larıyla render edilir |

### FR-9 — İterasyon

| ID | Gereksinim | Kabul kriterleri |
|---|---|---|
| FR-9.1 | Tamamlanmış pipeline'a yeni mesaj → child pipeline | Parent referansı korunur, sidebar'da ayrı entry açılmaz |
| FR-9.2 | Child Proto mevcut repo üzerinde çalışır | Skip Scribe; mevcut branch'e değişiklik |
| FR-9.3 | Regression report otomatik üretilir | Baseline'a göre files changed + test summary |
| FR-9.4 | İterasyon içinde scribe_clarifying tetiklenebilir — **opsiyonel, default kapalı** (PDP-2'de kullanıcı feedback'i ile karar) | İstek belirsizse Scribe sorabilir, ama varsayılan davranış doğrudan Proto'ya geçmek; bayrak: `iteration.requireClarification` |

### FR-10 — Chat Q&A *(yeni feature)*

| ID | Gereksinim | Kabul kriterleri |
|---|---|---|
| FR-10.1 | Pipeline tamamlandıktan veya tetiklenmeden önce kullanıcı serbest soru sorabilir | "Bu kod ne yapıyor?", "Critic neden bu finding'i yazdı?" |
| FR-10.2 | Sorular conversation'a yazılır, pipeline tetiklenmez | Yanıt agent_message tipinde, mevcut UI ile |
| FR-10.3 | Yanıt RAG ile zenginleştirilir | Spec, Proto kodu, findings, regression report context'e eklenir |
| FR-10.4 | "Bu sorunun cevabı pipeline gerektirir" durumunda kullanıcıya öneri | "Bu yeni bir özellik gibi duruyor, build mi edelim?" |

### FR-11 — Intent detection *(yeni feature)*

| ID | Gereksinim | Kabul kriterleri |
|---|---|---|
| FR-11.1 | Her kullanıcı mesajı 4 sınıftan birine ayrılır: **BUILD** (yeni özellik), **ASK** (soru), **FEEDBACK** (mevcut çıktı hakkında geribildirim), **CHAT** (genel sohbet) | Sınıflandırma confidence ≥ 0.7 |
| FR-11.2 | Sınıflandırmaya göre uygun handler tetiklenir | BUILD → iteration pipeline; ASK → FR-10; FEEDBACK → log + agent_message; CHAT → conversational response |
| FR-11.3 | Confidence < 0.7 ise kullanıcıya disambiguation | "Bunu yapmamı mı, anlatmamı mı, geribildirim mi olarak almamı mı istiyorsun?" 3-4 seçenek |
| FR-11.4 | Intent detection mevcut "iteration mode" yerini alır | Eski "completed → yeni mesaj → child pipeline" akışı BUILD intent'in özel hâli |

### FR-12 — Sohbet yönetimi

| ID | Gereksinim | Kabul kriterleri |
|---|---|---|
| FR-12.1 | Sidebar — sohbet listesi (status: idle / running / awaiting_approval / error) | Status dot + son aktivite zamanı |
| FR-12.2 | Sohbetler arası geçiş — içerik kayıpsız yüklenir | "Yeni Sohbet" sonrası eski sohbete dönünce mesajlar görünür (F-01 fix gereklilik) |
| FR-12.3 | Sohbet yeniden adlandırma | Inline edit, optimistic update |
| FR-12.4 | Sohbet iptal/silme | Cancel running + delete from sidebar |
| FR-12.5 | Sohbet arama (Ctrl+K) | Mevcut özellik korunur |
| FR-12.6 | Yeni sohbet (Ctrl+Shift+N) | Mevcut özellik korunur |

---

## 3. Non-Functional Requirements (NFR)

### NFR-1 — Kalite-güveni kalıcılığı *(tezin core promise'ı)*

| ID | Gereksinim | Hedef | Ölçüm |
|---|---|---|---|
| NFR-1.1 | Reasoning + activities + regression DB'de kalıcı | Backend restart sonrası **%100** geri gelme | `/api/pipelines/:id/explanation` 200 + non-empty stages |
| NFR-1.2 | Backfill stratejisi var olan completed pipeline'lar için tanımlı | Eski kayıtlar UI'da bayraklı ("eski oturumda tamamlandı") | Migration covers backfill |
| NFR-1.3 | Findings + confidence skorları audit trail olarak korunur — kullanıcı **arşivleyebilir** ama hard-delete yok | Soft-delete only; arşivlenenler default UI'da gizli, "Arşiv" filtresinden erişilir | DB `archived_at` kolonu + foreign-key cascade soft |

### NFR-2 — Hata kurtarma (resilience)

| ID | Gereksinim | Hedef | Ölçüm |
|---|---|---|---|
| NFR-2.1 | AI provider 5xx → otomatik retry | 3 deneme, exponential backoff | Backend test |
| NFR-2.2 | Network drop → polling backoff + UI toast | Toast "Bağlantı koptu... yeniden deneniyor" | Frontend test (mock fetch fail) |
| NFR-2.3 | Backend restart → SSE reconnect, polling fallback | < 5s görsel iyileşme | Manuel smoke |
| NFR-2.4 | GitHub push fail → kullanıcıya bakkal-dilinde mesaj + retry | Stack trace gözükmez | i18n catalogue + retry button |
| NFR-2.5 | Pipeline cancel — temiz durdurma | DB durumu `cancelled`, sidebar update | Backend integration test |

### NFR-3 — Performans

| ID | Gereksinim | Hedef | Ölçüm |
|---|---|---|---|
| NFR-3.1 | TTI (Time to Interactive) | < 2s on dev hardware (M-series Mac, Chrome) | Lighthouse |
| NFR-3.2 | Sohbet geçişi (cached state) | < 200ms | Manual + perf marker |
| NFR-3.3 | Pipeline status polling | 5s (interactive), 8s (SSE down), 20s (SSE up) | Mevcut, korunur |
| NFR-3.4 | AI streaming first byte | < 3s | Backend latency log |
| NFR-3.5 | Lighthouse Performance | ≥ 80 | CI gate |

### NFR-4 — Erişilebilirlik (a11y)

| ID | Gereksinim | Hedef | Ölçüm |
|---|---|---|---|
| NFR-4.1 | Klavye navigasyonu — tüm aksiyonlar Tab/Enter/Esc ile | %100 ekranlar | Manuel klavye smoke |
| NFR-4.2 | ARIA — tab/region/dialog/alert rolleri | axe-core 0 critical/serious | Lighthouse + axe |
| NFR-4.3 | Kontrast — WCAG AA (4.5:1 metin / 3:1 büyük) | %100 ak-* tokenları | Tasarım tokens audit |
| NFR-4.4 | `prefers-reduced-motion` respect | Animasyonlar opsiyonel | CSS audit |
| NFR-4.5 | Ekran okuyucu uyumlu | NVDA/VoiceOver smoke | Manuel |

### NFR-5 — Usability *(bakkal lensi)*

| ID | Gereksinim | Hedef | Ölçüm |
|---|---|---|---|
| NFR-5.1 | Türkçe dil tutarlı + bakkal-language | Tech jargonu yok ("repo" → "depo", "PR" → "değişiklik teklifi") | i18n catalogue review |
| NFR-5.2 | Hata mesajları açık + yönlendirici | "Şunu denenebilir" formatında | Manuel review (her hata yolu) |
| NFR-5.3 | Mode badge ya net açıklamalı ya yok | Hover tooltip veya kaldır (F-05) | UX karar 02-ux'te |
| NFR-5.4 | **5-dakika oturumu olarak tasarlanan kullanıcı testi**: bir bakkal-personası kişi, AKIS'e ilk kez giriyor, tek bir küçük fikir veriyor (örn. "veresiye defteri") ve 5 dakika içinde plan'ı onaylama noktasına gelmiş olmalı | Yardım talebi (gözlemciden açıklama isteme) ≤ 2 — yani kullanıcı 3'ten fazla noktada takılırsa NFR ihlali. Test Q2 self-pilot v2 protokolünde yürütülür: gözlemci sessiz, kullanıcı sesli düşünüyor (`think-aloud`), takıldıkça not alınır. | Q2 form + ekran kayıtları (`docs/dogfooding/usability-2026-XX/`) |
| NFR-5.5 | İlk-kullanım onboarding gürültüsüz | Modal yok, JIT gate doğru anda | Mevcut JIT akış korunur |

### NFR-6 — i18n

| ID | Gereksinim | Hedef | Ölçüm |
|---|---|---|---|
| NFR-6.1 | TR + EN katalogları senkron | Missing-key 0 | Vitest i18n test |
| NFR-6.2 | Pipeline activity event'leri i18n key kullanır | Backend → frontend t() | Mevcut, korunur |

---

## 4. Out-of-scope (PDP-2 dalgası)

Bu PDP'de **tanımlanmaz**, mevcut hâlleri korunur veya başka dalgada ele alınır:

- **Mobil uygulama** — web yeter (responsive desteklenir, native değil)
- **Çoklu kullanıcı kolaborasyonu** — tek-tenant, tek-kullanıcı
- **Billing / subscription** — production zaten dormant
- **Production deploy & ops** — manuel, başka runbook (`docs/ops/`)
- **Settings sekmesi içerikleri** — mevcut hâliyle korunur, yeniden tasarlanmaz
- **Dashboard ekranı** — mevcut hâliyle, yeni metrikler eklenmez
- **Knowledge base UI** — mevcut sayfalar korunur

---

## 5. Cross-references

| Bağlantı | Açıklama |
|---|---|
| [`docs/THESIS_FOCUS.md`](../THESIS_FOCUS.md) | NFR-1'in kaynağı: kalite-güveni tezi |
| [`docs/PRODUCT_DIRECTION.md`](../PRODUCT_DIRECTION.md) | Personanın FR'larla bağı (bakkal Tier 1) |
| [`docs/AKIS_VISION.md`](../AKIS_VISION.md) | Vizyon umbrella |
| `02-ux.md` (yazılacak) | FR-3 ila FR-12'nin görsel akışı + UML state diagrams |
| `03-architecture.md` (yazılacak) | NFR-1 (persistence) + FR-10/11 (chat + intent) için mimari değişiklik |
| `04-quality.md` (yazılacak) | Her FR/NFR için test planı |
| `05-findings.md` | Mevcut kod ile bu hedef hâl arasındaki gap |

---

## 6. Kabul kriterleri (bu doc için)

- [x] Persona ve değer önerisi senin gözünden doğru — *çalışma yeri tek-seçeneğe kilitli değil revizyonu uygulandı*
- [x] Tüm FR'ler kapsam açısından eksiksiz
- [x] FR-10 (chat Q&A) ve FR-11 (intent detection) kapsamı net (ana feature listesi)
- [x] NFR-1..6 hedef sayıları/kriterleri uygun
- [x] Out-of-scope listesi anlaşmaya uygun
- [x] Adlandırma + dil tutarlı

---

## 7. Onay & revizyon notları

| Tarih | Değişiklik | Sebep |
|---|---|---|
| 2026-05-09 | İlk taslak yazıldı | PDP-2 başlangıç |
| 2026-05-09 | Persona değer önerisi: GitHub tek-seçenek olmaktan çıkarıldı; lokal + sunucu + GitHub üçü de tanımlı çıktı yeri | Kullanıcı: "github'tan çalıştırmak tek seçenek olmamalı" |
| 2026-05-09 | FR-6.5..6.8 eklendi (`install.sh`, README "Kendi bilgisayarında çalıştır" + "Sunucuya kur", opsiyonel Dockerfile, .env.example) | Aynı revizyon — scaffold çıktısının taşınabilirliği |
| 2026-05-09 | NFR-1.3 "hard-delete yok" → "soft-delete + arşivleme" olarak yumuşatıldı | Kullanıcı: kararı bana bıraktı, kalıcılık + bakkal-friendly arşivleme dengesi |
| 2026-05-09 | NFR-5.4 daha açıklayıcı yazıldı (think-aloud protokolü, ≤ 2 yardım talebi tanımı) | Kullanıcı: "biraz daha açıklayıcı yazarsan bunları iyi olur" |
| 2026-05-09 | FR-9.4 opsiyonel + default kapalı netleştirildi | Kullanıcı: "opsiyonel kalabilir şimdilik" |

---

## 8. Sonraki adım

**02-ux.md**: bu FR'ların kullanıcı yaşadığı akış halinde anlatımı + UML state/activity diagram'ları + ekran wireframe'leri. Visual Companion önerisi 02 yazımında ayrı mesajla yapılacak (mockup'lara geldiğimizde).
