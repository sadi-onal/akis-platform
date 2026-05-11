# Backend Prompts — Bakkal-Language Audit (F-12 Faz 3)

**Tarih:** 2026-05-11
**Kapsam:** Backend prompt + agent dosyaları (`backend/src/pipeline/agents/{scribe,critic,proto,trace,skills,repo-context}/`, `backend/src/services/ai/`).
**Yöntem:** `node scripts/lint/bakkal-language.mjs --all` (F-12 Faz 1'den) + manuel sınıflandırma.
**Önceki fazlar:** [PR #523 — Faz 1 (script + i18n top fixes)](https://github.com/OmerYasirOnal/akis-platform/pull/523), [PR #524 — Faz 2 (TR identical entries + sync detection)](https://github.com/OmerYasirOnal/akis-platform/pull/524).

**Script değişikliği (Faz 3):** `discoverFiles()` `--all` modu artık `backend/src/services/ai/` dizinini de tarıyor. Önceki fazda yalnızca `backend/src/pipeline/{templates,agents}` ve `backend/src/agents` taranıyordu; sistem prompt builder'ları (`prompt-constants.ts`, `AIService.ts`) kapsama girmemişti.

---

## 1. Özet

| Metrik | Sayı |
|---|---:|
| Taranan dosya (frontend + backend, `services/ai` dahil) | 131 |
| Backend dosyaları (warning üreten, ilk geçiş) | 6 |
| Backend bulgular (ilk geçiş, `services/ai` öncesi) | 59 (warn 36, info 23) |
| AI-facing (model'e gönderilen prompt) — **dokunulmadı** | 23 |
| User-facing (aktivite akışına / depo dosyalarına / değişiklik teklifi gövdesine giden) — **düzeltildi** | 20 |
| False positive (`Array.prototype.push`, JS değişken, doc-comment) — **opt-out yapıldı** | 16 |
| Backend warning kalan | **0** |
| Backend info kalan (kasıtlı + zayıf eşleşme) | 25 |

Backend **hiç warning üretmiyor** artık — `bakkal-language.mjs` `--all` sıfır warn ile yeşil. Frontend'deki 33 warning bu fazın kapsamı dışında (Faz 1'in info-level bıraktıkları).

---

## 2. Sınıflandırma — User-facing vs AI-facing

Backend prompt dosyaları iki tür string içerir:

- **AI-facing**: Modele gönderilen sistem promptları, kullanıcı promptu inşası, skill `.md` dosyaları, Critic adversarial review prompt'ları. Bu metinler doğrudan kullanıcıya gösterilmez. İngilizce / teknik vokabüler korundu — model bu kelimelerle daha iyi performans veriyor.
- **User-facing**: `emit?.()` çağrılarının `message` argümanı (aktivite akışına gider, `ActivityLog.tsx:77` `{activity.message}` olarak render edilir), `buildPRBody()` çıktısı (GitHub PR açıklaması — kullanıcı GitHub'da okur), `ScaffoldEnricher` README/Dockerfile/.env.example içerikleri (üretilen depoda kullanıcı görür).

### 2.1 AI-facing — dokunulmadı

| Dosya | Neden korundu |
|---|---|
| `backend/src/pipeline/agents/critic/prompts/code-review.ts` | Critic'in adversarial review system prompt'u. İngilizce bilinçli — modelin kalitesi düşmesin. Output Türkçe (zaten prompt içinde dayatıyor). |
| `backend/src/pipeline/agents/critic/prompts/spec-review.ts` | Yukarıdakinin aynısı (spec review için). |
| `backend/src/pipeline/agents/scribe/ScribeAgent.ts` `CLARIFICATION_SYSTEM_PROMPT`, `SPEC_GENERATION_SYSTEM_PROMPT` | Scribe'ın model promptları. |
| `backend/src/pipeline/agents/proto/ProtoAgent.ts` `SCAFFOLD_SYSTEM_PROMPT` | Proto'nun MVP scaffold üretim prompt'u. |
| `backend/src/pipeline/agents/trace/TraceAgent.ts` `TEST_GENERATION_PROMPT` | Trace'in Playwright test üretim prompt'u. |
| `backend/src/pipeline/agents/skills/*.md` | SkillLoader tarafından modelin context'ine yüklenen skill içerikleri. |
| `backend/src/pipeline/agents/repo-context/prompts/summarize-repo.ts` | RepoContextAgent'ın özet promptu. |
| `backend/src/services/ai/prompt-constants.ts` | `PLAN_SYSTEM_PROMPT`, `GENERATE_SYSTEM_PROMPT`, vb. — temel prompt sabitleri. Tamamen İngilizce, tamamen AI-facing. |

### 2.2 User-facing — düzeltildi

| Dosya | Değişiklik | Örnek |
|---|---|---|
| `backend/src/pipeline/agents/proto/ProtoAgent.ts` | 18 emit mesajı + 1 PR body satırı | `'Scaffold üretimi başarısız oldu'` → `'İskelet üretimi başarısız oldu'`; `'GitHub repo oluşturuluyor...'` → `'GitHub deposu oluşturuluyor...'`; `'... push edildi'` → `'... yüklendi'`; PR body: `'> Bu scaffold AKIS Proto agent ...'` → `'> Bu iskelet AKIS Proto agent ...'`. |
| `backend/src/pipeline/agents/trace/TraceAgent.ts` | 4 emit mesajı + 1 PR body satırı | `'Scaffold branch'inden ...'` → `'İskelet dalından ...'`; `'Repoda kaynak dosya bulunamadı'` → `'Depoda kaynak dosya bulunamadı'`; `'Test dosyaları push edili...'` → `'Test dosyaları yüklenmek...'`; PR body: `'... push/PR sonrası ...'` → `'... yükleme veya değişiklik teklifi sonrası ...'`. |

**Glossary terimleri:**
- `scaffold`/`Scaffold` → `iskelet`/`İskelet` (warn)
- `repo`/`Repo` → `depo`/`Depo` (warn)
- `push edildi`/`ediliyor`/`edilemedi` → `yüklendi`/`yükleniyor`/`yüklenemedi` (warn — glossary "yükle / gönder")
- `branch` → `dal` (warn) — `'Scaffold branch'inden'` → `'İskelet dalından'`
- `PR` → `değişiklik teklifi` (info) — Trace PR body `'push/PR sonrası'` → `'yükleme veya değişiklik teklifi sonrası'`

**Anlamı korumak için:**
- `Array.prototype.push()` çağrılarına dokunulmadı — kod kimliği, kullanıcıya gitmez.
- `spec.foo`, `state.context` gibi JS değişken kimliklerine dokunulmadı.
- `'Bağlantı noktası (port) ...'` zaten bakkal-Türkçe + parantezli teknik terim örüntüsü, **iyi pattern**, korundu.

### 2.3 False positive — `// allow:term` ile susturuldu

Script Türkçe karakter içeren satırlarda kelime arıyor; kod-comment/array-method satırlarında yanlış pozitif veriyor.

| Dosya | Satır | Sebep | Çözüm |
|---|---|---|---|
| `backend/src/pipeline/agents/scribe/SpecContract.ts` | 43, 46 | `issues.push('Başlık ...')` — JS Array push | `// allow:push` |
| `backend/src/pipeline/agents/scribe/ScribeAgent.ts` | 634, 644, 664, 672, 691 | `parts.push(...)`, `lines.push(...)` — JS Array push | `// allow:push` (664'te `// allow:push,spec` çünkü template'de `spec'i` de geçiyor) |
| `backend/src/pipeline/agents/trace/TraceAgent.ts` | 818 | `lines.push(...)` | `// allow:push` |
| `backend/src/pipeline/agents/proto/ScaffoldEnricher.ts` | 16 | Doc-comment satırında `'da gör — repo URL placeholder ...` (kod yorumu, kullanıcıya gitmez) | Satırı yeniden yapılandırdım: Türkçe kısım `'da gör'` ayrı satırda; takip satırı saf İngilizce `repo URL placeholder filled by ProtoAgent at upload time` artık script'in Türkçe filtresine takılmıyor. Hem `repo` warn'i hem `push`→`upload time` ifadesi naturel oldu. |

---

## 3. Info-level bulgular (kasıtlı bırakıldı)

25 backend info-level bulgusunun çoğunluğu:

- **`pipeline.activity.*` activity-key'leri**: `'pipeline.activity.proto.creating_scaffold'` gibi i18n anahtarı. Frontend `tr.json`'da zaten bakkal-Türkçeye çevrilmiş (`"İskelet üretiliyor"`). Anahtar adı kod kimliği, kullanıcıya gitmez. Script kelime sınırı bulduğu için yakalıyor — false positive.
- **`Spec` info'ları (Scribe emit mesajlarında)**: Frontend `tr.json` Faz 1'de `"Spec"` kullanmaya devam ediyor (info-level, blocking değil). Backend ile tutarlılık için aynı posture korundu. Bir sonraki fazda `Spec` → `Plan` yapılırsa hem frontend hem backend birlikte değişmeli.
- **`spec.foo` JS değişken kimlikleri**: false positive.
- **`stack` (info)**: `'# AKIS — bu stack için Dockerfile şablonu yok.\n'` (ScaffoldEnricher fallback). `stack` info-level glossary entry, opsiyonel düzeltme.
- **`port` (info)**: `'Bağlantı noktası (port) ...'` — zaten istenen pattern.
- **Skill `.md` dosyalarındaki `spec`**: AI-facing skill içeriği, dokunulmadı.

---

## 4. Sürdürülebilirlik — Disiplin nasıl korunur?

Phase 3 manuel düzeltmeyle 36 warn'i sıfırladı; ama yeni kod yazıldıkça yine sızabilir. Önerilen yollar:

### 4.1 CI gate (önerilen)

`.github/workflows/lint.yml` içinde `node scripts/lint/bakkal-language.mjs --all` adımı eklemek (exit code 1 → CI fail). Halihazırda exit kodu warn varsa 1 — sadece workflow'a eklemek yeter.

```yaml
- name: Bakkal-language audit
  run: node scripts/lint/bakkal-language.mjs --all
```

Risk: Frontend'de hâlâ 33 warn var (Faz 1'in info-leveled bıraktıkları + Türkçe karaktere takılan yenileri). Önce o warn'lerin de sıfırlanması veya `--quiet --backend-only` flag'i eklenmesi gerek.

### 4.2 Pre-commit hook (alternatif)

`.claude/hooks/format-on-edit.sh` zaten Prettier çalıştırıyor. Yanına yalnızca değişen dosyalarda audit çalıştıran bir pre-commit hook eklenebilir — ama kapsam dar olur (yeni dosyalar atlanır).

### 4.3 PR-time review checklist (en hafif)

`.github/pull_request_template.md`'a ekle:
> - [ ] Yeni `emit?.()` mesajları, PR/README üretim kodu, kullanıcıya görünen string eklediysen `node scripts/lint/bakkal-language.mjs --all` ile kontrol et.

**Önerim:** 4.1 (CI gate). Diğer iki yol disiplin sağlamaz; sadece `make` zinciri katı sınır kor. Frontend warn'leri Faz 4'te sıfırlanmayı bekliyor — onunla birlikte CI gate açılması en mantıklısı.

### 4.4 Glossary genişletme (opsiyonel)

Türkçe-eklemeli morfolojik formlar (örn. `Repoda`, `branch'inden`) script'in word-boundary regex'iyle yakalanmıyor. Glossary'e morfolojik varyantlar eklenebilir, ya da regex'i `\bX(?:[\W_])` gibi Türkçe-suffix-toleranslı yapılabilir. Bu fazın kapsamı dışı; bu fazda manuel grep ile bulduğum bir adet vardı (`'Repoda kaynak dosya bulunamadı'` → `Depoda...`), düzelttim.

---

## 5. Test sonucu

- `pnpm -C backend typecheck` ✅
- `pnpm -C backend lint` ✅
- `pnpm -C backend test` ✅ (3287/3287 pass — snapshot/string-eşleşme bağımlı test yok, bu yüzden activity message değişiklikleri kırılmadı)

---

## 6. Sonuç

Backend prompt dosyalarında **tüm warn-severity ihlaller temizlendi**, AI-facing promptlara hiç dokunulmadı, false-positive'ler `// allow:` ile susturuldu. Geriye kalan 23 info-level bulgu ya frontend'le tutarlılık için bilinçli (Spec, port (port)) ya da script'in zayıf eşleşmesi (activity-key adları, JS değişken kimlikleri).

Sonraki adım: CI gate açılması (Faz 4 frontend warn temizliği ile birlikte).
