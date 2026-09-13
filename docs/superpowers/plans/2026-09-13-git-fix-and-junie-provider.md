# Implementation Plan: Fix de Instalación Git, Validación de Probes y Proveedor Junie

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reparar la instalación vía Git de `usage-monitor` en Paseo 0.8, mejorar la robustez de los probes de Antigravity y Copilot en Linux, e implementar el proveedor de JetBrains Junie (historial y cuota en vivo).

**Architecture:** Limpieza de límites de módulos de compilación en Paseo (eliminando imports directos de `@getpaseo/client` y `@getpaseo/protocol` en favor de `@getpaseo/plugin`), adición de fallback por variable de entorno en Antigravity probe, y creación del subsistema de Junie basado en telemetría de `~/.junie/sessions/` y credenciales locales.

**Tech Stack:** TypeScript, Node.js (v22+), Paseo Plugin SDK (`@getpaseo/plugin`), Vitest, esbuild.

**Spec:** `docs/superpowers/specs/2026-09-13-git-fix-and-junie-provider-design.md`

## Global Constraints

- TypeScript estricto con `noEmit: true`, pasar `npm run typecheck` sin errores.
- 100% de la suite de pruebas (`npm test`) pasando en cada tarea.
- Cero dependencias prohibidas en bundles de Paseo (`@getpaseo/client` y `@getpaseo/protocol` no deben importarse directamente en bundles de servidor ni cliente).

---

### Task 1: Fix de Instalación Git y Fronteras de Módulos

**Files:**
- Modify: `server/handlers.server.ts`
- Modify: `server/limit-alerts.server.ts`
- Modify: `client/limit-alerts.client.tsx`
- Modify: `paseo-plugin.json`
- Test: `npm run typecheck && npm test`

**Interfaces:**
- Consumes: `@getpaseo/plugin/server` (`PluginHandlerContext`), `@getpaseo/plugin/client` (`usePaseo`)
- Produces: Módulos cliente y servidor 100% conformes con el compilador de Paseo 0.8 sin dependencias externas de tipos no provistas.

- [ ] **Step 1: Reemplazar importación de `@getpaseo/client` en `server/handlers.server.ts`**
  Reemplazar `import type { PaseoApi } from "@getpaseo/client";` por `import type { PluginHandlerContext } from "@getpaseo/plugin/server"; type PaseoApi = PluginHandlerContext["paseo"];`.

- [ ] **Step 2: Reemplazar importación de `@getpaseo/client` en `server/limit-alerts.server.ts`**
  Reemplazar `import type { PaseoApi } from "@getpaseo/client";` por `import type { PluginHandlerContext } from "@getpaseo/plugin/server"; type PaseoApi = PluginHandlerContext["paseo"];`.

- [ ] **Step 3: Reemplazar importaciones en `client/limit-alerts.client.tsx`**
  Reemplazar importación de `PaseoApi` por `type PaseoApi = ReturnType<typeof usePaseo>;` y sustituir la importación de `AgentTimelineItem` por una interfaz local estructural `{ type: string; message?: string; text?: string; [key: string]: unknown }`.

- [ ] **Step 4: Añadir directiva `build` en `paseo-plugin.json`**
  Añadir `"build": [["npm", "install", "--omit=dev"]]`.

- [ ] **Step 5: Ejecutar validación de tipos y tests**
  Correr `npm run typecheck && npm test`.

- [ ] **Step 6: Commit**
  `git commit -am "fix(plugin): comply with Paseo 0.8 module boundaries and add build step in manifest"`

---

### Task 2: Robustez de Antigravity y Copilot en Linux

**Files:**
- Modify: `server/antigravity-probe.server.ts`
- Modify: `shared/presets.shared.ts`
- Modify: `server/config-store.test.ts`
- Test: `npm test -- server/antigravity-probe.test.ts server/config-store.test.ts`

**Interfaces:**
- Consumes: `process.env.ANTIGRAVITY_TOKEN`
- Produces: Probe de Antigravity con fallback de token y presets de catálogo actualizados.

- [ ] **Step 1: Añadir soporte para `ANTIGRAVITY_TOKEN` en `server/antigravity-probe.server.ts`**
  En la resolución de credenciales de Antigravity, comprobar primero `process.env.ANTIGRAVITY_TOKEN` antes de llamar a Secret Service / D-Bus.

- [ ] **Step 2: Actualizar descripciones en `shared/presets.shared.ts`**
  Actualizar las descripciones de `antigravity` y `github-copilot` para eliminar el prefijo `Unverified: ` y describir su compatibilidad verificada en Linux/macOS.

- [ ] **Step 3: Actualizar tests en `server/config-store.test.ts`**
  Ajustar las aserciones de prueba que verificaban el patrón antiguo `Unverified: `.

- [ ] **Step 4: Ejecutar tests**
  `npm test -- server/antigravity-probe.test.ts server/config-store.test.ts`.

- [ ] **Step 5: Commit**
  `git commit -am "feat(presets): improve Antigravity Linux fallback and verify preset descriptions"`

---

### Task 3: Parser de Historial de Junie (`UsageHistory`)

**Files:**
- Modify: `server/history.server.ts`
- Modify: `server/history.test.ts`
- Test: `npm test -- server/history.test.ts`

**Interfaces:**
- Consumes: `~/.junie/sessions/*/events.jsonl`
- Produces: `UsageRow` con `providerId: "junie"`, tokens de entrada/salida/caché, coste en USD y desglose temporal.

- [ ] **Step 1: Escribir test que falla en `server/history.test.ts`**
  Crear fixture con eventos `LlmResponseMetadataEvent` de Junie y verificar que `collectJunieRows` extrae los tokens, coste y modelo correctos.

- [ ] **Step 2: Implementar escaneo y parsing de Junie en `server/history.server.ts`**
  * Definir `JUNIE_PROVIDER_ID = "junie"`.
  * Añadir `join(adapters.homeDir, ".junie", "sessions")` a los directorios de búsqueda de sesiones.
  * Implementar `collectJunieRows(text: string): UsageRow[]` para procesar eventos `LlmResponseMetadataEvent`.

- [ ] **Step 3: Ejecutar tests**
  `npm test -- server/history.test.ts`.

- [ ] **Step 4: Commit**
  `git commit -am "feat(history): add JetBrains Junie token usage history parser"`

---

### Task 4: Probe en Vivo y Preset para Junie (`UsageMonitor`)

**Files:**
- Create: `server/junie-probe.server.ts`
- Create: `server/junie-probe.test.ts`
- Modify: `server/source.server.ts`
- Modify: `shared/presets.shared.ts`
- Test: `npm test -- server/junie-probe.test.ts server/source.test.ts`

**Interfaces:**
- Consumes: `~/.junie/secure_credentials.json`, `~/.junie/sessions/`
- Produces: `UsageReading` para el dashboard de Paseo con el estado de cuenta y cuota de Junie.

- [ ] **Step 1: Escribir tests unitarios en `server/junie-probe.test.ts`**
  Validar casos:
  * Credenciales presentes y sesión activa -> estado OK con métricas.
  * Sesión con `ExitPaymentRequired` -> estado de agotamiento con advertencia (0% balance).
  * Sin instalación de Junie -> error descriptivo.

- [ ] **Step 2: Implementar `server/junie-probe.server.ts`**
  Lógica de detección de credenciales y lectura de la última sesión.

- [ ] **Step 3: Conectar el probe en `server/source.server.ts` y preset en `shared/presets.shared.ts`**
  Registrar `"junie"` como probe reconocido.

- [ ] **Step 4: Ejecutar tests**
  `npm test -- server/junie-probe.test.ts server/source.test.ts`.

- [ ] **Step 5: Commit**
  `git commit -am "feat(probe): add live Junie quota and balance monitor probe"`

---

### Task 5: Verificación Integral y Publicación

**Files:**
- Modify: `README.md`
- Test: `npm test && npm run typecheck`

- [ ] **Step 1: Actualizar `README.md`**
  Documentar la integración de Junie y los proveedores verificados.

- [ ] **Step 2: Suite completa de pruebas**
  Ejecutar `npm test && npm run typecheck`.

- [ ] **Step 3: Git Push a GitHub**
  `git push origin main`.

- [ ] **Step 4: Verificación en Paseo**
  Recargar el plugin en Paseo (`paseo plugin reload usage-monitor`) y validar que las tarjetas e historial de Junie, Antigravity y Copilot estén operativas.
