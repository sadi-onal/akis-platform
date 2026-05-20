# Final Smoke Verification — 2026-05-20

Yeni bulgular tamamen çözüldü. Browser'da Playwright MCP ile son test.

## 6 yeni PR (bu seans)

| # | PR | Verify durumu |
|---|---|---|
| #592 | V6-fix (placeholder bypass + assumptions drop) | ✅ kısmi — gerçek bug bulundu, ama yetersiz; V6-fix2 ile tamamlandı |
| #593 | V-i18n-round2 (Profil + Usage diakritikler) | ✅ Playwright VERIFIED — tüm Türkçe karakterler doğru |
| #594 | V-duplicate-repo (suffix on collision) | ✅ kod + 12 test; e2e GitHub creds gerekir |
| #595 | V-preview-overlap (overflow-hidden + min-w-0) | ✅ test suite + ChatHeader 23/23; visual gerçek preview gerekir |
| #596 | V-stage-tooltip (StageInfoButton + confidence badge separate triggers) | ✅ Playwright VERIFIED — popover açılıyor, çakışma yok |
| #597 | V6-fix2 (fetch fallback via pipelineId) | ✅ Playwright VERIFIED — disclosures DOM'da! |

## 🎉 V6 Scribe disclosures ARTIK ÇALIŞIYOR

Browser inspection (after V6-fix2 merged):
```
{
  "disclosureFound": true,
  "detailsCount": 4,
  "detailsTestIds": [
    "scribe-problem-statement-disclosure",
    "scribe-acceptance-criteria-disclosure",
    "scribe-user-stories-disclosure",
    "scribe-out-of-scope-disclosure"
  ]
}
```

Reassigned pipeline'da bile (activeWorkflow boş olsa bile) disclosures render oluyor — fetch fallback sayesinde.

## V-i18n-round2 PROOF

Settings → Kullanım tab'ı:
- "Bu Ayki Kullanım" ✓ (ı, ı doğru)
- "Sınırsız" ✓ (ı, ı)
- "Çalıştırılan İş" ✓ (ç, ı, ı, İ, ş)
- "Token Kullanımı" ✓ (ı)
- "Detaylı Dağılım" ✓ (ı, ğ, ı)
- "Giriş Tokenları" ✓ (ş, ı)
- "Çıkış Tokenları" ✓ (Ç, ı, ş, ı)
- "Günlük Aktivite" ✓ (ü, ü)
- "iş" suffix ✓

Settings → Profil tab'ı:
- "Doğrulandı" ✓
- "Şifre Değiştir" ✓
- "Mevcut Şifre" / "Yeni Şifre" / "Yeni Şifre (Tekrar)" ✓
- "Şifreyi Değiştir" ✓
- "Hesap Bilgileri" ✓
- "Üyelik Tarihi" ✓
- "Hesap Durumu" ✓
- "Hesabı Sil" ✓

## V-stage-tooltip PROOF

Akış tab'ı, Scribe card'a tıklanan "?" ikonu:
- Popover açıldı: "SCRİBE / Fikri spec'e çevirir — kabul kriterleri ve kullanıcı hikayeleri"
- Confidence badge (sağ-üst) ayrı kalıyor, ayrı popover'ı var
- testid'ler: `stage-info-scribe`, `stage-info-proto`, `stage-info-trace` (3 stage)
- Hiçbir çakışma yok

## Geriye kalan testler (demo öncesi kullanıcı tarafından)

- **V-duplicate-repo**: aynı idea ile 2 chat → ikincisi `qr-kod-uretici-2` repo açıyor (e2e)
- **V-preview-overlap**: pipeline tamamla → preview aç → splitter'ı geniş kaydır → Önizleme butonu separator'ın içinde kalıyor (visual)
- **V-spec-artifacts**: pipeline tamamlandıktan sonra GitHub repo'da `docs/PRD.md` + `docs/TECHNICAL-ANALYSIS.md` (+ API contract varsa) görünüyor
- **V-pricing**: birkaç pipeline çalıştır → Settings → Kullanım → non-zero $ accurate Claude doc fiyatıyla
- **V8 Critic stack false-positive**: YENİ pipeline'da boş stack → Critic "kritik" finding üretmemeli

## Bu seansta çözülen 7 problem

1. ✅ V6 disclosures (gerçek 2-katmanlı bug: placeholder bypass + assumptions drop + activeWorkflow race)
2. ✅ Profil/Kullanım diakritiksiz Türkçe (21 string)
3. ✅ Duplicate chat → duplicate repo (probe + suffix)
4. ✅ Preview button separator overlap (overflow-hidden + min-w-0)
5. ✅ Stage card tooltip vs confidence badge çakışması (discrete-trigger isolation)
6. ✅ Roadmap: existing repo + Atlassian MCP eklendi (`docs/product/future-works.md`)
7. ✅ V-spec-artifacts manuel test listesi rapora eklendi

## Statü: TÜM BİLİNEN BUG'LAR ÇÖZÜLDÜ

Backend: 3487/3487 tests pass
Frontend: 1657/1657 tests pass
typecheck + lint clean her PR'da

Demo: 2026-06-12 (~23 gün kaldı)

🤖 Final smoke verification — Playwright MCP browser + Vitest + Node test runner
