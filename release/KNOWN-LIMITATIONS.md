# SGS v0.2.0-rc1 — Known limitations

- Verified: Windows portable command deployment, isolated new-user bootstrap, thin entry installation/rebind and actual Codex Desktop runtime invocation from the portable deployment.
- Production filesystem writes are verified only on Windows. macOS/Linux production writes remain blocked by the existing runtime gate.
- Desktop behavior is specific to the tested host/runtime. Other Desktop versions and hosts require their own evidence; copied evidence does not establish support.
- Bootstrap is a conservative filesystem inventory. Missing roots, broken links and out-of-scope external junctions produce PARTIAL coverage and explicit errors. It does not establish a global Desktop discovery count.
- Inventory is a timestamped snapshot. Author-machine counts are not defaults or guarantees for another user.
- Installation and bootstrap do not authorize production apply. Host binding, exact authorization, Desktop capability, before-state comparison and transaction recovery gates remain required.
- Entry pointers contain local deployment paths. After relocating a read-only deployment, rebind the entry and rerun bootstrap to refresh inventory paths. Moving a live cold store or unfinished transaction is a separate operation.
- The distribution excludes local profiles, authorizations, receipts, cold assets, raw Desktop sessions, private historical evidence and third-party Skill assets. Published acceptance records are sanitized summaries.
