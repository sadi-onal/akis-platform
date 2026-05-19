/**
 * PR-V-spec-artifacts — PRD markdown renderer tests
 *
 * Pure-function tests: assert the renderer produces the expected sections
 * for a complete spec and gracefully elides missing fields without ever
 * surfacing the word "undefined".
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { renderPRDMarkdown } from '../../src/pipeline/agents/scribe/render/prdMarkdown.js';
import type {
  StructuredSpec,
  UserFriendlyPlan,
} from '../../src/pipeline/core/contracts/PipelineTypes.js';

const FIXED_DATE = new Date('2026-05-20T10:00:00.000Z');

const fullSpec: StructuredSpec = {
  title: 'Bakkal Stok Takip',
  problemStatement: 'Küçük işletmeler stok takibinde zorlanıyor.',
  userStories: [
    { persona: 'Bakkal sahibi', action: 'ürün eklemek', benefit: 'stoğumu kontrol edebileyim' },
    {
      persona: 'Tezgâhtar',
      action: 'satış kaydetmek',
      benefit: 'gün sonu raporu otomatik oluşsun',
    },
  ],
  acceptanceCriteria: [
    {
      id: 'AC-1',
      given: 'Boş bir stok listesi',
      when: 'Yeni bir ürün eklendiğinde',
      then: 'Liste bu ürünü göstermeli',
    },
    {
      id: 'AC-2',
      given: 'Bir ürün stoğa eklenmişken',
      when: 'Sat tuşuna basıldığında',
      then: 'Stok adedi 1 azalmalı',
    },
  ],
  technicalConstraints: {
    stack: 'React + Vite',
    integrations: ['localStorage'],
    nonFunctional: ['Offline çalışmalı', 'Türkçe arayüz'],
  },
  outOfScope: ['Çoklu mağaza', 'Online ödeme'],
};

const fullPlan: UserFriendlyPlan = {
  projectName: 'Bakkal Stok Takip',
  summary: 'Küçük bakkal sahibi için tek sayfalık stok takip uygulaması.',
  features: [
    { name: 'Ürün ekleme', description: 'Yeni ürün için form' },
    { name: 'Satış kaydı', description: 'Stoğu azaltır' },
  ],
  techChoices: ['React + Vite', 'localStorage'],
  estimatedFiles: 9,
  requiresTests: false,
};

describe('renderPRDMarkdown', () => {
  it('produces all major sections for a complete spec', () => {
    const md = renderPRDMarkdown({
      spec: fullSpec,
      plan: fullPlan,
      assumptions: ['Tarayıcı modern (ES2020+)'],
      now: FIXED_DATE,
    });

    assert.match(md, /^# Bakkal Stok Takip — Proje Tanımı \(PRD\)/);
    assert.match(md, /## Özet/);
    assert.match(md, /## Problem Tanımı/);
    assert.match(md, /## Kullanıcı Hikayeleri \(2\)/);
    assert.match(md, /## Kabul Kriterleri \(2\)/);
    assert.match(md, /### AC-1/);
    assert.match(md, /### AC-2/);
    assert.match(md, /## Teknik Kısıtlamalar/);
    assert.match(md, /\*\*Stack:\*\* React \+ Vite/);
    assert.match(md, /## Kapsam Dışı/);
    assert.match(md, /## Varsayımlar/);
    assert.match(md, /Tarayıcı modern \(ES2020\+\)/);
    assert.match(md, /## Özellikler \(Proto'nun planladığı\)/);
    assert.match(md, /Üretildi: 2026-05-20T10:00:00\.000Z · AKIS Scribe/);

    // user story formatting
    assert.match(md, /\*\*Bakkal sahibi\*\*: ürün eklemek → stoğumu kontrol edebileyim/);
    // AC formatting
    assert.match(md, /\*\*Verildiğinde:\*\* Boş bir stok listesi/);
    assert.match(md, /\*\*Olduğunda:\*\* Yeni bir ürün eklendiğinde/);
    assert.match(md, /\*\*Sonuç:\*\* Liste bu ürünü göstermeli/);
  });

  it('never renders the literal word "undefined"', () => {
    const sparseSpec: StructuredSpec = {
      title: 'Test',
      problemStatement: '',
      userStories: [],
      acceptanceCriteria: [],
      technicalConstraints: {},
      outOfScope: [],
    };
    const md = renderPRDMarkdown({ spec: sparseSpec, now: FIXED_DATE });
    assert.ok(!md.includes('undefined'), 'PRD must never contain "undefined"');
    assert.ok(!md.includes('null'), 'PRD must never contain bare "null"');
  });

  it('elides missing sections when their inputs are empty', () => {
    const minimalSpec: StructuredSpec = {
      title: 'Minimal',
      problemStatement: 'Sade bir test.',
      userStories: [],
      acceptanceCriteria: [],
      technicalConstraints: {},
      outOfScope: [],
    };
    const md = renderPRDMarkdown({ spec: minimalSpec, now: FIXED_DATE });
    assert.ok(!md.includes('## Kullanıcı Hikayeleri'));
    assert.ok(!md.includes('## Kabul Kriterleri'));
    assert.ok(!md.includes('## Kapsam Dışı'));
    assert.ok(!md.includes('## Varsayımlar'));
    assert.ok(!md.includes('## Özellikler'));
    // Problem still shows up:
    assert.match(md, /## Problem Tanımı\n\nSade bir test\./);
  });

  it('falls back to "Proje" title when spec.title is empty', () => {
    const md = renderPRDMarkdown({
      spec: { ...fullSpec, title: '   ' },
      now: FIXED_DATE,
    });
    assert.match(md, /^# Proje — Proje Tanımı \(PRD\)/);
  });

  it('uses default AC id when criterion.id is missing', () => {
    const md = renderPRDMarkdown({
      spec: {
        ...fullSpec,
        acceptanceCriteria: [{ id: '', given: 'X', when: 'Y', then: 'Z' }],
      },
      now: FIXED_DATE,
    });
    assert.match(md, /### AC-1/);
  });

  it('shows "Proto seçecek" placeholder when stack is unset', () => {
    const md = renderPRDMarkdown({
      spec: { ...fullSpec, technicalConstraints: { integrations: ['Stripe'] } },
      now: FIXED_DATE,
    });
    assert.match(md, /\*\*Stack:\*\* Proto seçecek/);
    assert.match(md, /\*\*Entegrasyonlar:\*\* Stripe/);
  });
});
