---
name: system-design
description: Principles for designing and evaluating system architecture — module boundaries, tradeoffs, data flow.
agents: scribe, proto, critic
tier: core-scribe, opt-proto, opt-critic
version: 1
---

# System Design

## Principles

1. **Single responsibility.** Each module/component has one reason to change. If a file mixes data fetching, rendering, and auth, it needs splitting.
2. **Clear boundaries.** Interfaces between units are named, typed, and narrow. No reaching into another module's internals.
3. **Communicate via explicit contracts.** Shared global state is the exception; dependency injection is the default.
4. **Isolate side effects.** Pure logic should not transitively depend on IO. Push IO to the edges (orchestration layer).

## When to apply

- Introducing a new feature that spans multiple modules
- Evaluating a proposed architecture or ADR
- Identifying a design smell (god object, circular dep, implicit coupling)
- Deciding how to split a growing file

## Tradeoff reasoning

Every non-trivial design choice has explicit tradeoffs. State them in the form:

> "Option A wins on X but loses on Y; we pick A because X matters more in this project."

Never pick an option without naming what you are giving up. If no tradeoff exists, re-examine — you may be missing context.

## Anti-patterns

- **God objects / god modules** — one class/file that knows about everything
- **Circular dependencies** — A imports B imports A
- **Implicit coupling** — units silently share a global or a shared file
- **Premature abstraction** — interfaces with a single implementation, factories that always return the same type
- **Over-engineered abstractions** — wrappers that add indirection without removing duplication

## Signals that something is wrong

- A file exceeds the project's size norms (e.g. >300 lines in a codebase where 100 is typical)
- Changing one module requires touching 5+ others
- A test requires mocking more than 3 collaborators
- Naming becomes increasingly vague (`Manager`, `Handler`, `Utils`) as scope grows
