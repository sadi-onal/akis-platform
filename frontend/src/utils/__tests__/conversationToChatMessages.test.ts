import { describe, it, expect } from 'vitest';
import { conversationToChatMessages } from '../conversationToChatMessages';
import type { ConversationMessage, StructuredSpec } from '../../types/workflow';

function spec(): StructuredSpec {
  return {
    title: 'Bakkal stoğu',
    problemStatement: 'Bakkal stoğu kalmadığında haber alsın.',
    userStories: [
      {
        asA: 'bakkal sahibi',
        action: 'düşük stoğa düşen ürünleri görmek',
        benefit: 'siparişimi zamanında verebilmek',
        acceptanceCriteria: ['Stok 5 birimin altına düştüğünde uyarı görünür.'],
      },
    ],
  } as unknown as StructuredSpec;
}

function specMsg(): ConversationMessage {
  return {
    role: 'scribe',
    type: 'spec',
    spec: spec(),
    content: 'Spec hazır.',
    timestamp: '2026-05-09T12:00:00Z',
  } as unknown as ConversationMessage;
}

describe('conversationToChatMessages — plan status by stage', () => {
  it("keeps the plan card 'active' while Scribe is still clarifying", () => {
    const msgs = conversationToChatMessages([specMsg()], 'scribe_clarifying');
    const plan = msgs.find((m) => m.type === 'plan');
    expect(plan).toBeDefined();
    expect(plan && 'status' in plan && plan.status).toBe('active');
  });

  it("keeps the plan card 'active' during scribe_generating", () => {
    const msgs = conversationToChatMessages([specMsg()], 'scribe_generating');
    const plan = msgs.find((m) => m.type === 'plan');
    expect(plan && 'status' in plan && plan.status).toBe('active');
  });

  it("keeps the plan card 'active' while Critic is reviewing the spec (regression: Bug A)", () => {
    // Bug A: previously the plan was flipped to 'approved' as soon as the
    // stage moved past awaiting_approval / scribe_*, which incorrectly
    // included critic_reviewing_spec — Critic may have signed off internally
    // but the user hasn't pressed "Onayla" yet.
    const msgs = conversationToChatMessages([specMsg()], 'critic_reviewing_spec');
    const plan = msgs.find((m) => m.type === 'plan');
    expect(plan && 'status' in plan && plan.status).toBe('active');
  });

  it("keeps the plan card 'active' while awaiting_approval", () => {
    const msgs = conversationToChatMessages([specMsg()], 'awaiting_approval');
    const plan = msgs.find((m) => m.type === 'plan');
    expect(plan && 'status' in plan && plan.status).toBe('active');
  });

  it("flips the plan to 'approved' once Proto kicks off", () => {
    const msgs = conversationToChatMessages([specMsg()], 'proto_building');
    const plan = msgs.find((m) => m.type === 'plan');
    expect(plan && 'status' in plan && plan.status).toBe('approved');
  });

  it("flips the plan to 'approved' during critic_reviewing_code", () => {
    const msgs = conversationToChatMessages([specMsg()], 'critic_reviewing_code');
    const plan = msgs.find((m) => m.type === 'plan');
    expect(plan && 'status' in plan && plan.status).toBe('approved');
  });

  it("a system 'reddedildi' message overrides plan status to 'rejected'", () => {
    const reject: ConversationMessage = {
      role: 'system',
      type: 'system',
      content: 'Plan reddedildi.',
      timestamp: '2026-05-09T12:00:01Z',
    } as unknown as ConversationMessage;
    const msgs = conversationToChatMessages([specMsg(), reject], 'awaiting_approval');
    const plan = msgs.find((m) => m.type === 'plan');
    expect(plan && 'status' in plan && plan.status).toBe('rejected');
  });
});
