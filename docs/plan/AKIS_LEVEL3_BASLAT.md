# AKIS Level 3 — Başlatma Komutu

## Dosyayı Koy
`AKIS_LEVEL3_MASTER_PLAN.md` dosyasını şuraya kopyala:
```
~/Projects/akisflow/docs/plans/AKIS_LEVEL3_MASTER_PLAN.md
```

## Claude Code'a Yapıştır (TEK KOMUT)

```
@docs/plans/AKIS_LEVEL3_MASTER_PLAN.md Read this master plan and execute it step by step in act mode. ADIM 0: discovery and create 4 sub-plan files. ADIM 1: write the sub-plan files to docs/plans/. ADIM 2: launch 4 parallel Claude Code instances (claude CLI with --model claude-opus-4-6-20250710) — each reads its own plan and works independently. ADIM 3: wait for all agents, check reports. ADIM 4: integrate all outputs into PipelineOrchestrator. ADIM 5: final report. IMPORTANT: .env files are OFF LIMITS. Fix errors before moving to next step. Each parallel agent has STRICT file boundaries — they must NOT touch each other's files.
```

## Alternatif: Doğrudan Terminal'den Başlat

Eğer Claude Code UI yerine terminal'den başlatmak istersen:

```bash
cd ~/Projects/akisflow

claude --model claude-opus-4-6-20250710 --max-turns 150 -p \
  "Bu projede docs/plans/AKIS_LEVEL3_MASTER_PLAN.md dosyasını oku ve adım adım uygula. Act mode'da çalış. ADIM 0'da projeyi tanı ve 4 sub-plan dosyası oluştur. ADIM 2'de 4 paralel Claude Code instance'ı başlat (claude CLI ile). Her agent kendi dosya sınırlarında çalışsın. Hepsini bekle, raporlarını kontrol et. ADIM 4'te entegrasyonu yap. .env dosyalarına ASLA dokunma. Hata varsa düzelt, sonra devam et."
```

## Takip

Paralel agent'lar çalışırken log'ları izle:
```bash
tail -f /tmp/akis_agent_*.log
```

Agent'ların durumunu kontrol et:
```bash
ls docs/plans/REPORT_*.md
```
