# Proto Agent -- Accumulated Learnings

> Bu dosya pipeline run'larindan ogrenilen pattern'lari, hatalari ve cozumleri biriktirir.
> Her basarili/basarisiz run sonrasi guncellenir.

## Known Good Patterns

### Agentic Loop Execution
Proto, basit text generation yerine `runAgenticLoop()` kullanir:
- Claude API'yi tools ile cagirir
- `stop_reason === "tool_use"` ise tool handler calistirir, sonucu geri gonderir
- `end_turn` veya max iterasyon'a kadar devam eder
- Default max iterations: 15 (AgenticLoop.DEFAULT_MAX_ITERATIONS)
- Tool'lar: `PROTO_TOOLS` + `createProtoToolHandlers()` (GitHub operations)

### Scaffold Generation Rules
- Minimum 6 dosya (MIN_SCAFFOLD_FILES)
- 8-12 dosya hedef, her biri < 80 satir
- Zorunlu dosyalar: index.html, package.json, vite.config.js, .gitignore, README.md, src/main.jsx, src/App.jsx, src/App.css
- Her user story icin ayri component: `src/components/FeatureName.jsx`
- Sandpack preview uyumlulugu: relative imports, no dynamic imports, no path aliases

### Verification Report
Proto, JSON output'unda `verificationReport` urerir:
```
{
  "specCoverage": "5/5 criteria addressed",
  "integrityIssues": [],
  "missingDependencies": [],
  "unresolvedImports": [],
  "confidenceScore": 0.9
}
```
Her user story ve acceptance criteria icin kontrol yapilir.

### Turkish UI Text (Mandatory)
- Tum kullanici-goren metinler Turkce: buton label'lari, heading'ler, placeholder'lar, hata mesajlari
- Kod Ingilizce, UI Turkce

### Responsive Design (Mobile-First)
- Base stiller mobile icin, sm:/lg: responsive breakpoint'lar
- Touch target: minimum 44px
- CSS media queries: min-width: 640px, 768px, 1024px

### JSON Parse Safety
Proto, AI yanitlari icin 3 fonksiyonlu safety chain kullanir:
1. `extractJsonSafe()` -- markdown fences ve brace extraction
2. `sanitizeJsonControlChars()` -- control char escaping
3. `repairTruncatedJson()` -- truncated JSON repair
Bu fonksiyonlar `json-extract.ts`'den import edilir.

### Iteration Mode
Proto, mevcut kodu degistirmek icin "iteration mode" destekler:
- Sifirdan build yerine mevcut dosyalar uzerinde calisir
- Follow-up degisiklikler icin Scribe atlanabilir (pipeline iteration mode)

## Known Failure Modes

### PROTO_SCAFFOLD_GENERATION_FAILED
- **Belirtiler:** AI scaffold uretirken JSON parse hatasi veya eksik dosyalar.
- **Kok sebep:** Model cok uzun output uretmeye calisiyor ve max_tokens'a takiliyor.
- **Recovery:** retryable=true, `repairTruncatedJson()` truncated output'u onarmaya calisir.

### PROTO_PUSH_FAILED
- **Belirtiler:** Scaffold uretildi ama GitHub'a push edilemiyor.
- **Kok sebep:** GitHub API rate limit, permission sorunu, veya network hatasi.
- **Recovery:** retryable=true, backoff ile tekrar dener.

### GITHUB_REPO_EXISTS
- **Belirtiler:** Ayni isimde repo zaten var.
- **Kok sebep:** Kullanici onceki pipeline'dan ayni ismi kullanmis.
- **Recovery:** retryable=false, kullaniciya farkli isim secmesi istenir (recoveryAction: edit_spec).

### GITHUB_PERMISSION_DENIED
- **Belirtiler:** Token'in repo olusturma yetkisi yok.
- **Kok sebep:** PAT'in "repo" scope'u eksik.
- **Recovery:** retryable=false, GitHub baglantisini yenilemesi istenir.

### File Content Truncation
- **Belirtiler:** Olusturulan dosyalarin sonlari eksik.
- **Kok sebep:** AI max_tokens'a ulasiyor, JSON truncate oluyor.
- **Cozum:** `repairTruncatedJson()` acik string/array/object'leri kapatir.

## Workarounds & Fixes

### pushFiles Batch Operation
- `ProtoGitHubDeps.pushFiles?` optional method ile toplu commit destegi.
- Tek tek `commitFile()` yerine batch kullanilir -- daha hizli ve atomik.

### Dry Run Mode
- `input.dryRun === true` ise GitHub'a push yapilmaz.
- Test'lerde kullanilir, gercek GitHub API'ye basvurulmaz.

### Activity Emitter
- `createActivityEmitter(pipelineId, 'proto')` ile pipeline progress takibi.
- Frontend'e real-time durum bildirimi gonderir.

## Quality Baselines

| Metrik | Beklenen | Notlar |
|--------|----------|--------|
| Dosya sayisi | 8-12 | Minimum 6 (MIN_SCAFFOLD_FILES) |
| Confidence score | >= 0.8 | verificationReport.confidenceScore |
| Spec coverage | %100 | Her AC en az bir dosya ile eslesir |
| Import integrity | 0 hata | Var olmayan path'lere import yok |
| Dependency completeness | %100 | package.json tum import'lari icerir |
| Push success rate | > 95% | Network hatalari haric |

## Convention Notes

- temperature=0 (SCAFFOLD_SYSTEM_PROMPT icinde explicit)
- Stage timeout: 5 dakika (RETRY_CONFIG.stageTimeoutMs)
- Max retries: 3, backoff: [5s, 15s, 30s]
- Agent'lar arasi iletisim yalnizca PipelineOrchestrator uzerinden
- Proto, Trace'in testlerini GORMEZ (holdout pattern)
- Kod yorumu yok, console.log yok, test dosyasi yok (scaffold'da)
- README.md Turkce (proje aciklamasi + kurulum adimlari)
