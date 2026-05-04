# PLAN B — FIX LOOP SERVISI

## CONTEXT
Trace testleri fail ettiginde, Proto'nun kodu otomatik duzeltmesi icin bir self-healing loop gerekiyor. Bu loop: Trace fail -> hata mesajini Proto'ya gonder -> Proto duzelt -> Trace tekrar test et. Max 3 iterasyon.

Bu StrongDM'in "holdout test" pattern'i ve LLMloop arastirmasindaki "fix-test-fix" loop'unun AKIS implementasyonu.

## FORBIDDEN RULES
- .env dosyalarina DOKUNMA
- `backend/src/pipeline/core/fix-loop/` DISINDA dosya olusturma veya degistirme
- PipelineOrchestrator.ts'ye DOKUNMA
- Mevcut agent dosyalarina DOKUNMA

## ADIM 0 — DISCOVERY
```bash
cd ~/Projects/akisflow
cat CLAUDE.md
cat backend/src/pipeline/core/contracts/PipelineTypes.ts
cat backend/src/pipeline/agents/proto/ProtoAgent.ts
cat backend/src/pipeline/agents/trace/TraceAgent.ts
cat backend/src/pipeline/core/orchestrator/PipelineOrchestrator.ts | head -150
```
Proto ve Trace'in input/output tiplerini anla. Orchestrator'in akisini anla.

## ADIM 1 — Fix Loop Dosya Yapisi
```
fix-loop/
├── FixLoopService.ts       <- Ana servis
├── FixLoopTypes.ts         <- Tipler
└── __tests__/
    └── FixLoopService.test.ts
```

## ADIM 2 — FixLoopTypes.ts
```typescript
export interface FixLoopConfig {
  maxIterations: number;          // default: 3
  baseTemperature: number;        // default: 0
  temperatureIncrement: number;   // default: 0.1 (her iterasyonda artar)
  timeoutPerIteration: number;    // default: 5 * 60 * 1000 (5 dakika)
}

export interface FixLoopIteration {
  iteration: number;
  temperature: number;
  protoOutput: unknown;   // ProtoOutput
  traceOutput: unknown;   // TraceOutput
  testsPassed: boolean;
  failureReason?: string;
  durationMs: number;
}

export interface FixLoopResult {
  success: boolean;
  totalIterations: number;
  iterations: FixLoopIteration[];
  finalProtoOutput?: unknown;
  finalTraceOutput?: unknown;
  /** Neden durdu: 'tests_passed' | 'max_iterations' | 'timeout' | 'error' */
  terminationReason: string;
}
```

## ADIM 3 — FixLoopService.ts
Su mantigi implement et:
```
function runFixLoop(spec, protoAgent, traceAgent, config):
  for i in 0..config.maxIterations:
    temperature = config.baseTemperature + (i * config.temperatureIncrement)
    
    if i == 0:
      protoOutput = protoAgent.run(spec, temperature)
    else:
      // Onceki iterasyonun hata mesajini Proto'ya feedback olarak ver
      protoOutput = protoAgent.runWithFeedback(spec, previousFailure, temperature)
    
    traceOutput = traceAgent.run(protoOutput)
    
    if traceOutput.allTestsPassed:
      return { success: true, iteration: i }
    else:
      previousFailure = traceOutput.failureSummary
  
  return { success: false, iterations: all }
```

ONEMLI:
- Bu servis ProtoAgent ve TraceAgent'i DOGRUDAN cagirmaz. Callback function'lar alir.
- `runProto: (spec, feedback?, temperature?) => Promise<ProtoOutput>`
- `runTrace: (protoOutput) => Promise<TraceOutput>`
- Bu sayede orchestrator integration'da agent'lari inject edebiliriz.

## ADIM 4 — Testler
- Happy path: Ilk iterasyonda testler gecer -> success
- Fix path: Ilk 2 iterasyon fail, 3. iterasyon pass -> success
- Max iterations: 3 iterasyon da fail -> terminationReason: 'max_iterations'
- Temperature escalation: Her iterasyonda temperature 0.1 artiyor mu?
- Timeout: Bir iterasyon timeout olursa ne oluyor?
- En az 6 test case

## ADIM 5 — Dogrulama
```bash
cd backend && pnpm typecheck
cd backend && pnpm test:unit -- --testPathPattern="fix-loop"
```

## STATUS REPORT
`docs/plans/REPORT_B_FIXLOOP.md` olarak kaydet (ayni format).
