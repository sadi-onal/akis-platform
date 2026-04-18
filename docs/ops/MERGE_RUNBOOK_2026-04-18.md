# Merge Runbook — 15 Açık PR (2026-04-18 itibarıyla)

**Amaç:** Review sırasındaki karar yükünü azaltmak. Bu belge 15 açık PR'ı risk / bağımlılık sırasına göre listeler, her biri için "merge öncesi bir şey gözden kaçırdın mı?" kontrol listesi verir.

## Hızlı Özet

| Kategori | Sayı | Aksiyon |
|---|---|---|
| Merge edilmiş wave-1 | 7 | ✅ Canlı (`d69f645`) |
| **Low-risk, merge-ready** | **10** | **Batch merge + auto-deploy** |
| **High-risk, user confirm şart** | **4** | **Tek tek merge + her birinden sonra Chrome smoke** |
| **Toplam canlı olmayan** | **14** | (bu runbook içerik) |

## Önerilen Merge Sırası

### Grup A — Documentation + Testing (4 PR, zero code risk)
Sırayla merge, sonra devam:

1. [#411](https://github.com/OmerYasirOnal/akis-platform-devolopment/pull/411) — `docs(claude): PR review + Chrome smoke-test automation loop rule`
   - Sadece CLAUDE.md güncellemesi. Runtime etkisi yok.
   - **Check:** `git diff main origin/docs/auto-pr-chrome-test-rule -- CLAUDE.md` içinde kullanıcıya zorluk çıkaracak bir rule var mı?
2. [#412](https://github.com/OmerYasirOnal/akis-platform-devolopment/pull/412) — `test(e2e): prod smoke tests suite`
   - Sadece `frontend/tests/e2e/prod-smoke/` ekliyor. Playwright testleri, mevcut davranışa dokunmaz.
   - **Check:** tests/e2e/prod-smoke altındaki dosya sayısı beklendiği gibi mi (6 spec + 1 README)?
3. [#413](https://github.com/OmerYasirOnal/akis-platform-devolopment/pull/413) — `docs(ops): smoke report + bug log (force-add)`
   - `docs/ops/` `.gitignore`'lu ama force-add ile iki dosya ekliyor.
   - **Check:** Bu iki dosyanın kalıcı olarak repo'da kalmasını istiyor musun? (wave-1 smoke + bug log — evet, iki artefakt hep referans verilecek)
4. [#415](https://github.com/OmerYasirOnal/akis-platform-devolopment/pull/415) — `docs(claude): trailer 4.6 → 4.7`
   - CLAUDE.md tek satır değişiklik, co-author bilgisi güncel.

**Grup A için tahmini toplam merge süresi:** ~3 dakika. Deploy tetiklenmez (sadece docs) ama CI çalışır.

---

### Grup B — UI Polish + Narration (3 PR, bağımsız, düşük risk)
Sırayla merge, her merge sonrası deploy bekle (3 dk) + Chrome'dan bak:

5. [#414](https://github.com/OmerYasirOnal/akis-platform-devolopment/pull/414) — `feat(chat): Claude-Code-style Background Agent lines (#390 MVP)`
   - Yeni `AgentStartedLine` komponenti + ChatMessage union genişletme. Görsel sadece.
   - **Smoke check (merge + deploy sonra):** `/chat/<existing-pipeline-id>` → timeline'da "Background agent started [Scribe|Proto|Trace]" satırları görünür mü?

---

### Grup C — Multimodal Stack (4 PR, **sıra önemli**, stacked)
**MUTLAKA bu sırada merge:** #416 → #417 → #418 → #419. Her biri bir öncekinin commit'lerini içerir; sıra bozulursa conflict.

6. [#416](https://github.com/OmerYasirOnal/akis-platform-devolopment/pull/416) — `feat(ai): multimodal Anthropic client helper`
   - Yeni `multimodalClient.ts`. Bağımsız, kimseyi etkilemez. 11 unit test.
7. [#417](https://github.com/OmerYasirOnal/akis-platform-devolopment/pull/417) — `feat(scribe): wire multimodal into ScribeAIDeps`
   - Opsiyonel interface değişiklikleri. Kimse henüz çağırmıyor, dead path.
8. [#418](https://github.com/OmerYasirOnal/akis-platform-devolopment/pull/418) — `feat(ai): RealAIService.generateMultimodalArtifact`
   - AIService class'ına method ekler. Provider `anthropic` değilse guard'la hata fırlatır.
9. [#419](https://github.com/OmerYasirOnal/akis-platform-devolopment/pull/419) — `feat(pipeline): thread image blocks through plugin → Scribe (final)`
   - pipeline.plugin → ScribeState wire-up. Son hareket; image upload'u canlı eder.

**Smoke check (4'ü merge + deploy sonra):** `/chat` → yeni sohbet → resim + prompt at → Scribe ilk cevapta görselin içeriğine atıf yapıyor mu (filename'den fazlası)?

---

### Grup D — Jira Failure Wiring (2 PR, stacked)
Yine sıra önemli: #420 → #421.

10. [#420](https://github.com/OmerYasirOnal/akis-platform-devolopment/pull/420) — `feat(jira): commentJiraWithFailure helper`
    - Yeni helper fonksiyon + 6 test. Kimse çağırmıyor.
11. [#421](https://github.com/OmerYasirOnal/akis-platform-devolopment/pull/421) — `feat(orchestrator): failPipeline → Jira failure comment`
    - failPipeline artık Jira Epic'e yorum düşer. Atlassian OAuth bağlı değilse sessiz.

**Smoke check (2'si merge + deploy sonra):** Atlassian OAuth bağlı test hesabıyla Proto'yu kasıtlı fail ettir → Epic'te "AKIS pipeline failed" yorumu var mı?

---

### Grup E — HIGH-RISK (4 PR, kullanıcı onayı zorunlu)
**Her biri merge + deploy + smoke test döngüsü.** Toplu merge YAPMA.

12. [#401](https://github.com/OmerYasirOnal/akis-platform-devolopment/pull/401) — `fix(billing): admin unlimited + counter coherence`
    - **Risk:** Billing logic, admin UI. Her admin hesabı etkilenir.
    - **Rebase:** Zaten #409 ile conflict'te idi, rebased + force-pushed.
    - **Smoke (deploy sonra):** `/settings?tab=plan` + `/settings?tab=usage` → ∞ görünüyor + kırmızı bar yok (admin hesap).
    - **Geri alma planı:** Revert edilebilir, migration yok.
13. [#399](https://github.com/OmerYasirOnal/akis-platform-devolopment/pull/399) — `fix(auth): unify GitHub token storage`
    - **Risk:** Auth katmanı. `getGitHubToken` tek kaynağa dönüştürülüyor.
    - **Schema impact:** `users.githubToken` kolonu okuma fallback'inde kalıyor, silinmiyor. Veri kaybı YOK.
    - **Smoke:** GitHub OAuth ile login → banner kaybolur + `/engineer` repo listesi gelir.
    - **Geri alma planı:** Revert güvenli.
14. [#403](https://github.com/OmerYasirOnal/akis-platform-devolopment/pull/403) — `fix(multimodal): force image ack`
    - **Risk:** Scribe prompt'una instruction block ekler. Token kullanımı artabilir.
    - **Not:** Grup C ile birlikte en iyi deneyimi verir (ack + pixel).
    - **Smoke:** Resim upload → Scribe "X gördüm" ack mesajı atar.
15. [#400](https://github.com/OmerYasirOnal/akis-platform-devolopment/pull/400) — `fix(chat): iteration stays in same chat`
    - **Risk:** Orchestrator + frontend birlikte. Pipeline ilişkileri değişir.
    - **Review notları:** Code reviewer 4 issue flaglamıştı — tümü fix edildi (exponential backoff, 15 min cutoff, unmount cleanup, response type).
    - **Smoke:** Complete bir chat'ten "tema değiştir" iterasyon → URL değişmez + sidebar tek entry.
    - **Geri alma planı:** Revert, backend schema etkilenmez.

---

## Sıra Özeti (önerilen)

```
Grup A (#411 + #412 + #413 + #415) — tek batch, 3 dakika
     ↓
Grup B (#414) — merge + deploy (3 dk) + chat smoke
     ↓
Grup C multimodal stack (#416 → #417 → #418 → #419) — sırayla merge, 4. sonrasında tek deploy + image upload smoke
     ↓
Grup D (#420 → #421) — sırayla merge, Jira opsiyonel
     ↓
Grup E high-risk (#401 → #399 → #403 → #400)
     — her biri merge + deploy bekle + Chrome smoke + kısa rapor
     — 4 PR'ı aynı güne sığdırmak 1.5-2 saat alır
```

## Paralel Görevler (merge dışı)

- [#385 avatar upload](https://github.com/OmerYasirOnal/akis-platform-devolopment/issues/385) — başlatılmadı, ~4 saat scope (backend migration + storage + frontend)
- #397 Cucumber verify — live pipeline doğrulaması, sonraki sprint

## Hızlı Komutlar

Tüm gruplar için CI kontrol:
```bash
for pr in 411 412 413 414 415 416 417 418 419 420 421 401 399 403 400; do
  gh pr checks $pr --repo OmerYasirOnal/akis-platform-devolopment 2>&1 | awk '{print $2}' | sort -u | tr '\n' ',' | sed 's/,$//;s/^/#'$pr': /' | head -1
  echo
done
```

Grup A batch merge:
```bash
for pr in 411 412 413 415; do
  gh pr merge $pr --repo OmerYasirOnal/akis-platform-devolopment --squash --delete-branch
done
```

Deploy sağlık kontrolü:
```bash
curl -sS https://akisflow.com/version | python3 -m json.tool
```

---

Oluşturan: Claude Code oturumu, 12. /loop tick — bu runbook `docs/ops/` altında kalıcı referans.
