<h1 align="center">ARM64 Compatibility Radar</h1>

<p align="center">
  <strong>Make Windows-on-ARM compatibility claims traceable.</strong><br>
  A local, evidence-first catalog where every entry is <code>tested</code>, <code>reported</code>, or <code>unknown</code> — with dated, HTTPS sources.
</p>

<p align="center">
  <a href="https://github.com/Fredy-E/ARM64-Compatibility-Radar/actions/workflows/verify.yml"><img src="https://github.com/Fredy-E/ARM64-Compatibility-Radar/actions/workflows/verify.yml/badge.svg" alt="verify"></a>
  <img src="https://img.shields.io/badge/platform-browser-29354b?style=flat-square" alt="Platform: browser">
  <img src="https://img.shields.io/badge/data-stays%20local-c7a366?style=flat-square" alt="Data stays local">
  <img src="https://img.shields.io/badge/status-prototype-737373?style=flat-square" alt="Status: prototype">
  <img src="https://img.shields.io/badge/license-MIT-737373?style=flat-square" alt="License: MIT">
</p>

## What this is

Open `index.html` in a browser. No installation, no server, no network requests. Search and filter entries, import your own JSON catalog, add dated evidence, and export the result.

- Entry types include apps, drivers, devices, and interfaces.
- `tested` / `reported` records require an HTTPS source and a date.
- The bundled entries are clearly marked **fictional** and `unknown` — they demonstrate the schema, not real compatibility results.
- The app does not establish compatibility itself or verify submitted evidence; changes stay in memory until exported.

## Checks

```sh
node tests/catalog.test.cjs
```

CI runs the same checks on every push (badge above).

## Next

Independently sourced records, stronger environment/version schemas, and a reviewed contribution workflow.

## See also

[DriverLens](https://github.com/Fredy-E/DriverLens) · [MeshLab Mini](https://github.com/Fredy-E/MeshLab-Mini) · [Diagnostic Scan Diff](https://github.com/Fredy-E/Diagnostic-Scan-Diff) · [Offline Museum Kit](https://github.com/Fredy-E/Offline-Museum-Kit) — small local-first tools built for Windows-on-ARM work.
