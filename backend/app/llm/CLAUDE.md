# backend/app/llm

Before editing anything in this directory, read `docs/handbook/llm-boundary.md` (path from the repo root) in full: the prompt input bounds, the 413 / 503 size errors, output truncation, the capability probe and the metering-context rules. Before changing the TAILOR or PLAN_CV prompt, or the model, also read `docs/handbook/skills.md` and `docs/handbook/tailoring.md` — about thirteen prompt and model changes were measured and rejected there, each with its numbers. A new LLM task needs a stub branch in `client.py` and a smoke-test check (root `CLAUDE.md`, *Testing*).

This file is a pointer and must stay one: a rule has one home, in its department's handbook file, never here.
