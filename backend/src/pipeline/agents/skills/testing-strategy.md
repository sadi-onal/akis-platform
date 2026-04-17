---
name: testing-strategy
description: Test pyramid, coverage discipline, when to mock vs integrate. Apply when deciding what to test or how.
agents: proto, trace, critic
tier: core-trace, opt-proto, opt-critic
version: 1
---

# Testing Strategy

## What to test (priority order)

1. **User-observable behavior** — what the user actually sees and does
2. **Business rules** — invariants and constraints of the domain
3. **Integration boundaries** — API contracts, DB schema, auth flows
4. **Error paths** — how the system behaves when things fail
5. Implementation details — last, and only when they encode non-obvious invariants

If a test asserts on implementation details that could change without breaking user outcomes, rethink it.

## Test pyramid

- **Many unit tests** — fast, focused, isolate one unit
- **Some integration tests** — verify that units compose correctly
- **Few end-to-end tests** — verify the full user journey

The right ratio depends on the system. Favor the higher tier when possible without sacrificing speed.

## When to mock vs integrate

**Mock when:**
- The collaborator is external (network, filesystem, random, time)
- The collaborator is slow or flaky
- You need to force a specific edge case (e.g. 503 error)

**Do not mock when:**
- The collaborator is pure, fast, and deterministic — call the real thing
- The mock would duplicate the real behavior enough to diverge (e.g. mocking a DB when you could use a real test DB)

A test that mocks everything verifies nothing.

## AAA structure

Each test: **Arrange → Act → Assert**. One logical assertion per test. If you need two, usually you have two tests.

## Anti-patterns

- **Test coverage fetish** — 100% coverage with weak assertions
- **Implementation tests** — tests that know the private details of the unit
- **Snapshot abuse** — snapshotting everything, updating on every change without review
- **Shared mutable state** — tests that pass in isolation, fail together

## Reliability

Tests must be deterministic. No randomness without a fixed seed. No time without a frozen clock. No network without a stub or test server.
