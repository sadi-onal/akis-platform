# Trace Agent -- Accumulated Learnings

> Bu dosya pipeline run'larindan ogrenilen pattern'lari, hatalari ve cozumleri biriktirir.
> Her basarili/basarisiz run sonrasi guncellenir.

## Known Good Patterns

### Real Code Reading from GitHub
Trace, Proto'nun push ettigi GERCEK kodu GitHub'dan okur:
- `TraceGitHubDeps.listFiles()` ile dosya listesi alinir
- `TraceGitHubDeps.getFileContent()` ile dosya icerikleri okunur
- Filtreleme: SOURCE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.vue', '.svelte', '.css', '.html']
- Exclusion: node_modules/, .git/, dist/, build/, .next/, coverage/, .cache/, __pycache__/
- Max dosya: 80 (MAX_SOURCE_FILES), max dosya boyutu: 100KB (MAX_FILE_SIZE_BYTES)
- Max codebase context: 200,000 karakter (RETRY_CONFIG.maxCodebaseContextChars)

### Agentic Loop Execution
Trace da Proto gibi `runAgenticLoop()` kullanir:
- `TRACE_TOOLS` + `createTraceToolHandlers()` ile tool-based execution
- GitHub dosya okuma ve commit islemleri tool handler'lar uzerinden

### Playwright E2E Test Generation
- Page Object Model (POM) pattern kullanilir
- BasePage class + page-specific class'lar
- Semantic locator onceligi: getByRole() > getByText() > getByTestId() > getByLabel() > CSS
- Web-first assertions: expect(locator).toBeVisible(), toHaveText(), toContainText()
- Manual waitForTimeout() YASAK -- expect(locator).toBeVisible() veya page.waitForURL() kullanilir

### Traceability Matrix
Her acceptance criteria icin test mapping'i uretilir:
```
[
  {"criterionId": "ac-1", "testFile": "...", "testName": "...", "coverage": "full"},
  {"criterionId": "ac-2", "testFile": "...", "testName": "...", "coverage": "partial"}
]
```
Coverage: "full" (Given+When+Then), "partial" (bazi adimlar eksik), "none".

### Coverage Matrix
Test summary output:
```
{
  "totalTests": 8,
  "coveragePercentage": 80,
  "coveredCriteria": ["ac-1", "ac-2"],
  "uncoveredCriteria": ["ac-5"]
}
```

### Turkish UI Label Matching
- Test dosya adlari ve describe/it bloklari Ingilizce
- UI text matcher'lari Turkce (getByRole('button', { name: 'Giris Yap' }))
- i18n key'leri degil, resolve edilmis Turkce text kullanilir

### Gherkin Generation
- `generateGherkinFromSpec()` (cucumberGenerator.js) ile spec'ten Gherkin senaryolari turetilir
- BDD yaklasimiyla Given/When/Then format

### AI Call Timeout Protection
- Her AI cagrisi `withAiTimeout()` wrapper'i ile korunur
- Timeout: RETRY_CONFIG.aiCallTimeoutMs (3 dakika)
- Suuresiz askida kalmayi onler

## Known Failure Modes

### TRACE_CODE_READ_FAILED
- **Belirtiler:** GitHub'dan dosya okuma basarisiz.
- **Kok sebep:** GitHub API hatasi, yanlis branch/repo bilgisi, token yetkisi.
- **Recovery:** retryable=true, backoff ile tekrar dener.

### TRACE_EMPTY_CODEBASE
- **Belirtiler:** Push edilen projede test yazilabilecek kaynak kod yok.
- **Kok sebep:** Proto sadece config dosyalari uretmis, veya filtreleme sonrasi source dosya kalmamis.
- **Recovery:** retryable=false, recoveryAction=edit_spec.

### TRACE_TEST_GENERATION_FAILED
- **Belirtiler:** AI test dosyalari uretemedi veya JSON parse hatasi.
- **Kok sebep:** Codebase cok buyuk (>200K char), model context window'a sigmiyor.
- **Recovery:** retryable=true.

### TRACE_AI_CALL_TIMEOUT
- **Belirtiler:** AI yanit vermedi, 3 dakika timeout.
- **Kok sebep:** Cok buyuk codebase ile cok sayida test yazilmaya calisildi.
- **Recovery:** retryable=true.

### Codebase Context Overflow
- **Belirtiler:** 200K karakter limitine ulasildi, bazi dosyalar AI'a gonderilemiyor.
- **Kok sebep:** Proto cok fazla dosya uretmis.
- **Cozum:** MAX_SOURCE_FILES=80 ve MAX_CODEBASE_CONTEXT_CHARS=200K limitleri ile budanir.

## Workarounds & Fixes

### pushFiles Batch
- `TraceGitHubDeps.pushFiles?` optional -- tek commit ile tum test dosyalarini push eder.
- Fallback: tek tek `commitFile()` cagirilir.

### Branch + PR Workflow
- Trace kendi branch'ini olusturabilir (`createBranch`)
- Test dosyalari icin PR acabilir (`createPR`)

### Skip Trace
- Pipeline'da `skip-trace` endpoint'i mevcut
- Trace basarisiz olursa veya istenirse atlanabilir
- Pipeline `completed_partial` durumuna gecer

## Quality Baselines

| Metrik | Beklenen | Notlar |
|--------|----------|--------|
| Coverage percentage | >= 70% | AC coverage orani |
| Total tests per run | 4-12 | Spec karmasikligina bagli |
| Traceability completeness | >= 80% | Her AC icin en az "partial" |
| AI call timeout rate | < 5% | withAiTimeout korumasinda |
| JSON parse success | > 95% | parseAIJson safety chain |
| Stage success rate | > 85% | Trace en cok fail eden agent |

## Convention Notes

- temperature=0 (TEST_GENERATION_PROMPT icinde explicit)
- Stage timeout: 10 dakika (RETRY_CONFIG.traceStageTimeoutMs -- diger agent'lardan fazla)
- AI call timeout: 3 dakika (RETRY_CONFIG.aiCallTimeoutMs)
- Max retries: 3, backoff: [5s, 15s, 30s]
- Max source files: 80, max file size: 100KB, max codebase context: 200K chars
- Test dosya dili: TypeScript
- Test framework: Playwright
- Test pattern: Page Object Model
- Trace, Proto'nun kodunu GORMEDEN test yazar (holdout principle -- tez temasi)
- Trace, spec'i bilir ama implementation detail'leri bilmez (black-box testing)
