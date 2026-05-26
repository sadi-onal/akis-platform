# AKIS Product Discovery & Design Pack (PDP)

**Status:** Çalışılan paket — bu klasördeki dosyalar parçalı olarak yazılır ve onaylanır.
**Owner:** Ömer Yasir Önal
**Started:** 2026-05-09
**Locale:** Türkçe (kullanıcı yüzüne çıkan tüm metinler) + İngilizce kod terminolojisi

---

## Bu paket nedir?

AKIS'i "çalışan demo"dan "kullanılabilir, kaliteli, dört başı mamur ürün" konumuna taşıyacak iyileştirme dalgası için yazılan ön-tasarım paketi. Var olan kodu en az değişiklikle hedeflenen niteliğe ulaştırmak için **ürün-yönetim disiplini** uygulanır: önce bulgu, sonra gereksinim, sonra UX, sonra mimari, sonra kalite stratejisi, en son uygulama planı.

**Felsefi temel:** disiplinli ön-tasarım hem kalite hem hız üretir; rework'ten kaçınma yatırımı baştan yapılır.

## Vizyonla bağ

PDP, mevcut belgelerin yerini almaz; **uygulama disiplini** katmanı ekler.

| Mevcut belge | PDP'deki rolü |
|---|---|
| [`docs/THESIS_FOCUS.md`](../THESIS_FOCUS.md) | Kalite-güveni teması — her gereksinim bu filtreden geçer |
| [`docs/PRODUCT_DIRECTION.md`](../PRODUCT_DIRECTION.md) | Bakkal personası + Tier 1/2/3 — gereksinimlerin hedef kitlesi |
| [`docs/AKIS_VISION.md`](../AKIS_VISION.md) | Ürün vizyonu — umbrella tutarlılık |
| [`docs/ARCHITECTURE.md`](../ARCHITECTURE.md) | Mevcut mimari — delta'nın referansı |
| [`docs/TESTING.md`](../TESTING.md) | Mevcut test yaklaşımı — kalite stratejisinin temeli |
| Claude memory: `chat_intent_gaps.md` | Sonraki dalganın iki ürün boşluğu (chat Q&A + intent detection); repo dışında, oturum bağlamı |

## Hedef persona ve scope filtresi

**Birincil persona:** Bakkal — yazılım geliştirici olmayan, kendi işine yönelik küçük yazılım üretmek isteyen kullanıcı. (Detay: `docs/PRODUCT_DIRECTION.md`.)

**Tez bağlamı:** AKIS bir bitirme projesi — kalite-güveni / doğrulama zinciri (Scribe → Critic → Proto → Trace) tezin ekseni. PDP bu eksenden sapmaz.

**Bu pakette scope:**
- ✅ Mevcut akışta kullanıcının yüzüne çarpan UX/UI hataları
- ✅ Akışı tamamlamayı engelleyen ya da güveni sarsan davranışlar
- ✅ Test/QA stratejisi ile kalite kapısı
- ✅ "Chat Q&A" ve "intent detection" boşluklarının ürün boyutunda tanımı (uygulama bu PDP içinde değil, sonraki PDP dalgasında)

**Bu pakette out-of-scope:**
- Yeni satıcı/AI sağlayıcı entegrasyonu (mevcut anthropic + mock + openrouter yeter)
- Tez yazımı (sonra, ürün şekillenince)
- Dağıtım/billing (prod dormant — `docs/ops/`)
- Mobil uygulama (web yeter)

## Paket içeriği

**Sıralama mantığı:** Önce hedef hâl (vision → requirements → ux → architecture → quality), sonra mevcut kod ile hedef arasındaki gap (findings), en son uygulama planı (roadmap). Findings reaktif "ne kırık" listesi değil, hedef hâle göre yapılan **gap analizi** olarak konumlanır; bu yüzden quality'den sonra gelir.

| # | Dosya | İçerik | Durum |
|---|---|---|---|
| 00 | [`README.md`](./00-README.md) | Bu dosya — umbrella | ✍️ Taslak |
| 01 | [`requirements.md`](./01-requirements.md) | Functional + non-functional gereksinimler | ✅ 2026-05-09 |
| 02 | [`ux.md`](./02-ux.md) | User flows + UI wireframes + state diagrams | ✅ 2026-05-10 |
| 03 | [`architecture.md`](./03-architecture.md) | Component/sequence diagramlar + delta planı | ✍️ Taslak |
| 04 | [`quality.md`](./04-quality.md) | Test piramidi + kabul kriterleri + CI gate'leri | ✍️ Taslak |
| 05 | [`findings.md`](./05-findings.md) | Gap analizi: mevcut kod vs hedef hâl + yokluk-gap'leri | ✍️ Taslak (revize) |
| 06 | [`roadmap.md`](./06-roadmap.md) | Sıralanmış uygulama planı (5 wave) | ✍️ Taslak |
| 07 | [`documentation-inventory.md`](./07-documentation-inventory.md) | Canonical dokümantasyon envanteri + gap matrisi | ✍️ Taslak |

✍️ Taslak · ⏳ Bekliyor · ✅ Onaylandı

## Süreç

1. **Her dosya bağımsız onay alır.** Onay bekliyorken sonraki dosya yazılmaz.
2. Onay sonrası `Onay: 2026-XX-YY` etiketi dosyanın başına eklenir, durum tablosu güncellenir.
3. **06-roadmap.md** üretildikten sonra `writing-plans` skill devreye girer, oradan implementation döngüsüne geçilir.
4. Her uygulama döngüsü kendi spec'ine bağlı; spec'ler sürüm aldıkça PDP güncellenir.

## Kayıt

- Tüm bulgular, kararlar ve revizyonlar bu klasörde işlenir.
- Karar değişikliklerinde dosyaya `## Revizyon notları` bölümü eklenir, eski karar **silinmez**, üstü çizilir + yeni karar yazılır.
- Sözel onaylar PR mesajına da yansıtılır (commit history audit).

---

## Kabul kriterleri (umbrella)

- [ ] PDP'nin ana dosyaları yazılmış ve onaylanmış
- [ ] Her doc kabul kriterleri içeriyor ve `quality.md` ile çapraz referansı var
- [ ] `06-roadmap.md` writing-plans skill'inin ürettiği detaylı planı içeriyor
- [ ] Mevcut belgeler (`THESIS_FOCUS`, `PRODUCT_DIRECTION`, `ARCHITECTURE`, `TESTING`) PDP içeriğiyle çelişmiyor; çelişki varsa ilgili belgeye revizyon notu düşülmüş
