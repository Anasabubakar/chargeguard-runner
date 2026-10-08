# Verification

```bash
pnpm run typecheck && pnpm test && pnpm run check:schema   # 67 tests in 7 files, about 2 minutes (spawns worker processes), no external network
```

Supported: Node 22.13+ (developed on 24.19), TypeScript 7.0.2, vitest 5.0.3, zod 4.6.5; the `openssl` CLI for the stub's per-run certificate.
